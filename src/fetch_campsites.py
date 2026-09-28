"""Build ../campsites-us.geojson: every OSM tourism=camp_site / caravan_site in the United States,
classified by who runs it (federal, state, county/city, tribal, private), enriched with the park or
protected area each one sits in, and carrying the tags the card shows.

Usage: python3 fetch_campsites.py
Raw Overpass replies are cached next to this file (campsites_raw.json, parks_*.json, all git-ignored);
delete one to refetch it. The parks query uses bounding boxes per region because the whole-country
area query is too heavy for the public mirrors.
"""
import json, os, re, sys, time, urllib.request, urllib.parse

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
OUT = os.path.join(root, "campsites-us.geojson")
UA = "camp-radar/1.0 (github.com/a20r/CampRadar)"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.openstreetmap.fr/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

CAMP_QUERY = """[out:json][timeout:900];
area["ISO3166-1"="US"][admin_level=2]->.a;
(nwr["tourism"="camp_site"](area.a);nwr["tourism"="caravan_site"](area.a););
out center tags;"""
PARK_FILTER = """(wr["boundary"="protected_area"];wr["boundary"="national_park"];wr["leisure"="nature_reserve"];
wr["leisure"="park"]["name"~"State (Park|Forest|Recreation|Beach)|National (Forest|Park|Recreation|Seashore|Lakeshore|Grassland|Monument|Preserve)|County Park|Regional Park|State Game|Wildlife (Area|Management|Refuge)",i];
wr["landuse"="forest"]["name"~"State Forest|National Forest",i];);
out tags bb;"""
# CONUS is tiled so no single request exceeds what the public mirrors allow
PARK_REGIONS = {f"conus_{la}_{lo}": f"{la},{lo},{min(la + 9, 50)},{min(lo + 12, -66)}" for la in range(24, 50, 9) for lo in range(-125, -66, 12)}
PARK_REGIONS.update({"ak": "51,-180,72,-129", "hi": "18,-161,23,-154", "pr": "17,-68,19,-64"})

def overpass(query, path):
    if os.path.exists(path): return json.load(open(path, encoding="utf-8"))
    last = None
    for attempt in range(6):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(), headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=1400) as r: body = r.read()
            data = json.loads(body)
            if data.get("remark", "").startswith("runtime error"): raise RuntimeError(data["remark"])
            open(path, "wb").write(body)
            return data
        except Exception as e:  # noqa: BLE001 - any mirror failure just moves to the next one
            last = e; print(f"  {url}: {e}", file=sys.stderr); time.sleep(10 * (attempt + 1))
    raise SystemExit(f"Overpass failed: {last}")

raw = overpass(CAMP_QUERY, os.path.join(here, "campsites_raw.json"))
parks, seen = [], set()
for region, bbox in PARK_REGIONS.items():
    for el in overpass(f"[out:json][timeout:600][bbox:{bbox}];\n{PARK_FILTER}", os.path.join(here, f"parks_{region}.json")).get("elements", []):
        if (el["type"], el["id"]) not in seen: seen.add((el["type"], el["id"])); parks.append(el)

