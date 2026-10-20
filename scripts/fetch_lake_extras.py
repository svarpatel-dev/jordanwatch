"""
The extra signals for every EPA CyAN lake (decided Oct 13: wind, lake level
and beaches go nationwide, plus runoff from the nearest gauge). The slow
parts are worked out here, once, so a phone opening a lake card only has to
ask for today's numbers:

1. USGS gauges (about a minute): which gauges belong to each lake.
   - lake level: a gauge on the lake or within 2 km of its shore (lake
     surface elevation 62614 / 00062 / 62615, or gage height 00065 at a
     USGS "lake" site)
   - rain: the nearest rain gauge (00045) within 25 km of the lake
   - river flow: the nearest stream-flow gauge (00060) within 25 km
   A big lake (100 km2 or more, like Lake Michigan) is too big for one rain
   gauge, so it gets the nearest ones along its whole shore instead, and the
   phone picks the one near the user. Only gauges that sent a reading in
   the last 7 days count.
2. Beaches (slow: OpenStreetMap's free Overpass server, one request at a
   time): the beaches and swimming areas mapped on each lake's shore, and
   which way each one faces the water (for the wind rule). Biggest lakes
   first; a run stops after BEACH_BUDGET_MINUTES and the next run carries on.

Output: data/lakes/extras/NC.json and so on, one file per state (a phone only
downloads its lake's state), one lake per line. Gauges and beaches rarely
change, so this is run by hand about once a month:
    python3 scripts/fetch_lake_extras.py                (gauges + beaches not looked up yet)
    python3 scripts/fetch_lake_extras.py --all-beaches  (every lake's beaches again)
Beach data (c) OpenStreetMap contributors, ODbL: the app has to say so.
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

import numpy as np

from cyan_images import HEADERS, get_bytes, load_outlines, mercator_x, mercator_y, to_lat_lng
from fetch_lakes import SHORE_LAKE_KM2, save, shore_points

EXTRAS_DIR = Path(__file__).resolve().parent.parent / "data" / "lakes" / "extras"

USGS_LATEST = ("https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items"
               "?f=json&parameter_code={codes}&time=P7D&limit=10000"
               "&properties=monitoring_location_id,parameter_code")
USGS_INFO = ("https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items"
             "?f=json&id={ids}&properties=monitoring_location_name,site_type_code&skipGeometry=true&limit=10000")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Lake level, best first: elevation in the older datum (the one Jordan
# Lake's 216 ft normal pool uses), elevation "above datum", elevation in the
# newer datum, then gage height. Gage height alone only counts at a USGS
# "lake" site: at a stream site it's the river's height, not the lake's.
LEVEL_CODES = ["62614", "00062", "62615"]
STAGE_CODE = "00065"
RAIN_CODE = "00045"
FLOW_CODE = "00060"

LEVEL_MAX_KM = 2        # a lake-level gauge has to be on the lake or this close to its shore
RUNOFF_MAX_KM = 25      # rain gauges: this close to the lake (decided Oct 13)
FLOW_MAX_KM = 10        # river gauges: closer, so it's this lake's river (decided Oct 20)
FLOW_CANDIDATES = 3     # the nearest few river gauges, in case the nearest isn't a plain stream
INFO_BATCH = 250        # gauge ids per USGS name lookup

BEACH_TAGS = [("natural", "beach"), ("leisure", "swimming_area"), ("leisure", "beach_resort")]
BEACH_KINDS = {"beach": "b", "swimming_area": "s", "beach_resort": "p"}   # p = beach park
BEACH_MAX_M = 700       # a beach's middle has to be this close to the lake's outline (EPA's
                        # pixel outlines miss coves: Parkers Creek Beach is 627 m from Jordan Lake's)
SAME_BEACH_M = 150      # mapped beaches closer than this are one beach
WATER_RADIUS_M = 3000   # which way a beach faces: the water within this distance...
WATER_STEP_M = 150      # ...tested every 150 m
MAX_BEACHES = 100       # per lake (Lake Michigan has hundreds); named ones are kept first
BEACH_BATCH = 250       # lakes per Overpass request (halved if the server times out)
BEACH_PAUSE_SECONDS = 10
BEACH_BUDGET_MINUTES = 45
OVERPASS_TRIES = 5      # when the server is busy: wait 30 s, 60 s, 120 s, ... between tries

LAKE_FIELDS = ["level", "levelKm", "rain", "rainKm", "flow", "flowKm", "beaches", "shoreGauges"]
GAUGE_FIELDS = ["name", "lat", "lng", "levelCodes"]
BEACH_FIELDS = ["name", "lat", "lng", "onshoreWindFrom", "kind"]
METERS_PER_DEGREE = 111320

NOTE = ("level = lake-level gauge on the lake or within 2 km; rain / flow = nearest rain / stream-flow gauge "
        "within 25 km (km = distance from the lake's shore, 0 = on the lake); a big lake (100 km2+) has none, "
        "and shoreGauges = [rain ids, flow ids] near its shore instead. beaches: null = not looked up yet, "
        "[] = none mapped; onshoreWindFrom = compass direction from the beach toward the water; kind b = beach, "
        "s = swimming area, p = beach park. A lake with no row has no gauge nearby and no beaches mapped "
        "(unless it's in beachesNotLookedUp).")


# ---------- geometry (Web Mercator meters, like the lake outlines) ----------
# A Web Mercator meter is only a real meter at the equator: times the cosine
# of the latitude gives real meters (0.81 at Jordan Lake). Directions are
# right as they are (the map projection keeps angles).

def segments_of(lake):
    """Every edge of a lake's outline (islands too), as rows x1, y1, x2, y2."""
    rows = []
    for ring in lake["rings"]:
        points = np.array(ring, dtype=float).reshape(-1, 2)
        rows.append(np.hstack([points[:-1], points[1:]]))
    return np.vstack(rows)


