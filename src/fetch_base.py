import json, subprocess, sys, time, os

MIRRORS = ["https://overpass.kumi.systems/api/interpreter",
           "https://overpass-api.de/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
BBOX = "43.55,-79.72,43.90,-79.05"
AREA = 'area["boundary"="administrative"]["admin_level"="6"]["name"="Toronto"]->.a;'

QUERIES = {
    "roads": f'''[out:json][timeout:300];{AREA}
(
  way["highway"~"^(motorway|trunk|primary|motorway_link|trunk_link)$"]({BBOX});
  way["highway"~"^(secondary|tertiary)$"](area.a);
);
out geom;''',
    "coast": f'[out:json][timeout:180];way["natural"="coastline"]({BBOX});out geom;',
    "rivers": f'[out:json][timeout:180];way["waterway"="river"]({BBOX});out geom;',
    "water": f'[out:json][timeout:180];{AREA}way["natural"="water"](area.a);out geom;',
    "transit": f'[out:json][timeout:180];{AREA}relation["route"~"^(subway|light_rail)$"](area.a);out geom;',
    "rail": f'[out:json][timeout:180];way["railway"="rail"]["usage"="main"]({BBOX});out geom;',
    "places": f'[out:json][timeout:180];{AREA}node["place"~"^(neighbourhood|suburb|quarter)$"](area.a);out;',
    "boundary": '[out:json][timeout:180];relation["boundary"="administrative"]["admin_level"="6"]["name"="Toronto"];out geom;',
}

def fetch(name, q):
    out = f"base_{name}.json"
    if os.path.exists(out) and os.path.getsize(out) > 100:
        print(name, "cached"); return
    for m in MIRRORS:
        r = subprocess.run(["curl", "-sS", "-m", "400", "-o", out, "--data-urlencode", f"data={q}", m],
                           capture_output=True, text=True)
        try:
            d = json.load(open(out))
            print(name, m.split('/')[2], len(d.get("elements", [])), "elements", os.path.getsize(out)//1024, "KB")
            return
        except Exception as e:
            print(name, m, "failed:", r.stderr.strip()[:120], e)
            time.sleep(3)
    sys.exit(f"could not fetch {name}")

for k, q in QUERIES.items():
    fetch(k, q)
