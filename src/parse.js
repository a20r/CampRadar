/* Loo Runner data parser: turns whatever the user drops in (GeoJSON, loose JSON,
   Overpass JSON, CSV/TSV, GPX, KML) into a flat list of points with a small
   normalised schema. Runs in the browser and under node (for tests). */
(function (root) {
'use strict';

const MAX_POINTS = 25000;
const R_EARTH = 6378137;

/* ---------------- key matching ---------------- */
const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_KEY = /^(id|objectid|fid|gid|uid|osmid|globalid|guid|rowid|index|ogcfid|cityassetid|assetid)$/;
const COORD_KEY = /^(lat|latitude|y|lon|lng|long|longitude|x|geometry|coordinates|coords|latlng|geo|position|point|wkt|thegeom|geom|shape)$/;
const LAT_KEY = /^(y|lat|latitude|ylat|latdeg|latwgs84|point_?y|centroidlat|geolat|loclat)$|latitude$|^lat[a-z]{0,4}$/;
const LON_KEY = /^(x|lon|lng|long|longitude|xlon|londeg|lonwgs84|point_?x|centroidlon|geolon|loclon|loclng|lng[a-z]{0,4})$|longitude$|^lon[a-z]{0,4}$/;

const FIELD_RULES = {
  // ordered by priority; exact normalised keys first, then a "contains" regex
  name: { exact: ['name', 'title', 'label', 'facility', 'facilityname', 'site', 'sitename', 'locationname', 'assetname', 'placename', 'parkname', 'park', 'washroomname', 'toiletname', 'stationname', 'nameen', 'nom', 'nome', 'nombre', 'bezeichnung', 'displayname', 'commonname', 'fullname', 'officialname'], like: /name$|^title/ },
  status: { exact: ['status', 'open', 'isopen', 'opened', 'closed', 'isclosed', 'state', 'active', 'isactive', 'operational', 'operationalstatus', 'openstatus', 'currentstatus', 'facilitystatus', 'availability', 'available', 'inservice', 'openclosed'], like: /status$|^isopen|^open$/ },
  reason: { exact: ['statusreason', 'reason', 'closurereason', 'closedreason', 'statusnote', 'statusdetails', 'alert', 'notice'], like: /reason$/ },
  access: { exact: ['access', 'acces', 'acceso', 'accesso', 'zugang', 'publicaccess', 'accesstype', 'public', 'ispublic', 'audience', 'restricted', 'restriction', 'toiletsaccess', 'accessibility_public', 'openness', 'who'], like: /^access$|publicaccess/ },
  hours: { exact: ['hours', 'horaires', 'horaire', 'horario', 'horarios', 'orari', 'offnungszeiten', 'openinghours', 'openhours', 'hoursofoperation', 'operatinghours', 'times', 'time', 'schedule', 'opentime', 'opentimes', 'openingtimes', 'hoursopen', 'operationhours'], like: /hour|opening/ },
  address: { exact: ['address', 'addr', 'street', 'streetaddress', 'fulladdress', 'location', 'addressfull', 'addrfull', 'siteaddress', 'civicaddress', 'addrstreet'], like: /addr|street|adresse|direccion|indirizzo/ },
  description: { exact: ['description', 'desc', 'details', 'locationdetails', 'notes', 'note', 'comment', 'comments', 'where', 'directions', 'info', 'remarks', 'about', 'summary'], like: /desc|detail|note|comment/ },
  url: { exact: ['url', 'website', 'web', 'link', 'href', 'homepage', 'moreinfo', 'contactwebsite', 'sourceurl', 'weburl', 'webpage', 'infourl', 'detailsurl'], like: /url$|website|link$/ },
  fee: { exact: ['fee', 'cost', 'price', 'paid', 'charge', 'free', 'isfree', 'fees'], like: /^fee|cost|price/ },
  wheelchair: { exact: ['wheelchair', 'accessible', 'accessibility', 'ada', 'wheelchairaccessible', 'accessiblefeatures', 'disabledaccess', 'wheelchairaccess', 'barrierfree'], like: /wheelchair|accessib/ },
  type: { exact: ['type', 'category', 'amenity', 'kind', 'class', 'facilitytype', 'assettype', 'featuretype', 'subtype', 'toilettype', 'washroomtype'], like: /type$|category/ },
  source: { exact: ['source', 'src', 'provider', 'dataset', 'datasource', 'origin', 'publisher', 'agency'], like: /source$/ },
};

/* ---------------- value interpretation ---------------- */
function statusValue(v, key) {
  // returns {s: 1|0, messy: bool} or undefined; messy means the text carried more than a plain open/closed token
  if (v === null || v === undefined || v === '') return undefined;
  let r, messy = false;
  if (typeof v === 'boolean') r = v ? 1 : 0;
  else if (typeof v === 'number') r = v ? 1 : 0;
  else {
    const s = String(v).trim().toLowerCase();
    if (/^(open|opened|yes|y|true|t|active|operational|operating|available|in service|in-service|ok|1|normal|enabled|working)$/.test(s)) r = 1;
    else if (/^(closed|close|no|n|false|f|inactive|out of service|out-of-service|unavailable|0|disabled|off|removed|demolished|decommissioned)$/.test(s)) r = 0;
    else if (/clos|out of (service|order)|unavail|inactive|suspend|not (open|available)/.test(s)) { r = 0; messy = true; }
    else if (/open|active|avail|operat|service/.test(s)) { r = 1; messy = true; }
    else return undefined;
  }
  if (/closed|inactive|disabled|isclosed/.test(key)) r = 1 - r;
  return { s: r, messy };
}
function accessValue(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'boolean') return { a: v ? 'public' : 'restricted', raw: v ? 'Public' : 'Restricted' };
  const raw = String(v).trim(), s = raw.toLowerCase();
  if (s === 'unknown' || s === 'n/a' || s === 'na' || s === '-') return undefined;
  if (/^(public|yes|y|true|open|free|permissive|anyone|all|everyone|1)$/.test(s) || /public/.test(s) && !/non.?public|not public/.test(s)) return { a: 'public', raw: cap(raw) };
  if (/^(private|no|n|false|0)$/.test(s) || /customer|patron|private|member|staff|employee|restrict|permit|key|ticket|resident|guest|student|non.?public|not public|limited|paying/.test(s)) return { a: 'restricted', raw: cap(raw) };
  return { a: 'restricted', raw: cap(raw) };
}
function feeValue(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return v > 0 ? 'yes' : 'no';
  const s = String(v).trim().toLowerCase();
  if (s === 'unknown' || s === 'n/a') return undefined;
  if (/^(no|n|false|free|0|none|0\.0+|\$0(\.00)?)$/.test(s)) return 'no';
  if (/^(yes|y|true|paid|1)$/.test(s) || /\d/.test(s)) return 'yes';
  return undefined;
}
function cap(s) { s = String(s); return s.length > 40 ? s.slice(0, 40) : s.charAt(0).toUpperCase() + s.slice(1); }
function clean(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') { const s = v.trim(); return s === '' || /^(null|none|n\/a|na|unknown|undefined|-)$/i.test(s) ? undefined : s; }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return undefined;
}

/* ---------------- property flattening ---------------- */
function flatten(props, out, prefix, depth) {
  out = out || {};
  if (!props || typeof props !== 'object') return out;
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) { if (depth < 2) flatten(v, out, prefix + k + '_', depth + 1); }
    else if (Array.isArray(v)) { if (v.every(x => typeof x !== 'object')) out[prefix + k] = v.join(', '); }
    else out[prefix + k] = v;
  }
  return out;
}

