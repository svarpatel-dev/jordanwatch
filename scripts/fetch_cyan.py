"""
Fetch the latest EPA CyAN satellite cyanobacteria estimates for ten
points on Jordan Lake and save them to cyan.json for the JordanWatch app.

Why a script: EPA's CyAN API blocks browsers from reading it directly
(no CORS header), so this runs on GitHub Actions every 6 hours instead,
and the app reads the saved cyan.json from its own site.

Clean days (bug 9, fixed Oct 10): EPA's point data leaves out days when
the water was below detection, so after a bloom clears, a point's latest
reading can be an old bloom. So the script also reads EPA's whole-lake
pixel counts. If a recent image saw most of the lake, most of what it saw
was below detection, and a point has no reading that day, that point is
marked "below detection" on that date (cellsPerMl 0, belowDetection true).

Recent blooms (bug 11, fixed Oct 15): one arm of the lake can still be
blooming while the rest is clean, and the whole-lake counts can't tell.
So a point whose own latest reading was at the Caution level or higher
(20,000+ cells/mL) is never marked clean within 7 days of that reading;
it keeps its warning.

Daily history (decided Oct 21, for the trend charts): every run also saves
one value per day for each of the ten points over the last 120 days, in
data/history/jordan.json. It's rebuilt from EPA's full archive each run, so
nothing is lost if a run fails. Clean days are filled the same way as above
(the whole-lake counts), with the same bug 11 rule: a day is only marked
clean if the point wasn't at 20,000+ cells/mL in the 7 days before it.

Run locally:  python3 scripts/fetch_cyan.py
"""

import json
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Ten lake points tested on Oct 3, ordered north to south. Each sits a few
# hundred meters offshore of its area, because CyAN masks out pixels that
# touch land. "id" is the permanent key the app uses; "kind" is "area" for
# places people visit and "intake" for the drinking-water intake (context only).
LAKE_POINTS = [
    {"id": "north", "name": "Upper New Hope Arm", "kind": "area", "lat": 35.81, "lng": -78.99},
    {"id": "crosswinds", "name": "Crosswinds", "kind": "area", "lat": 35.748, "lng": -79.015},
    {"id": "parkers-creek", "name": "Parkers Creek", "kind": "area", "lat": 35.745, "lng": -79.030},
    {"id": "white-oak", "name": "White Oak", "kind": "area", "lat": 35.742, "lng": -79.024},
    {"id": "intake", "name": "Cary/Apex Water Intake", "kind": "intake", "lat": 35.739, "lng": -79.027},
    {"id": "seaforth", "name": "Seaforth", "kind": "area", "lat": 35.727, "lng": -79.027},
    {"id": "poplar-point", "name": "Poplar Point", "kind": "area", "lat": 35.722, "lng": -79.027},
    {"id": "ebenezer-church", "name": "Ebenezer Church", "kind": "area", "lat": 35.707, "lng": -79.032},
    {"id": "vista-point", "name": "Vista Point", "kind": "area", "lat": 35.703, "lng": -79.042},
    {"id": "new-hope-overlook", "name": "New Hope Overlook", "kind": "area", "lat": 35.697, "lng": -79.038},
]

CYAN_URL = "https://cyan.epa.gov/cyan/cyano/location/data/{lat}/{lng}/all"
LAKE_URL = ("https://cyan.epa.gov/waterbody/data/?OBJECTID=2764219"
            "&start_year={year}&start_day={start}&end_year={year}&end_day={end}")
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}

# EPA's whole-lake counts for Jordan Lake have 1,066 pixels every day:
# bin 0 = below detection, 1-253 = detected, 254 = land, 255 = cloud / no data.
# 465 of the bin-0 pixels are always 0 because they lie outside the lake
# (found Oct 9), so the real lake is 533 pixels.
OUTSIDE_LAKE = 465
LAKE_PIXELS = 533

LOOKBACK_DAYS = 14   # the app ignores satellite images older than this anyway
CLEAR_SHARE = 0.8    # the image must see at least 80% of the lake
CLEAN_SHARE = 0.5    # and at least half of what it saw must be below detection,
                     # so a point that's missing on a bloom day is never called clean

# Bug 11: a point that was blooming this recently keeps its warning
RECENT_BLOOM_CELLS = 20000   # the WHO 1999/2003 low-risk level (Caution and up)
RECENT_BLOOM_DAYS = 7

# Daily history for the trend charts (decided Oct 21): this many days back
HISTORY_DAYS = 120

# cyan.json goes in the repo's top folder, next to index.html
OUTPUT_FILE = Path(__file__).resolve().parent.parent / "cyan.json"
HISTORY_FILE = Path(__file__).resolve().parent.parent / "data" / "history" / "jordan.json"


