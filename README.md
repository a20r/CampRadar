# Loo Runner

Find the closest public toilet, in any city. Single-file static site (`index.html`): neon map, "FIND CLOSEST" search using device location, Google Maps walking directions.

Bring your own data: tap DATA and drop in a GeoJSON, JSON, CSV, GPX or KML file. Points are pulled out of whatever geometry is inside (polygons and lines are reduced to a representative point), and name, open/closed status, access, hours, address and website are detected from the properties. The file is parsed and stored in your browser (IndexedDB); nothing is sent to a server, so the site stays fully static. A `?src=https://…/points.geojson` link loads a file from the web and keeps it locally too.

Bundled sample: 614 Toronto washrooms from City of Toronto open data (Park Washroom Facilities, incl. open/closed status) and OpenStreetMap `amenity=toilets`. Also provided as `toronto-public-toilets.gpx`, `.geojson`, and a kepler.gl map file (`.kepler.json`).

Basemap: Esri World Dark Gray Canvas raster tiles (Esri, HERE, Garmin, © OpenStreetMap contributors).

Hosting: any static host over https (geolocation requires a secure context). On GitHub Pages: Settings → Pages → Deploy from branch `main` / root.

Kepler view once hosted: `https://kepler.gl/demo?mapUrl=<https url of toronto-public-toilets.kepler.json>`

Sources are in `src/`; `python3 src/build.py` regenerates `index.html`.
