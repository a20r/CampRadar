(function () {
'use strict';
const D = window.MAPDATA;
const TAU = Math.PI * 2;
const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- projection (Web Mercator, local origin at Toronto) ---------------- */
const lonToX = lon => (lon + 180) / 360;
const latToY = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const X0 = lonToX(-79.39), Y0 = latToY(43.70);
const proj = (lon, lat) => [lonToX(lon) - X0, latToY(lat) - Y0];
const unproj = (x, y) => [(x + X0) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + Y0)))) * 180 / Math.PI];
const M_PER_UNIT = 40075016.686 * Math.cos(43.7 * Math.PI / 180); // ground metres per world unit here
const hav = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
};

/* ---------------- decode packed polylines ---------------- */
function decode(str) {
  const out = []; let i = 0, x = 0, y = 0;
  while (i < str.length) {
    let b, sh = 0, res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << sh; sh += 5; } while (b >= 32);
    y += (res & 1) ? ~(res >> 1) : (res >> 1);
    sh = 0; res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << sh; sh += 5; } while (b >= 32);
    x += (res & 1) ? ~(res >> 1) : (res >> 1);
    out.push(x / 1e5, y / 1e5);
  }
  return out;
}
function toLine(str) {
  const ll = decode(str), n = ll.length / 2, a = new Float32Array(n * 2);
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (let i = 0; i < n; i++) {
    const p = proj(ll[2 * i], ll[2 * i + 1]);
    a[2 * i] = p[0]; a[2 * i + 1] = p[1];
    if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
    if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
  }
  return { a, minx, miny, maxx, maxy };
}
const L = { roads: {}, water: [], rail: [], tram: [], subway: [], boundary: null, places: [], toilets: [] };
for (const k in D.roads) L.roads[k] = D.roads[k].map(toLine);
L.water = D.water.map(rings => rings.map(toLine));
L.rail = D.rail.map(toLine); L.tram = D.tram.map(toLine);
L.subway = D.subway.map(s => Object.assign(toLine(s.p), { name: s.n }));
L.boundary = toLine(D.boundary);
L.places = D.places.map(p => { const q = proj(p[0], p[1]); return { x: q[0], y: q[1], name: p[2].toUpperCase() }; });
L.toilets = D.toilets.map((t, i) => { const q = proj(t.lo, t.la); return Object.assign({ i, x: q[0], y: q[1], dist: NaN, cross: 0 }, t); });
const CN = (() => { const q = proj(-79.3871, 43.6426); return { x: q[0], y: q[1] }; })();
const N_OPEN = L.toilets.filter(t => t.s === 1).length;

/* ---------------- colours ---------------- */
const C = {
  void: '#04060c', water: '#071022', cyan: '#33e6ff', cyan2: '#a9f4ff', cyanDim: '#1a7f95',
  magenta: '#ff2fd6', amber: '#ffa62b', red: '#ff3b5c', mint: '#5dffc0', dim: '#6f9fb3'
};
const FONT_MONO = "'Share Tech Mono', ui-monospace, Menlo, Consolas, monospace";
const FONT_DISP = "'Michroma', system-ui, sans-serif";

