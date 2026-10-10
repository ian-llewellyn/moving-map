#!/usr/bin/env python3
"""Fetch the static villages/towns/cities dataset for the island of Ireland.

Data source: OpenStreetMap via the Overpass API (ODbL).
Run once at build time:  python3 tools/fetch_towns.py
Output: data/towns.json
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


def build_query():
    poly = " ".join(f"{lat} {lon}" for lat, lon in ISLAND_POLY)
    return (
        "[out:json][timeout:120];"
        'node["place"~"^(city|town|village)$"]'
        f'(poly:"{poly}");out;'
    )


def fetch(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for endpoint in OVERPASS_ENDPOINTS:
        req = urllib.request.Request(
            endpoint, data=body, headers={"User-Agent": UA}
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    return json.load(resp)
            except (urllib.error.URLError, TimeoutError) as exc:
                last = exc
                print(f"{endpoint}: {exc}; retrying", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
    raise SystemExit(f"Overpass request failed: {last}")


def main():
    data = fetch(build_query())
    places = []
    seen = set()
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if "lat" not in el or "lon" not in el:
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
        "count": len(places),
        "places": places,
    }
    dest = os.path.join(os.path.dirname(__file__), "..", "data", "towns.json")
    dest = os.path.abspath(dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print(f"wrote {len(places)} places to {dest}", file=sys.stderr)


if __name__ == "__main__":
    main()