def outline_distance(segments, x, y):
    """How far (x, y) is from the closest point of the outline."""
    x1, y1, x2, y2 = segments.T
    dx, dy = x2 - x1, y2 - y1
    length2 = np.maximum(dx * dx + dy * dy, 1e-9)
    # How far along each edge its closest point is (0 = start, 1 = end)
    t = np.clip(((x - x1) * dx + (y - y1) * dy) / length2, 0, 1)
    return math.sqrt(np.min((x1 + t * dx - x) ** 2 + (y1 + t * dy - y) ** 2))


def is_inside(segments, x, y):
    """True if (x, y) is on the water: a line going east from it crosses the
    outline an odd number of times. Island shores count too, so a point on
    an island is outside."""
    x1, y1, x2, y2 = segments.T
    crosses = (y1 > y) != (y2 > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        x_at = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
    return int(np.sum(crosses & (x < x_at))) % 2 == 1


def distance_km(segments, x, y, lat):
    """Real km from (x, y) to the lake: 0 on the water."""
    if is_inside(segments, x, y):
        return 0.0
    return outline_distance(segments, x, y) * math.cos(math.radians(lat)) / 1000


def onshore_wind_from(segments, x, y, lat):
    """The compass direction (degrees) from a spot toward the lake's water:
    toward the middle of the water within 3 km, with nearer water counting
    more (each bit of water weighs 1 / its distance). Wind blowing FROM there
    pushes floating algae onto the spot's shore: the same meaning as
    onshoreWindFrom in js/areas.js. EPA's outlines are made of 300 m
    satellite pixels, so the direction to the single nearest bit of outline
    jumps between 0, 45 and 90 degrees; the middle of the nearby water
    doesn't (checked Oct 17 on Jordan Lake's 7 beaches: 18 degrees from the
    hand-set directions on average). None if there's no water within 3 km."""
    scale = math.cos(math.radians(lat))       # Web Mercator meters -> real meters
    radius, step = WATER_RADIUS_M / scale, WATER_STEP_M / scale
    # A grid of test points every 150 m within 3 km of the spot
    offsets = np.arange(-radius, radius + step, step)
    gx, gy = np.meshgrid(offsets, offsets)
    in_circle = gx ** 2 + gy ** 2 <= radius ** 2
    px, py = x + gx[in_circle], y + gy[in_circle]
    # Which test points are on the water (is_inside for many points at once).
    # Only outline edges that reach the circle's band of latitudes can be
    # crossed by a line going east from a test point, so only those count.
    y1, y2 = segments[:, 1], segments[:, 3]
    band = segments[(np.minimum(y1, y2) <= y + radius) & (np.maximum(y1, y2) >= y - radius)]
    x1, y1, x2, y2 = (band[:, i][np.newaxis, :] for i in range(4))
    crosses = (y1 > py[:, np.newaxis]) != (y2 > py[:, np.newaxis])
    with np.errstate(divide="ignore", invalid="ignore"):
        x_at = x1 + (py[:, np.newaxis] - y1) * (x2 - x1) / (y2 - y1)
    water = np.sum(crosses & (px[:, np.newaxis] < x_at), axis=1) % 2 == 1
    if not water.any():
        return None
    wx, wy = px[water], py[water]
    weight = 1 / np.maximum(np.hypot(wx - x, wy - y), step)
    middle_x, middle_y = (wx * weight).sum() / weight.sum(), (wy * weight).sum() / weight.sum()
    return round(math.degrees(math.atan2(middle_x - x, middle_y - y))) % 360   # 0 = north, 90 = east


def near_box(lake, segments, km):
    """The box around the lake's outline, km bigger on every side:
    (west, south, east, north) in Web Mercator meters."""
    margin = km * 1000 / math.cos(math.radians(lake["lat"]))
    return (segments[:, [0, 2]].min() - margin, segments[:, [1, 3]].min() - margin,
            segments[:, [0, 2]].max() + margin, segments[:, [1, 3]].max() + margin)


# ---------- 1. USGS gauges ----------

def usgs_gauges(codes):
    """Every US gauge that sent one of these parameters in the last 7 days:
    {id: {"lat", "lng", "codes"}}. USGS sends 10,000 rows per page, so this
    follows the "next" links."""
    gauges = {}
    url = USGS_LATEST.format(codes=",".join(codes))
    while url:
        data = json.loads(get_bytes(url))
        for feature in data["features"]:
            if not feature.get("geometry"):
                continue      # no location, so it can't be matched to a lake
            gauge_id = feature["properties"]["monitoring_location_id"].replace("USGS-", "")
            lng, lat = feature["geometry"]["coordinates"]
            gauge = gauges.setdefault(gauge_id, {"lat": lat, "lng": lng, "codes": set()})
            gauge["codes"].add(feature["properties"]["parameter_code"])
        url = next((link["href"] for link in data.get("links", []) if link["rel"] == "next"), None)
        time.sleep(1)
    print(f"USGS {','.join(codes)}: {len(gauges)} gauges")
    return gauges


def gauge_info(ids):
    """Each gauge's name and site type ("LK" lake, "ST" stream, "ST-TS"
    tidal stream, ...): {id: (name, site type)}."""
    info = {}
    ids = sorted(ids)
    for start in range(0, len(ids), INFO_BATCH):
        batch = ",".join(f"USGS-{gauge_id}" for gauge_id in ids[start:start + INFO_BATCH])
        data = json.loads(get_bytes(USGS_INFO.format(ids=batch)))
        for feature in data["features"]:
            p = feature["properties"]
            info[feature["id"].replace("USGS-", "")] = (p["monitoring_location_name"], p["site_type_code"])
        time.sleep(1)
    return info


def gauges_near(lake, segments, gauges, km):
    """The gauges within km of the lake, nearest first: [(km, id)].
    gauges = (ids, x, y, lat) with numpy arrays, for a fast box test first."""
    ids, xs, ys, lats, _ = gauges
    west, south, east, north = near_box(lake, segments, km)
    found = []
    for i in np.flatnonzero((xs >= west) & (xs <= east) & (ys >= south) & (ys <= north)):
        distance = distance_km(segments, xs[i], ys[i], lats[i])
        if distance <= km:
            found.append((distance, ids[i]))
    return sorted(found)


def km_to_many(lat, lng, lats, lngs):
    """Real km from one point to many (numpy arrays), on a flat map (fine within 25 km)."""
    dx = (lngs - lng) * math.cos(math.radians(lat)) * METERS_PER_DEGREE / 1000
    dy = (lats - lat) * METERS_PER_DEGREE / 1000
    return np.hypot(dx, dy)


def along_shore(lake, gauges, how_many):
    """For a big lake: the nearest how_many gauges within 25 km of each of
    its shore points (one every 5 km), all together: a set of ids."""
    ids, _, _, lats, lngs = gauges
    points = shore_points(lake)
    found = set()
    for i in range(0, len(points), 2):
        km = km_to_many(points[i], points[i + 1], lats, lngs)
        for j in np.argsort(km)[:how_many]:
            if km[j] <= RUNOFF_MAX_KM:
                found.add(ids[j])
    return found


def as_arrays(gauges):
    ids = list(gauges)
    return (ids, np.array([mercator_x(gauges[g]["lng"]) for g in ids]),
            np.array([mercator_y(gauges[g]["lat"]) for g in ids]), np.array([gauges[g]["lat"] for g in ids]),
            np.array([gauges[g]["lng"] for g in ids]))


def match_gauges(lakes, all_segments):
    """Each lake's gauges: ({lake id: [level, levelKm, rain, rainKm, flow,
    flowKm, shoreGauges]}, {gauge id: [name, lat, lng, levelCodes]}).
    shoreGauges = [rain ids, flow ids] along a big lake's shore, else None."""
    level = usgs_gauges(LEVEL_CODES)
    stage = usgs_gauges([STAGE_CODE])
    rain = usgs_gauges([RAIN_CODE])
    flow = usgs_gauges([FLOW_CODE])
    # Where each gauge is and which level codes it sends (a gauge can be in several lists)
    where = {**flow, **rain, **stage, **level}
    level_codes = {g: [c for c in LEVEL_CODES + [STAGE_CODE]
                       if c in level.get(g, {"codes": set()})["codes"] | stage.get(g, {"codes": set()})["codes"]]
                   for g in set(level) | set(stage)}

    near = {}   # lake id -> {"level": [(km, id)], "rain": ..., "flow": ...}
    lists = {"level": as_arrays({**stage, **level}), "rain": as_arrays(rain), "flow": as_arrays(flow)}
    for lake, segments in zip(lakes, all_segments):
        near[lake["id"]] = {
            "level": gauges_near(lake, segments, lists["level"], LEVEL_MAX_KM),
            "rain": gauges_near(lake, segments, lists["rain"], RUNOFF_MAX_KM)[:1],
            "flow": gauges_near(lake, segments, lists["flow"], FLOW_MAX_KM)[:FLOW_CANDIDATES],
        }
        if lake["km2"] >= SHORE_LAKE_KM2:
            near[lake["id"]]["shoreRain"] = along_shore(lake, lists["rain"], 1)
            near[lake["id"]]["shoreFlow"] = along_shore(lake, lists["flow"], FLOW_CANDIDATES)

    # Names and site types, only for the gauges that might be used
    wanted = set()
    for found in near.values():
        wanted.update(g for _, g in found["level"] + found["rain"] + found["flow"])
        wanted.update(found.get("shoreRain", set()) | found.get("shoreFlow", set()))
    info = gauge_info(wanted)
    site_type = lambda g: info.get(g, ("", ""))[1]

    # A lake-level gauge belongs to the ONE lake it's closest to (two lakes
    # can be within 2 km of the same dam)
    owner = {}
    for lake_id, found in near.items():
        for distance, g in found["level"]:
            if g not in level and site_type(g) != "LK":
                continue      # gage height at a stream site: the river's height, not the lake's
            if g not in owner or distance < owner[g][0]:
                owner[g] = (distance, lake_id)
    level_pick = {}
    for g, (distance, lake_id) in owner.items():
        # On the lake (0 km) or nearest wins; then the best level code
        rank = (distance, LEVEL_CODES.index(level_codes[g][0]) if level_codes[g][0] in LEVEL_CODES else 9)
        if lake_id not in level_pick or rank < level_pick[lake_id][0]:
            level_pick[lake_id] = (rank, distance, g)

    rows, used = {}, {}
    record = lambda g: used.setdefault(g, [info.get(g, (f"USGS {g}", ""))[0],
                                          round(where[g]["lat"], 4), round(where[g]["lng"], 4), ""])
    for lake in lakes:
        found = near[lake["id"]]
        big = lake["km2"] >= SHORE_LAKE_KM2
        picks = [
            level_pick[lake["id"]][1:] if lake["id"] in level_pick else None,
            # A big lake has no single rain or river gauge (see shoreGauges)
            found["rain"][0] if found["rain"] and not big else None,
            # The nearest plain stream (not tidal, not a canal), so "flow" means a river
            next(((d, g) for d, g in found["flow"] if site_type(g) == "ST"), None) if not big else None,
        ]
        shore_gauges = None
        if big:
            shore_gauges = [sorted(found["shoreRain"]), sorted(g for g in found["shoreFlow"] if site_type(g) == "ST")]
            for g in shore_gauges[0] + shore_gauges[1]:
                record(g)
        if not any(picks) and not (shore_gauges and any(shore_gauges)):
            continue
        row = []
        for i, pick in enumerate(picks):
            if pick is None:
                row += [None, None]
                continue
            distance, g = pick
            row += [g, round(distance, 1)]
            if i == 0:
                record(g)[3] = ",".join(level_codes[g])
            else:
                record(g)
        rows[lake["id"]] = row + [shore_gauges]

    counts = {name: sum(1 for r in rows.values() if r[i]) for i, name in ((0, "level"), (2, "rain"), (4, "flow"))}
    print(f"Lakes with a gauge: {counts} (of {len(lakes)}); {len(used)} gauges used")
    return rows, used


# ---------- 2. beaches (OpenStreetMap) ----------

def overpass(query):
    """One Overpass request: the elements, or None if the server stayed busy.
    The free server is often busy, so wait and try again (30 s, 60 s, ...).
    "timeout" means the query itself was too big."""
    body = urllib.parse.urlencode({"data": query}).encode()
    wait = 30
    for _ in range(OVERPASS_TRIES):
        try:
            request = urllib.request.Request(OVERPASS_URL, data=body, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=300) as response:
                data = json.loads(response.read())
            if "timed out" in data.get("remark", ""):
                return "timeout"
            return data["elements"]
        except urllib.error.HTTPError as error:
            if error.code == 400:
                sys.exit(f"Overpass refused the query (HTTP 400): {error.read()[:300]}")
            print(f"  Overpass busy (HTTP {error.code}); waiting {wait} s")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            print(f"  Overpass failed ({error}); waiting {wait} s")
        time.sleep(wait)
        wait *= 2
    return None


def beach_query(batch):
    """The Overpass query for a batch of (lake, segments): a small box around
    each lake (south, west, north, east in degrees), every beach tag."""
    parts = []
    for lake, segments in batch:
        west, south, east, north = near_box(lake, segments, BEACH_MAX_M / 1000)
        (lat1, lng1), (lat2, lng2) = to_lat_lng(west, south), to_lat_lng(east, north)
        box = f"({lat1:.4f},{lng1:.4f},{lat2:.4f},{lng2:.4f})"
        parts += [f'nwr["{key}"="{value}"]{box};' for key, value in BEACH_TAGS]
    # "out tags center": only each beach's tags and middle point
    return f"[out:json][timeout:240];({''.join(parts)});out tags center;"


def fetch_beach_batch(batch, found):
    """Asks Overpass for one batch; a batch too big for the server is split
    in half. Returns False if the server stayed busy."""
    elements = overpass(beach_query(batch))
    if elements == "timeout" and len(batch) > 1:
        half = len(batch) // 2
        return fetch_beach_batch(batch[:half], found) and fetch_beach_batch(batch[half:], found)
    if elements is None or elements == "timeout":
        return False
    for element in elements:
        tags = element.get("tags", {})
        if tags.get("access") in ("private", "no"):
            continue      # never point people to a private beach
        point = element.get("center") or element
        kind = next(BEACH_KINDS[value] for key, value in BEACH_TAGS if tags.get(key) == value)
        # Keyed by the OSM element, so a beach found in two batches counts once
        found[(element["type"], element["id"])] = {
            "name": tags.get("name", ""), "lat": point["lat"], "lng": point["lon"], "kind": kind}
    return True


def find_beaches(lakes, all_segments, beaches, check_all):
    """Looks up the lakes whose beaches are None (not looked up yet), biggest
    first, and fills in beaches[lake id] = [[name, lat, lng, onshoreWindFrom, kind], ...]."""
    pairs = list(zip(lakes, all_segments))
    if check_all:
        beaches.update({lake["id"]: None for lake in lakes})
    todo = sorted((p for p in pairs if beaches[p[0]["id"]] is None), key=lambda p: -p[0]["km2"])
    print(f"Beaches: {len(todo)} lakes to look up, biggest first")

    started = time.time()
    found = {}
    checked = []
    for start in range(0, len(todo), BEACH_BATCH):
        if time.time() - started > BEACH_BUDGET_MINUTES * 60:
            print(f"Beaches: stopping after {BEACH_BUDGET_MINUTES} min; the next run carries on")
            break
        batch = todo[start:start + BEACH_BATCH]
        if not fetch_beach_batch(batch, found):
            print("Beaches: Overpass stayed busy; stopping (the next run carries on)")
            break
        checked += [lake["id"] for lake, _ in batch]
        print(f"  lakes {start + 1}-{start + len(batch)} looked up; {len(found)} mapped beaches so far")
        time.sleep(BEACH_PAUSE_SECONDS)

    # Each beach goes to the lake whose outline is closest, if within 700 m
    boxes = np.array([near_box(lake, segments, BEACH_MAX_M / 1000) for lake, segments in pairs])
    new = {lake_id: [] for lake_id in checked}
    for beach in found.values():
        x, y = mercator_x(beach["lng"]), mercator_y(beach["lat"])
        best = None
        hits = (boxes[:, 0] <= x) & (boxes[:, 2] >= x) & (boxes[:, 1] <= y) & (boxes[:, 3] >= y)
        for i in np.flatnonzero(hits):
            meters = distance_km(pairs[i][1], x, y, beach["lat"]) * 1000
            if meters <= BEACH_MAX_M and (best is None or meters < best[0]):
                best = (meters, i)
        if best and pairs[best[1]][0]["id"] in new:
            lake, segments = pairs[best[1]]
            new[lake["id"]].append([beach["name"], round(beach["lat"], 5), round(beach["lng"], 5),
                                    onshore_wind_from(segments, x, y, beach["lat"]), beach["kind"]])
    for lake_id, lake_beaches in new.items():
        beaches[lake_id] = one_per_beach(lake_beaches)


def one_per_beach(beaches):
    """Named beaches first; a mapped beach within 150 m of one already kept
    is the same beach (e.g. the sand and its swimming area). At most
    MAX_BEACHES per lake."""
    kept = []
    for beach in sorted(beaches, key=lambda b: (b[0] == "", b[4] != "b", b[0])):
        def meters_to(other):
            dx = (beach[2] - other[2]) * math.cos(math.radians(beach[1]))
            return math.hypot(dx, beach[1] - other[1]) * METERS_PER_DEGREE
        if all(meters_to(other) >= SAME_BEACH_M for other in kept):
            kept.append(beach)
    return kept[:MAX_BEACHES]


# ---------- main ----------

def load_old():
    """The last run's files, merged: (lake rows, gauges, ids not looked up)."""
    rows, gauges, not_looked_up = {}, {}, set()
    for path in sorted(EXTRAS_DIR.glob("*.json")):
        saved = json.loads(path.read_text())
        rows.update({int(lake_id): row for lake_id, row in saved["lakes"].items()})
        gauges.update(saved["gauges"])
        not_looked_up.update(saved["beachesNotLookedUp"])
    return rows, gauges, not_looked_up


def main():
    check_all = "--all-beaches" in sys.argv
    lakes = load_outlines()
    all_segments = [segments_of(lake) for lake in lakes]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # The last run's beaches stay unless they're looked up again (the first
    # time, every lake's beaches are "not looked up yet")
    old_rows, old_gauges, not_looked_up = load_old()
    if not old_rows:
        not_looked_up = {lake["id"] for lake in lakes}
    beaches = {lake["id"]: (old_rows[lake["id"]][6] if lake["id"] in old_rows
                            else None if lake["id"] in not_looked_up else [])
               for lake in lakes}

    # 1. Gauges. If USGS fails, the last run's gauges stay.
    try:
        gauge_rows, gauges = match_gauges(lakes, all_segments)
    except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as error:
        print(f"USGS gauges FAILED ({error}); keeping the last run's gauges")
        gauge_rows = {lake_id: row[:6] + [row[7] if len(row) > 7 else None] for lake_id, row in old_rows.items()}
        gauges = old_gauges

    # 2. Beaches
    find_beaches(lakes, all_segments, beaches, check_all)

    # One file per state, so a phone only downloads its lake's state.
    # Only lakes with a gauge or a beach get a row.
    by_state = {}
    for lake in lakes:
        by_state.setdefault(lake["state"], []).append(lake)
    for state, state_lakes in sorted(by_state.items()):
        rows = {}
        for lake in state_lakes:
            gauge_row = gauge_rows.get(lake["id"], [None] * 7)
            # Beaches go before shoreGauges (LAKE_FIELDS order)
            row = gauge_row[:6] + [beaches[lake["id"]], gauge_row[6]]
            if any(row[:6]) or row[6] or row[7]:
                rows[str(lake["id"])] = row
        used = sorted({g for row in rows.values()
                       for g in [row[0], row[2], row[4]] + (row[7][0] + row[7][1] if row[7] else []) if g})
        save(EXTRAS_DIR / f"{state}.json", {
            "source": "USGS Water Data API gauges; beaches (c) OpenStreetMap contributors, ODbL",
            "updatedAt": now,
            "note": NOTE,
            "lakeFields": LAKE_FIELDS,
            "gaugeFields": GAUGE_FIELDS,
            "beachFields": BEACH_FIELDS,
            "beachesNotLookedUp": sorted(l["id"] for l in state_lakes if beaches[l["id"]] is None),
            "gauges": {g: gauges[g] for g in used},
        }, "lakes", rows)
    looked_up = sum(found is not None for found in beaches.values())
    print(f"Saved {len(by_state)} state files: beaches looked up for {looked_up} of {len(lakes)} lakes")


if __name__ == "__main__":
    main()
