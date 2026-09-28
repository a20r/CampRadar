"""Inline the sources and the Toronto sample into a single static index.html at the repo root."""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
rd = lambda f: open(os.path.join(here, f), encoding="utf-8").read()
safe = lambda s: s.replace("</", "<\\/")

# sample: the Toronto GeoJSON with null properties dropped, so the bundle stays small
sample = json.load(open(os.path.join(root, "toronto-public-toilets.geojson"), encoding="utf-8"))
for f in sample["features"]:
    f["properties"] = {k: v for k, v in f["properties"].items() if v not in (None, "", "unknown")}
    f["geometry"]["coordinates"] = [round(c, 6) for c in f["geometry"]["coordinates"]]
sample_js = safe(json.dumps(sample, separators=(",", ":"), ensure_ascii=False))

head = rd("page_head.html")
markup = rd("page_markup.html")
scripts = (
    f"<script>window.SAMPLE_DATA={sample_js};</script>\n"
    f"<script>\n{safe(rd('parse.js'))}\n</script>\n"
    f"<script>\n{safe(rd('app.js'))}\n</script>\n"
)

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#04060c">
<meta name="description" content="Find the closest campsite. Every federal, state, county and private campsite in the US, on a neon radar map. Drop in your own GeoJSON, CSV, GPX or KML for any city and Camp Radar keeps it in your browser and routes you to the nearest one.">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
{head}
</head>
<body>
{markup}
{scripts}
</body>
</html>
"""
out = os.path.join(root, "index.html")
open(out, "w", encoding="utf-8").write(page)
print("index.html", len(page.encode()) // 1024, "KB")
