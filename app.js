'use strict';
// App web del potenciostato: Web Bluetooth (Chrome en Android o en el PC) + simulador.
// Protocolo: ../docs/PROTOCOLO_BLE.md

const UUID = {
  service: '4c5d0001-8a3e-4f6b-9a2d-2f6e0c1b7a10',
  cmd:     '4c5d0002-8a3e-4f6b-9a2d-2f6e0c1b7a10',
  data:    '4c5d0003-8a3e-4f6b-9a2d-2f6e0c1b7a10',
  status:  '4c5d0004-8a3e-4f6b-9a2d-2f6e0c1b7a10',
};
// Rangos de corriente = resistencia de realimentación del TIA (índice 0-3, igual que el firmware).
// Placa Colombia: 74HC4052 con Rf = 10 k / 100 k / 1 M / 10 M, escala completa ±1,4 V.
const RANGES = [
  { rf: 1e4, name: '10 kΩ',  short: '10k',  fs: '±140 µA' },
  { rf: 1e5, name: '100 kΩ', short: '100k', fs: '±14 µA' },
  { rf: 1e6, name: '1 MΩ',   short: '1M',   fs: '±1,4 µA' },
  { rf: 1e7, name: '10 MΩ',  short: '10M',  fs: '±140 nA' },
];
const RF = RANGES.map((r) => r.rf);
const RANGE_NAME = RANGES.map((r) => r.name);
const FS_V = 1.4;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const APP_VERSION = '2026-11-09-d';

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`Sin respuesta al ${what} (${ms / 1000} s)`)), ms))]);
}
// Web Bluetooth falla a veces al primer intento (GATT ocupado); se reintenta unas veces.
async function retry(fn, tries = 3, wait = 600) {
  let last;
  for (let k = 0; k < tries; k++) {
    try { return await fn(); } catch (e) { last = e; if (k < tries - 1) await new Promise((r) => setTimeout(r, wait)); }
  }
  throw last;
}

