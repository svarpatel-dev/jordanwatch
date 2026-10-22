"""
Real lake shorelines for the satellite map layer (decided Oct 19, design
decision 1). Run ONCE by hand, not in GitHub Actions: lakes don't move.

Why: EPA's own lake outlines are made of 300 m blocks (they were drawn from
the satellite grid), so clipping the map's colors to them brings the blocks
back and lets color onto land. EPA's lake layer is a copy of USGS's National
Hydrography Dataset (NHD) "Waterbody - Large Scale" layer with the SAME
OBJECTIDs, so each CyAN lake's real shoreline can be looked up by its id.
NHD is public domain (USGS), medium resolution (1:100,000).

What it does:
1. Reads every CyAN lake's id, name and size from data/lakes/index.json.
2. Asks USGS for the shorelines, a batch of lakes per request, simplified to
   about 30 m (enough for a phone map; the satellite pixels are 300 m).
3. Keeps a shoreline only if it really is the whole lake: same name (or
   both unnamed) and at least 80% of the area of EPA's drawn outline.
   Found Oct 20: NHD splits some big reservoirs into many pieces (Lake
   Powell, Shasta Lake, Lake Sakakawea, Kentucky Lake...), and EPA's id
   points to only one piece, so clipping to it hid real blooms.
4. For those lakes, a second pass asks for every NHD lake or reservoir
   polygon in the lake's box and keeps the ones that lie mostly inside
   EPA's outline: together they are the whole lake. If they still cover
   less than 80% of it, the map uses EPA's own outline for that lake, and
   the lake is listed under "skipped".
5. Writes data/lakes/shorelines.json.gz: one lake per line, coordinates
   in Web Mercator meters rounded to 5 m (the shorelines are simplified to
   30 m anyway), each point stored as the step from the point before it,
   then gzipped. About 4 MB for every lake.

Polite to USGS: one request at a time, a short pause between requests, and
retries that wait longer each time. Every finished batch is saved to a
progress folder, so a stopped run picks up where it left off.

Run:  python3 scripts/fetch_shorelines.py [progress folder] [--assemble-only]
      --assemble-only skips the downloads and writes the file from the
      batches finished so far (the rest use EPA's outlines until a full run)
"""

import gzip
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from cyan_images import load_outlines

NHD_URL = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query"
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "lakes"
INDEX_FILE = DATA_DIR / "index.json"
OUT_FILE = DATA_DIR / "shorelines.json.gz"

SIMPLIFY_M = 30            # USGS simplifies each shoreline to within 30 m (map meters)
STEP_M = 5                 # coordinates are stored in 5 m steps
LAKES_PER_REQUEST = 40     # small lakes per request
BIG_LAKE_KM2 = 300         # lakes this big go one per request (long shorelines)
PAUSE_SECONDS = 1          # between requests
TRIES = 6                  # per request
FIRST_WAIT_SECONDS = 10    # after a failed try; doubles each time
TIMEOUT_SECONDS = 300
MIN_AREA_SHARE = 0.8       # the shoreline must cover at least 80% of EPA's outline...
MAX_AREA_SHARE = 2         # ...and not be more than twice its size
LAKE_TYPES = "390,436"     # NHD feature types: lake/pond, reservoir
PIECE_INSIDE_SHARE = 0.5   # a piece belongs to the lake if half of it is inside EPA's outline
SAMPLE_GRID = 40           # points per side used to measure that


def ask_usgs(fields):
    """One request with these query fields: {id: (name, km2, rings)}.
    Follows "more results" pages (USGS sends at most 2,000 at a time)."""
    found, offset = {}, 0
    while True:
        query = urllib.parse.urlencode({
            **fields,
            "outFields": "OBJECTID,GNIS_NAME,AREASQKM",
            "returnGeometry": "true",
            "outSR": "3857",
            "maxAllowableOffset": str(SIMPLIFY_M),
            "geometryPrecision": "0",
            "resultOffset": str(offset),
            "f": "json",
        })
        request = urllib.request.Request(NHD_URL, data=query.encode(), headers=HEADERS)   # POST: long queries
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            data = json.loads(response.read())
        if "error" in data:
            raise RuntimeError(data["error"])
        for feature in data.get("features", []):
            a = feature["attributes"]
            rings = feature.get("geometry", {}).get("rings")
            if rings:
                found[a["OBJECTID"]] = (a["GNIS_NAME"], a["AREASQKM"], rings)
        if not data.get("exceededTransferLimit"):
            return found
        offset += len(data.get("features", []))


