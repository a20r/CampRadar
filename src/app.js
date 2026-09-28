(function () {
'use strict';
const TAU = Math.PI * 2;
const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const Parse = window.LooParse;

/* ---------------- projection (Web Mercator, world units 0..1) ---------------- */
const lonToX = lon => (lon + 180) / 360;
const latToY = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const proj = (lon, lat) => [lonToX(lon), latToY(lat)];
const unproj = (x, y) => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
const mpuAt = lat => 40075016.686 * Math.cos(lat * Math.PI / 180); // ground metres per world unit at this latitude
const hav = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
};

/* ---------------- dataset state ---------------- */
let DS = null;   // {name, format, points, fields, bbox, nOpen, notes, sample, saved}
let U = [];      // units on the map: points plus x, y, dist, cross
let center = { lat: 43.7, lon: -79.39 };

/* ---------------- colours ---------------- */
const C = {
  void: '#04060c', cyan: '#33e6ff', cyan2: '#a9f4ff', cyanDim: '#1a7f95',
  magenta: '#ff2fd6', amber: '#ffa62b', red: '#ff3b5c', mint: '#5dffc0', dim: '#6f9fb3'
};
const FONT_MONO = "'Share Tech Mono', ui-monospace, Menlo, Consolas, monospace";

/* ---------------- canvas + view ---------------- */
const stage = $('stage'), map = $('map'), fx = $('fx');
const mctx = map.getContext('2d'), fctx = fx.getContext('2d');
let W = 0, H = 0, dpr = 1, dirty = true;
const view = { cx: 0.5, cy: 0.5, z: 11 };
const ZMIN = 2.5, ZMAX = 19;
const scale = z => 256 * Math.pow(2, z);
const mpu = () => mpuAt(unproj(view.cx, view.cy)[1]);
const mpp = () => mpu() / scale(view.z); // metres per screen pixel
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
  const dx = Math.max(maxx - minx, 1e-9), dy = Math.max(maxy - miny, 1e-9);
  const S = Math.min(availW / dx, availH / dy);
  const z = clamp(Math.log2(S / 256), ZMIN, 16.2), S2 = scale(z);
  const scx = (pad.l + W - pad.r) / 2, scy = (pad.t + H - pad.b) / 2;
  return { cx: (minx + maxx) / 2 - (scx - W / 2) / S2, cy: (miny + maxy) / 2 - (scy - H / 2) / S2, z };
}
function hudPad() { return $('hud').offsetHeight + $('chips').offsetHeight + 24; }

/* ---------------- raster tiles (Esri dark gray canvas, tinted) ---------------- */
const TILE_MAX = 16;
const tiles = new Map();
let tileGen = 0;
const tileKey = (z, x, y) => z + '/' + x + '/' + y;
const tileURL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
function getTile(z, x, y) {
  const k = tileKey(z, x, y);
  let t = tiles.get(k);
  if (t) { t.used = tileGen; return t; }
  t = { img: new Image(), ok: false, used: tileGen };
  t.img.crossOrigin = 'anonymous';
  t.img.onload = () => { t.ok = true; dirty = true; };
  t.img.onerror = () => { t.err = true; };
  t.img.src = tileURL(z, x, y);
  tiles.set(k, t);
  if (tiles.size > 900) {
    const old = [...tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 300);
    for (const [key, tt] of old) { if (!tt.ok) { tt.img.onload = null; tt.img.src = ''; } tiles.delete(key); }
  }
  return t;
}
function tileRange(v, S) {
  const zt = clamp(Math.round(v.z), 1, TILE_MAX), n = 1 << zt;
  const left = v.cx - W / 2 / S, top = v.cy - H / 2 / S, right = v.cx + W / 2 / S, bottom = v.cy + H / 2 / S;
  return { zt, n, x0: Math.floor(left * n), x1: Math.floor(right * n), y0: Math.max(0, Math.floor(top * n)), y1: Math.min(n - 1, Math.floor(bottom * n)), left, top };
}
function prefetchView(v) { // warm the cache for where a fly-to will land
  const r = tileRange(v, scale(v.z));
  if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 120) return;
  for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) getTile(r.zt, ((x % r.n) + r.n) % r.n, y);
}
function drawTiles(c, S) {
  tileGen++;
  const r = tileRange(view, S), tw = S / r.n;
  if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > 400) return;
  for (let x = r.x0; x <= r.x1; x++) {
    const xx = ((x % r.n) + r.n) % r.n;
    for (let y = r.y0; y <= r.y1; y++) {
      const sx = (x / r.n - r.left) * S, sy = (y / r.n - r.top) * S;
      const t = getTile(r.zt, xx, y);
      if (t.ok) { c.drawImage(t.img, sx, sy, tw + .5, tw + .5); continue; }
      for (let k = 1; k <= 6 && r.zt - k >= 1; k++) { // ancestor fallback while the tile loads
        const tp = tiles.get(tileKey(r.zt - k, xx >> k, y >> k));
        if (!tp || !tp.ok) continue;
        tp.used = tileGen;
        const f = 1 << k, iw = tp.img.width / f, ih = tp.img.height / f;
        c.drawImage(tp.img, (xx - ((xx >> k) << k)) * iw, (y - ((y >> k) << k)) * ih, iw, ih, sx, sy, tw + .5, tw + .5);
        break;
      }
    }
  }
  // tint the greys toward the grid's cyan
  c.globalCompositeOperation = 'multiply'; c.fillStyle = '#7fd4ff'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'screen'; c.fillStyle = 'rgba(8,20,40,0.55)'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
}

