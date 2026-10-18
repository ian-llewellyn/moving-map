#!/usr/bin/env python3
"""Build the static airfields dataset from OpenStreetMap.

Each airfield gets an aeroplane marker plus its runway directions. Derived
from `aeroway=aerodrome` and `aeroway=runway` within the region. Runways
that cannot be matched to an aerodrome become unnamed airfields of their
own, so small strips are still represented.

Regions: ie (island of Ireland), gb (Great Britain + Jersey, Guernsey and
the Isle of Man, excluding Northern Ireland which is in `ie`), fr
(metropolitan France + Corsica).

Run once and commit data/airfields.<code>.json:
    python3 tools/fetch_airfields.py [ie gb fr]

Regions default to all; an existing region file is skipped unless
--force is given.
"""

import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

UA = "hsi-airfields/1.0 (personal moving-map project)"

# Coarse outline of the island, matching tools/fetch_towns.py.
ISLAND_POLY = [
    (55.38, -7.37), (54.90, -8.50), (54.30, -8.90), (54.00, -10.00),
    (53.50, -9.90), (53.20, -9.50), (52.70, -9.80), (52.10, -10.50),
    (51.60, -10.30), (51.50, -9.50), (51.70, -8.40), (51.90, -7.60),
    (52.20, -6.30), (52.60, -5.90), (53.30, -6.10), (53.70, -6.30),
    (54.00, -6.00), (54.30, -5.70), (54.60, -5.50), (54.85, -5.80),
    (55.20, -6.10), (55.20, -7.00), (55.38, -7.37),
]

REGIONS = {
    "ie": {"name": "Ireland", "poly": ISLAND_POLY},
    "gb": {"name": "Great Britain", "areas": ["GB", "JE", "GG", "IM"],
           "subtract_poly": ISLAND_POLY},
    "fr": {"name": "France (metropolitan + Corsica)", "areas": ["FR"],
           "bbox": (41.0, -5.5, 51.5, 10.0)},
}

AERODROME_FILTER = '["aeroway"~"^(aerodrome|airstrip)$"]'

# Regions with a bbox are fetched in tiles of this size (degrees) so no
# single Overpass query is large enough to time out.
TILE_DEG = 3.0
FETCH_TIMEOUT = 240

MERGE_M = 1200      # merge aerodrome elements (node + area) this close
MATCH_M = 2500      # assign a runway to the nearest aerodrome within this
CLUSTER_M = 1500    # group orphan runways this close into one airfield
EARTH_R = 6371000.0


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
        poly = fmt_poly(region["poly"])
        parts.append(f'nwr{AERODROME_FILTER}(poly:"{poly}"){box};')
        parts.append(f'way["aeroway"="runway"](poly:"{poly}"){box};')
    for i, code in enumerate(region.get("areas", [])):
        out.append(f'area["ISO3166-1"="{code}"]["admin_level"="2"]->.a{i};')
        parts.append(f'nwr{AERODROME_FILTER}(area.a{i}){box};')
        parts.append(f'way["aeroway"="runway"](area.a{i}){box};')
    union = "(" + "".join(parts) + ")"
    if region.get("subtract_poly"):
        poly = fmt_poly(region["subtract_poly"])
        out.append(union + "->.all;")
        out.append(f'nwr{AERODROME_FILTER}(poly:"{poly}"){box}->.x1;')
        out.append(f'way["aeroway"="runway"](poly:"{poly}"){box}->.x2;')
        out.append("(.x1; .x2;)->.excl;")
        out.append("(.all; - .excl;);")
    else:
        out.append(union + ";")
    out.append("out geom;")
    return "".join(out)