def ask_with_retries(fields):
    wait = FIRST_WAIT_SECONDS
    for attempt in range(1, TRIES + 1):
        try:
            return ask_usgs(fields)
        except (urllib.error.URLError, TimeoutError, RuntimeError, json.JSONDecodeError, OSError) as error:
            if attempt == TRIES:
                raise
            print(f"  try {attempt} failed ({error}); waiting {wait} s")
            time.sleep(wait)
            wait *= 2


def by_ids(ids):
    return {"where": "OBJECTID IN (%s)" % ",".join(str(i) for i in ids)}


def in_box(rings):
    """Every NHD lake or reservoir polygon touching the box around these rings."""
    xs = [v for flat in rings for v in flat[0::2]]
    ys = [v for flat in rings for v in flat[1::2]]
    return {"where": f"FTYPE IN ({LAKE_TYPES})",
            "geometry": f"{min(xs)},{min(ys)},{max(xs)},{max(ys)}",
            "geometryType": "esriGeometryEnvelope", "inSR": "3857",
            "spatialRel": "esriSpatialRelIntersects"}


# ---------- shapes ----------

def flat_rings(rings):
    """USGS's [[x, y], ...] rings -> flat lists x1, y1, x2, y2, ... (like cyan_images)."""
    return [[v for xy in ring for v in xy] for ring in rings if len(ring) >= 4]