def get_json(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def fetch_point(point):
    """Return the latest cloud-free satellite reading for one lake point,
    plus the set of dates when the point had a reading."""
    data = get_json(CYAN_URL.format(lat=point["lat"], lng=point["lng"]))

    outputs = data.get("outputs", [])
    if not outputs:
        return {**point, "status": "no-data"}, set(), {}

    # Images with 0 valid pixels are almost always clouds, so skip them.
    valid = [o for o in outputs if o.get("validCellsCount", 0) > 0]
    newest = max(outputs, key=lambda o: o["imageDateLong"])
    if not valid:
        return {**point, "status": "no-data", "newestImageDate": to_date(newest["imageDateLong"])}, set(), {}

    # Sort by the numeric timestamp, not the "MM-DD-YYYY" text,
    # which doesn't sort correctly as a string.
    latest = max(valid, key=lambda o: o["imageDateLong"])

    # The image before it, for the trend arrow (decided Oct 12): the newest
    # reading from an earlier day
    earlier = [o for o in valid if to_date(o["imageDateLong"]) < to_date(latest["imageDateLong"])]
    previous = max(earlier, key=lambda o: o["imageDateLong"]) if earlier else None

    result = {
        **point,
        "status": "ok",
        "imageDate": to_date(latest["imageDateLong"]),
        "newestImageDate": to_date(newest["imageDateLong"]),
        "cellsPerMl": round(latest["cellConcentration"]),
        "maxCellsPerMl": round(latest["maxCellConcentration"]),
        "validPixels": latest["validCellsCount"],
        "frequency": latest.get("satelliteImageFrequency"),
        "belowDetection": False,
        "previousDate": to_date(previous["imageDateLong"]) if previous else None,
        "previousCellsPerMl": round(previous["cellConcentration"]) if previous else None,
    }
    reading_dates = {to_date(o["imageDateLong"]) for o in valid}
    return result, reading_dates, daily_readings(valid)


def daily_readings(valid):
    """{date: cells/mL} from the point's daily images (decided Oct 21: the
    weekly ones are the worst day of a week, so they'd make a daily chart
    look worse than it was). If a day has two, the higher one counts."""
    days = {}
    for o in valid:
        if o.get("satelliteImageFrequency") != "Daily":
            continue
        day = to_date(o["imageDateLong"])
        days[day] = max(days.get(day, 0), round(o["cellConcentration"]))
    return days


def clean_lake_days(today, look_back=LOOKBACK_DAYS):
    """Dates in the last look_back days when the lake image was clear and
    mostly below detection, newest first."""
    start = today - timedelta(days=look_back)
    days = {}
    # One request per calendar year (the window can cross New Year's Day)
    for year in sorted({start.year, today.year}):
        first = start if start.year == year else date(year, 1, 1)
        last = today if today.year == year else date(year, 12, 31)
        url = LAKE_URL.format(year=year, start=first.timetuple().tm_yday, end=last.timetuple().tm_yday)
        days.update(get_json(url).get("data", {}))

    clean = []
    for key, bins in days.items():
        year, day_of_year = map(int, key.split())
        below = bins[0] - OUTSIDE_LAKE
        seen = below + sum(bins[1:254])
        if seen >= CLEAR_SHARE * LAKE_PIXELS and below >= CLEAN_SHARE * seen:
            clean.append(date(year, 1, 1) + timedelta(days=day_of_year - 1))
    return sorted(clean, reverse=True)


def apply_clean_days(result, reading_dates, clean_days):
    """If the lake was clean after this point's last reading, and the point has
    no reading that day, mark it below detection on the newest such day."""
    for day in clean_days:
        day_text = day.isoformat()
        if result.get("imageDate") and day_text <= result["imageDate"]:
            return result   # the point's own reading is newer; keep it
        if bloomed_recently(result, day):
            # Bug 11: this spot was blooming within the last week, so the
            # rest of the lake being clean doesn't prove it is. Older clean
            # days are even closer to that bloom, so stop here.
            return result
        if day_text not in reading_dates:
            return {
                **result,
                "status": "ok",
                "imageDate": day_text,
                "cellsPerMl": 0,
                "maxCellsPerMl": 0,
                "frequency": "Daily",
                "belowDetection": True,
                # keep the last real reading for reference; it's also the
                # previous image for the trend arrow
                "lastDetectedDate": result.get("imageDate"),
                "lastDetectedCellsPerMl": result.get("cellsPerMl"),
                "previousDate": result.get("imageDate"),
                "previousCellsPerMl": result.get("cellsPerMl"),
            }
    return result


def bloomed_recently(result, day):
    """True if this point's latest reading was at the Caution level or higher
    (20,000+ cells/mL) no more than 7 days before this day (bug 11)."""
    if result.get("status") != "ok":
        return False
    days_since = (day - date.fromisoformat(result["imageDate"])).days
    return result["cellsPerMl"] >= RECENT_BLOOM_CELLS and days_since <= RECENT_BLOOM_DAYS


def point_history(readings, clean_days, today):
    """One point's last 120 days for the trend chart: [[date, cells/mL], ...],
    oldest first, 0 = below detection. Days with no reading stay out (the
    chart leaves a gap: clouds or no satellite pass)."""
    start = (today - timedelta(days=HISTORY_DAYS)).isoformat()
    days = {day: cells for day, cells in readings.items() if day >= start}
    for day in clean_days:
        text = day.isoformat()
        if text < start or text in days:
            continue
        # Bug 11, day by day: blooming in the week before → not called clean
        week_before = (day - timedelta(days=RECENT_BLOOM_DAYS)).isoformat()
        if any(week_before <= d < text and cells >= RECENT_BLOOM_CELLS for d, cells in readings.items()):
            continue
        days[text] = 0
    return [[day, days[day]] for day in sorted(days)]


def save_history(histories, previous_file):
    """data/history/jordan.json: { points: { "north": [[date, cells], ...] } }.
    A point that failed this run keeps its last saved history."""
    try:
        old = json.loads(previous_file.read_text()).get("points", {})
    except (FileNotFoundError, json.JSONDecodeError):
        old = {}
    points = {p["id"]: histories.get(p["id"], old.get(p["id"], [])) for p in LAKE_POINTS}
    previous_file.parent.mkdir(parents=True, exist_ok=True)
    header = {
        "source": "EPA CyAN daily satellite estimates at JordanWatch's ten Jordan Lake points",
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "One value per day, cells/mL, last 120 days. 0 = below detection (a clear whole-lake "
                "image, filled like cyan.json). Missing days: clouds or no satellite pass.",
    }
    # One point per line, so git only stores what changed
    lines = [f'    {json.dumps(pid)}: {json.dumps(days, separators=(",", ":"))}' for pid, days in points.items()]
    top = json.dumps(header, indent=2)[:-2]   # the header without its closing brace
    previous_file.write_text(top + ',\n  "points": {\n' + ",\n".join(lines) + "\n  }\n}\n")


def to_date(milliseconds):
    """Turn CyAN's millisecond timestamp into a 'YYYY-MM-DD' date string."""
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).date().isoformat()


