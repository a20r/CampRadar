# Build sources

`index.html` at the repo root is generated; edit these and rebuild:

- `page_head.html` (title, fonts, CSS), `page_markup.html` (DOM), `app.js` (map renderer, gestures, locate sequence, card)
- `mapdata.json`: packed base map + toilets (roads, water, rail, subway, neighbourhood labels, 614 toilets)
- `build.py`: inlines the above into `site/index.html` (and an artifact fragment)
- `process_base.py`: rebuilds `mapdata.json` from the raw layers (`base_roads.json` from Overpass via `fetch_base.py`; City of Toronto water/rail GeoJSON, TTC subway shapefile, neighbourhoods GeoJSON, `toronto-public-toilets.geojson`). Raw downloads are not included; the scripts fetch them.

Rebuild: `python3 build.py` then copy `site/index.html` to the repo root.
