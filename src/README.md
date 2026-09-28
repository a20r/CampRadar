# Build sources

`index.html` at the repo root is generated; edit these and rebuild:

- `page_head.html` (title, fonts, CSS), `page_markup.html` (DOM)
- `parse.js`: turns an uploaded GeoJSON / JSON / CSV / GPX / KML file into a flat list of points with a normalised schema (name, status, access, hours, address, url, fee, wheelchair, type, source, extras). Runs under node too, for tests.
- `app.js`: map renderer (Esri dark canvas raster tiles, tinted), gestures, the locate / sweep / target sequence, result card, data panel, and local persistence (IndexedDB with a localStorage fallback)
- `fetch_campsites.py`: queries Overpass for every US camp_site / caravan_site, classifies each by operator (federal, state, county/city, tribal, private) and writes `../campsites-us.geojson`, the default dataset the page fetches on load. The raw Overpass reply is cached as `campsites_raw.json` (git-ignored).
- `build.py`: inlines the above plus a minified copy of `../toronto-public-toilets.geojson` (the bundled sample) into `../index.html`

Rebuild: `python3 build.py`

Quick parser check: `node -e "const P=require('./parse.js');console.log(P.parseText(require('fs').readFileSync('../toronto-public-toilets.geojson','utf8'),'t.geojson').points.length)"`
