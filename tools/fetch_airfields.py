#!/usr/bin/env python3
"""Build the static airfields dataset from OpenStreetMap (island of Ireland).

Each airfield gets an aeroplane marker plus its runway directions. Derived
from `aeroway=aerodrome` and `aeroway=runway` within the island polygon.
Runways that cannot be matched to an aerodrome become unnamed airfields of
their own, so small strips are still represented.

Run once and commit data/airfields.json:
    python3 tools/fetch_airfields.py
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
    "https://overpass.kumi.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
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

MERGE_M = 1200      # merge aerodrome elements (node + area) this close
MATCH_M = 2500      # assign a runway to the nearest aerodrome within this
CLUSTER_M = 1500    # group orphan runways this close into one airfield
EARTH_R = 6371000.0


def build_query():
    poly = " ".join(f"{lat} {lon}" for lat, lon in ISLAND_POLY)
    return (
        "[out:json][timeout:180];"
        "("
        f'nwr["aeroway"~"^(aerodrome|airstrip)$"](poly:"{poly}");'
        f'way["aeroway"="runway"](poly:"{poly}");'
        ");out geom;"
    )


def fetch_data():
    body = urllib.parse.urlencode({"data": build_query()}).encode()
    last = None
    for endpoint in OVERPASS_ENDPOINTS:
        req = urllib.request.Request(endpoint, data=body, headers={"User-Agent": UA})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=240) as resp:
                    return json.load(resp)
            except (urllib.error.URLError, TimeoutError) as exc:
                last = exc
                print(f"{endpoint}: {exc}; retrying", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
    raise SystemExit(f"Overpass request failed: {last}")


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


def main():
    elements = fetch_data().get("elements", [])

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
        "count": len(airfields),
        "airfields": airfields,
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "airfields.json"
    dest.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    named = sum(1 for a in airfields if a["name"])
    with_rw = sum(1 for a in airfields if a["runways"])
    print(
        f"wrote {len(airfields)} airfields "
        f"({named} named, {with_rw} with runways) to {dest}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
