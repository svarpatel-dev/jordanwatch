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

# cyan.json goes in the repo's top folder, next to index.html
OUTPUT_FILE = Path(__file__).resolve().parent.parent / "cyan.json"


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
        return {**point, "status": "no-data"}, set()

    # Images with 0 valid pixels are almost always clouds, so skip them.
    valid = [o for o in outputs if o.get("validCellsCount", 0) > 0]
    newest = max(outputs, key=lambda o: o["imageDateLong"])
    if not valid:
        return {**point, "status": "no-data", "newestImageDate": to_date(newest["imageDateLong"])}, set()

    # Sort by the numeric timestamp, not the "MM-DD-YYYY" text,
    # which doesn't sort correctly as a string.
    latest = max(valid, key=lambda o: o["imageDateLong"])
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
    }
    reading_dates = {to_date(o["imageDateLong"]) for o in valid}
    return result, reading_dates


def clean_lake_days(today):
    """Dates in the last 14 days when the lake image was clear and mostly
    below detection, newest first."""
    start = today - timedelta(days=LOOKBACK_DAYS)
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
        if day_text not in reading_dates:
            return {
                **result,
                "status": "ok",
                "imageDate": day_text,
                "cellsPerMl": 0,
                "maxCellsPerMl": 0,
                "frequency": "Daily",
                "belowDetection": True,
                # keep the last real reading for reference
                "lastDetectedDate": result.get("imageDate"),
                "lastDetectedCellsPerMl": result.get("cellsPerMl"),
            }
    return result


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
    try:
        clean_days = clean_lake_days(datetime.now(timezone.utc).date())
        print("Clean lake days in the last 14:", [d.isoformat() for d in clean_days] or "none")
    except Exception as error:
        clean_days = []
        print(f"Whole-lake data FAILED ({error}); skipping the clean-day check")

    for point in LAKE_POINTS:
        try:
            result, reading_dates = fetch_point(point)
            result = apply_clean_days(result, reading_dates, clean_days)
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

    # Exit with an error code only if every point failed, so GitHub
    # Actions can flag the run.
    if failures == len(LAKE_POINTS):
        sys.exit(1)


if __name__ == "__main__":
    main()