/* ---------------- pick fields out of properties ---------------- */
function pickField(entries, rule, used) {
  for (const key of rule.exact) { const e = entries.find(e => e.nk === key && !used.has(e.k)); if (e && clean(e.v) !== undefined) return e; }
  if (rule.like) { const e = entries.find(e => rule.like.test(e.nk) && !used.has(e.k) && clean(e.v) !== undefined && !ID_KEY.test(e.nk)); if (e) return e; }
  return null;
}
function normaliseProps(rawProps, idx) {
  const flat = flatten(rawProps, {}, '', 0);
  const entries = Object.keys(flat).map(k => ({ k, nk: norm(k), v: flat[k] }));
  const used = new Set();
  const take = name => { const e = pickField(entries, FIELD_RULES[name], used); if (e) used.add(e.k); return e; };
  const p = {};
  const name = take('name');
  p.n = name ? String(clean(name.v)) : '';
  const st = take('status'); if (st) { const sv = statusValue(st.v, st.nk); if (!sv) used.delete(st.k); else { p.s = sv.s; if (sv.messy) p.r = cap(String(st.v).trim()); } }
  const rs = take('reason'); if (rs) { const v = clean(rs.v); if (v !== undefined) p.r = String(v); else used.delete(rs.k); }
  const ac = take('access'); if (ac) { const a = accessValue(ac.v); if (a) { p.a = a.a; p.ar = a.raw; } else used.delete(ac.k); }
  const h = take('hours'); if (h) p.h = String(clean(h.v));
  const ad = take('address'); if (ad) p.ad = String(clean(ad.v));
  const d = take('description'); if (d) p.d = String(clean(d.v));
  const u = take('url'); if (u) { const v = String(clean(u.v)); if (/^https?:\/\//i.test(v)) p.u = v; else if (/^www\./i.test(v)) p.u = 'https://' + v; else used.delete(u.k); }
  const f = take('fee'); if (f) { p.f = feeValue(f.v); if (p.f === undefined) used.delete(f.k); }
  const w = take('wheelchair'); if (w) { const v = clean(w.v); p.w = v === true ? 'Yes' : v === false ? 'No' : String(v); }
  const t = take('type'); if (t) { const v = String(clean(t.v)); if (/^(node|way|relation|feature|point)$/i.test(v)) used.delete(t.k); else p.t = v; }
  const src = take('source'); if (src) p.src = String(clean(src.v));
  // leftovers: a few readable extras for the card
  const extra = [];
  for (const e of entries) {
    if (used.has(e.k) || ID_KEY.test(e.nk) || COORD_KEY.test(e.nk)) continue;
    const v = clean(e.v); if (v === undefined) continue;
    if (e.nk === 'type' && /^(node|way|relation|feature)$/i.test(String(v))) continue;
    const s = String(v); if (s.length > 140 || /^[{\[]/.test(s)) continue;
    extra.push([e.k.replace(/[_:]+/g, ' ').toUpperCase().slice(0, 18), s]);
    if (extra.length >= 5) break;
  }
  if (extra.length) p.ex = extra;
  if (!p.n) p.n = p.t ? cap(p.t) : p.ad ? p.ad : `Unit ${String(idx + 1).padStart(3, '0')}`;
  return p;
}

/* ---------------- geometry → representative point ---------------- */
function centroid(coords, acc) {
  // walk any nesting of coordinate arrays, accumulate first two numbers of each position
  if (!Array.isArray(coords)) return acc;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') { acc.x += coords[0]; acc.y += coords[1]; acc.n++; return acc; }
  for (const c of coords) centroid(c, acc);
  return acc;
}
function geomPoints(g, out) {
  if (!g || typeof g !== 'object') return;
  const type = String(g.type || '').toLowerCase();
  if (type === 'geometrycollection' && Array.isArray(g.geometries)) { for (const gg of g.geometries) geomPoints(gg, out); return; }
  const c = g.coordinates;
  if (!Array.isArray(c)) return;
  if (type === 'point') { if (typeof c[0] === 'number' && typeof c[1] === 'number') out.push([c[0], c[1]]); return; }
  if (type === 'multipoint') { for (const p of c) if (Array.isArray(p) && typeof p[0] === 'number') out.push([p[0], p[1]]); return; }
  if (type === 'polygon' || type === 'multipolygon') {
    // outer rings only, closing vertex dropped
    const rings = type === 'polygon' ? [c[0]] : c.map(poly => poly && poly[0]);
    const acc = { x: 0, y: 0, n: 0 };
    for (const r of rings) { if (!Array.isArray(r)) continue; const rr = r.length > 1 && r[0] && r[r.length - 1] && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r; centroid(rr, acc); }
    if (acc.n) out.push([acc.x / acc.n, acc.y / acc.n]);
    return;
  }
  const acc = centroid(c, { x: 0, y: 0, n: 0 });
  if (acc.n) out.push([acc.x / acc.n, acc.y / acc.n]);
}

/* ---------------- JSON walking ---------------- */
const GEOM_TYPES = new Set(['point', 'multipoint', 'linestring', 'multilinestring', 'polygon', 'multipolygon', 'geometrycollection']);
const CONTAINER_KEYS = ['features', 'geometries', 'elements', 'data', 'results', 'result', 'items', 'records', 'rows', 'points', 'locations', 'places', 'value', 'values', 'entries', 'list', 'objects', 'markers', 'nodes', 'response', 'hits', 'docs', 'toilets', 'washrooms', 'restrooms'];

function numish(v) { if (typeof v === 'number') return isFinite(v) ? v : NaN; if (typeof v === 'string' && v.trim() !== '' && !isNaN(v)) return parseFloat(v); return NaN; }
function latLonFromObject(o) {
  // returns [lon, lat, keys] from lat/lon style keys, or null
  const keys = Object.keys(o);
  let latK = null, lonK = null;
  for (const k of keys) { const nk = norm(k); if (!latK && LAT_KEY.test(nk) && !isNaN(numish(o[k]))) latK = k; else if (!lonK && LON_KEY.test(nk) && !isNaN(numish(o[k]))) lonK = k; }
  if (latK && lonK) return [numish(o[lonK]), numish(o[latK]), [latK, lonK]];
  for (const k of keys) { // "43.6,-79.4" strings or [lon,lat] arrays under a coordinate-ish key
    const nk = norm(k), v = o[k];
    if (!/^(coordinates|coords|latlng|latlon|lnglat|lonlat|position|location|geo|point|center|centre|centroid|wkt|thegeom|geom|shape)$/.test(nk) || v == null) continue;
    if (Array.isArray(v) && v.length >= 2 && !isNaN(numish(v[0])) && !isNaN(numish(v[1]))) return /latlng|latlon/.test(nk) ? [numish(v[1]), numish(v[0]), [k]] : [numish(v[0]), numish(v[1]), [k]];
    if (typeof v === 'string') { const w = parseWKTPoint(v); if (w) return [w[0], w[1], [k]]; const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ;]\s*(-?\d+(?:\.\d+)?)\s*$/); if (m) return [parseFloat(m[2]), parseFloat(m[1]), [k]]; }
    if (typeof v === 'object' && !Array.isArray(v)) { const r = latLonFromObject(v); if (r) return [r[0], r[1], [k]]; }
  }
  return null;
}
function parseWKTPoint(s) { const m = /point\s*(?:z|m|zm)?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i.exec(s); return m ? [parseFloat(m[1]), parseFloat(m[2])] : null; }

function walk(node, out, depth, warn) {
  if (out.length >= MAX_POINTS * 2 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, out, depth + 1, warn); return; }
  const type = String(node.type || '').toLowerCase();
  if (type === 'featurecollection' && Array.isArray(node.features)) { for (const f of node.features) walk(f, out, depth + 1, warn); return; }
  if (type === 'feature') {
    const pts = []; geomPoints(node.geometry, pts);
    const props = Object.assign({}, node.properties || {});
    if (node.id !== undefined && props.id === undefined) props.id = node.id;
    if (!pts.length) { const ll = latLonFromObject(props); if (ll) pts.push([ll[0], ll[1]]); }
    if (!pts.length) { warn.nogeom++; return; }
    for (const p of pts) out.push({ c: p, props });
    return;
  }
  if (GEOM_TYPES.has(type)) { const pts = []; geomPoints(node, pts); for (const p of pts) out.push({ c: p, props: {} }); return; }
  // Overpass / plain records: lat+lon keys on the object itself
  const ll = latLonFromObject(node);
  if (ll) {
    const props = {};
    for (const k of Object.keys(node)) { if (ll[2].includes(k)) continue; const v = node[k]; if (k === 'tags' && v && typeof v === 'object') Object.assign(props, v); else if (v === null || typeof v !== 'object' || Array.isArray(v)) props[k] = v; else if (k === 'properties' || k === 'attributes' || k === 'fields') Object.assign(props, v); }
    out.push({ c: [ll[0], ll[1]], props });
    return;
  }
  if (node.geometry && typeof node.geometry === 'object') { // ESRI-ish {geometry:{x,y}, attributes:{}}
    const g = node.geometry, pts = [];
    geomPoints(g, pts);
    if (!pts.length) { const gl = latLonFromObject(g); if (gl) pts.push([gl[0], gl[1]]); }
    if (pts.length) { const props = Object.assign({}, node.attributes || node.properties || node.fields || {}); for (const p of pts) out.push({ c: p, props }); return; }
  }
  if (depth > 6) return;
  for (const k of CONTAINER_KEYS) if (Array.isArray(node[k]) || (node[k] && typeof node[k] === 'object')) walk(node[k], out, depth + 1, warn);
  if (!out.length) for (const k of Object.keys(node)) { if (CONTAINER_KEYS.includes(k)) continue; const v = node[k]; if (v && typeof v === 'object') walk(v, out, depth + 1, warn); }
}

/* ---------------- coordinate sanity ---------------- */
function fixCoordinates(recs, warn) {
  if (!recs.length) return recs;
  let big = 0, swapped = 0, ok = 0;
  for (const r of recs) {
    const [a, b] = r.c;
    if (!isFinite(a) || !isFinite(b)) continue;
    if (Math.abs(a) > 1000 || Math.abs(b) > 1000) big++;
    else if (Math.abs(b) > 90 && Math.abs(a) <= 90) swapped++;
    else if (Math.abs(a) <= 180 && Math.abs(b) <= 90) ok++;
  }
  if (big > recs.length / 2) { // projected metres, assume Web Mercator
    warn.notes.push('Coordinates looked like Web Mercator metres and were converted to lat/lon.');
    for (const r of recs) { const [x, y] = r.c; r.c = [x / R_EARTH * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * 180 / Math.PI]; }
  } else if (swapped > ok) {
    warn.notes.push('Coordinates were [lat, lon]; swapped to [lon, lat].');
    for (const r of recs) r.c = [r.c[1], r.c[0]];
  }
  return recs.filter(r => { const [lo, la] = r.c; const good = isFinite(lo) && isFinite(la) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(lo === 0 && la === 0); if (!good) warn.badcoord++; return good; });
}

/* ---------------- CSV ---------------- */
function parseCSV(text) {
  const delim = detectDelim(text);
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(f => f.trim() !== '')) rows.push(row); row = []; }
    else field += ch;
  }
  row.push(field); if (row.some(f => f.trim() !== '')) rows.push(row);
  return rows;
}
function detectDelim(text) {
  const head = text.slice(0, 4000).split(/\r?\n/).slice(0, 5);
  let best = ',', bestN = -1;
  for (const d of [',', '\t', ';', '|']) { const n = head.map(l => l.split(d).length).reduce((a, b) => a + b, 0); if (n > bestN) { bestN = n; best = d; } }
  return best;
}
function csvRecords(text, warn) {
  const rows = parseCSV(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim());
  const nk = header.map(norm);
  let latI = nk.findIndex(k => LAT_KEY.test(k)), lonI = nk.findIndex(k => LON_KEY.test(k));
  const wktI = nk.findIndex(k => /^(wkt|geometry|geom|thegeom|shape|location|point|coordinates|coords|latlng|latlon|position)$/.test(k));
  if (latI < 0 || lonI < 0) { // guess: first pair of numeric columns that fit lat/lon ranges
    const sample = rows.slice(1, 60);
    const numeric = header.map((_, i) => sample.every(r => r[i] === undefined || r[i].trim() === '' || !isNaN(numish(r[i]))) && sample.some(r => r[i] && r[i].trim() !== ''));
    const range = header.map((_, i) => { const v = sample.map(r => numish(r[i])).filter(x => !isNaN(x)); return v.length ? Math.max(...v.map(Math.abs)) : NaN; });
    if (wktI < 0) {
      for (let i = 0; i < header.length && (latI < 0 || lonI < 0); i++) {
        if (!numeric[i] || isNaN(range[i])) continue;
        if (latI < 0 && range[i] <= 90 && range[i] > 0 && !ID_KEY.test(nk[i])) { latI = i; continue; }
        if (lonI < 0 && range[i] <= 180 && range[i] > 0 && !ID_KEY.test(nk[i])) { lonI = i; }
      }
      if (latI >= 0 && lonI >= 0) warn.notes.push(`No lat/lon headers; guessed "${header[latI]}" = lat and "${header[lonI]}" = lon.`);
    }
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r], props = {};
    header.forEach((h, i) => { if (i !== latI && i !== lonI && i !== wktI && row[i] !== undefined && row[i] !== '') props[h || `col${i + 1}`] = row[i]; });
    let c = null;
    if (latI >= 0 && lonI >= 0) { const la = numish(row[latI]), lo = numish(row[lonI]); if (!isNaN(la) && !isNaN(lo)) c = [lo, la]; }
    if (!c && wktI >= 0 && row[wktI]) { const w = parseWKTPoint(row[wktI]); if (w) c = w; else { const m = row[wktI].match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/); if (m) c = [parseFloat(m[2]), parseFloat(m[1])]; } }
    if (!c) { warn.nogeom++; continue; }
    out.push({ c, props });
  }
  return out;
}

