"""
Make the ZIP code lookup files for JordanWatch's "See what's near you" step.

Why a script: the app turns a typed ZIP code into a point on the map without
sending the ZIP anywhere, so it needs its own list of where every ZIP code
is. This downloads the US Census Bureau's ZIP Code Tabulation Area (ZCTA)
Gazetteer file (public domain) and saves each ZCTA's internal point
(roughly the middle of its area).

ZCTAs approximate ZIP codes: ZIPs used only for PO boxes or a single
building have no ZCTA, so they're missing (the app says it couldn't find them).

The files are split by the ZIP's first digit (data/zip/0.json ... 9.json), so
a phone only downloads about a tenth of the list. Each looks like
{"27519": [35.808, -78.887], ...}, with lat/lng rounded to 3 decimals
(about 100 m, plenty for the middle of a ZIP area).

Run once (and again when the Census publishes a new year):
    python3 scripts/make_zip_points.py
"""

import csv
import io
import json
import urllib.request
import zipfile
from pathlib import Path

GAZETTEER_URL = ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
                 "2026_Gazetteer/2026_Gaz_zcta_national.zip")
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}

DECIMALS = 3   # 3 decimals of latitude is about 100 m

# data/zip/ goes in the repo's top folder, next to index.html
OUTPUT_FOLDER = Path(__file__).resolve().parent.parent / "data" / "zip"


def download_gazetteer():
    """Download the Census zip file and return the text of the table inside."""
    request = urllib.request.Request(GAZETTEER_URL, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=120) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    # The zip file holds a single .txt table
    name = archive.namelist()[0]
    return archive.read(name).decode("utf-8")


def read_points(text):
    """Return {zip: [lat, lng]} from the Gazetteer table."""
    lines = text.splitlines()
    # The 2026 file separates columns with "|"; older years used tabs
    delimiter = "|" if "|" in lines[0] else "\t"

    points = {}
    for row in csv.DictReader(lines, delimiter=delimiter):
        # Older files have stray spaces in names and values (e.g. "INTPTLONG  ")
        row = {key.strip(): value.strip() for key, value in row.items()}
        lat = round(float(row["INTPTLAT"]), DECIMALS)
        lng = round(float(row["INTPTLONG"]), DECIMALS)
        points[row["GEOID"]] = [lat, lng]
    return points


def save_by_first_digit(points):
    """Write data/zip/0.json ... 9.json, one per first digit of the ZIP."""
    OUTPUT_FOLDER.mkdir(parents=True, exist_ok=True)
    for digit in "0123456789":
        group = {z: point for z, point in sorted(points.items()) if z.startswith(digit)}
        path = OUTPUT_FOLDER / f"{digit}.json"
        # No spaces after commas and colons keeps the files small
        path.write_text(json.dumps(group, separators=(",", ":")) + "\n")
        print(f"{path.name}: {len(group):,} ZIPs, {path.stat().st_size / 1024:.0f} KB")


def main():
    points = read_points(download_gazetteer())
    print(f"Read {len(points):,} ZIP code areas from the Census Gazetteer")
    save_by_first_digit(points)


if __name__ == "__main__":
    main()
