# Loo Runner

Find the closest public toilet in Toronto. Single-file static site (`index.html`): neon vector map, "FIND CLOSEST" search using device location, Google Maps walking directions.

Data: 614 washrooms from City of Toronto open data (Park Washroom Facilities, incl. open/closed status) and OpenStreetMap `amenity=toilets`. Also provided as `toronto-public-toilets.gpx`, `.geojson`, and a kepler.gl map file (`.kepler.json`).

Hosting: any static host over https (geolocation requires a secure context). On GitHub Pages: Settings → Pages → Deploy from branch `main` / root.

Kepler view once hosted: `https://kepler.gl/demo?mapUrl=<https url of toronto-public-toilets.kepler.json>`
