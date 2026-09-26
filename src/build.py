import json, os
here = os.path.dirname(os.path.abspath(__file__))
rd = lambda f: open(os.path.join(here, f), encoding="utf-8").read()
data = rd("mapdata.json").replace("</", "<\\/")
head = rd("page_head.html")
markup = rd("page_markup.html")
app = rd("app.js")
scripts = f"<script>window.MAPDATA={data};</script>\n<script>\n{app}\n</script>\n"

standalone = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#04060c">
<meta name="description" content="Find the closest public toilet in Toronto. 614 washrooms from City of Toronto open data and OpenStreetMap, on a neon vector map.">
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
os.makedirs(os.path.join(here, "site"), exist_ok=True)
open(os.path.join(here, "site", "index.html"), "w", encoding="utf-8").write(standalone)
open(os.path.join(here, "site", "loo-runner-artifact.html"), "w", encoding="utf-8").write(head + "\n" + markup + "\n" + scripts)
print("index.html", len(standalone.encode()) // 1024, "KB")