/* ---------------- canvas + view ---------------- */
const stage = $('stage'), map = $('map'), fx = $('fx');
const mctx = map.getContext('2d'), fctx = fx.getContext('2d');
let W = 0, H = 0, dpr = 1, dirty = true;
const view = { cx: 0, cy: 0, z: 11 };
const ZMIN = 9.6, ZMAX = 17;
const scale = z => 256 * Math.pow(2, z);
const mpp = () => M_PER_UNIT / scale(view.z); // metres per screen pixel
const toScreen = (x, y) => { const S = scale(view.z); return [(x - view.cx) * S + W / 2, (y - view.cy) * S + H / 2]; };
const toWorld = (sx, sy) => { const S = scale(view.z); return [view.cx + (sx - W / 2) / S, view.cy + (sy - H / 2) / S]; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = t => 1 - Math.pow(1 - t, 3);

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = stage.clientWidth; H = stage.clientHeight;
  for (const c of [map, fx]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  layoutChrome();
  dirty = true;
}
function layoutChrome() {
  const hudH = $('hud').offsetHeight;
  $('chips').style.top = (hudH + 2) + 'px';
  $('legend').style.top = (hudH + 2 + $('chips').offsetHeight + 8) + 'px';
}
function fitBounds(minx, miny, maxx, maxy, pad) {
  // pad: {l,t,r,b} in px. Returns {cx,cy,z}
  const availW = Math.max(40, W - pad.l - pad.r), availH = Math.max(40, H - pad.t - pad.b);
  const dx = Math.max(maxx - minx, 1e-6), dy = Math.max(maxy - miny, 1e-6);
  const S = Math.min(availW / dx, availH / dy);
  const z = clamp(Math.log2(S / 256), ZMIN, 16.2), S2 = scale(z);
  const scx = (pad.l + W - pad.r) / 2, scy = (pad.t + H - pad.b) / 2;
  return { cx: (minx + maxx) / 2 - (scx - W / 2) / S2, cy: (miny + maxy) / 2 - (scy - H / 2) / S2, z };
}
function hudPad() { return $('hud').offsetHeight + $('chips').offsetHeight + 24; }

/* ---------------- base map ---------------- */
function pathLine(c, l) { const a = l.a; c.moveTo(a[0], a[1]); for (let i = 2; i < a.length; i += 2) c.lineTo(a[i], a[i + 1]); }
function lw(base, k, lo, hi) { return clamp(base + (view.z - 11) * k, lo, hi); }

function drawBase() {
  const S = scale(view.z), z = view.z;
  const left = view.cx - W / 2 / S, top = view.cy - H / 2 / S, right = view.cx + W / 2 / S, bottom = view.cy + H / 2 / S;
  const vis = l => !(l.maxx < left || l.minx > right || l.maxy < top || l.miny > bottom);
  const c = mctx, px = 1 / S;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = C.void; c.fillRect(0, 0, W, H);

  // sector grid (1 km at street zoom, 5 km citywide)
  const gm = z >= 14.6 ? 250 : z >= 12.2 ? 1000 : 5000, g = gm / M_PER_UNIT;
  c.strokeStyle = 'rgba(51,230,255,0.055)'; c.lineWidth = 1; c.beginPath();
  for (let x = Math.ceil(left / g) * g; x < right; x += g) { const sx = (x - left) * S; c.moveTo(sx, 0); c.lineTo(sx, H); }
  for (let y = Math.ceil(top / g) * g; y < bottom; y += g) { const sy = (y - top) * S; c.moveTo(0, sy); c.lineTo(W, sy); }
  c.stroke();

  c.setTransform(S * dpr, 0, 0, S * dpr, -left * S * dpr, -top * S * dpr);
  c.lineJoin = 'round'; c.lineCap = 'round';

  // water
  c.beginPath();
  for (const poly of L.water) { if (!vis(poly[0])) continue; for (const ring of poly) { pathLine(c, ring); c.closePath(); } }
  c.fillStyle = C.water; c.fill('evenodd');
  c.lineWidth = 5 * px; c.strokeStyle = 'rgba(51,230,255,0.10)'; c.stroke();
  c.lineWidth = 1 * px; c.strokeStyle = 'rgba(51,230,255,0.42)'; c.stroke();

  // city limits
  c.beginPath(); pathLine(c, L.boundary); c.closePath();
  c.setLineDash([6 * px, 5 * px]); c.lineWidth = 1 * px; c.strokeStyle = 'rgba(255,47,214,0.45)'; c.stroke(); c.setLineDash([]);

  // rail / streetcar
  if (z >= 11.2) {
    c.beginPath(); for (const l of L.rail) if (vis(l)) pathLine(c, l);
    c.setLineDash([3 * px, 3 * px]); c.lineWidth = lw(.7, .25, .6, 1.6) * px; c.strokeStyle = 'rgba(150,170,200,0.28)'; c.stroke(); c.setLineDash([]);
  }
  if (z >= 12.6) {
    c.beginPath(); for (const l of L.tram) if (vis(l)) pathLine(c, l);
    c.lineWidth = lw(.7, .3, .6, 1.8) * px; c.strokeStyle = 'rgba(190,120,255,0.42)'; c.stroke();
  }

  // roads: tertiary → secondary → primary → links → motorway
  const R = L.roads;
  if (z >= 12.4) {
    c.beginPath(); for (const l of R.tr) if (vis(l)) pathLine(c, l);
    c.lineWidth = lw(.7, .3, .6, 2) * px; c.strokeStyle = 'rgba(38,110,140,0.55)'; c.stroke();
  }
  if (z >= 11) {
    c.beginPath(); for (const l of R.sc) if (vis(l)) pathLine(c, l);
    c.lineWidth = lw(1, .4, .8, 2.8) * px; c.strokeStyle = 'rgba(30,150,185,0.75)'; c.stroke();
  }
  { c.beginPath(); for (const l of R.pr) if (vis(l)) pathLine(c, l);
    const w = lw(1.4, .45, 1, 4);
    if (z >= 11.5) { c.lineWidth = w * 3.2 * px; c.strokeStyle = 'rgba(51,230,255,0.14)'; c.stroke(); }
    c.lineWidth = w * px; c.strokeStyle = z >= 11.5 ? 'rgba(51,230,255,0.9)' : 'rgba(51,230,255,0.7)'; c.stroke(); }
  if (z >= 11.8) {
    c.beginPath(); for (const l of R.lk) if (vis(l)) pathLine(c, l);
    c.lineWidth = lw(.9, .3, .8, 2) * px; c.strokeStyle = 'rgba(255,166,43,0.55)'; c.stroke();
  }
  { c.beginPath(); for (const l of R.mw) if (vis(l)) pathLine(c, l);
    const w = lw(2.2, .5, 1.6, 6);
    c.lineWidth = w * 3.4 * px; c.strokeStyle = 'rgba(255,166,43,0.16)'; c.stroke();
    c.lineWidth = w * px; c.strokeStyle = '#ffb347'; c.stroke();
    c.lineWidth = w * .35 * px; c.strokeStyle = '#fff1d6'; c.globalAlpha = .55; c.stroke(); c.globalAlpha = 1; }

  // subway
  { c.beginPath(); for (const l of L.subway) if (vis(l)) pathLine(c, l);
    const w = lw(2.4, .5, 2, 5.5);
    c.lineWidth = w * 3.6 * px; c.strokeStyle = 'rgba(255,47,214,0.22)'; c.stroke();
    c.lineWidth = w * px; c.strokeStyle = C.magenta; c.stroke();
    c.lineWidth = w * .3 * px; c.strokeStyle = '#ffd8f6'; c.globalAlpha = .7; c.stroke(); c.globalAlpha = 1; }

  // ---- screen space: labels, landmark, toilets ----
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (z >= 12.2) drawPlaceLabels(c, left, top, S);

  // CN Tower beacon
  { const [sx, sy] = toScreen(CN.x, CN.y);
    if (sx > -40 && sx < W + 40 && sy > -40 && sy < H + 40) {
      c.strokeStyle = C.cyan2; c.lineWidth = 1; c.beginPath(); c.moveTo(sx, sy - 14); c.lineTo(sx, sy + 4); c.stroke();
      c.fillStyle = C.cyan2; c.beginPath(); c.arc(sx, sy - 14, 2, 0, TAU); c.fill();
      if (z >= 12) { c.font = `9px ${FONT_MONO}`; c.fillStyle = 'rgba(169,244,255,0.75)'; c.textAlign = 'left'; c.fillText('CN TOWER', sx + 6, sy - 10); }
    } }

  // toilets
  const r = lw(2.2, .55, 2.2, 6), glow = r * 2.6;
  for (const t of L.toilets) {
    const sx = (t.x - left) * S, sy = (t.y - top) * S;
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
    const col = toiletColor(t), on = passesFilter(t);
    c.globalAlpha = on ? .22 : .08; c.fillStyle = col; c.beginPath(); c.arc(sx, sy, glow, 0, TAU); c.fill();
    c.globalAlpha = on ? 1 : .35; c.beginPath(); c.arc(sx, sy, r, 0, TAU); c.fill();
    if (on && z >= 12) { c.globalAlpha = .9; c.fillStyle = '#fff'; c.beginPath(); c.arc(sx, sy, r * .35, 0, TAU); c.fill(); }
  }
  c.globalAlpha = 1;
}
function toiletColor(t) { return t.s === 0 ? C.red : t.a === 'public' ? C.mint : t.a === 'unverified' ? C.cyanDim : C.amber; }
function drawPlaceLabels(c, left, top, S) {
  const placed = [];
  c.font = `10px ${FONT_MONO}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  if ('letterSpacing' in c) c.letterSpacing = '2px';
  for (const p of L.places) {
    const sx = (p.x - left) * S, sy = (p.y - top) * S;
    if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
    const w = c.measureText(p.name).width + 8, h = 14;
    const box = { x: sx - w / 2, y: sy - h / 2, w, h };
    if (placed.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
    placed.push(box);
    c.fillStyle = 'rgba(4,6,12,0.55)'; c.fillRect(box.x, box.y, w, h);
    c.fillStyle = 'rgba(111,159,179,0.9)'; c.fillText(p.name, sx, sy + 1);
  }
  if ('letterSpacing' in c) c.letterSpacing = '0px';
  c.textBaseline = 'alphabetic';
}

/* ---------------- filters / ranking ---------------- */
let openOnly = true, publicOnly = false;
function passesFilter(t) { return (!openOnly || t.s === 1) && (!publicOnly || t.a === 'public' || t.a === 'unverified'); }
let user = null;          // {lat, lon, acc, x, y, manual}
let ranked = [];          // filtered toilets sorted by distance
let rankIdx = 0;
let target = null;
function computeRank() {
  if (!user) { ranked = []; return; }
  for (const t of L.toilets) t.dist = hav(user.lat, user.lon, t.la, t.lo);
  ranked = L.toilets.filter(passesFilter).sort((a, b) => a.dist - b.dist);
  if (!ranked.length) ranked = L.toilets.slice().sort((a, b) => a.dist - b.dist);
}

/* ---------------- SFX (synthesised, off by default) ---------------- */
let AC = null, sfxOn = false;
function ac() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); return AC; }
function tone(f0, f1, dur, type, gain) {
  if (!sfxOn) return;
  try {
    const a = ac(), o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch (e) { /* audio unavailable */ }
}
const SFX = {
  ping: () => tone(1500, 500, .3, 'sine', .05),
  tick: () => tone(2400, 2400, .03, 'square', .035),
  hit: () => tone(1900, 1300, .06, 'triangle', .03),
  lock: () => { tone(660, 660, .1, 'square', .04); setTimeout(() => tone(990, 990, .16, 'square', .04), 110); },
  target: () => { tone(330, 880, .4, 'sawtooth', .04); setTimeout(() => tone(1320, 1320, .25, 'sine', .05), 200); },
  ui: () => tone(1200, 1200, .04, 'square', .025),
};

/* ---------------- HUD text ---------------- */
const GLYPHS = 'アイウエオカキクケコサシスセソ0123456789<>/\\|#%&';
const scrambles = new Map();
function scramble(el, text, dur = 420) {
  if (reduceMotion) { el.textContent = text; return; }
  const start = performance.now(); scrambles.set(el, start);
  const step = now => {
    if (scrambles.get(el) !== start) return;
    const p = clamp((now - start) / dur, 0, 1), n = Math.floor(text.length * p);
    let out = text.slice(0, n);
    for (let i = n; i < text.length; i++) out += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    el.textContent = out;
    if (p < 1) requestAnimationFrame(step); else scrambles.delete(el);
  };
  requestAnimationFrame(step);
}
function setStatus(text, led) { scramble($('status'), text); $('led').className = 'led' + (led ? ' ' + led : ''); }
function setCoords(text) { $('coords').textContent = text; }
function fmtCoord(lat, lon) { return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`; }
function updateCoordsIdle() {
  if (user) setCoords(`${fmtCoord(user.lat, user.lon)} · ±${Math.round(user.acc || 0)} M · Z${view.z.toFixed(1)}`);
  else { const [lon, lat] = unproj(view.cx, view.cy); setCoords(`${fmtCoord(lat, lon)} · Z${view.z.toFixed(1)}`); }
}
function fmtDist(m) { return m < 950 ? `${Math.round(m)} M` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} KM`; }
function fmtWalk(m) { const min = Math.round(m / 81); return min < 1 ? '< 1 MIN WALK' : min < 60 ? `~${min} MIN WALK` : `~${(min / 60).toFixed(1)} H WALK`; }
setInterval(() => { const d = new Date(); $('clock').textContent = d.toLocaleTimeString('en-CA', { hour12: false, timeZone: 'America/Toronto' }); }, 1000);

/* ---------------- sequence state machine ---------------- */
const seq = { phase: 'idle', t0: 0, fix: null, err: null, fly: null, flashT: -1e9, glitchT: -1e9, tick: -1, sweepR: 0, sweepDur: 0, sweepMax: 0, hits: 0, lastHit: 0, cands: [], satPts: [], fixScreen: null };
const now = () => performance.now();
function setPhase(p) { seq.phase = p; seq.t0 = now(); }
function busy() { return seq.phase !== 'idle' && seq.phase !== 'done'; }
function flash(strength) { seq.flashT = now(); seq.flashStrength = strength || .35; if (!reduceMotion) { $('title').classList.remove('glitch'); void $('title').offsetWidth; $('title').classList.add('glitch'); } }

function startFind() {
  if (busy()) return;
  hideCard();
  seq.fix = null; seq.err = null; seq.hits = 0; seq.cands = [];
  for (const t of L.toilets) t.cross = 0;
  document.getElementById('app').classList.add('busy');
  stage.classList.remove('pin'); pinMode = false; $('chipPin').classList.remove('on');
  $('overlay').classList.add('show'); $('overlay').classList.remove('actions');
  $('ovTitle').textContent = 'ACQUIRING POSITION'; $('ovJp').textContent = '位置特定中'; $('ovSkip').hidden = false; $('ovSkip').textContent = 'TAP ANYWHERE TO ABORT';
  seq.satPts = [[W * .12, H * .2], [W * .9, H * .28], [W * .5, H * .78]];
  setStatus('ACQUIRING POSITION', 'busy'); SFX.ping();
  setPhase('acquire');
  if (!navigator.geolocation) { seq.err = { code: 0, message: 'no geolocation API' }; return; }
  const token = seq.t0;
  try {
    navigator.geolocation.getCurrentPosition(
      pos => { if (seq.phase !== 'acquire' || token !== seq.t0) return; seq.fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 0 }; },
      err => { if (seq.phase !== 'acquire' || token !== seq.t0) return; seq.err = err; },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
  } catch (e) { seq.err = e; }
  setTimeout(() => { if (seq.phase === 'acquire' && token === seq.t0 && !seq.fix && !seq.err) seq.err = { code: 3, message: 'timeout' }; }, 14000);
}
function setUser(lat, lon, acc, manual) {
  const q = proj(lon, lat);
  user = { lat, lon, acc: acc || 0, x: q[0], y: q[1], manual: !!manual };
  computeRank(); rankIdx = 0; target = ranked[0] || null;
}
function beginFly() {
  // called once a position is known: fly to the user, sized so the sweep to the nearest unit fits on screen
  const t = ranked[0];
  const dist = t ? t.dist : 500;
  seq.sweepMax = Math.max(dist * 1.18, 140);
  const availR = Math.max(60, Math.min(W, H - hudPad() - 120) / 2 - 24);
  const zNeeded = Math.log2((availR * M_PER_UNIT / seq.sweepMax) / 256);
  const z = clamp(zNeeded, 10.5, 15.6);
  const scy = (hudPad() + (H - 100)) / 2, S = scale(z);
  seq.fly = { from: { ...view }, to: { cx: user.x, cy: user.y - (scy - H / 2) / S, z }, dur: reduceMotion ? 500 : 1500 };
  seq.tick = -1;
  $('overlay').classList.remove('actions'); $('ovSkip').hidden = false; $('ovSkip').textContent = 'TAP ANYWHERE TO SKIP';
  $('ovTitle').textContent = 'SIGNAL ACQUIRED'; $('ovJp').textContent = '信号取得';
  setStatus(`FIX ±${Math.round(user.acc)} M · ENHANCING`, 'busy');
  flash(.5);
  setPhase('fly');
}
function signalLost() {
  setPhase('lost');
  $('overlay').classList.add('actions');
  $('ovTitle').textContent = 'NO SIGNAL'; $('ovJp').textContent = '信号なし'; $('ovLines').textContent = '';
  const m = (seq.err && seq.err.code === 1) ? 'Location permission was denied. Set your position by hand, or run a simulated fix to see the search.'
    : 'Location is unavailable here (hosted previews block it). Set your position by hand, or run a simulated fix.';
  $('ovErr').textContent = m;
  setStatus('SIGNAL LOST', 'busy');
}
function abort() {
  setPhase('idle'); $('overlay').classList.remove('show', 'actions'); $('app').classList.remove('busy');
  setStatus(user ? 'GRID ONLINE · POSITION HELD' : `GRID ONLINE · ${L.toilets.length} UNITS · ${N_OPEN} OPEN`); updateCoordsIdle();
}
function finishNow() {
  // skip straight to the result
  if (!user) return abort();
  if (!target) { computeRank(); target = ranked[0]; }
  Object.assign(view, finalView()); dirty = true;
  setPhase('done'); $('overlay').classList.remove('show', 'actions'); $('app').classList.remove('busy');
  showCard(); SFX.target();
}
function finalView() {
  fillCard(true);
  const cardH = $('card').offsetHeight || 260;
  const pad = { l: 44, r: 44, t: hudPad() + 20, b: cardH + 40 };
  const pts = target ? [user, target] : [user, user];
  const b = fitBounds(Math.min(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y), Math.max(pts[0].x, pts[1].x), Math.max(pts[0].y, pts[1].y), pad);
  b.z = Math.min(b.z, 15.5); return b;
}
function retarget(idx, animate) {
  rankIdx = idx; target = ranked[rankIdx] || null;
  if (!target) return;
  if (animate && !reduceMotion) {
    for (const t of L.toilets) t.cross = 0;
    seq.fly = { from: { ...view }, to: finalView(), dur: 700 };
    setPhase('target'); seq.mini = true; SFX.target();
  } else { Object.assign(view, finalView()); dirty = true; }
  fillCard();
}

function updateSeq(t) {
  const el = t - seq.t0;
  switch (seq.phase) {
    case 'acquire': {
      updateAcquireLines(el);
      const minWait = reduceMotion ? 400 : 1900;
      if (seq.fix && el > minWait) { setUser(seq.fix.lat, seq.fix.lon, seq.fix.acc, false); seq.fixScreen = toScreen(user.x, user.y); beginFly(); }
      else if (seq.err && el > 1400) signalLost();
      else if (!reduceMotion && Math.floor(el / 700) !== Math.floor((el - 16) / 700)) SFX.ping();
      break; }
    case 'fly': {
      const f = seq.fly, p = clamp(el / f.dur, 0, 1), e = easeInOut(p);
      view.cx = lerp(f.from.cx, f.to.cx, e); view.cy = lerp(f.from.cy, f.to.cy, e); view.z = lerp(f.from.z, f.to.z, e); dirty = true;
      const tick = Math.floor(p * 5);
      if (tick !== seq.tick && p < 1) { seq.tick = tick; flash(.28); seq.glitchT = t; SFX.tick(); $('ovLines').textContent = `ENHANCE  ×${Math.pow(2, tick + 1)}\nZOOM     ${view.z.toFixed(2)}\nFIX      ±${Math.round(user.acc)} M`; }
      if (p >= 1) { setPhase('lock'); setStatus('POSITION LOCKED', 'lock'); $('ovTitle').textContent = 'POSITION LOCKED'; $('ovJp').textContent = '位置固定'; $('ovLines').textContent = `LAT  ${user.lat.toFixed(5)}\nLON  ${user.lon.toFixed(5)}\nACC  ±${Math.round(user.acc)} M`; SFX.lock(); }
      break; }
    case 'lock': {
      if (el > (reduceMotion ? 250 : 900)) {
        seq.sweepDur = reduceMotion ? 600 : clamp(1500 + seq.sweepMax / 1.4, 1700, 3400);
        setPhase('sweep'); setStatus('SCANNING SECTOR', 'busy'); $('ovTitle').textContent = 'SCANNING SECTOR'; $('ovJp').textContent = '周辺走査中';
        seq.cands = ranked.slice(0, 4);
      }
      break; }
    case 'sweep': {
      const p = clamp(el / seq.sweepDur, 0, 1); seq.sweepR = seq.sweepMax * easeOut(p);
      let n = 0;
      for (const t2 of L.toilets) { if (t2.cross) { n++; continue; } if (t2.dist <= seq.sweepR) { t2.cross = t; n++; if (t - seq.lastHit > 70) { seq.lastHit = t; SFX.hit(); } } }
      $('ovLines').textContent = `RADIUS   ${fmtDist(seq.sweepR)}\nCONTACTS ${String(n).padStart(3, '0')}\nFILTER   ${openOnly ? 'OPEN' : 'ALL'}${publicOnly ? ' · PUBLIC' : ''}`;
      if (p >= 1) { seq.fly = { from: { ...view }, to: finalView(), dur: reduceMotion ? 300 : 950 }; seq.mini = false; setPhase('target'); SFX.target();
        setStatus('TARGET ACQUIRED', 'lock'); $('ovTitle').textContent = 'TARGET ACQUIRED'; $('ovJp').textContent = '目標捕捉'; $('ovLines').textContent = target ? `UNIT     ${target.n.toUpperCase().slice(0, 28)}\nRANGE    ${fmtDist(target.dist)}\nETA      ${fmtWalk(target.dist)}` : ''; }
      break; }
    case 'target': {
      const f = seq.fly, p = clamp(el / f.dur, 0, 1), e = easeInOut(p);
      view.cx = lerp(f.from.cx, f.to.cx, e); view.cy = lerp(f.from.cy, f.to.cy, e); view.z = lerp(f.from.z, f.to.z, e); dirty = true;
      if (p >= 1) { setPhase('done'); if (!seq.mini) { $('overlay').classList.remove('show'); $('app').classList.remove('busy'); showCard(); } }
      break; }
  }
}
function updateAcquireLines(el) {
  const p = Math.min(1, el / 1900);
  const bar = k => { const n = Math.round(clamp((p - k) / .35, 0, 1) * 8); return '▮'.repeat(n) + '░'.repeat(8 - n); };
  const rnd = n => String(Math.floor(Math.random() * Math.pow(10, n))).padStart(n, '0');
  const c = seq.fix ? `${seq.fix.lat.toFixed(4)}° N · ${Math.abs(seq.fix.lon).toFixed(4)}° W` : `43.${rnd(4)}° N · 79.${rnd(4)}° W`;
  $('ovLines').textContent = `UPLINK 01  ${bar(0)}\nUPLINK 02  ${bar(.18)}\nUPLINK 03  ${bar(.36)}\nTRIANG.    ${c}`;
}

/* ---------------- FX layer ---------------- */
const drops = [];
function seedRain() { drops.length = 0; const n = reduceMotion ? 0 : Math.round(Math.min(160, W * H / 3800)); for (let i = 0; i < n; i++) drops.push({ x: Math.random() * W, y: Math.random() * H, l: 10 + Math.random() * 22, s: 520 + Math.random() * 560, a: .05 + Math.random() * .18 }); }
function drawRain(dt) {
  if (!drops.length) return;
  const c = fctx; c.lineWidth = 1;
  for (let k = 0; k < 3; k++) {
    c.strokeStyle = `rgba(170,225,255,${(k + 1) * .07})`; c.beginPath();
    for (let i = k; i < drops.length; i += 3) { const d = drops[i]; d.y += d.s * dt; d.x -= d.s * .16 * dt; if (d.y > H + 30) { d.y = -30; d.x = Math.random() * (W + 80); } if (d.x < -30) d.x = W + 20; c.moveTo(d.x, d.y); c.lineTo(d.x + d.l * .16, d.y - d.l); }
    c.stroke();
  }
}
function bracket(c, x, y, half, len, col, width) {
  c.strokeStyle = col; c.lineWidth = width || 1.5; c.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    c.moveTo(x + sx * half, y + sy * (half - len)); c.lineTo(x + sx * half, y + sy * half); c.lineTo(x + sx * (half - len), y + sy * half);
  }
  c.stroke();
}
function drawFX(t, dt) {
  const c = fctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const ph = seq.phase, el = t - seq.t0;

  // glitch slices (enhance ticks)
  if (t - seq.glitchT < 130 && !reduceMotion) {
    for (let i = 0; i < 5; i++) { const y = Math.random() * H, h = 4 + Math.random() * 22, dx = (Math.random() - .5) * 40; c.drawImage(map, 0, y * dpr, map.width, h * dpr, dx, y, W, h); }
    c.globalAlpha = .35; c.drawImage(map, 0, 0, map.width, map.height, 3, 0, W, H); c.globalAlpha = 1;
  }

  if (ph === 'acquire' || ph === 'lost') {
    c.fillStyle = 'rgba(4,6,12,0.5)'; c.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H * .46, R = Math.hypot(W, H) * .55;
    // rings
    for (let i = 0; i < 4; i++) { const p = ((t / 1600) + i / 4) % 1; c.strokeStyle = `rgba(51,230,255,${(1 - p) * .35})`; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, p * R, 0, TAU); c.stroke(); }
    // sweep wedge
    const ang = (t / 1400) * TAU;
    let grad = null; try { grad = c.createConicGradient(ang - TAU * .28, cx, cy); } catch (e) { grad = null; }
    if (grad) { grad.addColorStop(0, 'rgba(51,230,255,0)'); grad.addColorStop(.28, 'rgba(51,230,255,0.28)'); grad.addColorStop(.281, 'rgba(51,230,255,0)'); grad.addColorStop(1, 'rgba(51,230,255,0)'); c.fillStyle = grad; c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fill(); }
    c.strokeStyle = 'rgba(169,244,255,0.9)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R); c.stroke();
    // crosshair
    c.strokeStyle = 'rgba(51,230,255,0.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(cx - 24, cy); c.lineTo(cx + 24, cy); c.moveTo(cx, cy - 24); c.lineTo(cx, cy + 24); c.stroke();
    // contacts: toilets the sweep passes over blink
    const S = scale(view.z);
    for (let i = 0; i < L.toilets.length; i += 2) { const tt = L.toilets[i]; const sx = (tt.x - view.cx) * S + W / 2, sy = (tt.y - view.cy) * S + H / 2; if (sx < 0 || sx > W || sy < 0 || sy > H) continue; const a = Math.atan2(sy - cy, sx - cx); let d = (ang - a) % TAU; if (d < 0) d += TAU; if (d < 1.2) { c.fillStyle = `rgba(93,255,192,${(1 - d / 1.2) * .9})`; c.fillRect(sx - 1.5, sy - 1.5, 3, 3); } }
    // uplink nodes
    seq.satPts.forEach((p, i) => { const pp = ((t / 1300) + i / 3) % 1; c.strokeStyle = `rgba(255,47,214,${(1 - pp) * .6})`; c.lineWidth = 1; c.beginPath(); c.arc(p[0], p[1], 6 + pp * 60, 0, TAU); c.stroke(); c.fillStyle = C.magenta; c.beginPath(); c.moveTo(p[0], p[1] - 6); c.lineTo(p[0] + 5, p[1] + 4); c.lineTo(p[0] - 5, p[1] + 4); c.closePath(); c.fill(); c.font = `9px ${FONT_MONO}`; c.fillStyle = 'rgba(255,208,245,0.8)'; c.textAlign = 'left'; c.fillText(`SAT-0${i + 1}`, p[0] + 10, p[1] + 3); });
    if (seq.fix) { // triangulation lines converge on the fix
      const q = proj(seq.fix.lon, seq.fix.lat), [ux, uy] = toScreen(q[0], q[1]);
      c.strokeStyle = 'rgba(255,47,214,0.7)'; c.setLineDash([4, 4]); c.lineDashOffset = -t / 20; c.lineWidth = 1; c.beginPath(); for (const p of seq.satPts) { c.moveTo(p[0], p[1]); c.lineTo(clamp(ux, -50, W + 50), clamp(uy, -50, H + 50)); } c.stroke(); c.setLineDash([]);
    }
  }

  drawRain(dt);

  // user beacon
  if (user && ph !== 'acquire' && ph !== 'lost') {
    const [ux, uy] = toScreen(user.x, user.y);
    if (user.acc > 0) { const ar = user.acc / mpp(); if (ar > 10) { c.fillStyle = 'rgba(51,230,255,0.07)'; c.strokeStyle = 'rgba(51,230,255,0.3)'; c.lineWidth = 1; c.beginPath(); c.arc(ux, uy, ar, 0, TAU); c.fill(); c.stroke(); } }
    for (let i = 0; i < 3; i++) { const p = ((t / 2200) + i / 3) % 1; c.strokeStyle = `rgba(51,230,255,${(1 - p) * .55})`; c.lineWidth = 1.5; c.beginPath(); c.arc(ux, uy, 6 + p * 44, 0, TAU); c.stroke(); }
    c.fillStyle = 'rgba(51,230,255,0.35)'; c.beginPath(); c.arc(ux, uy, 11, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(ux, uy, 4.5, 0, TAU); c.fill();
    c.strokeStyle = C.cyan; c.lineWidth = 1; c.beginPath(); c.moveTo(ux - 18, uy); c.lineTo(ux - 8, uy); c.moveTo(ux + 8, uy); c.lineTo(ux + 18, uy); c.moveTo(ux, uy - 18); c.lineTo(ux, uy - 8); c.moveTo(ux, uy + 8); c.lineTo(ux, uy + 18); c.stroke();
    c.font = `9px ${FONT_MONO}`; c.fillStyle = 'rgba(169,244,255,0.85)'; c.textAlign = 'left'; c.fillText(user.manual ? 'PIN' : 'YOU', ux + 14, uy - 12);

    if (ph === 'fly') { // enhance brackets converge on the user
      const p = clamp(el / seq.fly.dur, 0, 1), half = lerp(Math.min(W, H) * .48, 26, easeInOut(p));
      bracket(c, ux, uy, half, Math.max(8, half * .22), 'rgba(169,244,255,0.9)', 1.5);
      c.font = `10px ${FONT_MONO}`; c.fillStyle = C.cyan2; c.textAlign = 'left'; c.fillText(`ENHANCE ×${Math.pow(2, Math.max(0, seq.tick) + 1)}`, ux + half + 6, uy - half + 10);
    }
    if (ph === 'lock') {
      const p = clamp(el / 900, 0, 1);
      bracket(c, ux, uy, 26, 8, C.cyan2, 1.5);
      c.strokeStyle = `rgba(169,244,255,${1 - p})`; c.lineWidth = 2; c.beginPath(); c.arc(ux, uy, 26 + p * 140, 0, TAU); c.stroke();
      c.strokeStyle = `rgba(255,47,214,${(1 - p) * .8})`; c.lineWidth = 1; c.beginPath(); c.arc(ux, uy, 26 + p * 70, 0, TAU); c.stroke();
    }
    if (ph === 'sweep' || (ph === 'target' && !seq.mini)) {
      const r = seq.sweepR / mpp();
      if (ph === 'sweep') {
        const g = c.createRadialGradient(ux, uy, Math.max(0, r - 70), ux, uy, r);
        g.addColorStop(0, 'rgba(51,230,255,0)'); g.addColorStop(1, 'rgba(51,230,255,0.16)');
        c.fillStyle = g; c.beginPath(); c.arc(ux, uy, r, 0, TAU); c.fill();
        c.strokeStyle = 'rgba(169,244,255,0.9)'; c.lineWidth = 2; c.beginPath(); c.arc(ux, uy, r, 0, TAU); c.stroke();
        c.strokeStyle = 'rgba(51,230,255,0.25)'; c.lineWidth = 12; c.stroke();
      }
      // blips on crossed units
      for (const tt of L.toilets) {
        if (!tt.cross) continue; const age = (t - tt.cross) / 900; if (age > 1 && !seq.cands.includes(tt)) continue;
        const [sx, sy] = toScreen(tt.x, tt.y); if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue;
        const a = Math.max(0, 1 - age);
        c.strokeStyle = `rgba(93,255,192,${a})`; c.lineWidth = 1.5; c.beginPath(); c.arc(sx, sy, 4 + age * 22, 0, TAU); c.stroke();
      }
      // candidate tracers + labels
      seq.cands.forEach((tt, i) => {
        if (!tt.cross) return; const [sx, sy] = toScreen(tt.x, tt.y), age = clamp((t - tt.cross) / 500, 0, 1);
        const col = i === 0 ? C.magenta : 'rgba(93,255,192,0.8)';
        c.strokeStyle = col; c.lineWidth = i === 0 ? 1.5 : 1; c.setLineDash([3, 5]); c.lineDashOffset = -t / 15; c.beginPath(); c.moveTo(ux, uy); c.lineTo(lerp(ux, sx, age), lerp(uy, sy, age)); c.stroke(); c.setLineDash([]);
        if (age >= 1) { c.font = `10px ${FONT_MONO}`; c.textAlign = 'left'; const lab = `${String(i + 1).padStart(2, '0')} · ${fmtDist(tt.dist)}`; const w = c.measureText(lab).width + 8; c.fillStyle = 'rgba(4,6,12,0.8)'; c.fillRect(sx + 8, sy - 18, w, 14); c.fillStyle = i === 0 ? '#ffd0f5' : C.mint; c.fillText(lab, sx + 12, sy - 7); }
      });
    }
  }

  // target reticle
  if (target && user && (ph === 'target' || ph === 'done')) {
    const [tx, ty] = toScreen(target.x, target.y), [ux, uy] = toScreen(user.x, user.y);
    const p = ph === 'target' ? clamp(el / seq.fly.dur, 0, 1) : 1;
    c.strokeStyle = 'rgba(255,47,214,0.85)'; c.lineWidth = 1.5; c.setLineDash([6, 6]); c.lineDashOffset = -t / 12; c.beginPath(); c.moveTo(ux, uy); c.lineTo(lerp(ux, tx, p), lerp(uy, ty, p)); c.stroke(); c.setLineDash([]);
    if (p > .6) {
      const q = (p - .6) / .4, size = lerp(90, 18, easeOut(q)), rot = t / 1800;
      c.strokeStyle = C.magenta; c.lineWidth = 1.5;
      for (const [s, dir] of [[size, 1], [size * .72, -1]]) { c.save(); c.translate(tx, ty); c.rotate(rot * dir + Math.PI / 4); c.strokeRect(-s / 2, -s / 2, s, s); c.restore(); }
      c.fillStyle = 'rgba(255,47,214,0.25)'; c.beginPath(); c.arc(tx, ty, 10, 0, TAU); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(tx, ty, 3, 0, TAU); c.fill();
      if (q >= 1) { c.font = `10px ${FONT_MONO}`; c.textAlign = 'center'; const lab = 'TARGET ' + fmtDist(target.dist); const w = c.measureText(lab).width + 10; c.fillStyle = 'rgba(4,6,12,0.85)'; c.fillRect(tx - w / 2, ty - 34, w, 15); c.fillStyle = '#ffd0f5'; c.fillText(lab, tx, ty - 23); }
    }
  }

  // full-screen flash
  const fa = 1 - (t - seq.flashT) / 200;
  if (fa > 0) { $('flash').style.opacity = (fa * (seq.flashStrength || .35)).toFixed(3); } else if ($('flash').style.opacity !== '0') $('flash').style.opacity = '0';
}

/* ---------------- card ---------------- */
function showCard() { fillCard(); $('card').classList.add('show'); $('app').classList.add('card-open'); }
function hideCard() { $('card').classList.remove('show'); $('app').classList.remove('card-open'); }
function fillCard(quiet) {
  if (!target) return;
  const t = target, has = user && !isNaN(t.dist);
  const far = has && t.dist > 25000;
  $('eyebrow').textContent = far ? 'OUTSIDE THE GRID · NEAREST INDEXED UNIT' : user ? `${t === ranked[rankIdx] ? 'NEAREST UNIT' : 'SELECTED UNIT'} · ${String(rankIdx + 1).padStart(2, '0')} / ${ranked.length}` : 'SELECTED UNIT';
  const pill = $('pill'), st = t.s === 0 ? 'closed' : t.a === 'public' ? 'open' : t.a === 'unverified' ? 'unverified' : 'restricted';
  pill.className = 'pill ' + st; pill.textContent = st === 'restricted' ? (t.a === 'customers' ? 'CUSTOMERS ONLY' : 'PERMISSIVE') : st === 'unverified' ? 'OPEN · UNVERIFIED' : st;
  $('cName').textContent = t.n.replace(/ \((customers only|permissive access)\)$/i, '');
  $('cDist').textContent = has ? fmtDist(t.dist) : '— M';
  $('cWalk').textContent = has ? fmtWalk(t.dist) : 'SET A POSITION FOR RANGE';
  const rows = [];
  if (t.s === 0) rows.push(['STATUS', `<span class="warn">CLOSED${t.r ? ' · ' + esc(t.r) : ''}</span>`]);
  else if (t.r) rows.push(['STATUS', `<span class="warn">${esc(t.r)}</span>`]);
  if (t.h) rows.push(['HOURS', esc(t.h)]);
  rows.push(['ACCESS', esc({ public: 'Public', customers: 'Customers only', permissive: 'Permissive', unverified: 'Unverified (OSM)' }[t.a] || t.a) + (t.f === 'yes' ? ' · fee' : t.f === 'no' ? ' · free' : '')]);
  if (t.ad) rows.push(['ADDRESS', esc(t.ad)]);
  if (t.d) rows.push(['WHERE', esc(t.d)]);
  if (t.w && t.w !== 'None') rows.push(['ACCESSIBLE', esc(t.w)]);
  if (t.t) rows.push(['TYPE', esc(t.t)]);
  $('cRows').innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  $('btnNav').href = `https://www.google.com/maps/dir/?api=1&destination=${t.la},${t.lo}&travelmode=walking`;
  $('cSrc').textContent = (t.src === 'city' ? 'CITY OF TORONTO PARKS & REC' : 'OPENSTREETMAP') + ` · ${t.la.toFixed(5)}, ${t.lo.toFixed(5)}`;
  const link = $('cLink'); if (t.u) { link.href = t.u; link.hidden = false; } else link.hidden = true;
  $('btnNext').hidden = !(user && ranked.length > 1);
  if (user && has && !quiet) setStatus(far ? `OUTSIDE THE GRID · NEAREST ${fmtDist(t.dist)}` : `ROUTE READY · ${fmtDist(t.dist)} · ${fmtWalk(t.dist)}`, 'lock');
  updateCoordsIdle();
}
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* ---------------- gestures ---------------- */
let pinMode = false;
const pointers = new Map();
let pan = null, pinch = null, lastTap = 0, downInfo = null;
const rel = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
stage.addEventListener('pointerdown', e => {
  stage.setPointerCapture(e.pointerId);
  const q = rel(e); pointers.set(e.pointerId, q);
  downInfo = { x: q.x, y: q.y, t: now(), moved: false };
  if (pointers.size === 1) { pan = { sx: q.x, sy: q.y, cx: view.cx, cy: view.cy }; pinch = null; stage.classList.add('pan'); }
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2]; pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: view.z, w0: toWorld(mid[0], mid[1]) }; pan = null; }
});
stage.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const q = rel(e); pointers.set(e.pointerId, q);
  if (downInfo && Math.hypot(q.x - downInfo.x, q.y - downInfo.y) > 8) downInfo.moved = true;
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()]; const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    view.z = clamp(pinch.z0 + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0), ZMIN, ZMAX);
    const S = scale(view.z); view.cx = pinch.w0[0] - (mid[0] - W / 2) / S; view.cy = pinch.w0[1] - (mid[1] - H / 2) / S; dirty = true; onViewChange();
  } else if (pan && pointers.size === 1) {
    const S = scale(view.z); view.cx = pan.cx - (q.x - pan.sx) / S; view.cy = pan.cy - (q.y - pan.sy) / S; dirty = true; onViewChange();
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 1) { const [p] = [...pointers.values()]; pan = { sx: p.x, sy: p.y, cx: view.cx, cy: view.cy }; pinch = null; }
  else if (pointers.size === 0) {
    stage.classList.remove('pan'); pan = null; pinch = null;
    if (downInfo && !downInfo.moved && now() - downInfo.t < 400 && e.type === 'pointerup') { const dbl = now() - lastTap < 320; lastTap = dbl ? 0 : now(); const q = rel(e); onTap(q.x, q.y, dbl); }
    downInfo = null;
  }
}
stage.addEventListener('pointerup', endPointer); stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', e => { e.preventDefault(); const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; const w = toWorld(mx, my); view.z = clamp(view.z - e.deltaY * 0.0022, ZMIN, ZMAX); const S = scale(view.z); view.cx = w[0] - (mx - W / 2) / S; view.cy = w[1] - (my - H / 2) / S; dirty = true; onViewChange(); }, { passive: false });
function onViewChange() { if (!busy()) updateCoordsIdle(); }
function onTap(sx, sy, dbl) {
  if (busy()) { if (seq.phase === 'lost') return; if (seq.phase === 'acquire' && !seq.fix) { abort(); return; } finishNow(); return; }
  if (pinMode) { const [lon, lat] = unproj(...toWorld(sx, sy)); pinMode = false; stage.classList.remove('pin'); $('chipPin').classList.remove('on'); $('chipPin').setAttribute('aria-pressed', 'false'); runWithPosition(lat, lon, 0, true); return; }
  if (dbl) { const w = toWorld(sx, sy); view.z = clamp(view.z + 1, ZMIN, ZMAX); const S = scale(view.z); view.cx = w[0] - (sx - W / 2) / S; view.cy = w[1] - (sy - H / 2) / S; dirty = true; onViewChange(); return; }
  // hit test toilets
  let best = null, bd = 22;
  for (const t of L.toilets) { const [x, y] = toScreen(t.x, t.y); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = t; } }
  if (best) { target = best; if (user) { const i = ranked.indexOf(best); rankIdx = i >= 0 ? i : rankIdx; } showCard(); SFX.ui(); }
  else if ($('card').classList.contains('show')) hideCard();
}
function runWithPosition(lat, lon, acc, manual) {
  hideCard(); for (const t of L.toilets) t.cross = 0;
  setUser(lat, lon, acc, manual);
  $('app').classList.add('busy'); $('overlay').classList.add('show'); $('overlay').classList.remove('actions');
  seq.satPts = [[W * .12, H * .2], [W * .9, H * .28], [W * .5, H * .78]];
  beginFly();
}