/* ---------------- GPX / KML ---------------- */
function xmlRecords(text, warn) {
  if (typeof DOMParser === 'undefined') { warn.notes.push('XML parsing needs a browser.'); return []; }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) { warn.notes.push('The XML did not parse cleanly.'); }
  const out = [];
  const txt = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : undefined; };
  // GPX waypoints (fall back to route/track points if there are no waypoints)
  for (const tag of ['wpt', 'rtept', 'trkpt']) {
    const els = doc.getElementsByTagName(tag);
    if (!els.length) continue;
    for (const el of els) {
      const la = parseFloat(el.getAttribute('lat')), lo = parseFloat(el.getAttribute('lon'));
      if (isNaN(la) || isNaN(lo)) continue;
      const props = { name: txt(el, 'name'), description: txt(el, 'desc'), comment: txt(el, 'cmt'), type: txt(el, 'type'), url: txt(el, 'link') || (el.getElementsByTagName('link')[0] || {}).getAttribute?.('href') };
      out.push({ c: [lo, la], props });
    }
    if (tag !== 'wpt') warn.notes.push(`No waypoints in the GPX; used ${tag} points instead.`);
    break;
  }
  if (out.length) return out;
  // KML placemarks
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const props = { name: txt(pm, 'name'), description: txt(pm, 'description'), address: txt(pm, 'address') };
    for (const d of pm.getElementsByTagName('Data')) { const v = txt(d, 'value'); if (d.getAttribute('name')) props[d.getAttribute('name')] = v; }
    for (const d of pm.getElementsByTagName('SimpleData')) { if (d.getAttribute('name')) props[d.getAttribute('name')] = d.textContent.trim(); }
    const acc = { x: 0, y: 0, n: 0 };
    const pointEl = pm.getElementsByTagName('Point')[0];
    const coordEls = pointEl ? pointEl.getElementsByTagName('coordinates') : pm.getElementsByTagName('coordinates');
    for (const ce of coordEls) for (const tok of ce.textContent.trim().split(/\s+/)) { const p = tok.split(','); const lo = parseFloat(p[0]), la = parseFloat(p[1]); if (!isNaN(lo) && !isNaN(la)) { acc.x += lo; acc.y += la; acc.n++; } }
    if (!acc.n) { warn.nogeom++; continue; }
    out.push({ c: [acc.x / acc.n, acc.y / acc.n], props });
  }
  return out;
}

