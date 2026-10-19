"""
A satellite reading for every lake EPA CyAN covers in the lower 48 (6,951
lakes), saved in data/lakes/ for the app's lake pins and lake cards. Runs 4
times a day in GitHub Actions (.github/workflows/fetch-lakes.yml), and the
bot commits the files, like cyan.json. The verdict rules live in the app
(js/lakes.js); this script only collects the numbers.

Two passes (decided Oct 16):
1. Image pass (about a minute, every lake): EPA's nationwide images from
   the last week (cyan_images.py). Covers every lake north of 29.86 N, but
   only DETECTED blooms are drawn, so clean water and clouds look the same:
   it can warn about a bloom, but it can never give Low Risk.
2. Per-lake check (about 2.4 s per lake, one request at a time): EPA's own
   pixel counts for one lake over the last 14 days, which tell clean water
   (below detection) apart from clouds. The only source of Low Risk, and it
   also covers the southern lakes the image misses. Each run checks as many
   lakes as fit in its time budget: about once a day per lake when EPA is
   fast (2-3 s per lake), every 1-2 weeks when it's slow (10-15 s, seen Oct
   16). Lakes likely to be clean go first (decided Oct 18). If EPA errors or
   slows down, the next runs check fewer lakes and wait between requests
   (the "pace" in readings.json).

Files:
  data/lakes/index.json     every lake: id, name, state, middle, size in km2,
                            image pixels (+ shoreline points for big lakes);
                            rarely changes
  data/lakes/readings.json  each lake's newest bloom warning from the images
                            ("i") and its newest per-lake check ("c"), plus
                            this script's own bookkeeping (when each lake was
                            checked, the pace)
Both are written with one lake per line, so git only stores what changed.

Run locally:  python3 scripts/fetch_lakes.py   (needs Pillow and NumPy; the
              per-lake check stops after BUDGET_MINUTES)
"""

import json
import math
import sys
import time
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from cyan_images import (CELLS, get_bytes, image_levels, load_outlines, prepare_masks,
                         recent_images, ring_is_outer, to_lat_lng)

LAKE_DATA_URL = ("https://cyan.epa.gov/waterbody/data/?OBJECTID={id}"
                 "&start_year={year}&start_day={start}&end_year={year}&end_day={end}")

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "lakes"
INDEX_FILE = DATA_DIR / "index.json"
READINGS_FILE = DATA_DIR / "readings.json"

# Image pass
DAILY_DAYS = 7           # EPA keeps only a few recent images; readings.json remembers older ones
WEEKLY_LOOK_BACK = 10
KEEP_WARNING_DAYS = 30   # forget image warnings older than this (the app stops using them at 14)

# Per-lake check
CHECK_WINDOW_DAYS = 14
RUNS_PER_DAY = 4
BUDGET_MINUTES = 75          # each run stops checking after this (the job's limit is 120)
RECHECK_AFTER_HOURS = 18
RECHECK_NO_WATER_DAYS = 30   # lakes where the satellite sees no water pixels at all
SOUTH_EDGE_LAT = 29.86       # the image has nothing south of this, so these go first

# Automatic slowdown if EPA throttles, errors or answers slowly
MAX_FAILURES_IN_A_ROW = 5    # EPA is probably down: stop this run
FIRST_WAIT_SECONDS = 5       # after a failure; doubles with each failure in a row
MAX_WAIT_SECONDS = 120
SLOW_REQUEST_SECONDS = 10    # a slower answer (usually 2-3 s): wait as long again before the next one
BAD_RUN_SHARE = 0.10         # more than 10% failed: next run checks half as many lakes
SLOW_RUN_SHARE = 0.25        # or more than 25% were slow
GOOD_RUN_SHARE = 0.02        # at most 2% failed and 2% slow: speed back up
SLOWEST_SHARE = 0.125        # never fewer than 1/8 of the usual lakes per run
MAX_DELAY_SECONDS = 10       # longest pause between requests

# The same bloom levels as js/lakes.js (WHO 1999/2003 guideline levels).
# Used here only to pick which day or image is worth keeping.
WHO_LOW_RISK = 20000
WHO_MODERATE_RISK = 100000
BLOOM_SHARE = 0.05           # 5% of the lake the satellite saw
MIN_BLOOM_PIXELS = 2
GOOD_LOOK_SHARE = 0.5        # a day that saw at least half the lake

