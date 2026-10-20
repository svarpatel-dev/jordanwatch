"""
Each state's official way to report an algal bloom, for the "Report a bloom"
link on every lake card (researched Oct 11: 50 states + DC, every link
checked). Reads the research table, which stays outside the repo (its notes
have staff names and numbers the app doesn't need), and writes only what
the app shows:
    data/report_routes.json   {"NC": [agency, route type, url, fresh water], ...}
route type: form, email, phone, or page (a page that explains how to report).
fresh water = false where the research found no route for freshwater blooms
(its notes start with a capital "NO "); the app then points to EPA's
bloomWatch app instead.

Run: python3 scripts/make_report_routes.py ../jordanwatch-data/state-bloom-report-routes-2026-10.csv
"""

import csv
import json
import sys
from pathlib import Path

OUT_FILE = Path(__file__).resolve().parent.parent / "data" / "report_routes.json"


def main():
    routes = {}
    with open(sys.argv[1], newline="") as table:
        for row in csv.DictReader(table):
            fresh_water = not row["notes"].startswith("NO ")
            routes[row["state"]] = [row["agency"], row["route_type"], row["url"], fresh_water]
    # One state per line, so it's easy to read and git diffs stay small
    lines = [f"{json.dumps(state)}:{json.dumps(route)}" for state, route in sorted(routes.items())]
    OUT_FILE.write_text("{\n" + ",\n".join(lines) + "\n}\n")
    print(f"Saved {OUT_FILE.name}: {len(routes)} states, "
          f"{sum(not r[3] for r in routes.values())} without a freshwater route")


if __name__ == "__main__":
    main()
