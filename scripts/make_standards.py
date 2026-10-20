"""Builds data/standards.json from data/standards.csv.

The CSV is the table of each state's water quality standards for its
warm-water fish class (or its closest general one), checked against the
state regulations (decided Oct 10; spot-checked Oct 16). The app reads the
JSON, so a station near the user is compared with ITS OWN state's numbers
(js/nearby.js).

Run it again whenever the CSV changes:
    python3 scripts/make_standards.py

Standard library only. An empty cell means "this state has no single
statewide number", and the app then uses EPA's national number for that
measurement only (decided Oct 18).
"""

import csv
import json
from pathlib import Path

# Paths are relative to the repo folder (one level above scripts/)
REPO = Path(__file__).resolve().parent.parent
CSV_FILE = REPO / "data" / "standards.csv"
JSON_FILE = REPO / "data" / "standards.json"

# The row that holds EPA's national recommended criteria (the fallback)
EPA_CODE = "US-EPA"


def number_or_none(text):
    """'4.0' -> 4.0, '' -> None (an empty cell means no number)."""
    text = text.strip()
    return float(text) if text else None


def first_url(text):
    """Some rows list two sources ("url1 ; url2"). The app links the first."""
    return text.split(";")[0].strip()


def make_row(csv_row):
    """One CSV row -> the dict the app uses (shorter, camelCase names,
    like the rest of the app's JSON files)."""
    return {
        "code": csv_row["state"].strip(),
        "name": csv_row["state_name"].strip(),
        # Shown after the state's name, so drop a period at the end
        "useClass": csv_row["use_class"].strip().rstrip("."),
        "doMin": number_or_none(csv_row["do_min_mg_l"]),        # mg/L, at any time
        "phMin": number_or_none(csv_row["ph_min"]),
        "phMax": number_or_none(csv_row["ph_max"]),
        "turbidityLakes": number_or_none(csv_row["turbidity_ntu_lakes"]),    # NTU
        "turbidityStreams": number_or_none(csv_row["turbidity_ntu_streams"]),
        "citation": csv_row["citation"].strip(),
        "sourceUrl": first_url(csv_row["source_url"]),
        "confidence": csv_row["confidence"].strip()   # high / medium / low
    }


def check(row):
    """Stop with a clear message if a row has a number that can't be right,
    so a typo in the CSV never reaches the app."""
    problems = []
    if row["doMin"] is not None and not 0 < row["doMin"] < 15:
        problems.append(f"DO minimum {row['doMin']}")
    # pH comes as a pair: both numbers or neither
    if (row["phMin"] is None) != (row["phMax"] is None):
        problems.append("only one end of the pH range")
    elif row["phMin"] is not None and not 0 < row["phMin"] < row["phMax"] < 14:
        problems.append(f"pH range {row['phMin']}-{row['phMax']}")
    for key in ("turbidityLakes", "turbidityStreams"):
        if row[key] is not None and row[key] <= 0:
            problems.append(f"{key} {row[key]}")
    if not row["sourceUrl"].startswith("http"):
        problems.append("no source link")
    if problems:
        raise ValueError(f"{row['code']}: " + ", ".join(problems))


def main():
    with open(CSV_FILE, newline="", encoding="utf-8") as f:
        rows = [make_row(r) for r in csv.DictReader(f)]

    for row in rows:
        check(row)

    # Pull out EPA's row; every other row is a state (or DC)
    epa = [r for r in rows if r["code"] == EPA_CODE]
    if len(epa) != 1:
        raise ValueError(f"expected exactly one {EPA_CODE} row, found {len(epa)}")
    epa = epa[0]
    # EPA's numbers are the fallback for every state, so they must be complete
    # (turbidity is the exception: EPA has no national number for it)
    if None in (epa["doMin"], epa["phMin"], epa["phMax"]):
        raise ValueError("the EPA row needs a DO minimum and a pH range")

    # Keyed by the full state name, because that's what USGS gives for each
    # station ("North Carolina"), like a Python dict lookup
    states = {r["name"]: r for r in rows if r["code"] != EPA_CODE}

    output = {
        "about": "Each state's water quality standards for its warm-water fish "
                 "class (or its closest general one), plus EPA's national "
                 "recommended criteria as the fallback. Built by "
                 "scripts/make_standards.py from data/standards.csv.",
        "epa": epa,
        "states": states
    }
    with open(JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=1, ensure_ascii=False)

    print(f"Wrote {JSON_FILE.name}: {len(states)} states + EPA fallback")


if __name__ == "__main__":
    main()