# Big lakes get a point every 5 km along their shore, so "near you" can
# measure to the shore instead of the middle (Lake Michigan's middle is
# 150 miles from Chicago)
SHORE_LAKE_KM2 = 100
SHORE_SPACING_M = 5000

INDEX_FIELDS = ["id", "name", "state", "lat", "lng", "km2", "pixels", "shore"]
IMAGE_FIELDS = ["date", "kind", "pixels", "detected", "mean", "avoidMean", "max", "n20", "n100", "last100"]
CHECK_FIELDS = ["date", "seen", "lakePixels", "detected", "mean", "avoidMean", "max", "n20", "n100",
                "last100", "checked", "outside"]

# Which satellite levels (list positions 0-255) are detected cyanobacteria
# and which reach each WHO level. 0 = nothing / below detection, 254 = land,
# 255 = cloud or no data.
LEVELS = np.arange(256)
DETECTED = (LEVELS >= 1) & (LEVELS <= 253)
AT_20K = DETECTED & (CELLS >= WHO_LOW_RISK)
AT_100K = DETECTED & (CELLS >= WHO_MODERATE_RISK)


# ---------- numbers for one lake on one day ----------

def bloom_stats(counts):
    """counts[level] = how many pixels at each satellite level. Returns the
    detected pixels, their average and highest cells/mL, the average of the
    Avoid-level ones, and how many reach 20,000 and 100,000."""
    detected = int(counts[DETECTED].sum())
    if detected == 0:
        return {"detected": 0, "mean": None, "avoidMean": None, "max": None, "n20": 0, "n100": 0}
    cells_total = counts * CELLS
    n100 = int(counts[AT_100K].sum())
    return {
        "detected": detected,
        "mean": rounded(cells_total[DETECTED].sum() / detected),
        "avoidMean": rounded(cells_total[AT_100K].sum() / n100) if n100 else None,
        "max": rounded(CELLS[DETECTED & (counts > 0)].max()),
        "n20": int(counts[AT_20K].sum()),
        "n100": n100,
    }


def is_warning(stats, base):
    """Caution or worse by the app's rules: any pixel at the Avoid level
    (rule B), or at least 5% (and 2 pixels) of base at the Caution level."""
    return stats["n100"] >= 1 or (stats["n20"] >= MIN_BLOOM_PIXELS and stats["n20"] >= BLOOM_SHARE * base)


def rounded(cells):
    """To the nearest hundred cells/mL, e.g. 375,174.8 -> 375,200."""
    return int(round(float(cells), -2))


# ---------- 1. image pass ----------

def image_pass(lakes, images, state, today):
    """Each lake's newest bloom warning from EPA's images goes into the state.
    Returns the lake masks (or None if there were no images)."""
    masks = None
    newest = {}     # lake id -> the newest image warning (images come newest first)
    last100 = {}    # lake id -> newest image date with an Avoid-level pixel
    for im in images:
        started = time.time()
        levels, grid = image_levels(im["image"])
        im["image"].close()
        if masks is None:
            masks = prepare_masks(lakes, grid)
        warnings = 0
        for lake, box in zip(lakes, masks):
            if box is None:
                continue
            top, bottom, left, right, mask = box
            inside = levels[top:bottom, left:right][mask]
            if not inside.any():
                continue      # nothing drawn: clean, cloudy or no pass (can't tell)
            stats = bloom_stats(np.bincount(inside, minlength=256))
            pixels = int(mask.sum())
            if lake["id"] not in newest and is_warning(stats, pixels):
                newest[lake["id"]] = {"date": im["date"].isoformat(), "kind": im["kind"][0], "pixels": pixels,
                                      **stats}
                warnings += 1
            if stats["n100"] and lake["id"] not in last100:
                last100[lake["id"]] = im["date"].isoformat()
        print(f"{im['kind']} {im['date']}: {warnings} new lake warnings, "
              f"{grid['unknownColors']} unknown colors, {time.time() - started:.0f} s")
        del levels

    # Merge with the earlier runs (EPA deletes old images, so the state remembers)
    cutoff = (today - timedelta(days=KEEP_WARNING_DAYS)).isoformat()
    for lake_id, warning in newest.items():
        entry = state["lakes"].setdefault(str(lake_id), {})
        old = entry.get("i")
        if old is None or warning["date"] >= old["date"]:
            entry["i"] = {**warning, "last100": old["last100"] if old else None}
    for lake_id, day in last100.items():
        old = state["lakes"][str(lake_id)]["i"]
        old["last100"] = max(day, old["last100"] or "")
    for entry in state["lakes"].values():
        if "i" in entry and entry["i"]["date"] < cutoff:
            del entry["i"]
    state["images"] = [{"kind": im["kind"], "date": im["date"].isoformat()} for im in images]
    return masks