// ------------------------------------------------------------------ registro del equipo
function log(msg) {
  const el = $('#log');
  const t = new Date().toLocaleTimeString();
  el.textContent += `${t}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------ enlace BLE real
class BleLink {
  constructor() { this.onText = () => {}; this.onData = () => {}; this.onClose = () => {}; this.kind = 'ble'; }

  // Conecta y localiza las características. `step(texto)` informa del avance a la interfaz.
  async connect(step = () => {}) {
    if (!navigator.bluetooth) throw new Error('Este navegador no tiene Web Bluetooth (usa Chrome en Android o en el PC).');
    this.step = 'buscar dispositivo'; step('Elige el dispositivo…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.service] }, { namePrefix: 'Poten' }],
      optionalServices: [UUID.service],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onClose());
    try {
      this.step = 'conectar GATT'; step('Conectando…');
      const server = await retry(() => withTimeout(this.device.gatt.connect(), 15000, 'conectar'));
      this.step = 'buscar el servicio'; step('Buscando el servicio…');
      const svc = await retry(() => withTimeout(server.getPrimaryService(UUID.service), 10000, 'servicio'));
      this.step = 'buscar características';
      this.cmd = await retry(() => svc.getCharacteristic(UUID.cmd));
      this.data = await retry(() => svc.getCharacteristic(UUID.data));
      this.status = await retry(() => svc.getCharacteristic(UUID.status));
    } catch (e) {
      try { this.device.gatt.disconnect(); } catch (x) { /* ya desconectado */ }
      throw e;
    }
  }

  // Activa las notificaciones y pide la información del equipo. Si falla, la conexión sigue (se avisa).
  async begin(step = () => {}) {
    const dec = new TextDecoder();
    this.status.addEventListener('characteristicvaluechanged', (e) => this.onText(dec.decode(e.target.value)));
    this.data.addEventListener('characteristicvaluechanged', (e) => this.onData(e.target.value));
    this.step = 'activar notificaciones'; step('Activando notificaciones…');
    await retry(() => withTimeout(this.status.startNotifications(), 10000, 'notificaciones de estado'));
    await retry(() => withTimeout(this.data.startNotifications(), 10000, 'notificaciones de datos'));
    this.step = 'pedir información'; step('Pidiendo información…');
    await this.send({ c: 'info' });
  }

  async send(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    try {
      if (this.cmd.writeValueWithResponse) await this.cmd.writeValueWithResponse(bytes);
      else await this.cmd.writeValue(bytes);
    } catch (e) {
      if (this.cmd.writeValueWithoutResponse) await this.cmd.writeValueWithoutResponse(bytes);   // el equipo también acepta escritura sin respuesta
      else throw e;
    }
  }

  disconnect() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }
}

// ------------------------------------------------------------------ dispositivo simulado (mismo protocolo)
class SimLink {
  constructor() {
    this.onText = () => {}; this.onData = () => {}; this.onClose = () => {}; this.kind = 'sim';
    this.cfg = { glu: 100, redox: true };
    this.run = 0; this.timer = null; this.settleTimer = null;
  }

  async begin() {}

  async connect() {
    setTimeout(() => this._info(), 30);
    this.stTimer = setInterval(() => { if (!this.timer && !this.settleTimer) this._status(); }, 2000);
    setTimeout(() => this._status(), 80);
  }

  disconnect() { this._finish('stop', true); clearInterval(this.stTimer); this.onClose(); }

  async send(o) {
    switch (o.c) {
      case 'info': this._info(); break;
      case 'sim': this.cfg.glu = o.glu ?? 100; this.cfg.redox = !!o.redox; this._info(); break;
      case 'stop': this._finish('stop'); break;
      case 'ca': this._startCA(o); break;
      case 'cv': this._startCV(o); break;
      case 'ocp': this._startOCP(o); break;
      default: this._emit({ t: 'err', code: 'BAD_CMD', msg: 'comando desconocido' });
    }
  }

  _emit(obj) {
    // se parte en trozos de 20 bytes, como con un MTU mínimo, para probar el reensamblado
    const s = JSON.stringify(obj) + '\n';
    for (let i = 0; i < s.length; i += 20) this.onText(s.slice(i, i + 20));
  }
  _info() { this._emit({ t: 'info', fw: 'sim-js', mode: 'sim', name: 'Simulador', mtu: 23 }); }
  _status() { this._emit({ t: 'st', state: this.timer ? 'run' : 'idle', rng: this.rng ?? 3, bat: 3900, temp: 24.0, mode: 'sim' }); }

  _begin(mode, sps, total, rng) {
    if (this.timer || this.settleTimer) { this._emit({ t: 'err', code: 'BUSY', msg: 'ya hay una medicion en curso' }); return false; }
    this.run = (this.run + 1) & 255; this.mode = mode; this.sps = sps; this.total = total; this.idx = 0;
    this.rng = rng; this.batch = []; this.t0 = 0;
    this._emit({ t: 'start', mode, sps, rng, run: this.run, n: total });
    return true;
  }

  _startCA(o) {
    const sps = Math.min(Math.max(o.sps ?? 20, 1), 1000), dur = o.dur ?? 60;
    const rng = (o.rng === 'auto' || o.rng === undefined) ? this._autoRange(this.cfg.glu * 1.6) : o.rng;
    if (!this._begin('ca', sps, Math.floor(dur * sps), rng)) return;
    this.E = o.e ?? 0; this.eStep = this.E - 120; this.prevE = this.E;
    this.tOff = (o.settle ?? 2000) / 1000;
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.t0 = 0; this._loop(); }, o.settle ?? 2000);
  }

  _startOCP(o) {
    const sps = Math.min(Math.max(o.sps ?? 10, 1), 100), dur = o.dur ?? 10;
    if (!this._begin('ocp', sps, Math.floor(dur * sps), 1)) return;
    this.tOff = 0;
    this._loop();
  }

  _startCV(o) {
    const sr = o.sr ?? 50, es = o.es ?? -200, e1 = o.e1 ?? 600, e2 = o.e2 ?? -200, n = o.n ?? 1;
    const sps = Math.min(Math.max(sr, 20), 330), dE = sr / sps;
    const wp = [es, e1, e2]; for (let c = 1; c < n; c++) wp.push(e1, e2);
    let total = 1; for (let k = 0; k + 1 < wp.length; k++) total += Math.ceil(Math.abs(wp[k + 1] - wp[k]) / dE - 1e-4);
    const rng = o.rng === 'auto' ? 1 : (o.rng ?? 1);
    if (!this._begin('cv', sps, total, rng)) return;
    this.wp = wp; this.seg = 0; this.eCur = es; this.dE = dE; this.first = true; this.E = es; this.prevE = es;
    this.eStep = es - 120;
    this.tOff = 1.0;
    this.df = null;
    if (this.cfg.redox) {
      this._diffInit(sps, total);
      for (let k = 0, m = Math.round(1.0 * sps); k < m; k++) this._diffStep(es);   // 1 s de preelectrólisis en E inicial
    }
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this._loop(); }, 1000);
  }

  // Par redox reversible/cuasi-reversible (ferri/ferrocianuro 5 mM) con difusión lineal semi-infinita:
  // diferencias finitas explícitas; O + e ⇌ R, DO = DR, así CO + CR = C* en todo punto y solo se resuelve CR.
  // Condición en el electrodo: Butler-Volmer con k0 finito. Corriente catódica positiva (convención de la app).
  _diffInit(sps, total) {
    const D = 7.6e-6, dt = 1 / sps, lam = 0.4, dx = Math.sqrt(D * dt / lam);   // cm², s, cm
    const T = total / sps + 2, N = Math.min(4000, Math.ceil(6 * Math.sqrt(D * T) / dx) + 8);
    this.df = { D, dx, lam, N, CR: new Float64Array(N), tmp: new Float64Array(N), C: 5e-6, A: 0.07, k0: 0.006, alpha: 0.5, E0: 220 };
  }

  _diffStep(E_mV) {
    const d = this.df, CR = d.CR, nx = d.tmp, N = d.N;
    const eta = 38.92 * (E_mV - d.E0) / 1000;                       // F/RT · (E − E0')
    const kf = d.k0 * Math.exp(-d.alpha * eta), kb = d.k0 * Math.exp((1 - d.alpha) * eta);
    const g = d.D / (2 * d.dx);
    const CR0 = (kf * d.C + g * (4 * CR[1] - CR[2])) / (3 * g + kf + kb);
    CR[0] = CR0;
    const iA = 96485 * d.A * (kf * (d.C - CR0) - kb * CR0);          // A; reducción (O→R) positiva
    nx[0] = CR0;
    for (let i = 1; i < N - 1; i++) nx[i] = CR[i] + d.lam * (CR[i + 1] - 2 * CR[i] + CR[i - 1]);
    nx[N - 1] = 0;
    d.CR = nx; d.tmp = CR;
    return iA * 1e9;                                                  // nA
  }

  _autoRange(i_nA) {
    for (let r = 3; r >= 0; r--) if (Math.abs(i_nA) * 1e-9 * RF[r] < 0.9 * FS_V) return r;
    return 0;
  }

  _cvNext() {
    if (this.first) { this.first = false; return this.eCur; }
    if (this.seg >= this.wp.length - 1) return null;
    const tgt = this.wp[this.seg + 1], d = tgt - this.eCur;
    if (Math.abs(d) <= this.dE) { this.eCur = tgt; this.seg++; } else this.eCur += d > 0 ? this.dE : -this.dE;
    return this.eCur;
  }

  _loop() {
    const tickMs = 20;
    this.vstart = performance.now();
    this.timer = setInterval(() => {
      const due = Math.floor(((performance.now() - this.vstart) / 1000) * this.sps) - this.idx;
      for (let k = 0; k < due; k++) {
        if (this.mode === 'cv') {
          const E = this._cvNext();
          if (E === null) { this._finish('done'); return; }
          this.E = E;
        }
        this._push(this._sample());
        if (this.mode !== 'cv' && this.idx >= this.total) { this._finish('done'); return; }
      }
      if (this.batch.length) this._flush();
    }, tickMs);
  }

  gauss() { let s = 0; for (let k = 0; k < 4; k++) s += Math.random(); return (s - 2) / 0.577; }

  _sample() {
    const dt = 1 / this.sps, rf = RF[this.rng], t = this.idx * dt + (this.tOff || 0);
    let i_nA = 0, e_mV;
    if (this.mode === 'ocp') {
      e_mV = 120 + 0.5 * Math.sin(performance.now() / 9000) + 0.1 * this.gauss();
    } else {
      const dE = this.E - this.prevE; this.prevE = this.E;
      const dir = dE > 1e-4 ? 1 : dE < -1e-4 ? -1 : 0;
      const act = 1 / (1 + Math.exp((this.E - 100) / 30));
      i_nA += 1.6 * this.cfg.glu * act;
      i_nA += (-this.eStep / 1.5) * 1000 * Math.exp(-t / 0.03);
      i_nA += -0.02 * t + (this.eStep < 0 ? 25 : -25) * Math.exp(-t / 15);
      if (dir !== 0) {
        const sr = Math.abs(dE / dt) / 1000;
        i_nA += -dir * 5 * sr * 1000;                       // corriente capacitiva: C·dE/dt con C ≈ 5 µF
      }
      if (this.mode === 'cv' && this.cfg.redox && this.df) i_nA += this._diffStep(this.E);   // corriente faradaica por difusión
      e_mV = this.E + 0.03 * this.gauss();
    }
    i_nA += Math.hypot(3.7e-6 / rf * 1e9, 0.3) * this.gauss();
    let i_pA = i_nA * 1000;
    const max = FS_V / rf * 1e12;
    i_pA = Math.max(-max, Math.min(max, i_pA));
    return { i: Math.round(i_pA), e: Math.round(e_mV * 10) };
  }

  _push(s) { this.batch.push(s); this.idx++; if (this.batch.length >= 20) this._flush(); }

  _flush() {
    if (!this.batch.length) return;
    const n = this.batch.length, buf = new ArrayBuffer(7 + 6 * n), dv = new DataView(buf);
    dv.setUint8(0, 0xD1); dv.setUint8(1, this.run); dv.setUint32(2, this.idx - n, true); dv.setUint8(6, n);
    this.batch.forEach((s, k) => { dv.setInt32(7 + 6 * k, s.i, true); dv.setInt16(11 + 6 * k, s.e, true); });
    this.batch = [];
    this.onData(dv);
  }

  _finish(reason, silent) {
    const was = this.timer || this.settleTimer;
    clearInterval(this.timer); clearTimeout(this.settleTimer); this.timer = null; this.settleTimer = null;
    if (!was) return;
    this._flush();
    if (!silent) this._emit({ t: 'end', reason, n: this.idx, run: this.run, drop: 0 });
  }
}

// ------------------------------------------------------------------ gráfica
class Chart {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.x = []; this.y = []; this.xl = ''; this.yl = ''; this.pending = false;
    window.addEventListener('resize', () => this.request());
  }
  set(x, y, xl, yl) { this.x = x; this.y = y; this.xl = xl; this.yl = yl; this.request(); }
  request() { if (!this.pending) { this.pending = true; requestAnimationFrame(() => { this.pending = false; this.draw(); }); } }

  static ticks(min, max, n) {
    if (!(max > min)) { max = min + 1; }
    const raw = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    const out = []; for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return { out, step };
  }

  draw() {
    const cv = this.cv, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--grid').trim(), plot = css.getPropertyValue('--plot').trim();
    const L = 62, R = 12, T = 10, B = 38;
    ctx.font = '12px system-ui, sans-serif';
    if (this.x.length < 2) { ctx.fillStyle = ink; ctx.fillText('Sin datos', L + 10, T + 24); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < this.x.length; k++) {
      const a = this.x[k], b = this.y[k];
      if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b;
    }
    if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.06; y0 -= pad; y1 += pad;
    const sx = (v) => L + ((v - x0) / (x1 - x0 || 1)) * (w - L - R);
    const sy = (v) => T + (1 - (v - y0) / (y1 - y0)) * (h - T - B);
    ctx.strokeStyle = grid; ctx.fillStyle = ink; ctx.lineWidth = 1;
    const tx = Chart.ticks(x0, x1, 6), ty = Chart.ticks(y0, y1, 5);
    const dec = (st) => Math.max(0, -Math.floor(Math.log10(st)) + (st < 1 ? 0 : 0));
    ctx.textAlign = 'center';
    for (const v of tx.out) { const X = sx(v); ctx.beginPath(); ctx.moveTo(X, T); ctx.lineTo(X, h - B); ctx.stroke(); ctx.fillText(v.toFixed(dec(tx.step)), X, h - B + 15); }
    ctx.textAlign = 'right';
    for (const v of ty.out) { const Y = sy(v); ctx.beginPath(); ctx.moveTo(L, Y); ctx.lineTo(w - R, Y); ctx.stroke(); ctx.fillText(v.toFixed(dec(ty.step)), L - 6, Y + 4); }
    ctx.textAlign = 'center'; ctx.fillText(this.xl, L + (w - L - R) / 2, h - 6);
    ctx.save(); ctx.translate(13, T + (h - T - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(this.yl, 0, 0); ctx.restore();
    ctx.strokeStyle = plot; ctx.lineWidth = 1.6; ctx.beginPath();
    for (let k = 0; k < this.x.length; k++) { const X = sx(this.x[k]), Y = sy(this.y[k]); if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ estado de la app
const S = {
  link: null, mode: 'ca', running: false, rngSel: 'auto', page: 'medir', filter: 'all', bat: null,
  run: { mode: 'ca', sps: 20, rng: 3, n: 0, t: [], e: [], i: [], meta: null },
  textBuf: '', pending: null, hist: [],
};
const chart = new Chart($('#plot'));

function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

function unitFor(maxAbs_nA) {
  if (maxAbs_nA >= 1e6) return { f: 1e-6, u: 'mA' };
  if (maxAbs_nA >= 1e3) return { f: 1e-3, u: 'µA' };
  return { f: 1, u: 'nA' };
}
const fmtI = (nA) => { const { f, u } = unitFor(Math.abs(nA)); return `${(nA * f).toFixed(Math.abs(nA * f) < 10 ? 3 : 2)} ${u}`; };
const fmtE = (mV) => `${mV < 0 ? '−' : '+'}${Math.abs(mV).toFixed(1)} mV`;
const batPct = (mV) => Math.round(Math.min(100, Math.max(0, (mV - 3300) / 9)));
const hora = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function updateChip() {
  const c = $('#chip');
  if (!S.link) { c.textContent = 'Sin conexión'; c.className = 'chip'; return; }
  if (S.running) { c.textContent = 'Midiendo…'; c.className = 'chip run'; return; }
  c.textContent = 'Conectado' + (S.bat != null ? ` · ${batPct(S.bat)} %` : ''); c.className = 'chip ok';
}

function updateButtons() {
  const on = !!S.link, has = S.run.i.length > 0, sim = on && S.link.kind === 'sim';
  const go = $('#btnGo');
  go.disabled = !on; go.textContent = S.running ? 'Detener' : 'Iniciar'; go.classList.toggle('stop', S.running);
  $('#connCard').hidden = on;
  $('#btnDisc').hidden = !on;
  $$('.tab').forEach((t) => (t.disabled = S.running));
  $$('#rng button').forEach((b) => (b.disabled = S.running));
  $('#btnCsv').disabled = !has; $('#btnCsv2').disabled = !has;
  $('#btnSimCfg').disabled = !sim; $('#simHint').hidden = sim;
  updateChip();
}

// ------------------------------------------------------------------ mensajes del dispositivo
function onText(chunk) {
  S.textBuf += chunk;
  let k;
  while ((k = S.textBuf.indexOf('\n')) >= 0) {
    const line = S.textBuf.slice(0, k).trim(); S.textBuf = S.textBuf.slice(k + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch (e) { log('mensaje ilegible: ' + line); }
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'info':
      $('#dMode').textContent = m.mode === 'sim' ? 'Simulado' : 'Real';
      $('#dFw').textContent = m.fw;
      log(`dispositivo ${m.name}, fw ${m.fw}, analógico ${m.mode}`);
      break;
    case 'st':
      S.bat = m.bat;
      $('#dBat').textContent = (m.bat / 1000).toFixed(2) + ' V (' + batPct(m.bat) + ' %)';
      $('#dTemp').textContent = Number(m.temp).toFixed(1) + ' °C';
      $('#dRng').textContent = RANGE_NAME[m.rng] ?? '–';
      updateChip();
      break;
    case 'start':
      S.run = { mode: m.mode, sps: m.sps, rng: m.rng, n: m.n, t: [], e: [], i: [], meta: { ...m, params: S.pending, date: new Date().toISOString() } };
      S.running = true; $('#dRng').textContent = RANGE_NAME[m.rng] ?? '–';
      log(`inicio ${m.mode.toUpperCase()}: ${m.n} muestras a ${m.sps} /s, rango ${RANGE_NAME[m.rng]}`);
      refreshPlot(); refreshStats(); updateButtons();
      break;
    case 'end':
      S.running = false;
      log(`fin (${m.reason}): ${m.n} muestras` + (m.drop ? `, ${m.drop} perdidas` : ''));
      addHistory(m.reason);
      refreshPlot(); refreshStats(); updateButtons();
      break;
    case 'err':
      log(`ERROR ${m.code}: ${m.msg}`);
      break;
    default: log('mensaje: ' + JSON.stringify(m));
  }
}

function onData(dv) {
  if (dv.byteLength < 7 || dv.getUint8(0) !== 0xD1) return;
  const idx0 = dv.getUint32(2, true), n = dv.getUint8(6), r = S.run;
  for (let k = 0; k < n && 7 + 6 * (k + 1) <= dv.byteLength; k++) {
    const i_pA = dv.getInt32(7 + 6 * k, true), e_01 = dv.getInt16(11 + 6 * k, true);
    r.t.push((idx0 + k) / r.sps); r.e.push(e_01 / 10); r.i.push(i_pA / 1000);   // nA
  }
  refreshPlot(); refreshStats();
}

// ------------------------------------------------------------------ gráfica y resultados
function refreshPlot() {
  const r = S.run;
  let xs, ys, xl, yl, title;
  const maxI = r.i.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
  const { f, u } = unitFor(maxI);
  if (r.mode === 'cv') { xs = r.e; ys = r.i.map((v) => v * f); xl = 'E (mV)'; yl = `I (${u})`; title = 'Voltamperograma cíclico'; }
  else if (r.mode === 'ocp') { xs = r.t; ys = r.e; xl = 't (s)'; yl = 'E (mV)'; title = 'Potencial de reposo'; }
  else { xs = r.t; ys = r.i.map((v) => v * f); xl = 't (s)'; yl = `I (${u})`; title = 'Cronoamperometría'; }
  $('#plotTitle').textContent = title;
  $('#plotN').textContent = `${r.i.length} muestras`;
  chart.set(xs, ys, xl, yl);
}

function tile(k, label, value, sub) {
  $('#rL' + k).textContent = label; $('#rV' + k).textContent = value; $('#rS' + k).innerHTML = sub || '&nbsp;';
}

function meanSd(arr, sps) {
  const tail = arr.slice(-Math.max(1, Math.round(10 * sps)));
  const m = tail.reduce((a, b) => a + b, 0) / tail.length;
  return { m, sd: Math.sqrt(tail.reduce((a, b) => a + (b - m) ** 2, 0) / tail.length), tail };
}

function cvPeaks(r) {
  let kmax = 0, kmin = 0;
  for (let k = 1; k < r.i.length; k++) { if (r.i[k] > r.i[kmax]) kmax = k; if (r.i[k] < r.i[kmin]) kmin = k; }
  return { kmax, kmin };   // corriente positiva = catódica
}

function glucose(meanNA) {
  const slope = parseFloat($('#calSlope').value), intercept = parseFloat($('#calInt').value) || 0;
  return slope > 0 ? Math.max(0, (meanNA - intercept) / slope) : null;
}

// Si la señal llega al límite del rango, la gráfica se aplana ("recortada"): se avisa en pantalla.
function satNote(r) {
  const rg = RANGES[r.rng]; if (!rg) return '';
  const lim = FS_V / rg.rf * 1e9 * 0.98;                    // nA
  if (!r.i.some((v) => Math.abs(v) >= lim)) return '';
  return r.rng > 0 ? ` · ⚠ señal recortada en ${rg.name} (±${rg.fs.replace('±', '')}): usa un rango menor, p. ej. ${RANGES[r.rng - 1].short}`
                   : ' · ⚠ señal recortada en 10 kΩ (el rango máximo): baja la velocidad o la concentración';
}

function refreshStats() {
  const r = S.run, n = r.i.length, meta = $('#rMeta');
  $('#btnCsv').disabled = n === 0; $('#btnCsv2').disabled = n === 0;
  const labels = { ca: ['Última', 'Media 10 s', 'Glucosa'], cv: ['Pico anódico', 'Pico catódico', 'ΔEp'], ocp: ['Actual', 'Deriva', 'Muestras'] }[r.mode];
  if (!n) {
    tile(1, labels[0], '–'); tile(2, labels[1], '–'); tile(3, labels[2], '–');
    meta.textContent = 'Corriente positiva = catódica (reducción). Potenciales respecto al electrodo de referencia.';
    return;
  }
  if (r.mode === 'ocp') {
    const { sd, tail } = meanSd(r.e, r.sps);
    const nt = tail.length, dt = (nt - 1) / r.sps;
    const drift = dt > 0 ? (tail[nt - 1] - tail[0]) / dt : 0;
    tile(1, labels[0], fmtE(r.e[n - 1])); tile(2, labels[1], drift.toFixed(2) + ' mV/s', 'últimos 10 s'); tile(3, labels[2], String(n));
    meta.textContent = `σ ${sd.toFixed(2)} mV en los últimos 10 s`;
    return;
  }
  const { m, sd } = meanSd(r.i, r.sps);
  if (r.mode === 'cv') {
    const { kmax, kmin } = cvPeaks(r);
    tile(1, labels[0], fmtI(r.i[kmin]), `en ${r.e[kmin].toFixed(0)} mV`);
    tile(2, labels[1], fmtI(r.i[kmax]), `en ${r.e[kmax].toFixed(0)} mV`);
    tile(3, labels[2], Math.abs(r.e[kmin] - r.e[kmax]).toFixed(0) + ' mV', 'entre picos');
    meta.textContent = `${n} muestras · rango ${RANGE_NAME[r.rng] ?? '–'}` + satNote(r);
    return;
  }
  const g = glucose(m);
  tile(1, labels[0], fmtI(r.i[n - 1])); tile(2, labels[1], fmtI(m), 'σ ' + fmtI(sd));
  tile(3, labels[2], g === null ? '–' : g.toFixed(1) + ' µM', 'según calibración');
  meta.textContent = `${n} muestras · rango ${RANGE_NAME[r.rng] ?? '–'}` + satNote(r);
}

// ------------------------------------------------------------------ historial de mediciones
function summarize(r, params, reason) {
  const p = params || {}, t0 = r.meta?.date || new Date().toISOString(), h = hora(t0);
  const stopped = reason === 'stop' ? ' · detenida' : '';
  const rn = RANGE_NAME[r.rng] ?? '–', n = r.i.length;
  if (r.mode === 'cv') {
    const { kmax, kmin } = cvPeaks(r);
    return { title: `CV · ${p.n ?? 1} ${(p.n ?? 1) === 1 ? 'ciclo' : 'ciclos'}`, sub: `${h} · ${p.sr ?? '?'} mV/s · ${rn}${stopped}`, val: 'ΔEp ' + Math.abs(r.e[kmin] - r.e[kmax]).toFixed(0) + ' mV', t: t0 };
  }
  if (r.mode === 'ocp') return { title: `OCP · ${p.dur ?? '?'} s`, sub: `${h}${stopped}`, val: fmtE(r.e[n - 1]), t: t0 };
  const { m } = meanSd(r.i, r.sps), g = glucose(m);
  return { title: `CA · ${p.e ?? 0} mV · ${p.dur ?? '?'} s`, sub: `${h} · rango ${rn}${stopped}`, val: g === null ? fmtI(m) : g.toFixed(1) + ' µM', t: t0 };
}

function addHistory(reason) {
  const r = S.run;
  if (r.i.length < 2) return;
  const e = summarize(r, r.meta?.params, reason);
  e.run = r;
  S.hist.unshift(e); S.hist = S.hist.slice(0, 40);
  store('pot_hist', JSON.stringify(S.hist.map(({ title, sub, val, t }) => ({ title, sub, val, t }))));
  renderHist();
}

function renderHist() {
  const box = $('#hist'); box.innerHTML = '';
  if (!S.hist.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Todavía no hay mediciones. Inicia una desde Medir.'; box.appendChild(p); return; }
  S.hist.forEach((e) => {
    const it = document.createElement('div'); it.className = 'it';
    const l = document.createElement('div');
    const b = document.createElement('b'); b.textContent = e.title;
    const s = document.createElement('small'); s.textContent = e.sub;
    l.append(b, s);
    const rgt = document.createElement('div'); rgt.className = 'v'; rgt.textContent = e.val;
    if (e.run) {
      const d = document.createElement('button'); d.type = 'button'; d.textContent = 'CSV'; d.setAttribute('aria-label', 'Exportar ' + e.title + ' a CSV');
      d.onclick = () => downloadCsv(e.run);
      const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:8px'; wrap.append(rgt, d);
      it.append(l, wrap);
    } else it.append(l, rgt);
    box.appendChild(it);
  });
}

function applyFilter() {
  $$('#filt button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === S.filter)));
  $('#secMed').hidden = S.filter === 'dev';
  $('#secDev').hidden = S.filter === 'med';
}

// ------------------------------------------------------------------ pantallas y controles
const TITLES = { medir: 'Medir', reg: 'Registro', aj: 'Ajustes' };
function showPage(p) {
  S.page = p;
  ['medir', 'reg', 'aj'].forEach((k) => ($('#pg-' + k).hidden = k !== p));
  $$('.nav button').forEach((b) => (p === b.dataset.page ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('#pgTitle').textContent = TITLES[p];
  if (p === 'medir') chart.request();
  if (p === 'reg') { const l = $('#log'); l.scrollTop = l.scrollHeight; }
  window.scrollTo(0, 0);
}

function buildRange() {
  const box = $('#rng'); box.innerHTML = '';
  [{ v: 'auto', t: 'Auto' }, ...RANGES.map((r, i) => ({ v: String(i), t: r.short }))].forEach((o) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.v = o.v; b.textContent = o.t;
    b.onclick = () => { S.rngSel = o.v; refreshRange(); parSummary(); };
    box.appendChild(b);
  });
  refreshRange();
}

function refreshRange() {
  $$('#rng button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === S.rngSel));
    if (b.dataset.v === 'auto') b.hidden = S.mode === 'cv';
  });
  const r = RANGES[parseInt(S.rngSel, 10)];
  $('#rngHint').textContent = S.rngSel === 'auto' ? 'Rango automático: el equipo elige según la corriente.' : `${r.name} · ${r.fs} a plena escala`;
}

function parSummary() {
  const g = (id) => ($('#' + id).value || '–');
  const rg = S.rngSel === 'auto' ? 'Auto' : RANGES[parseInt(S.rngSel, 10)].short;
  let s;
  if (S.mode === 'ca') s = `E ${g('caE')} mV · ${g('caDur')} s · ${g('caSps')}/s · ${rg}`;
  else if (S.mode === 'cv') s = `${g('cvEs')} → ${g('cvE1')} → ${g('cvE2')} mV · ${g('cvSr')} mV/s · ${g('cvN')} ciclos · ${rg}`;
  else s = `${g('ocpDur')} s · ${g('ocpSps')}/s`;
  $('#parSum').textContent = s;
}

function showMode(mode) {
  S.mode = mode;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  $$('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== mode));
  $('#rngBox').hidden = mode === 'ocp';
  if (mode === 'cv' && S.rngSel === 'auto') S.rngSel = '0';
  refreshRange(); parSummary();
  if (!S.running && S.run.mode !== mode) { S.run = { mode, sps: S.run.sps, rng: S.run.rng, n: 0, t: [], e: [], i: [], meta: null }; refreshPlot(); refreshStats(); updateButtons(); }
}

const num = (id) => parseFloat($('#' + id).value);
const rngCmd = () => (S.rngSel === 'auto' ? 'auto' : parseInt(S.rngSel, 10));

function buildCommand() {
  if (S.mode === 'ca') return { c: 'ca', e: num('caE'), dur: num('caDur'), sps: num('caSps'), rng: rngCmd(), settle: num('caSettle') };
  if (S.mode === 'cv') return { c: 'cv', es: num('cvEs'), e1: num('cvE1'), e2: num('cvE2'), sr: num('cvSr'), n: num('cvN'), rng: rngCmd() === 'auto' ? 0 : rngCmd() };
  return { c: 'ocp', dur: num('ocpDur'), sps: num('ocpSps') };
}

async function send(obj) {
  log('→ ' + JSON.stringify(obj));
  try { await S.link.send(obj); } catch (e) { log('error al enviar: ' + e.message); }
}

function showErr(msg) { $('#errMsg').textContent = msg; $('#err').hidden = false; }
function clearErr() { $('#err').hidden = true; }

function explain(e, step) {
  const m = `${e.name || 'Error'}: ${e.message || e}`.replace(/\.+$/, '');
  let hint = '';
  if (/not found|no services|no characteristics/i.test(m)) hint = ' Quita "Potenciostato" de los dispositivos Bluetooth del teléfono o del PC, reinicia el ESP32 y vuelve a intentar: el sistema puede guardar una lista de servicios vieja.';
  else if (/GATT|NetworkError|Unknown ATT|disconnected/i.test(m)) hint = ' Acerca el ESP32, reinícialo (botón RST) y vuelve a intentar. Si otro programa o pestaña está conectado, ciérralo.';
  else if (/Sin respuesta/i.test(m)) hint = ' El equipo no contestó; reinicia el ESP32 e inténtalo de nuevo.';
  return `No se pudo conectar (paso: ${step || '?'}). ${m}.${hint}`;
}

async function connect(link) {
  const chip = $('#chip');
  const step = (t) => { chip.textContent = t; chip.className = 'chip run'; };
  clearErr();
  link.onText = onText; link.onData = onData;
  link.onClose = () => { S.link = null; S.running = false; S.bat = null; log('desconectado'); updateButtons(); };
  step('Conectando…');
  try {
    await link.connect(step);
  } catch (e) {
    S.link = null; updateButtons();
    if (e && e.name === 'NotFoundError' && /cancel/i.test(e.message)) { log('selección de dispositivo cancelada'); return; }
    log('no se pudo conectar (' + (link.step || '?') + '): ' + (e.name || '') + ' ' + e.message);
    showErr(explain(e, link.step));
    return;
  }
  // GATT listo: se muestra la conexión de inmediato y luego se activan las notificaciones.
  S.link = link; S.textBuf = '';
  log(link.kind === 'sim' ? 'simulador conectado' : 'BLE conectado');
  updateButtons();
  try {
    await link.begin(step);
    updateButtons();
  } catch (e) {
    log('aviso al iniciar (' + (link.step || '?') + '): ' + (e.name || '') + ' ' + e.message);
    showErr(`Conectado, pero falló el paso "${link.step || '?'}": ${e.name || 'Error'}: ${e.message}. Pulsa Desconectar (Ajustes) y vuelve a conectar.`);
    updateButtons();
  }
}

function toCsv(r) {
  const lines = [];
  lines.push('# Potenciostato - ' + r.mode.toUpperCase() + ' - ' + (r.meta?.date || ''));
  lines.push('# sps=' + r.sps + ' rango=' + (RANGE_NAME[r.rng] ?? '?') + ' params=' + JSON.stringify(r.meta?.params || {}));
  lines.push('# corriente positiva = catodica');
  lines.push('idx,t_s,E_mV,I_nA');
  r.i.forEach((v, k) => lines.push([k, r.t[k].toFixed(4), r.e[k].toFixed(1), v.toFixed(3)].join(',')));
  return lines.join('\n') + '\n';
}

function downloadCsv(r) {
  const url = URL.createObjectURL(new Blob([toCsv(r)], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `potenciostato_${r.mode}_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(url);
}