def area(rings):
    """Area inside flat rings (islands subtracted), shoelace formula, map square meters."""
    total = 0.0
    for flat in rings:
        x, y = np.asarray(flat[0::2], dtype=float), np.asarray(flat[1::2], dtype=float)
        total += 0.5 * (np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    return abs(total)


def inside(px, py, rings):
    """For each point, is it inside these rings? Even-odd rule: a ray to the
    right crosses the shoreline an odd number of times from inside."""
    hits = np.zeros(px.size, dtype=bool)
    for flat in rings:
        xa, ya = np.asarray(flat[0::2], dtype=float), np.asarray(flat[1::2], dtype=float)
        xb, yb = np.roll(xa, -1), np.roll(ya, -1)
        for start in range(0, xa.size, 2000):
            sa, sb = slice(start, start + 2000), slice(start, start + 2000)
            x1, y1, x2, y2 = xa[sa], ya[sa], xb[sb], yb[sb]
            crosses = (y1 <= py[:, None]) != (y2 <= py[:, None])
            with np.errstate(divide="ignore", invalid="ignore"):
                x_at = x1 + (py[:, None] - y1) * (x2 - x1) / (y2 - y1)
            hits ^= (np.count_nonzero(crosses & (x_at > px[:, None]), axis=1) % 2).astype(bool)
    return hits


def share_inside(piece, outline):
    """How much of a piece (by area) lies inside EPA's outline, measured on a grid of points."""
    xs = [v for flat in piece for v in flat[0::2]]
    ys = [v for flat in piece for v in flat[1::2]]
    gx, gy = np.meshgrid(np.linspace(min(xs), max(xs), SAMPLE_GRID), np.linspace(min(ys), max(ys), SAMPLE_GRID))
    px, py = gx.ravel(), gy.ravel()
    in_piece = inside(px, py, piece)
    if not in_piece.any():               # a sliver: test one of its corners instead
        return float(inside(np.array(xs[:1], dtype=float), np.array(ys[:1], dtype=float), outline)[0])
    return float((in_piece & inside(px, py, outline)).sum() / in_piece.sum())


def covers(rings, outline):
    """True if these rings are the whole lake: 80% to 200% of EPA's outline's area."""
    share = area(rings) / max(area(outline), 1)
    return MIN_AREA_SHARE <= share <= MAX_AREA_SHARE


def pack_ring(ring):
    """[[x, y], ...] -> [x1, y1, dx2, dy2, ...] in 5 m units (steps from the point before)."""
    out, last_x, last_y = [], 0, 0
    for x, y in ring:
        x, y = round(x / STEP_M), round(y / STEP_M)
        out += [x - last_x, y - last_y]
        last_x, last_y = x, y
    return out


def unpack_ring(packed):
    """The opposite of pack_ring: a flat list x1, y1, x2, y2, ... (like cyan_images's rings)."""
    flat, x, y = [], 0, 0
    for i in range(0, len(packed), 2):
        x += packed[i]
        y += packed[i + 1]
        flat += [x * STEP_M, y * STEP_M]
    return flat


def load_shorelines(path=OUT_FILE):
    """{lake id: rings} from shorelines.json.gz; {} if the file isn't there."""
    try:
        lines = gzip.decompress(path.read_bytes()).decode().splitlines()
    except FileNotFoundError:
        return {}
    shorelines = {}
    for line in lines[1:-1]:                 # first and last lines are the wrapper
        lake_id, rings = json.loads(line.rstrip(","))
        shorelines[lake_id] = [unpack_ring(ring) for ring in rings]
    return shorelines


def batches(lakes):
    """Lakes in request-sized groups: big lakes alone, the rest LAKES_PER_REQUEST at a time."""
    small = []
    for lake in lakes:
        if lake["km2"] >= BIG_LAKE_KM2:
            yield [lake]
        else:
            small.append(lake)
            if len(small) == LAKES_PER_REQUEST:
                yield small
                small = []
    if small:
        yield small


def main():
    folders = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    progress = Path(folders[0] if folders else "shoreline-progress")
    assemble_only = "--assemble-only" in sys.argv
    progress.mkdir(parents=True, exist_ok=True)

    index = json.loads(INDEX_FILE.read_text())
    fields = index["fields"]
    lakes = [dict(zip(fields, row)) for row in index["lakes"]]
    lakes.sort(key=lambda lake: lake["id"])
    groups = list(batches(lakes))
    print(f"{len(lakes)} lakes in {len(groups)} requests")

    # Pass 1: each lake's own NHD feature, by id
    started = time.time()
    for number, group in enumerate(groups):
        done = progress / f"batch_{number:04d}.json"
        if done.exists() or assemble_only:
            continue
        t = time.time()
        found = ask_with_retries(by_ids([lake["id"] for lake in group]))
        done.write_text(json.dumps({str(k): v for k, v in found.items()}))
        print(f"batch {number + 1}/{len(groups)}: {len(found)} of {len(group)} lakes, {time.time() - t:.1f} s")
        time.sleep(PAUSE_SECONDS)

    # Keep the ones that are the whole lake (compared with EPA's drawn outline)
    outlines = {lake["id"]: lake["rings"] for lake in load_outlines()}
    kept, partial = {}, []
    for number in range(len(groups)):
        done = progress / f"batch_{number:04d}.json"
        found = json.loads(done.read_text()) if done.exists() else {}
        for lake in groups[number]:
            got = found.get(str(lake["id"]))
            if got is None:
                continue                  # not downloaded yet (--assemble-only)
            rings = flat_rings(got[2])
            if (got[0] or "Unnamed lake") == lake["name"] and covers(rings, outlines[lake["id"]]):
                kept[lake["id"]] = rings
            else:
                partial.append(lake["id"])

    # Pass 2: lakes NHD splits into pieces: every lake polygon in the box,
    # keeping the pieces that lie mostly inside EPA's outline
    pieced = 0
    for number, lake_id in enumerate(partial):
        done = progress / f"pieces_{lake_id}.json"
        if not done.exists():
            if assemble_only:
                continue
            t = time.time()
            found = ask_with_retries(in_box(outlines[lake_id]))
            done.write_text(json.dumps({str(k): v for k, v in found.items()}))
            print(f"pieces {number + 1}/{len(partial)} (lake {lake_id}): {len(found)} polygons, {time.time() - t:.1f} s")
            time.sleep(PAUSE_SECONDS)
        rings = []
        for _, _, piece in json.loads(done.read_text()).values():
            piece = flat_rings(piece)
            if piece and share_inside(piece, outlines[lake_id]) >= PIECE_INSIDE_SHARE:
                rings += piece
        if rings and covers(rings, outlines[lake_id]):
            kept[lake_id] = rings
            pieced += 1

    skipped = [lake["id"] for lake in lakes if lake["id"] not in kept]
    points = sum(len(flat) // 2 for rings in kept.values() for flat in rings)

    lines = [json.dumps({"source": "USGS NHD Waterbody - Large Scale (public domain), same OBJECTIDs as EPA CyAN",
                         "note": f"rings in Web Mercator meters / {STEP_M}, simplified to {SIMPLIFY_M} m; each point "
                                 "is the step from the one before; lakes not listed use EPA's own outline",
                         "skipped": sorted(skipped)}) + ","]
    lines[0] = lines[0][:-2] + ', "lakes": ['        # the lakes list stays open, one lake per line
    lines += [json.dumps([lake_id, [pack_ring(zip(flat[0::2], flat[1::2])) for flat in rings]],
                         separators=(",", ":")) + "," for lake_id, rings in sorted(kept.items())]
    lines[-1] = lines[-1].rstrip(",")
    lines.append("]}")
    # mtime=0: the same shorelines always give the same file (make_tiles.py checks it)
    OUT_FILE.write_bytes(gzip.compress(("\n".join(lines) + "\n").encode(), compresslevel=9, mtime=0))
    size_mb = OUT_FILE.stat().st_size / 1e6
    print(f"{len(kept)} shorelines kept ({pieced} put together from pieces), {len(skipped)} lakes use "
          f"EPA's outline; {points:,} points, "
          f"{size_mb:.1f} MB, {(time.time() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()