# ---------- 2. per-lake check ----------

def fetch_lake_days(lake_id, today):
    """EPA's pixel counts for one lake, for each day of the last 14:
    {date: 256 counts}. bin 0 = below detection, 1-253 = detected levels,
    254 = land, 255 = cloud or no data."""
    start = today - timedelta(days=CHECK_WINDOW_DAYS)
    days = {}
    # One request per calendar year (the window can cross New Year's Day)
    for year in sorted({start.year, today.year}):
        first = start if start.year == year else date(year, 1, 1)
        last = today if today.year == year else date(year, 12, 31)
        url = LAKE_DATA_URL.format(id=lake_id, year=year, start=first.timetuple().tm_yday,
                                   end=last.timetuple().tm_yday)
        data = json.loads(get_bytes(url, timeout=120)).get("data", {})
        for key, counts in data.items():
            y, day_of_year = map(int, key.split())
            days[date(y, 1, 1) + timedelta(days=day_of_year - 1)] = np.array(counts, dtype=np.int64)
    return days


def summarize_check(days, old, checked_at):
    """The newest day worth using from one lake's 14 days of counts: a day
    with a bloom warning (even a partial view can warn), or else a day that
    saw at least half the lake (only a good look can say it's clean).

    bin 0 also counts some pixels OUTSIDE the lake that are always 0 (465
    for Jordan Lake, found Oct 9). On a day with no satellite pass, bin 0 is
    only those, so the smallest bin 0 is that number."""
    result = {"date": None, "seen": None, "lakePixels": old["lakePixels"] if old else 0,
              "detected": 0, "mean": None, "avoidMean": None, "max": None, "n20": 0, "n100": 0,
              "last100": None, "checked": checked_at, "outside": old["outside"] if old else None}
    if not days:
        return result

    outside = min(int(counts[0]) for counts in days.values())
    if old and old["outside"] is not None:
        outside = min(outside, old["outside"])
    sample = next(iter(days.values()))
    lake_pixels = int(sample.sum() - sample[254] - outside)
    result.update(lakePixels=lake_pixels, outside=outside)

    for day in sorted(days, reverse=True):
        counts = days[day].copy()
        counts[0] -= outside          # below detection, inside the lake only
        stats = bloom_stats(counts)
        seen = int(counts[0]) + stats["detected"]
        if result["last100"] is None and stats["n100"] > 0:
            result["last100"] = day.isoformat()
        good_look = lake_pixels > 0 and seen >= GOOD_LOOK_SHARE * lake_pixels
        if result["date"] is None and seen > 0 and (is_warning(stats, seen) or good_look):
            result.update(date=day.isoformat(), seen=seen, **stats)
    return result


def due_lakes(lakes, state, now):
    """Lakes to check, most useful first. Never-checked lakes come first:
    the southern ones the image can't see, then the ones with no image
    warning (they have no verdict at all until they're checked). Then the
    lakes due for a recheck: again the ones with no image warning first,
    because only a check can say they're clean (a lake with a warning
    already has its answer from the daily image), oldest check first."""
    due = []
    for lake in lakes:
        entry = state["lakes"].get(str(lake["id"]), {})
        check = entry.get("c")
        if check is None:
            south = lake["lat"] < SOUTH_EDGE_LAT
            due.append(((0, 0 if south else 1, 1 if "i" in entry else 0, ""), lake))
            continue
        hours_ago = (now - datetime.fromisoformat(check["checked"])).total_seconds() / 3600
        wait_hours = RECHECK_NO_WATER_DAYS * 24 if check["lakePixels"] <= 0 else RECHECK_AFTER_HOURS
        if hours_ago >= wait_hours:
            due.append(((1, 1 if "i" in entry else 0, 0, check["checked"]), lake))
    due.sort(key=lambda pair: pair[0])
    return [lake for _, lake in due]