def load_previous():
    """Last run's results by point id, so a failed fetch can keep them."""
    try:
        previous = json.loads(OUTPUT_FILE.read_text())
        return {p["id"]: p for p in previous.get("points", []) if "id" in p}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main():
    previous = load_previous()
    points = []
    failures = 0

    # Whole-lake check for clean days; if EPA's lake data fails, carry on
    # without it (the app then shows old readings as before, never falsely clean)
    today = datetime.now(timezone.utc).date()
    try:
        # The last 120 days for the history; the last 14 of them for today's readings
        history_clean_days = clean_lake_days(today, HISTORY_DAYS)
        recent = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
        clean_days = [d for d in history_clean_days if d.isoformat() >= recent]
        print("Clean lake days in the last 14:", [d.isoformat() for d in clean_days] or "none")
    except Exception as error:
        clean_days = history_clean_days = []
        print(f"Whole-lake data FAILED ({error}); skipping the clean-day check")
    histories = {}

    for point in LAKE_POINTS:
        try:
            result, reading_dates, readings = fetch_point(point)
            result = apply_clean_days(result, reading_dates, clean_days)
            histories[point["id"]] = point_history(readings, history_clean_days, today)
            print(f"{point['name']}: {result['status']}", result.get("imageDate", ""), result.get("cellsPerMl", ""),
                  "(below detection)" if result.get("belowDetection") else "")
        except Exception as error:
            # EPA down or a bad response: keep last run's data for this point
            # instead of wiping it. The app's staleness rules flag old dates.
            failures += 1
            print(f"{point['name']}: FAILED ({error}); keeping previous data")
            result = previous.get(point["id"], {**point, "status": "error"})
        points.append(result)

    output = {
        "source": "EPA CyAN (Cyanobacteria Assessment Network), satellite estimate",
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "points": points,
    }
    OUTPUT_FILE.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Saved {OUTPUT_FILE.name} ({len(points) - failures} of {len(points)} points fetched)")
    save_history(histories, HISTORY_FILE)
    print(f"Saved {HISTORY_FILE.name}: {sum(len(h) for h in histories.values())} daily values")

    # Exit with an error code only if every point failed, so GitHub
    # Actions can flag the run.
    if failures == len(LAKE_POINTS):
        sys.exit(1)


if __name__ == "__main__":
    main()