def fetch_data(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for endpoint in OVERPASS_ENDPOINTS:
        req = urllib.request.Request(endpoint, data=body, headers={"User-Agent": UA})
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
        doc = fetch_data(build_query(region, tile))
        for el in doc.get("elements", []):
            elements[(el.get("type"), el.get("id"))] = el
    return list(elements.values())


def haversine(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def bearing(a, b):
    """Initial true bearing from a to b, degrees [0, 360)."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def element_coords(el):
    """All coordinates Overpass returned for an element (geo output)."""
    if el.get("type") == "node":
        if "lat" in el and "lon" in el:
            return [(el["lat"], el["lon"])]
        return []
    coords = []
    for g in el.get("geometry") or []:
        if "lat" in g and "lon" in g:
            coords.append((g["lat"], g["lon"]))
    for m in el.get("members") or []:
        for g in m.get("geometry") or []:
            if "lat" in g and "lon" in g:
                coords.append((g["lat"], g["lon"]))
    return coords


def in_bbox(coords, bbox):
    return any(
        bbox[0] <= lat <= bbox[2] and bbox[1] <= lon <= bbox[3]
        for lat, lon in coords
    )


def centroid(coords):
    if not coords:
        return None
    return (
        sum(c[0] for c in coords) / len(coords),
        sum(c[1] for c in coords) / len(coords),
    )


def runway_info(el):
    coords = [
        (g["lat"], g["lon"])
        for g in el.get("geometry") or []
        if "lat" in g and "lon" in g
    ]
    if len(coords) < 2:
        return None
    a, b = coords[0], coords[-1]
    mid = ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
    length = sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
    return {
        "mid": mid,
        "hdg": int(round(bearing(a, b))) % 180,
        "lengthM": int(round(length)),
    }


def airfield_key(tags):
    icao = (tags.get("icao") or "").strip().upper()
    if icao:
        return "icao:" + icao
    name = (tags.get("name") or "").strip().lower()
    return "name:" + name if name else None


class Aerodrome:
    def __init__(self, key, name, icao, lat, lon, elem):
        self.key = key
        self.name = name
        self.icao = icao
        self.lat = lat
        self.lon = lon
        self.elem = elem
        self.runways = []


def fmt(runways):
    return [{"hdg": r["hdg"], "lengthM": r["lengthM"]} for r in runways]


def build(code, force=False):
    region = REGIONS[code]
    dest = Path(__file__).resolve().parent.parent / "data" / f"airfields.{code}.json"
    if dest.exists() and not force:
        print(f"{code}: {dest} exists; skipping (use --force to rebuild)", file=sys.stderr)
        return
    bbox = region.get("bbox")
    elements = fetch_elements(region)
    if bbox:
        elements = [el for el in elements if in_bbox(element_coords(el), bbox)]

    aerodromes = []
    runway_ways = []
    for el in elements:
        tags = el.get("tags", {})
        kind = tags.get("aeroway")
        if kind == "runway":
            runway_ways.append(el)
        elif kind in ("aerodrome", "airstrip"):
            pt = centroid(element_coords(el))
            if pt is None:
                continue
            name = (tags.get("name") or "").strip() or None
            icao = (tags.get("icao") or "").strip().upper() or None
            aerodromes.append(Aerodrome(airfield_key(tags), name, icao, pt[0], pt[1], el))

    # Deduplicate: merge a compatible aerodrome into an earlier kept one.
    kept = []
    for af in aerodromes:
        hit = None
        for other in kept:
            if haversine((af.lat, af.lon), (other.lat, other.lon)) > MERGE_M:
                continue
            compatible = (
                (af.key and af.key == other.key) or af.key is None or other.key is None
            )
            if compatible:
                hit = other
                break
        if hit is None:
            kept.append(af)
        else:
            if hit.icao is None and af.icao:
                hit.icao, hit.key = af.icao, af.key
            if hit.name is None and af.name:
                hit.name = af.name

    orphans = []
    for el in runway_ways:
        info = runway_info(el)
        if info is None:
            continue
        best, best_d = None, None
        for af in kept:
            d = haversine(info["mid"], (af.lat, af.lon))
            if best_d is None or d < best_d:
                best_d, best = d, af
        if best is not None and best_d is not None and best_d <= MATCH_M:
            best.runways.append(info)
        else:
            orphans.append((info, el))

    clusters = []
    for info, el in orphans:
        group = next(
            (c for c in clusters if haversine(info["mid"], (c["lat"], c["lon"])) <= CLUSTER_M),
            None,
        )
        if group is None:
            group = {"lat": info["mid"][0], "lon": info["mid"][1], "runways": [], "ids": []}
            clusters.append(group)
        group["runways"].append(info)
        if el.get("id") is not None:
            group["ids"].append(el["id"])

    airfields = []
    for af in kept:
        if not af.runways and not af.name and not af.icao:
            continue
        airfields.append(
            {
                "id": f"osm:{af.elem.get('type')}/{af.elem.get('id')}",
                "name": af.name,
                "lat": round(af.lat, 6),
                "lon": round(af.lon, 6),
                "icao": af.icao,
                "runways": fmt(af.runways),
            }
        )
    for cl in clusters:
        wid = min(cl["ids"]) if cl["ids"] else 0
        airfields.append(
            {
                "id": f"osm:runway/{wid}",
                "name": None,
                "lat": round(cl["lat"], 6),
                "lon": round(cl["lon"], 6),
                "icao": None,
                "runways": fmt(cl["runways"]),
            }
        )

    airfields.sort(key=lambda a: ((a["name"] or "~").lower(), a["lat"]))
    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "OpenStreetMap contributors (ODbL)",
        "region": code,
        "regionName": region["name"],
        "count": len(airfields),
        "airfields": airfields,
    }
    dest = Path(__file__).resolve().parent.parent / "data" / f"airfields.{code}.json"
    dest.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    named = sum(1 for a in airfields if a["name"])
    with_rw = sum(1 for a in airfields if a["runways"])
    print(
        f"wrote {len(airfields)} airfields "
        f"({named} named, {with_rw} with runways) to {dest}",
        file=sys.stderr,
    )


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