/* ---------------- base map ---------------- */
function lw(base, k, lo, hi) { return clamp(base + (view.z - 11) * k, lo, hi); }
function drawBase() {
  const S = scale(view.z), z = view.z;
  const left = view.cx - W / 2 / S, top = view.cy - H / 2 / S, right = view.cx + W / 2 / S, bottom = view.cy + H / 2 / S;
  const c = mctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = C.void; c.fillRect(0, 0, W, H);
  drawTiles(c, S);

  // sector grid (100 m at street zoom, up to 1000 km when zoomed right out)
  const gm = z >= 16.5 ? 100 : z >= 14.6 ? 250 : z >= 12.2 ? 1000 : z >= 9.6 ? 5000 : z >= 7 ? 25000 : z >= 4.5 ? 100000 : 1000000;
  const g = gm / mpu();
  c.strokeStyle = 'rgba(51,230,255,0.07)'; c.lineWidth = 1; c.beginPath();
  for (let x = Math.ceil(left / g) * g; x < right; x += g) { const sx = (x - left) * S; c.moveTo(sx, 0); c.lineTo(sx, H); }
  for (let y = Math.ceil(top / g) * g; y < bottom; y += g) { const sy = (y - top) * S; c.moveTo(0, sy); c.lineTo(W, sy); }
  c.stroke();

  // units
  const r = lw(2.2, .55, 2.2, 6), glow = r * 2.6;
  const many = U.length > 4000;
  for (const t of U) {
    const sx = (t.x - left) * S, sy = (t.y - top) * S;
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
    const col = unitColor(t), on = passesFilter(t);
    if (!many) { c.globalAlpha = on ? .22 : .08; c.fillStyle = col; c.beginPath(); c.arc(sx, sy, glow, 0, TAU); c.fill(); }
    c.globalAlpha = on ? 1 : .35; c.fillStyle = col;
    if (many && z < 9) { c.fillRect(sx - r * .7, sy - r * .7, r * 1.4, r * 1.4); continue; }
    c.beginPath(); c.arc(sx, sy, r, 0, TAU); c.fill();
    if (on && z >= 12 && !many) { c.globalAlpha = .9; c.fillStyle = '#fff'; c.beginPath(); c.arc(sx, sy, r * .35, 0, TAU); c.fill(); }
  }
  c.globalAlpha = 1;
}
function unitColor(t) {
  if (t.s === 0) return C.red;
  if (t.a === 'restricted') return C.amber;
  if (t.s === 1 || t.a === 'public') return C.mint;
  return (DS && (DS.fields.status || DS.fields.access)) ? C.cyanDim : C.mint;
}