def wait_after_failure(error, in_a_row):
    """Seconds to wait: what EPA asks for (HTTP 429/503 "Retry-After"), or
    5, 10, 20, 40... seconds, at most 2 minutes."""
    if isinstance(error, urllib.error.HTTPError):
        asked = error.headers.get("Retry-After", "")
        if asked.isdigit():
            return min(int(asked), MAX_WAIT_SECONDS)
    return min(FIRST_WAIT_SECONDS * 2 ** (in_a_row - 1), MAX_WAIT_SECONDS)


def check_pass(lakes, state, now):
    """Check the most overdue lakes, one request at a time, within the time budget."""
    pace = state["pace"]
    batch = math.ceil(len(lakes) / RUNS_PER_DAY * pace["share"])
    due = due_lakes(lakes, state, now)
    print(f"Per-lake check: {len(due)} lakes due, checking up to {batch} "
          f"(pace: {pace['share']:.3g} of the usual, {pace['delaySeconds']:.3g} s between requests)")

    checked_at = now.isoformat(timespec="minutes")
    started = time.time()
    checked = failed = slow = in_a_row = 0
    stopped_early = False
    for lake in due[:batch]:
        if time.time() - started > BUDGET_MINUTES * 60:
            print("  time budget used up; the rest wait for the next run")
            break
        asked = time.time()
        try:
            days = fetch_lake_days(lake["id"], now.date())
        except Exception as error:
            failed += 1
            in_a_row += 1
            print(f"  {lake['id']} {lake['name']}: FAILED ({error})")
            if in_a_row >= MAX_FAILURES_IN_A_ROW:
                print("  too many failures in a row; stopping this run")
                stopped_early = True
                break
            time.sleep(wait_after_failure(error, in_a_row))
            continue
        in_a_row = 0
        entry = state["lakes"].setdefault(str(lake["id"]), {})
        entry["c"] = summarize_check(days, entry.get("c"), checked_at)
        checked += 1

        # A slow answer can mean EPA is busy: give it as long again to recover
        took = time.time() - asked
        if took > SLOW_REQUEST_SECONDS:
            slow += 1
            time.sleep(min(took, MAX_WAIT_SECONDS))
        if pace["delaySeconds"]:
            time.sleep(pace["delaySeconds"])

    # Slow down after a bad run, speed back up after a good one
    tried = checked + failed
    failure_share = failed / tried if tried else 0
    slow_share = slow / checked if checked else 0
    if stopped_early or failure_share > BAD_RUN_SHARE or slow_share > SLOW_RUN_SHARE:
        pace["share"] = max(pace["share"] / 2, SLOWEST_SHARE)
        pace["delaySeconds"] = min(max(pace["delaySeconds"] * 2, 1), MAX_DELAY_SECONDS)
    elif failure_share <= GOOD_RUN_SHARE and slow_share <= GOOD_RUN_SHARE:
        pace["share"] = min(pace["share"] * 2, 1)
        pace["delaySeconds"] = pace["delaySeconds"] / 2 if pace["delaySeconds"] >= 1 else 0

    minutes = (time.time() - started) / 60
    state["lastCheckRun"] = {"at": checked_at, "checked": checked, "failed": failed, "slow": slow,
                             "minutes": round(minutes, 1), "stoppedEarly": stopped_early}
    print(f"Per-lake check: {checked} checked, {failed} failed, {slow} slow, {minutes:.1f} min")


# ---------- files ----------

def shore_points(lake):
    """A point every 5 km along a big lake's shore: [lat, lng, lat, lng, ...]
    (2 decimals, about 1 km). Islands and tiny bits of shore are skipped."""
    points = []
    for ring in lake["rings"]:
        if not ring_is_outer(ring):
            continue      # an island's shore
        since_last = SHORE_SPACING_M
        for i in range(0, len(ring) - 2, 2):
            if since_last >= SHORE_SPACING_M:
                lat, lng = to_lat_lng(ring[i], ring[i + 1])
                points += [round(lat, 2), round(lng, 2)]
                since_last = 0
            since_last += math.dist(ring[i:i + 2], ring[i + 2:i + 4])
    return points


def write_index(lakes, masks):
    rows = []
    for lake, box in zip(lakes, masks):
        row = [lake["id"], lake["name"], lake["state"], round(lake["lat"], 3), round(lake["lng"], 3),
               round(lake["km2"], 1), int(box[4].sum()) if box else 0]
        if lake["km2"] >= SHORE_LAKE_KM2:
            row.append(shore_points(lake))
        rows.append(row)
    save(INDEX_FILE, {"source": "EPA CyAN lakes (waterbodies_9), lower 48",
                      "note": "pixels = pixels inside the outline on EPA's nationwide image (about 340 m); "
                              "shore = points along the shore, big lakes only",
                      "fields": INDEX_FIELDS}, "lakes", rows)