/* ---------------- entry point ---------------- */
function parseText(text, filename) {
  const warn = { nogeom: 0, badcoord: 0, notes: [] };
  let recs = [], format = 'unknown';
  const s = text && typeof text === 'object' ? '{' : String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) throw new Error('The file is empty.');
  const first = s[0];
  if (first === '{' || first === '[') {
    let data;
    if (typeof text === 'object') data = text;
    else { try { data = JSON.parse(s); } catch (e) { throw new Error('Not valid JSON: ' + e.message.slice(0, 80)); } }
    format = data && (data.type === 'FeatureCollection' || data.type === 'Feature') ? 'GeoJSON' : 'JSON';
    walk(data, recs, 0, warn);
  } else if (first === '<') { format = /<gpx[\s>]/i.test(s.slice(0, 2000)) ? 'GPX' : /<kml[\s>]/i.test(s.slice(0, 2000)) ? 'KML' : 'XML'; recs = xmlRecords(s, warn); }
  else { format = 'CSV'; recs = csvRecords(s, warn); }
  recs = fixCoordinates(recs, warn);
  if (!recs.length) throw new Error(format === 'unknown' ? 'Could not find any coordinates in that file.' : `No usable points found in the ${format}${warn.nogeom ? ` (${warn.nogeom} records had no geometry)` : ''}.`);
  if (recs.length > MAX_POINTS) { warn.notes.push(`Kept the first ${MAX_POINTS.toLocaleString()} of ${recs.length.toLocaleString()} points.`); recs = recs.slice(0, MAX_POINTS); }
  const points = recs.map((r, i) => Object.assign(normaliseProps(r.props, i), { lo: +r.c[0].toFixed(7), la: +r.c[1].toFixed(7) }));
  const fields = {
    status: points.some(p => p.s !== undefined),
    access: points.some(p => p.a !== undefined),
    hours: points.some(p => p.h), url: points.some(p => p.u), address: points.some(p => p.ad),
  };
  let minLo = 180, maxLo = -180, minLa = 90, maxLa = -90;
  for (const p of points) { if (p.lo < minLo) minLo = p.lo; if (p.lo > maxLo) maxLo = p.lo; if (p.la < minLa) minLa = p.la; if (p.la > maxLa) maxLa = p.la; }
  if (warn.nogeom) warn.notes.push(`${warn.nogeom} record${warn.nogeom === 1 ? '' : 's'} had no usable geometry and were skipped.`);
  if (warn.badcoord) warn.notes.push(`${warn.badcoord} point${warn.badcoord === 1 ? '' : 's'} had out-of-range coordinates and were skipped.`);
  return { name: prettyName(filename), format, points, fields, bbox: [minLo, minLa, maxLo, maxLa], notes: warn.notes, nOpen: points.filter(p => p.s === 1).length };
}
function prettyName(filename) {
  if (!filename) return 'Custom dataset';
  return String(filename).replace(/^.*[\\/]/, '').replace(/\.(geo)?json$|\.csv$|\.tsv$|\.gpx$|\.kml$|\.txt$/i, '').replace(/[_\-.]+/g, ' ').trim() || 'Custom dataset';
}

const api = { parseText, MAX_POINTS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.LooParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
