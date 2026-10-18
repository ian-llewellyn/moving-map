#!/usr/bin/env python3
"""Fetch the static villages/towns/cities dataset for a region.

Data source: OpenStreetMap via the Overpass API (ODbL).
Run once at build time:  python3 tools/fetch_towns.py [ie gb fr]

Each region is written to data/towns.<code>.json. Regions default to all;
an existing region file is skipped unless --force is given.
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "hsi-build/1.0 (personal project; offline moving-map)"

# Coarse outline of the island of Ireland (lat lon pairs, clockwise).
ISLAND_POLY = [
    (55.38, -7.37), (54.90, -8.50), (54.30, -8.90), (54.00, -10.00),
    (53.50, -9.90), (53.20, -9.50), (52.70, -9.80), (52.10, -10.50),
    (51.60, -10.30), (51.50, -9.50), (51.70, -8.40), (51.90, -7.60),
    (52.20, -6.30), (52.60, -5.90), (53.30, -6.10), (53.70, -6.30),
    (54.00, -6.00), (54.30, -5.70), (54.60, -5.50), (54.85, -5.80),
    (55.20, -6.10), (55.20, -7.00), (55.38, -7.37),
]

# GB plus the crown dependencies that ISO 3166-1 GB omits (Jersey,
# Guernsey/Alderney/Sark, Isle of Man); Ireland is subtracted to avoid
# duplicating Northern Ireland.
# France is limited to metropolitan France + Corsica by bbox.
REGIONS = {
    "ie": {"name": "Ireland", "poly": ISLAND_POLY},
    "gb": {"name": "Great Britain", "areas": ["GB", "JE", "GG", "IM"],
           "subtract_poly": ISLAND_POLY},
    "fr": {"name": "France (metropolitan + Corsica)", "areas": ["FR"],
           "bbox": (41.0, -5.5, 51.5, 10.0)},
}

PLACE_FILTER = '["place"~"^(city|town|village)$"]'

# Regions with a bbox are fetched in tiles of this size (degrees) so no
# single Overpass query is large enough to time out.
TILE_DEG = 3.0
FETCH_TIMEOUT = 240

# Fallback radius (km) by OSM place type when population is unknown.
DEFAULT_RADIUS_KM = {"city": 3.0, "town": 1.0, "village": 0.35}


def radius_km(tags):
    pop = tags.get("population")
    if pop:
        try:
            n = float(str(pop).replace(",", "").split(";")[0].strip())
        except ValueError:
            n = 0
        if n > 0:
            # Urban radius grows ~ sqrt(population); calibrated against Irish towns.
            return max(0.25, min(12.0, 0.01 * math.sqrt(n)))
    return DEFAULT_RADIUS_KM.get(tags.get("place"), 0.35)


def fmt_poly(coords):
    return " ".join(f"{lat} {lon}" for lat, lon in coords)


def tiles_for(bbox):
    """Cover a bbox with TILE_DEG chunks (s, w, n, e)."""
    s, w, n, e = bbox
    tiles = []
    lat = s
    while lat < n:
        top = min(lat + TILE_DEG, n)
        lon = w
        while lon < e:
            right = min(lon + TILE_DEG, e)
            tiles.append((round(lat, 4), round(lon, 4), round(top, 4), round(right, 4)))
            lon += TILE_DEG
        lat += TILE_DEG
    return tiles


def bbox_filter(bbox):
    return f"({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]})" if bbox else ""


def build_query(region, bbox=None):
    box = bbox_filter(bbox)
    out = ["[out:json][timeout:300];"]
    parts = []
    if region.get("poly"):
        parts.append(f'node{PLACE_FILTER}(poly:"{fmt_poly(region["poly"])}"){box};')
    for i, code in enumerate(region.get("areas", [])):
        out.append(f'area["ISO3166-1"="{code}"]["admin_level"="2"]->.a{i};')
        parts.append(f"node{PLACE_FILTER}(area.a{i}){box};")
    union = "(" + "".join(parts) + ")"
    if region.get("subtract_poly"):
        out.append(union + "->.all;")
        out.append(
            f'node{PLACE_FILTER}(poly:"{fmt_poly(region["subtract_poly"])}"){box}->.excl;'
        )
        out.append("(.all; - .excl;);")
    else:
        out.append(union + ";")
    out.append("out;")
    return "".join(out)


def fetch(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for endpoint in OVERPASS_ENDPOINTS:
        req = urllib.request.Request(
            endpoint, data=body, headers={"User-Agent": UA}
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
                    return json.load(resp)
            except (urllib.error.URLError, TimeoutError) as exc:
                last = exc
                print(f"{endpoint}: {exc}; retrying", file=sys.stderr)
                time.sleep(min(60, 5 * 2**attempt))
    raise SystemExit(f"Overpass request failed: {last}")


def fetch_elements(region):
    """All elements for a region, tile by tile for bbox regions."""
    bbox = region.get("bbox")
    tiles = tiles_for(bbox) if bbox else [None]
    elements = {}
    for i, tile in enumerate(tiles):
        if len(tiles) > 1:
            print(f"  tile {i + 1}/{len(tiles)} {tile}", file=sys.stderr)
        doc = fetch(build_query(region, tile))
        for el in doc.get("elements", []):
            elements[(el.get("type"), el.get("id"))] = el
    return list(elements.values())


def build(code, force=False):
    region = REGIONS[code]
    dest = os.path.join(os.path.dirname(__file__), "..", "data", f"towns.{code}.json")
    dest = os.path.abspath(dest)
    if os.path.exists(dest) and not force:
        print(f"{code}: {dest} exists; skipping (use --force to rebuild)", file=sys.stderr)
        return
    elements = fetch_elements(region)
    bbox = region.get("bbox")
    places = []
    seen = set()
    for el in elements:
        tags = el.get("tags", {})
        if "lat" not in el or "lon" not in el:
            continue
        if bbox and not (bbox[0] <= el["lat"] <= bbox[2] and bbox[1] <= el["lon"] <= bbox[3]):
            continue
        name = tags.get("name")
        if not name:
            continue
        key = (name, round(el["lat"], 4), round(el["lon"], 4))
        if key in seen:
            continue
        seen.add(key)
        places.append(
            {
                "name": name,
                "lat": round(el["lat"], 6),
                "lon": round(el["lon"], 6),
                "radiusKm": round(radius_km(tags), 3),
            }
        )
    places.sort(key=lambda p: p["name"].casefold())

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "OpenStreetMap contributors (ODbL)",
        "region": code,
        "regionName": region["name"],
        "count": len(places),
        "places": places,
    }
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print(f"wrote {len(places)} places to {dest}", file=sys.stderr)


def main(argv):
    force = "--force" in argv
    codes = [a for a in argv if a != "--force"] or list(REGIONS)
    for code in codes:
        if code not in REGIONS:
            raise SystemExit(f"unknown region {code!r}; choose from {', '.join(REGIONS)}")
    for code in codes:
        build(code, force)


if __name__ == "__main__":
    main(sys.argv[1:])