/* ---------------- filters / ranking ---------------- */
let openOnly = true, publicOnly = false;
function passesFilter(t) { return (!openOnly || t.s !== 0) && (!publicOnly || t.a !== 'restricted'); }
let user = null;          // {lat, lon, acc, x, y, manual}
let ranked = [];          // filtered units sorted by distance
let rankIdx = 0;
let target = null;
function computeRank() {
  if (!user) { ranked = []; return; }
  for (const t of U) t.dist = hav(user.lat, user.lon, t.la, t.lo);
  ranked = U.filter(passesFilter).sort((a, b) => a.dist - b.dist);
  if (!ranked.length) ranked = U.slice().sort((a, b) => a.dist - b.dist);
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
  err: () => tone(300, 120, .25, 'sawtooth', .04),
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
function gridStatus() { return DS ? `GRID ONLINE · ${U.length} UNITS${DS.fields.status ? ` · ${DS.nOpen} OPEN` : ''}` : 'NO DATA LOADED'; }
setInterval(() => { const d = new Date(); $('clock').textContent = d.toLocaleTimeString([], { hour12: false }); }, 1000);

/* ---------------- sequence state machine ---------------- */
const seq = { phase: 'idle', t0: 0, fix: null, err: null, fly: null, flashT: -1e9, glitchT: -1e9, tick: -1, sweepR: 0, sweepDur: 0, sweepMax: 0, hits: 0, lastHit: 0, cands: [], satPts: [], fixScreen: null };
const now = () => performance.now();
function setPhase(p) { seq.phase = p; seq.t0 = now(); }
function busy() { return seq.phase !== 'idle' && seq.phase !== 'done'; }
function flash(strength) { seq.flashT = now(); seq.flashStrength = strength || .35; if (!reduceMotion) { $('title').classList.remove('glitch'); void $('title').offsetWidth; $('title').classList.add('glitch'); } }

function startFind() {
  if (busy()) return;
  if (!U.length) { openPanel(); return; }
  hideCard();
  seq.fix = null; seq.err = null; seq.hits = 0; seq.cands = [];
  for (const t of U) t.cross = 0;
  $('app').classList.add('busy');
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
  const zNeeded = Math.log2((availR * mpuAt(user.lat) / seq.sweepMax) / 256);
  const z = clamp(zNeeded, 4, 15.6);
  const scy = (hudPad() + (H - 100)) / 2, S = scale(z);
  seq.fly = { from: { ...view }, to: { cx: user.x, cy: user.y - (scy - H / 2) / S, z }, dur: reduceMotion ? 500 : 1500 };
  prefetchView(seq.fly.to);
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
  setStatus(user ? 'GRID ONLINE · POSITION HELD' : gridStatus()); updateCoordsIdle();
}
function finishNow() {
  // skip straight to the result
  if (!user) return abort();
  if (!target) { computeRank(); target = ranked[0]; }
  if (!target) return abort();
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
    for (const t of U) t.cross = 0;
    seq.fly = { from: { ...view }, to: finalView(), dur: 700 };
    prefetchView(seq.fly.to);
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
      for (const t2 of U) { if (t2.cross) { n++; continue; } if (t2.dist <= seq.sweepR) { t2.cross = t; n++; if (t - seq.lastHit > 70) { seq.lastHit = t; SFX.hit(); } } }
      $('ovLines').textContent = `RADIUS   ${fmtDist(seq.sweepR)}\nCONTACTS ${String(n).padStart(3, '0')}\nFILTER   ${openOnly && DS.fields.status ? 'OPEN' : 'ALL'}${publicOnly ? ' · PUBLIC' : ''}`;
      if (p >= 1) { seq.fly = { from: { ...view }, to: finalView(), dur: reduceMotion ? 300 : 950 }; prefetchView(seq.fly.to); seq.mini = false; setPhase('target'); SFX.target();
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
  const c = seq.fix ? fmtCoord(seq.fix.lat, seq.fix.lon) : fmtCoord(center.lat + (Math.random() - .5) * .2, center.lon + (Math.random() - .5) * .2);
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
    for (let i = 0; i < 4; i++) { const p = ((t / 1600) + i / 4) % 1; c.strokeStyle = `rgba(51,230,255,${(1 - p) * .35})`; c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, p * R, 0, TAU); c.stroke(); }
    const ang = (t / 1400) * TAU;
    let grad = null; try { grad = c.createConicGradient(ang - TAU * .28, cx, cy); } catch (e) { grad = null; }
    if (grad) { grad.addColorStop(0, 'rgba(51,230,255,0)'); grad.addColorStop(.28, 'rgba(51,230,255,0.28)'); grad.addColorStop(.281, 'rgba(51,230,255,0)'); grad.addColorStop(1, 'rgba(51,230,255,0)'); c.fillStyle = grad; c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fill(); }
    c.strokeStyle = 'rgba(169,244,255,0.9)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R); c.stroke();
    c.strokeStyle = 'rgba(51,230,255,0.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(cx - 24, cy); c.lineTo(cx + 24, cy); c.moveTo(cx, cy - 24); c.lineTo(cx, cy + 24); c.stroke();
    // contacts: units the sweep passes over blink
    const S = scale(view.z), step = U.length > 4000 ? Math.ceil(U.length / 2000) : 2;
    for (let i = 0; i < U.length; i += step) { const tt = U[i]; const sx = (tt.x - view.cx) * S + W / 2, sy = (tt.y - view.cy) * S + H / 2; if (sx < 0 || sx > W || sy < 0 || sy > H) continue; const a = Math.atan2(sy - cy, sx - cx); let d = (ang - a) % TAU; if (d < 0) d += TAU; if (d < 1.2) { c.fillStyle = `rgba(93,255,192,${(1 - d / 1.2) * .9})`; c.fillRect(sx - 1.5, sy - 1.5, 3, 3); } }
    seq.satPts.forEach((p, i) => { const pp = ((t / 1300) + i / 3) % 1; c.strokeStyle = `rgba(255,47,214,${(1 - pp) * .6})`; c.lineWidth = 1; c.beginPath(); c.arc(p[0], p[1], 6 + pp * 60, 0, TAU); c.stroke(); c.fillStyle = C.magenta; c.beginPath(); c.moveTo(p[0], p[1] - 6); c.lineTo(p[0] + 5, p[1] + 4); c.lineTo(p[0] - 5, p[1] + 4); c.closePath(); c.fill(); c.font = `9px ${FONT_MONO}`; c.fillStyle = 'rgba(255,208,245,0.8)'; c.textAlign = 'left'; c.fillText(`SAT-0${i + 1}`, p[0] + 10, p[1] + 3); });
    if (seq.fix) {
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

    if (ph === 'fly') {
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
      for (const tt of U) {
        if (!tt.cross) continue; const age = (t - tt.cross) / 900; if (age > 1 && !seq.cands.includes(tt)) continue;
        const [sx, sy] = toScreen(tt.x, tt.y); if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue;
        const a = Math.max(0, 1 - age);
        c.strokeStyle = `rgba(93,255,192,${a})`; c.lineWidth = 1.5; c.beginPath(); c.arc(sx, sy, 4 + age * 22, 0, TAU); c.stroke();
      }
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
  const pill = $('pill');
  const st = t.s === 0 ? 'closed' : t.a === 'restricted' ? 'restricted' : (t.s === 1 || t.a === 'public') ? 'open' : 'unverified';
  const typed = DS.fields.status || DS.fields.access;
  pill.className = 'pill ' + st;
  pill.textContent = st === 'closed' ? 'CLOSED' : st === 'restricted' ? (t.ar || 'RESTRICTED').toUpperCase().slice(0, 18)
    : st === 'open' ? (t.s === 1 ? (t.a === 'public' ? 'OPEN · PUBLIC' : 'OPEN') : 'PUBLIC') : typed ? 'UNVERIFIED' : 'UNIT';
  $('cName').textContent = t.n.replace(/ \((customers only|permissive access)\)$/i, '');
  $('cDist').textContent = has ? fmtDist(t.dist) : '— M';
  $('cWalk').textContent = has ? fmtWalk(t.dist) : 'SET A POSITION FOR RANGE';
  const rows = [];
  if (t.s === 0) rows.push(['STATUS', `<span class="warn">CLOSED${t.r ? ' · ' + esc(t.r) : ''}</span>`]);
  else if (t.r) rows.push(['STATUS', `<span class="warn">${esc(t.r)}</span>`]);
  if (t.h) rows.push(['HOURS', esc(t.h)]);
  const access = (t.ar || (t.a === 'public' ? 'Public' : '')) + (t.f === 'yes' ? (t.ar || t.a ? ' · fee' : 'Fee') : t.f === 'no' ? (t.ar || t.a ? ' · free' : 'Free') : '');
  if (access) rows.push(['ACCESS', esc(access)]);
  if (t.ad) rows.push(['ADDRESS', esc(t.ad)]);
  if (t.d) rows.push(['WHERE', esc(t.d)]);
  if (t.w && t.w !== 'None') rows.push(['ACCESSIBLE', esc(t.w)]);
  if (t.t) rows.push(['TYPE', esc(t.t)]);
  if (t.ex) for (const [k, v] of t.ex) rows.push([esc(k), esc(v)]);
  $('cRows').innerHTML = rows.slice(0, 12).map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  $('btnNav').href = `https://www.google.com/maps/dir/?api=1&destination=${t.la},${t.lo}&travelmode=walking`;
  $('cSrc').textContent = `${(t.src || DS.name).toUpperCase().slice(0, 44)} · ${t.la.toFixed(5)}, ${t.lo.toFixed(5)}`;
  const link = $('cLink'); if (t.u) { link.href = t.u; link.hidden = false; } else link.hidden = true;
  // web search for the unit: name plus whatever context the record has (park, operator, address)
  const ctx = (t.ex || []).filter(([k]) => /PARK|OPERATOR|CITY|BOROUGH|COUNTY|STATE/.test(k)).map(([, v]) => v);
  $('cSearch').href = 'https://www.google.com/search?q=' + encodeURIComponent([t.n, t.ad, ...ctx].filter(Boolean).slice(0, 3).join(' '));
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
function onViewChange() { view.cy = clamp(view.cy, 0, 1); if (!busy()) updateCoordsIdle(); }
function onTap(sx, sy, dbl) {
  if (busy()) { if (seq.phase === 'lost') return; if (seq.phase === 'acquire' && !seq.fix) { abort(); return; } finishNow(); return; }
  if (pinMode) { const [lon, lat] = unproj(...toWorld(sx, sy)); pinMode = false; stage.classList.remove('pin'); $('chipPin').classList.remove('on'); $('chipPin').setAttribute('aria-pressed', 'false'); runWithPosition(lat, lon, 0, true); return; }
  if (dbl) { const w = toWorld(sx, sy); view.z = clamp(view.z + 1, ZMIN, ZMAX); const S = scale(view.z); view.cx = w[0] - (sx - W / 2) / S; view.cy = w[1] - (sy - H / 2) / S; dirty = true; onViewChange(); return; }
  let best = null, bd = 22;
  for (const t of U) { const [x, y] = toScreen(t.x, t.y); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = t; } }
  if (best) { target = best; if (user) { const i = ranked.indexOf(best); rankIdx = i >= 0 ? i : rankIdx; } showCard(); SFX.ui(); }
  else if ($('card').classList.contains('show')) hideCard();
}
function runWithPosition(lat, lon, acc, manual) {
  if (!U.length) { openPanel(); return; }
  hideCard(); for (const t of U) t.cross = 0;
  setUser(lat, lon, acc, manual);
  $('app').classList.add('busy'); $('overlay').classList.add('show'); $('overlay').classList.remove('actions');
  seq.satPts = [[W * .12, H * .2], [W * .9, H * .28], [W * .5, H * .78]];
  beginFly();
}

/* ---------------- local storage (IndexedDB, localStorage fallback) ---------------- */
const store = (() => {
  const DBN = 'camp-radar', ST = 'kv';
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      try { const r = indexedDB.open(DBN, 1); r.onupgradeneeded = () => r.result.createObjectStore(ST); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); }
      catch (e) { rej(e); }
    });
    return dbp;
  }
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction(ST, mode), q = fn(t.objectStore(ST));
    t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
  }));
  const LS = 'campradar:';
  const ls = {
    get: k => { try { const v = localStorage.getItem(LS + k); return Promise.resolve(v ? JSON.parse(v) : undefined); } catch (e) { return Promise.resolve(undefined); } },
    set: (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
    del: k => { try { localStorage.removeItem(LS + k); } catch (e) { /* ignore */ } return Promise.resolve(); },
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => ls.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => ls.set(k, v)),
    del: k => tx('readwrite', s => s.delete(k)).catch(() => ls.del(k)).then(() => ls.del(k)),
  };
})();

