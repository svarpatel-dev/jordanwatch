"""
Fetch the latest EPA CyAN satellite cyanobacteria estimates for three
points on Jordan Lake and save them to cyan.json for the JordanWatch app.

Why a script: EPA's CyAN API blocks browsers from reading it directly
(no CORS header), so this runs on GitHub Actions every 6 hours instead,
and the app reads the saved cyan.json from its own site.

Run locally:  python3 scripts/fetch_cyan.py
"""

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# The three lake points tested on Sept 27 (all return satellite data)
LAKE_POINTS = [
    {"name": "North", "lat": 35.81, "lng": -78.99},
    {"name": "Middle", "lat": 35.75, "lng": -79.01},
    {"name": "South", "lat": 35.70, "lng": -79.03},
]

CYAN_URL = "https://cyan.epa.gov/cyan/cyano/location/data/{lat}/{lng}/all"

# cyan.json goes in the repo's top folder, next to index.html
OUTPUT_FILE = Path(__file__).resolve().parent.parent / "cyan.json"


def fetch_point(point):
    """Return the latest cloud-free satellite reading for one lake point."""
    url = CYAN_URL.format(lat=point["lat"], lng=point["lng"])
    request = urllib.request.Request(
        url, headers={"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)

    outputs = data.get("outputs", [])
    if not outputs:
        return {**point, "status": "no-data"}

    # Images with 0 valid pixels are almost always clouds, so skip them.
    valid = [o for o in outputs if o.get("validCellsCount", 0) > 0]
    newest = max(outputs, key=lambda o: o["imageDateLong"])
    if not valid:
        return {**point, "status": "no-data", "newestImageDate": to_date(newest["imageDateLong"])}

    # Sort by the numeric timestamp, not the "MM-DD-YYYY" text,
    # which doesn't sort correctly as a string.
    latest = max(valid, key=lambda o: o["imageDateLong"])
    return {
        **point,
        "status": "ok",
        "imageDate": to_date(latest["imageDateLong"]),
        "newestImageDate": to_date(newest["imageDateLong"]),
        "cellsPerMl": round(latest["cellConcentration"]),
        "maxCellsPerMl": round(latest["maxCellConcentration"]),
        "validPixels": latest["validCellsCount"],
        "frequency": latest.get("satelliteImageFrequency"),
    }


def to_date(milliseconds):
    """Turn CyAN's millisecond timestamp into a 'YYYY-MM-DD' date string."""
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).date().isoformat()


def load_previous():
    """Last run's results by point name, so a failed fetch can keep them."""
    try:
        previous = json.loads(OUTPUT_FILE.read_text())
        return {p["name"]: p for p in previous.get("points", [])}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main():
    previous = load_previous()
    points = []
    failures = 0

    for point in LAKE_POINTS:
        try:
            result = fetch_point(point)
            print(f"{point['name']}: {result['status']}", result.get("imageDate", ""), result.get("cellsPerMl", ""))
        except Exception as error:
            # EPA down or a bad response: keep last run's data for this point
            # instead of wiping it. The app's staleness rules flag old dates.
            failures += 1
            print(f"{point['name']}: FAILED ({error}); keeping previous data")
            result = previous.get(point["name"], {**point, "status": "error"})
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
