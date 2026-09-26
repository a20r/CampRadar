import json, math
import shapefile
from shapely.geometry import shape, LineString, Polygon, MultiPolygon
from shapely.ops import unary_union

# ---------- polyline encoding (Google format, 1e-5 precision) ----------
def enc_val(v):
    v = v << 1 if v >= 0 else ~(v << 1)
    out = ""
    while v >= 0x20:
        out += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
    return out + chr(v + 63)

def encode(coords):  # list of (lon, lat)
    out, px, py = [], 0, 0
    for lon, lat in coords:
        x, y = round(lon * 1e5), round(lat * 1e5)
        out.append(enc_val(y - py)); out.append(enc_val(x - px)); px, py = x, y
    return "".join(out)

def simp_line(coords, tol):
    if len(coords) < 2: return None
    ls = LineString(coords).simplify(tol, preserve_topology=False)
    return list(ls.coords)

stats = {}
out = {}

# ---------- roads (OSM) ----------
roads = json.load(open("base_roads.json"))["elements"]
CLASS = {"motorway": "mw", "trunk": "mw", "motorway_link": "lk", "trunk_link": "lk",
         "primary": "pr", "secondary": "sc", "tertiary": "tr"}
TOL = {"mw": 4e-5, "lk": 4e-5, "pr": 3e-5, "sc": 3e-5, "tr": 3e-5}
rd = {k: [] for k in ("mw", "lk", "pr", "sc", "tr")}
npts = 0
for w in roads:
    c = CLASS.get(w.get("tags", {}).get("highway"))
    if not c or "geometry" not in w: continue
    coords = [(g["lon"], g["lat"]) for g in w["geometry"]]
    s = simp_line(coords, TOL[c])
    if s: rd[c].append(encode(s)); npts += len(s)
out["roads"] = rd
stats["roads"] = {k: len(v) for k, v in rd.items()}; stats["road_pts"] = npts

# ---------- water (City topo, extended past city limits; see water_polys.pkl) ----------
import pickle
rings, npts = [], 0
for p in pickle.load(open("water_polys.pkl", "rb")):
    r = [encode(list(p.exterior.coords))]
    for i in p.interiors:
        if Polygon(i).area > 4e-7: r.append(encode(list(i.coords)))
    npts += sum(len(x.coords) for x in [p.exterior, *p.interiors])
    rings.append(r)
out["water"] = rings
stats["water_polys"] = len(rings); stats["water_pts"] = npts

# ---------- rail + streetcar (City topo) ----------
r = json.load(open("rail.geojson"))
rail, tram, npts = [], [], 0
for f in r["features"]:
    t = f["properties"].get("SUBTYPE_DESC")
    g = f["geometry"]
    lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"] if g["type"] == "MultiLineString" else []
    for ln in lines:
        if t == "Rail Track":
            s = simp_line([tuple(c[:2]) for c in ln], 1e-4)
            if s and len(s) >= 2: rail.append(encode(s)); npts += len(s)
        elif t == "Streetcar Track":
            s = simp_line([tuple(c[:2]) for c in ln], 5e-5)
            if s and len(s) >= 2: tram.append(encode(s)); npts += len(s)
out["rail"] = rail; out["tram"] = tram
stats["rail"] = len(rail); stats["tram"] = len(tram); stats["rail_pts"] = npts

# ---------- subway (TTC shapefile, drop closed Line 3) ----------
sf = shapefile.Reader("shp/TTC_SUBWAY_LINES_WGS84")
sub = []
for rec, shp in zip(sf.records(), sf.shapes()):
    if rec[2] == 3: continue
    parts = list(shp.parts) + [len(shp.points)]
    for a, b in zip(parts[:-1], parts[1:]):
        s = simp_line([tuple(p) for p in shp.points[a:b]], 3e-5)
        if s: sub.append({"n": rec[1].split(" (")[0].title(), "id": rec[2], "p": encode(s)})
out["subway"] = sub
stats["subway"] = len(sub)

# ---------- neighbourhood labels ----------
n = json.load(open("nbhd.geojson"))
places = []
for f in n["features"]:
    g = shape(f["geometry"]); c = g.representative_point()
    places.append([round(c.x, 5), round(c.y, 5), f["properties"]["AREA_NAME"]])
places.sort(key=lambda p: p[2])
out["places"] = places
stats["places"] = len(places)

# ---------- city boundary ----------
sf = shapefile.Reader("shp/citygcs_regional_mun_wgs84")
shp = sf.shapes()[0]
poly = Polygon(shp.points).simplify(1e-4)
out["boundary"] = encode(list(poly.exterior.coords))
stats["boundary_pts"] = len(poly.exterior.coords)

# ---------- toilets ----------
g = json.load(open("toronto-public-toilets.geojson"))
T = []
for f in g["features"]:
    p = f["properties"]; lon, lat = f["geometry"]["coordinates"]
    T.append({
        "n": p["name"], "la": round(lat, 6), "lo": round(lon, 6),
        "s": 1 if p["status"] == "open" else 0,
        "r": p.get("status_reason"),
        "a": {"yes": "public", "customers": "customers", "permissive": "permissive"}.get(p.get("access"), "unverified"),
        "f": p.get("fee"), "h": p.get("hours"), "ad": p.get("address"), "d": p.get("details"),
        "w": p.get("accessible"), "t": p.get("type"),
        "src": "city" if p["source"].startswith("City") else "osm", "u": p.get("url"),
    })
T = [{k: v for k, v in t.items() if v not in (None, "", "None")} for t in T]
out["toilets"] = T
stats["toilets"] = len(T)

s = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
open("mapdata.json", "w").write(s)
stats["json_kb"] = len(s.encode()) // 1024
print(json.dumps(stats, indent=1))