FEDERAL = re.compile(r"national (park|forest|monument|recreation|wildlife|seashore|lakeshore|grassland|preserve|scenic|historic|battlefield)|\bnps\b|park service|forest service|\busfs\b|\bus forest|u\.?s\.? forest|bureau of land|\bblm\b|army corps|corps of engineers|\busace\b|fish (and|&) wildlife|\bfws\b|bureau of reclamation|\busbr\b|tennessee valley|\btva\b|federal|department of the interior|\bdoi\b|national|united states", re.I)
STATE = re.compile(r"state (park|forest|recreation|wildlife|game|fish|beach|historic|trust|lands?|natural|scenic)|\bdcr\b|conservation and recreation|conservation & recreation|department of natural resources|\bdnr\b|dept\.? of natural|parks (and|&) (recreation|wildlife)|fish (and|&) game|\bdec\b|department of environmental|state of \w+|commonwealth of|\b(california|texas|florida|new york|pennsylvania|illinois|ohio|georgia|north carolina|michigan|new jersey|virginia|washington|arizona|massachusetts|tennessee|indiana|maryland|missouri|wisconsin|colorado|minnesota|south carolina|alabama|louisiana|kentucky|oregon|oklahoma|connecticut|utah|iowa|nevada|arkansas|mississippi|kansas|new mexico|nebraska|idaho|west virginia|hawaii|new hampshire|maine|montana|rhode island|delaware|south dakota|north dakota|alaska|vermont|wyoming) (state|department|dept|division|parks)", re.I)
LOCAL = re.compile(r"county|city of|town of|village of|municipal|metro ?parks?|regional park|park district|township|borough", re.I)
TRIBAL = re.compile(r"tribe|tribal|nation\b|band of|pueblo|reservation", re.I)
PRIVATE = re.compile(r"\bkoa\b|kampgrounds of america|resort|rv park|\bllc\b|\binc\b|campground(s)? (llc|inc)|thousand trails|jellystone|good sam|holiday|ranch|farm|church|scout|ymca|association|club|conservancy|land trust|nature conservancy|audubon", re.I)

def classify(t, use_name=True):
    op = " ".join(x for x in (t.get("operator"), t.get("owner"), t.get("name") if use_name else None) if x)
    own = (t.get("operator:type") or "").lower(), (t.get("ownership") or "").lower()
    ot, own = own
    who = t.get("operator", "") + " " + t.get("owner", "")
    if own == "national" or FEDERAL.search(who): return "Federal"
    if own == "state" or STATE.search(op): return "State"
    if own in ("municipal", "county", "regional") or LOCAL.search(who): return "County / city"
    if TRIBAL.search(t.get("operator", "")): return "Tribal"
    if ot in ("private", "business", "commercial") or own == "private" or PRIVATE.search(op): return "Private"
    if ot in ("government", "public") or own == "public": return "Public (unspecified)"
    if use_name and FEDERAL.search(t.get("name", "")): return "Federal"
    if use_name and STATE.search(t.get("name", "")): return "State"
    return "Unclassified"

def yesno(v):
    if v is None: return None
    v = v.lower()
    return "yes" if v in ("yes", "true", "1", "designated", "permissive") else "no" if v in ("no", "false", "0", "none") else v