def load_state():
    """readings.json from the last run, with each lake's rows turned back
    into dicts, or an empty state the first time."""
    state = {"lakes": {}, "pace": {"share": 1, "delaySeconds": 0}}
    try:
        saved = json.loads(READINGS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return state
    state["pace"] = saved.get("pace", state["pace"])
    for lake_id, entry in saved["lakes"].items():
        state["lakes"][lake_id] = {}
        if "i" in entry:
            state["lakes"][lake_id]["i"] = dict(zip(saved["imageFields"], entry["i"]))
        if "c" in entry:
            state["lakes"][lake_id]["c"] = dict(zip(saved["checkFields"], entry["c"]))
    state["images"] = saved.get("images", [])
    return state


def saved_lakes():
    """The lake list from the last index.json (id, name, lat), if the outlines can't be downloaded."""
    index = json.loads(INDEX_FILE.read_text())
    return [dict(zip(index["fields"], row)) for row in index["lakes"]]


def save_state(state):
    lakes = {}
    for lake_id, entry in sorted(state["lakes"].items(), key=lambda pair: int(pair[0])):
        row = {}
        if "i" in entry:
            row["i"] = [entry["i"][field] for field in IMAGE_FIELDS]
        if "c" in entry:
            row["c"] = [entry["c"][field] for field in CHECK_FIELDS]
        if row:
            lakes[lake_id] = row
    save(READINGS_FILE, {
        "source": "EPA CyAN satellite estimates (about 300 m pixels): nationwide images + per-lake pixel counts",
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "images": state.get("images", []),
        "note": ("i = newest bloom warning from EPA's nationwide images (kind d = daily, w = weekly, dated by "
                 "its week's first day; pixels = image pixels in the outline). c = newest per-lake check "
                 "(seen = pixels the satellite saw, below detection + detected; lakePixels = water pixels "
                 "EPA can see). Dates are satellite image days; last100 = newest day with a pixel at "
                 "100,000+ cells/mL."),
        "imageFields": IMAGE_FIELDS,
        "checkFields": CHECK_FIELDS,
        "pace": state["pace"],
        "lastCheckRun": state.get("lastCheckRun"),
    }, "lakes", lakes)


def save(path, header, big_key, items):
    """Write JSON with one lake per line, so git diffs stay small when only
    some lakes change."""
    if isinstance(items, dict):
        lines = [f"{json.dumps(key)}:{json.dumps(value, separators=(',', ':'))}" for key, value in items.items()]
        opened, closed = "{", "}"
    else:
        lines = [json.dumps(value, separators=(",", ":")) for value in items]
        opened, closed = "[", "]"
    start = json.dumps(header, separators=(",", ":"))[:-1]    # without its closing }
    body = ",\n".join(lines)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'{start},"{big_key}":{opened}\n{body}\n{closed}}}\n')


# ---------- main ----------

def main():
    now = datetime.now(timezone.utc).replace(tzinfo=None)   # UTC, written without "+00:00"
    state = load_state()

    # 1. Image pass. If the outlines or the images can't be downloaded, skip
    #    it: the warnings from earlier runs stay in readings.json.
    lakes = None
    try:
        lakes = load_outlines()
    except Exception as error:
        print(f"Lake outlines FAILED ({error}); skipping the image pass")
    if lakes:
        images = recent_images(now.date(), DAILY_DAYS, WEEKLY_LOOK_BACK)
        if images:
            masks = image_pass(lakes, images, state, now.date())
            write_index(lakes, masks)
        else:
            print("No EPA images found; skipping the image pass")

    # 2. Per-lake check (needs only each lake's id, name and latitude)
    if lakes is None:
        try:
            lakes = saved_lakes()
        except FileNotFoundError:
            sys.exit("No lake list: the outlines failed and there's no index.json yet")
    check_pass(lakes, state, now)

    save_state(state)
    counts = {"image warnings": sum("i" in e for e in state["lakes"].values()),
              "checked lakes": sum("c" in e for e in state["lakes"].values())}
    print(f"Saved {READINGS_FILE.name}: {counts}")


if __name__ == "__main__":
    main()