/* ---------------- controls ---------------- */
$('fab').addEventListener('click', () => { SFX.ui(); startFind(); });
$('btnClose').addEventListener('click', () => { hideCard(); SFX.ui(); });
$('btnNext').addEventListener('click', () => { if (!ranked.length) return; retarget((rankIdx + 1) % Math.min(ranked.length, 12), true); });
$('btnAbort').addEventListener('click', abort);
$('btnPinMode').addEventListener('click', () => { abort(); pinMode = true; stage.classList.add('pin'); $('chipPin').classList.add('on'); $('chipPin').setAttribute('aria-pressed', 'true'); setStatus('TAP THE MAP TO SET POSITION', 'busy'); });
$('btnSim').addEventListener('click', () => { abort(); const lat = 43.628 + Math.random() * .1, lon = -79.50 + Math.random() * .2; runWithPosition(lat, lon, 25 + Math.random() * 40, true); });
function toggleChip(id, fn) { $(id).addEventListener('click', () => { if (busy() && seq.phase !== 'lost') return; const on = !$(id).classList.contains('on'); $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', String(on)); fn(on); SFX.ui(); }); }
toggleChip('chipOpen', on => { openOnly = on; refilter(); });
toggleChip('chipPublic', on => { publicOnly = on; refilter(); });
toggleChip('chipPin', on => { pinMode = on; stage.classList.toggle('pin', on); if (on) { hideCard(); setStatus('TAP THE MAP TO SET POSITION', 'busy'); } else abort(); });
toggleChip('chipSfx', on => { sfxOn = on; if (on) { ac(); SFX.lock(); } });
function refilter() { dirty = true; if (user && !busy()) { computeRank(); retarget(0, $('card').classList.contains('show')); } }
$('overlay').addEventListener('click', e => { if (e.target === $('overlay') && busy() && seq.phase !== 'lost') finishNow(); });
window.addEventListener('resize', () => { resize(); seedRain(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { dirty = true; layoutChrome(); });

/* ---------------- boot ---------------- */
resize(); seedRain();
{ // fit the whole city, leaving room for the HUD and the button
  const b = L.boundary, pad = { l: 10, r: 10, t: hudPad() + 30, b: 120 };
  Object.assign(view, fitBounds(b.minx, b.miny, b.maxx, b.maxy, pad));
}
scramble($('status'), `GRID ONLINE · ${L.toilets.length} UNITS · ${N_OPEN} OPEN`, 900);
updateCoordsIdle();
let last = now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, (t - last) / 1000); last = t;
  updateSeq(t);
  if (dirty) { drawBase(); dirty = false; }
  drawFX(t, dt);
}
requestAnimationFrame(frame);
})();