# ---- park index: bounding boxes in 1-degree cells, smallest containing box wins
CELL = {}
park_rows = []
for p in parks:
    b, t = p.get("bounds"), p.get("tags") or {}
    name = t.get("name")
    if not b or not name: continue
    dlat, dlon = b["maxlat"] - b["minlat"], b["maxlon"] - b["minlon"]
    if dlat * dlon > 30 or dlat > 8 or dlon > 8: continue  # statewide land designations, not a place
    kind = classify(t)
    if kind == "Unclassified":
        pc = t.get("protect_class", "")
        if pc in ("2", "3", "5") and re.search(r"national", name, re.I): kind = "Federal"
    row = (b["minlat"], b["minlon"], b["maxlat"], b["maxlon"], dlat * dlon, name, kind, t.get("operator") or t.get("owner"), t.get("website"))
    i = len(park_rows); park_rows.append(row)
    for la in range(int(b["minlat"] // 1), int(b["maxlat"] // 1) + 1):
        for lo in range(int(b["minlon"] // 1), int(b["maxlon"] // 1) + 1):
            CELL.setdefault((la, lo), []).append(i)

def park_for(lat, lon):
    best = None
    for i in CELL.get((int(lat // 1), int(lon // 1)), ()):
        r = park_rows[i]
        if r[0] <= lat <= r[2] and r[1] <= lon <= r[3] and (best is None or r[4] < best[4]): best = r
    return best

AMENITY_TAGS = [
    ("tents", "Tents"), ("caravans", "RVs"), ("motorhome", "RVs"), ("backcountry", "Backcountry"), ("group_only", "Group only"),
    ("toilets", "Toilets"), ("shower", "Showers"), ("drinking_water", "Drinking water"), ("sanitary_dump_station", "Dump station"),
    ("power_supply", "Power"), ("picnic_table", "Picnic tables"), ("fireplace", "Fire rings"), ("openfire", "Open fires OK"), ("bbq", "BBQ"),
    ("internet_access", "Wi-Fi"), ("laundry", "Laundry"), ("shop", "Store"), ("swimming_pool", "Pool"), ("swimming", "Swimming"),
    ("boat", "Boat access"), ("bicycle", "Bikes"), ("dog", "Dogs OK"), ("wheelchair", "Wheelchair access"), ("permanent_camping", "Long-term stays"),
]
feats, kinds, enriched = [], {}, 0
for e in raw["elements"]:
    t = e.get("tags") or {}
    if "lat" in e: lat, lon = e["lat"], e["lon"]
    elif "center" in e: lat, lon = e["center"]["lat"], e["center"]["lon"]
    else: continue
    cs = t.get("tourism") == "caravan_site"
    kind = classify(t)
    operator = t.get("operator")
    park = park_for(lat, lon)
    park_name = park_url = None
    if park:
        park_name = park[5]
        if kind == "Unclassified" and park[6] != "Unclassified": kind = park[6]; enriched += 1
        if not operator and park[7]: operator = park[7]
        park_url = park[8]
    kinds[kind] = kinds.get(kind, 0) + 1
    name = t.get("name") or t.get("official_name") or t.get("alt_name")
    if not name:
        base = "RV site" if cs else "Campsite"
        name = f"{park_name} {base.lower()}" if park_name else f"{operator} {base.lower()}" if operator else base
    amen = []
    for tag, label in AMENITY_TAGS:
        v = yesno(t.get(tag))
        if v not in (None, "no") and label not in amen: amen.append(label)
    if cs and "RVs" not in amen: amen.insert(0, "RVs")
    if t.get("site_type"): amen.append(t["site_type"].replace("_", " ").capitalize())
    addr = ", ".join(x for x in ((t.get("addr:housenumber", "") + " " + t.get("addr:street", "")).strip(), t.get("addr:city"), t.get("addr:state")) if x)
    stay = " · ".join(x for x in (f"max {t['max_stay']}" if t.get("max_stay") else None, f"{t['stars']}★" if t.get("stars") else None) if x)
    props = {
        "name": name,
        "kind": kind + (" · RV" if cs else ""),
        "park": park_name,
        "operator": operator,
        "access": t.get("access"),
        "fee": t.get("fee") or (t.get("charge") and "yes"),
        "cost": t.get("charge"),
        "hours": t.get("opening_hours"),
        "season": t.get("seasonal"),
        "reservation": t.get("reservation"),
        "capacity": t.get("capacity"),
        "stay": stay or None,
        "amenities": " · ".join(amen) or None,
        "desc": t.get("description") or t.get("note"),
        "addr": addr or None,
        "phone": t.get("phone") or t.get("contact:phone"),
        "email": t.get("email") or t.get("contact:email"),
        "url": t.get("website") or t.get("contact:website") or t.get("url") or park_url,
        "osm": f"{e['type']}/{e['id']}",
    }
    props = {k: v for k, v in props.items() if v}
    feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}, "properties": props})

feats.sort(key=lambda f: (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]))
fc = {"type": "FeatureCollection", "name": "US campsites (OpenStreetMap)", "features": feats}
json.dump(fc, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
print(len(feats), "campsites ->", OUT, os.path.getsize(OUT) // 1024, "KB;", len(park_rows), "parks indexed;", sum(1 for f in feats if "park" in f["properties"]), "sites inside a park;", enriched, "classified via their park")
for k, v in sorted(kinds.items(), key=lambda kv: -kv[1]): print(f"  {v:6d}  {k}")