/* ---------------- dataset loading ---------------- */
function applyDataset(ds, fit) {
  if (busy()) abort();
  DS = ds;
  U = ds.points.map((p, i) => { const q = proj(p.lo, p.la); return Object.assign({ i, x: q[0], y: q[1], dist: NaN, cross: 0 }, p); });
  // fit to the bulk of the points: a nationwide set with Guam or the Aleutians in it would otherwise centre on the ocean
  const [minLo, minLa, maxLo, maxLa] = ds.fit = trimmedBox(ds.points);
  center = { lat: (minLa + maxLa) / 2, lon: (minLo + maxLo) / 2 };
  user = null; ranked = []; target = null; rankIdx = 0; hideCard();
  // chips only for fields the data actually has
  openOnly = !!ds.fields.status; publicOnly = false;
  $('chipOpen').hidden = !ds.fields.status; $('chipOpen').classList.toggle('on', openOnly); $('chipOpen').setAttribute('aria-pressed', String(openOnly));
  $('chipPublic').hidden = !ds.fields.access; $('chipPublic').classList.remove('on'); $('chipPublic').setAttribute('aria-pressed', 'false');
  buildLegend(ds.fields);
  $('subName').textContent = `${ds.name.toUpperCase().slice(0, 26)} · ${U.length} UNITS`;
  document.title = ds.sample ? 'Camp Radar' : `Camp Radar · ${ds.name}`;
  layoutChrome();
  if (fit) {
    const a = proj(minLo, maxLa), b = proj(maxLo, minLa);
    Object.assign(view, fitBounds(a[0], a[1], b[0], b[1], { l: 24, r: 24, t: hudPad() + 30, b: 120 }));
    if (U.length === 1) view.z = Math.min(view.z, 14);
  }
  dirty = true;
  scramble($('status'), gridStatus(), 900); $('led').className = 'led';
  updateCoordsIdle();
  renderPanel();
}
function trimmedBox(pts) {
  if (pts.length < 50) { let a = 180, b = 90, c = -180, d = -90; for (const p of pts) { if (p.lo < a) a = p.lo; if (p.la < b) b = p.la; if (p.lo > c) c = p.lo; if (p.la > d) d = p.la; } return [a, b, c, d]; }
  const lo = pts.map(p => p.lo).sort((x, y) => x - y), la = pts.map(p => p.la).sort((x, y) => x - y);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  return [q(lo, .02), q(la, .02), q(lo, .98), q(la, .98)];
}
function buildLegend(f) {
  const items = [];
  if (f.status || f.access) {
    items.push([C.mint, f.status && f.access ? 'OPEN · PUBLIC' : f.status ? 'OPEN' : 'PUBLIC']);
    if (f.access) items.push([C.amber, 'RESTRICTED']);
    if (f.status) items.push([C.red, 'CLOSED']);
    items.push([C.cyanDim, 'UNVERIFIED']);
  } else items.push([C.mint, 'UNIT']);
  $('legend').innerHTML = items.map(([col, lab]) => `<span><i style="background:${col}"></i>${lab}</span>`).join('');
}
function loadParsed(ds, opts) {
  ds.sample = !!opts.sample; ds.saved = false;
  applyDataset(ds, true);
  const notes = ds.notes.length ? '\n' + ds.notes.join('\n') : '';
  if (opts.persist) {
    store.set('dataset', ds).then(() => { ds.saved = true; renderPanel(); })
      .catch(() => panelStatus(`Loaded ${U.length} units, but this browser refused to save them (storage full or blocked). They will be gone on reload.`, true));
  }
  panelStatus(`Loaded ${U.length} unit${U.length === 1 ? '' : 's'} from ${ds.format}${opts.sample ? ' (sample)' : ''}.${notes}`);
  SFX.lock();
}
function loadText(text, name, opts) {
  let ds;
  try { ds = Parse.parseText(text, name); }
  catch (e) { panelStatus(e.message || String(e), true); SFX.err(); return false; }
  loadParsed(ds, opts);
  return true;
}
function loadFile(file) {
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) { panelStatus('That file is over 60 MB. Trim it down first.', true); return; }
  panelStatus(`Reading ${file.name}…`);
  file.text().then(text => { if (loadText(text, file.name, { persist: true })) closePanelSoon(); })
    .catch(e => panelStatus('Could not read the file: ' + (e.message || e), true));
}
const DEFAULT_FILE = 'campsites-us.geojson';
function loadSample() {
  const raw = window.SAMPLE_DATA;
  if (!raw) { panelStatus('No sample bundled in this build.', true); return; }
  const ds = Parse.parseText(raw, 'Toronto public toilets');
  ds.name = 'Toronto public toilets';
  loadParsed(ds, { sample: true, persist: false });
}
function loadDefault() {
  // the US campsite file sits next to index.html; the Toronto sample is the offline fallback
  panelStatus('Loading US campsites…');
  setStatus('LOADING GRID', 'busy');
  return fetch(DEFAULT_FILE).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
    .then(text => { const ds = Parse.parseText(text, DEFAULT_FILE); ds.name = 'US campsites'; loadParsed(ds, { sample: true, persist: false }); })
    .catch(e => { loadSample(); panelStatus(`Could not load ${DEFAULT_FILE} (${e.message || e}); showing the Toronto sample instead.`); });
}
function forgetData() {
  store.del('dataset').finally(() => { panelStatus('Your dataset was removed from this browser.'); loadDefault(); });
}
function loadFromURL(url) {
  panelStatus(`Fetching ${url.slice(0, 80)}…`);
  fetch(url, { mode: 'cors' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
    .then(text => { if (loadText(text, url.split('?')[0], { persist: true })) closePanelSoon(); else openPanel(); })
    .catch(e => { openPanel(); panelStatus(`Could not fetch that URL (${e.message || e}). The host has to allow cross-origin requests; GitHub raw links and most open-data portals do.`, true); });
}

/* ---------------- data panel ---------------- */
let panelTimer = 0;
function openPanel() { $('panel').hidden = false; $('chipData').classList.add('on'); $('chipData').setAttribute('aria-pressed', 'true'); renderPanel(); clearTimeout(panelTimer); }
function closePanel() { $('panel').hidden = true; $('chipData').classList.remove('on'); $('chipData').setAttribute('aria-pressed', 'false'); clearTimeout(panelTimer); }
function closePanelSoon() { clearTimeout(panelTimer); panelTimer = setTimeout(closePanel, 1600); }
function panelStatus(msg, isErr) { const el = $('pnStatus'); el.hidden = false; el.textContent = msg; el.classList.toggle('err', !!isErr); if (isErr) openPanel(); }
function renderPanel() {
  if (!DS) { $('pnRows').innerHTML = ''; return; }
  const [minLo, minLa, maxLo, maxLa] = DS.bbox;
  const span = hav(minLa, minLo, maxLa, maxLo);
  const fields = ['status', 'access', 'hours', 'address', 'url'].filter(k => DS.fields[k]).map(k => k.toUpperCase()).join(' · ') || 'NAME + POSITION ONLY';
  const rows = [
    ['DATASET', esc(DS.name)],
    ['UNITS', `${U.length}${DS.fields.status ? ` · ${DS.nOpen} open` : ''}`],
    ['FORMAT', esc(DS.format)],
    ['FIELDS', esc(fields)],
    ['SPAN', span < 1 ? 'single point' : `${fmtDist(span).toLowerCase()} across · centre ${fmtCoord(center.lat, center.lon)}`],
    ['STORAGE', DS.sample ? 'Default data, not saved' : DS.saved ? 'Saved in this browser' : 'Not saved yet'],
  ];
  $('pnRows').innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
  $('btnSample').disabled = !!DS.sample && DS.name === 'US campsites';
  $('btnToronto').disabled = !!DS.sample && DS.name !== 'US campsites';
  $('btnForget').disabled = !!DS.sample;
}
$('chipData').addEventListener('click', () => { SFX.ui(); if ($('panel').hidden) openPanel(); else closePanel(); });
$('pnClose').addEventListener('click', () => { SFX.ui(); closePanel(); });
$('panel').addEventListener('click', e => { if (e.target === $('panel')) closePanel(); });
$('file').addEventListener('change', e => { loadFile(e.target.files && e.target.files[0]); e.target.value = ''; });
$('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('btnSample').addEventListener('click', () => { SFX.ui(); loadDefault().then(closePanelSoon); });
$('btnToronto').addEventListener('click', () => { SFX.ui(); loadSample(); closePanelSoon(); });
$('btnForget').addEventListener('click', () => { SFX.ui(); forgetData(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('panel').hidden) closePanel(); });
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); dragDepth++; $('app').classList.add('dragging'); });
window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('app').classList.remove('dragging'); } });
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('app').classList.remove('dragging'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { openPanel(); loadFile(f); } });
window.addEventListener('paste', e => { // pasted GeoJSON / CSV text
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text || text.length < 20) return;
  const head = text.slice(0, 2000), looksCsv = head.split('\n').length >= 3 && /^[^\n]*[,;\t][^\n]*\n/.test(head);
  if (!/^[\s\uFEFF]*[\[{<]/.test(head) && !looksCsv) return;
  const active = document.activeElement; if (active && /^(input|textarea)$/i.test(active.tagName)) return;
  openPanel(); if (loadText(text, 'Pasted data', { persist: true })) closePanelSoon();
});

/* ---------------- controls ---------------- */
$('fab').addEventListener('click', () => { SFX.ui(); startFind(); });
$('btnClose').addEventListener('click', () => { hideCard(); SFX.ui(); });
$('btnNext').addEventListener('click', () => { if (!ranked.length) return; retarget((rankIdx + 1) % Math.min(ranked.length, 12), true); });
$('btnAbort').addEventListener('click', abort);
$('btnPinMode').addEventListener('click', () => { abort(); pinMode = true; stage.classList.add('pin'); $('chipPin').classList.add('on'); $('chipPin').setAttribute('aria-pressed', 'true'); setStatus('TAP THE MAP TO SET POSITION', 'busy'); });
$('btnSim').addEventListener('click', () => {
  abort();
  const [minLo, minLa, maxLo, maxLa] = DS.fit || DS.bbox, padLa = Math.max(.01, (maxLa - minLa) * .1), padLo = Math.max(.01, (maxLo - minLo) * .1);
  const lat = minLa - padLa + Math.random() * (maxLa - minLa + 2 * padLa), lon = minLo - padLo + Math.random() * (maxLo - minLo + 2 * padLo);
  runWithPosition(lat, lon, 25 + Math.random() * 40, true);
});
function toggleChip(id, fn) { $(id).addEventListener('click', () => { if (busy() && seq.phase !== 'lost') return; const on = !$(id).classList.contains('on'); $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', String(on)); fn(on); SFX.ui(); }); }
toggleChip('chipOpen', on => { openOnly = on; refilter(); });
toggleChip('chipPublic', on => { publicOnly = on; refilter(); });
toggleChip('chipPin', on => { pinMode = on; stage.classList.toggle('pin', on); if (on) { hideCard(); closePanel(); setStatus('TAP THE MAP TO SET POSITION', 'busy'); } else abort(); });
toggleChip('chipSfx', on => { sfxOn = on; if (on) { ac(); SFX.lock(); } });
function refilter() { dirty = true; if (user && !busy()) { computeRank(); retarget(0, $('card').classList.contains('show')); } }
$('overlay').addEventListener('click', e => { if (e.target === $('overlay') && busy() && seq.phase !== 'lost') finishNow(); });
window.addEventListener('resize', () => { resize(); seedRain(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { dirty = true; layoutChrome(); });

/* ---------------- boot ---------------- */
resize(); seedRain();
buildLegend({});
scramble($('status'), 'LOADING GRID', 600);
const srcParam = new URLSearchParams(location.search).get('src');
store.get('dataset').then(saved => {
  if (saved && Array.isArray(saved.points) && saved.points.length) { saved.saved = true; saved.sample = false; saved.notes = saved.notes || []; applyDataset(saved, true); }
  else return loadDefault();
}).catch(() => loadDefault()).then(() => {
  if (srcParam && /^https?:\/\//i.test(srcParam)) loadFromURL(srcParam);
  else if (!srcParam && DS && DS.sample && !sessionStorage.getItem('campradar:hinted')) {
    try { sessionStorage.setItem('campradar:hinted', '1'); } catch (e) { /* ignore */ }
    setTimeout(() => { if (!busy()) setStatus('DEFAULT GRID · TAP DATA FOR YOUR OWN'); }, 2600);
  }
});
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
