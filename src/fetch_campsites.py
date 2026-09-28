"""Build ../campsites-us.geojson: every OSM tourism=camp_site / caravan_site in the United States,
classified by who runs it (federal, state, county/city, tribal, private), with the tags the card shows.

Usage: python3 fetch_campsites.py [raw_overpass.json]
Without an argument it queries Overpass (slow, several minutes) and caches the raw reply next to this file.
"""
import json, os, re, sys, urllib.request, urllib.parse

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "campsites_raw.json")
OUT = os.path.join(root, "campsites-us.geojson")
QUERY = """[out:json][timeout:900];
area["ISO3166-1"="US"][admin_level=2]->.a;
(nwr["tourism"="camp_site"](area.a);nwr["tourism"="caravan_site"](area.a););
out center tags;"""

if not os.path.exists(RAW):
    req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                 headers={"User-Agent": "camp-radar/1.0 (github.com/a20r/camp-radar)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=1200) as r, open(RAW, "wb") as f:
        f.write(r.read())
raw = json.load(open(RAW, encoding="utf-8"))

FEDERAL = re.compile(r"national (park|forest|monument|recreation|wildlife|seashore|lakeshore|grassland|preserve)|\bnps\b|park service|forest service|\busfs\b|\bus forest|u\.?s\.? forest|bureau of land|\bblm\b|army corps|corps of engineers|\busace\b|fish (and|&) wildlife|\bfws\b|bureau of reclamation|\busbr\b|tennessee valley|\btva\b|federal|department of the interior|\bdoi\b|national|united states", re.I)
STATE = re.compile(r"state (park|forest|recreation|wildlife|game|fish|beach|historic|trust|lands?)|\bdcr\b|conservation and recreation|conservation & recreation|department of natural resources|\bdnr\b|dept\.? of natural|parks (and|&) (recreation|wildlife)|fish (and|&) game|\bdec\b|department of environmental|state of \w+|commonwealth of|\b(california|texas|florida|new york|pennsylvania|illinois|ohio|georgia|north carolina|michigan|new jersey|virginia|washington|arizona|massachusetts|tennessee|indiana|maryland|missouri|wisconsin|colorado|minnesota|south carolina|alabama|louisiana|kentucky|oregon|oklahoma|connecticut|utah|iowa|nevada|arkansas|mississippi|kansas|new mexico|nebraska|idaho|west virginia|hawaii|new hampshire|maine|montana|rhode island|delaware|south dakota|north dakota|alaska|vermont|wyoming) (state|department|dept|division|parks)", re.I)
LOCAL = re.compile(r"county|city of|town of|village of|municipal|metro ?parks?|regional park|park district|township|borough", re.I)
TRIBAL = re.compile(r"tribe|tribal|nation\b|band of|pueblo|reservation", re.I)
PRIVATE = re.compile(r"\bkoa\b|kampgrounds of america|resort|rv park|\bllc\b|\binc\b|campground(s)? (llc|inc)|thousand trails|jellystone|good sam|holiday|ranch|farm|church|scout|ymca|association|club|association", re.I)

def classify(t):
    op = " ".join(x for x in (t.get("operator"), t.get("owner"), t.get("name")) if x)
    ot, own = (t.get("operator:type") or "").lower(), (t.get("ownership") or "").lower()
    if own == "national" or FEDERAL.search(t.get("operator", "") + " " + t.get("owner", "")): return "Federal"
    if own == "state" or STATE.search(op): return "State"
    if own in ("municipal", "county", "regional") or LOCAL.search(t.get("operator", "") + " " + t.get("owner", "")): return "County / city"
    if TRIBAL.search(t.get("operator", "")): return "Tribal"
    if ot in ("private", "business", "commercial") or own == "private" or PRIVATE.search(op): return "Private"
    if ot in ("government", "public") or own == "public": return "Public (unspecified)"
    if FEDERAL.search(t.get("name", "")): return "Federal"
    if STATE.search(t.get("name", "")): return "State"
    return "Unclassified"

def yesno(v):
    if v is None: return None
    v = v.lower()
    return "yes" if v in ("yes", "true", "1", "designated", "permissive") else "no" if v in ("no", "false", "0", "none") else v

feats, kinds = [], {}
for e in raw["elements"]:
    t = e.get("tags") or {}
    if "lat" in e: lat, lon = e["lat"], e["lon"]
    elif "center" in e: lat, lon = e["center"]["lat"], e["center"]["lon"]
    else: continue
    kind = classify(t)
    kinds[kind] = kinds.get(kind, 0) + 1
    cs = t.get("tourism") == "caravan_site"
    name = t.get("name") or t.get("official_name") or t.get("alt_name")
    if not name:
        who = t.get("operator")
        name = f"{who} {'RV site' if cs else 'campsite'}" if who else ("RV site" if cs else "Campsite")
    amen = []
    if yesno(t.get("tents")) == "yes": amen.append("Tents")
    if cs or yesno(t.get("caravans")) == "yes" or yesno(t.get("motorhome")) == "yes": amen.append("RVs")
    if yesno(t.get("backcountry")) == "yes": amen.append("Backcountry")
    if yesno(t.get("toilets")) == "yes": amen.append("Toilets")
    if yesno(t.get("shower")) == "yes": amen.append("Showers")
    if yesno(t.get("drinking_water")) == "yes": amen.append("Drinking water")
    if yesno(t.get("power_supply")) not in (None, "no"): amen.append("Power")
    if yesno(t.get("dog")) == "yes": amen.append("Dogs OK")
    addr = ", ".join(x for x in ((t.get("addr:housenumber", "") + " " + t.get("addr:street", "")).strip(), t.get("addr:city"), t.get("addr:state")) if x)
    props = {
        "name": name,
        "kind": kind + (" · RV" if cs else ""),
        "operator": t.get("operator"),
        "access": t.get("access"),
        "fee": t.get("fee"),
        "hours": t.get("opening_hours") or t.get("seasonal"),
        "reservation": t.get("reservation"),
        "capacity": t.get("capacity"),
        "amenities": " · ".join(amen) or None,
        "desc": t.get("description"),
        "addr": addr or None,
        "phone": t.get("phone") or t.get("contact:phone"),
        "url": t.get("website") or t.get("contact:website") or t.get("url"),
        "osm": f"{e['type']}/{e['id']}",
    }
    props = {k: v for k, v in props.items() if v}
    feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}, "properties": props})

feats.sort(key=lambda f: (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]))
fc = {"type": "FeatureCollection", "name": "US campsites (OpenStreetMap)", "features": feats}
json.dump(fc, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
print(len(feats), "campsites ->", OUT, os.path.getsize(OUT) // 1024, "KB")
for k, v in sorted(kinds.items(), key=lambda kv: -kv[1]): print(f"  {v:6d}  {k}")