function wire() {
  $('#errX').onclick = clearErr;
  $('#btnBle').onclick = () => connect(new BleLink());
  $('#btnSim').onclick = () => connect(new SimLink());
  $('#btnDisc').onclick = () => { if (S.link) S.link.disconnect(); };
  $$('.tab').forEach((t) => (t.onclick = () => showMode(t.dataset.mode)));
  $$('.nav button').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
  $$('#filt button').forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; applyFilter(); }));
  $('#btnGo').onclick = () => { if (S.running) send({ c: 'stop' }); else { const c = buildCommand(); S.pending = c; send(c); } };
  $('#btnSimCfg').onclick = () => send({ c: 'sim', glu: num('simGlu'), redox: $('#simRedox').value === '1' ? 1 : 0 });
  $('#btnClear').onclick = () => { if (S.running) return; S.run = { mode: S.mode, sps: S.run.sps, rng: S.run.rng, n: 0, t: [], e: [], i: [], meta: null }; refreshPlot(); refreshStats(); updateButtons(); };
  $('#btnCsv').onclick = () => { if (S.run.i.length) downloadCsv(S.run); };
  $('#btnCsv2').onclick = () => { if (S.run.i.length) downloadCsv(S.run); };
  ['calSlope', 'calInt'].forEach((id) => {
    const el = $('#' + id), saved = load('pot_' + id);
    if (saved !== null) el.value = saved;
    el.addEventListener('input', () => { store('pot_' + id, el.value); refreshStats(); });
  });
  try { S.hist = JSON.parse(load('pot_hist') || '[]'); } catch (e) { S.hist = []; }
  if (!navigator.bluetooth) { $('#btnBle').disabled = true; log('Este navegador no soporta Web Bluetooth: usa Chrome en Android o en el PC. El simulador sí funciona.'); }
  $$('.grid input').forEach((el) => el.addEventListener('input', parSummary));
  buildRange(); renderHist(); applyFilter();
  showMode('ca'); showPage('medir'); refreshPlot(); refreshStats(); updateButtons();
}

wire();
