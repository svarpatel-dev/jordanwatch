"""
Bloom forecast feasibility test for JordanWatch (open question 30).

Question: can a simple model predict whether Jordan Lake's satellite algae
level will RISE, stay STEADY or FALL about 7 days after the latest image,
better than just assuming "same as last image" (= always "steady")?

Plan decided Oct 8:
  - rise  = next level > 1.5x the latest level
    fall  = next level < latest / 1.5
    steady = anything in between
  - train on 2020-2023, test on 2025-2026 (2024 is left out)
  - pass = at least 5 percentage points more accurate than "same as last
    image" AND better at catching real rises
  - logistic regression first; random forest only if it fails

Two versions are tested:
  LAKE: one forecast for the whole lake, from EPA's lake-level endpoint.
        That endpoint counts every lake pixel per day (below detection,
        detected, cloud), so clean days are in the history.
  AREA: one forecast per lake area, from the same point readings the app
        uses. Bug 9: the point endpoint leaves out days when the water was
        below detection, so on a day when the lake image is mostly
        cloud-free and a point has no reading, we count that point as
        "below detection". That is an approximation (the point's own pixel
        could have been cloudy), so the AREA result is less certain.

Data (downloaded once into ../forecast-cache/, outside the repo):
  EPA CyAN (satellite), Open-Meteo archive (weather), USGS daily flow
  (Haw River near Bynum, 02096960).

Run:  python3 scripts/forecast_test.py      (needs numpy + scikit-learn)
"""

import json
import math
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CACHE = Path(__file__).resolve().parent.parent.parent / "forecast-cache"
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}

# The same ten points as fetch_cyan.py.
POINTS = {
    "north": (35.81, -78.99), "crosswinds": (35.748, -79.015),
    "parkers-creek": (35.745, -79.030), "white-oak": (35.742, -79.024),
    "intake": (35.739, -79.027), "seaforth": (35.727, -79.027),
    "poplar-point": (35.722, -79.027), "ebenezer-church": (35.707, -79.032),
    "vista-point": (35.703, -79.042), "new-hope-overlook": (35.697, -79.038),
}

JORDAN_LAKE_ID = 2764219   # CyAN waterbody id
YEARS = range(2020, 2027)
TRAIN_YEARS = {2020, 2021, 2022, 2023}
TEST_YEARS = {2025, 2026}

# The lake-level histogram has 1,066 pixels every day: 68 land (bin 254),
# 465 pixels that are always "0" (inside the image's box but outside the
# lake; found Oct 9: they stay 0 even on days with no image at all), and
# 533 real lake pixels. So "below detection" on the lake = bin 0 minus 465.
OUTSIDE_LAKE = 465
LAKE_PIXELS = 533
TOTAL_PIXELS = 1066

# CyAN's lowest detectable level is pixel value 1 = about 6,500 cells/mL.
# "Below detection" is stored as 3,000 so that ratios still work.
BELOW_DETECTION = 3000

RATIO = 1.5           # rise / fall threshold from the Oct 8 plan
HORIZON = 7           # days after the latest image
WINDOW = (5, 9)       # accept a "next image" 5-9 days later, closest to 7
CLEAR_LAKE = 0.8      # an image counts as clear if >= 80% of lake pixels are seen
USABLE_LAKE = 0.5     # the lake-wide level is used if >= 50% are seen
CLASSES = ["fall", "steady", "rise"]


# ---------- downloading (cached) ----------

def get_json(url, filename):
    """Download a JSON file once and keep it in the cache folder."""
    path = CACHE / filename
    if not path.exists():
        print("downloading", filename)
        request = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(request, timeout=400) as response:
            path.write_bytes(response.read())
    return json.loads(path.read_text())


def load_lake_days():
    """Whole-lake pixel counts per day: {date: (below, detected_values, cloud)}."""
    days = {}
    for year in YEARS:
        # One year per request: longer ranges time out on EPA's server.
        url = ("https://cyan.epa.gov/waterbody/data/?OBJECTID={}&start_year={}"
               "&start_day=1&end_year={}&end_day=366").format(JORDAN_LAKE_ID, year, year)
        data = get_json(url, f"lake_{year}.json")["data"]
        for key, bins in data.items():
            y, day_of_year = map(int, key.split())
            if sum(bins) != TOTAL_PIXELS:
                continue   # a few 2023 days have extra pixels; skip them
            day = date(y, 1, 1) + timedelta(day_of_year - 1)
            below = bins[0] - OUTSIDE_LAKE
            detected = {dn: int(count) for dn, count in enumerate(bins) if 1 <= dn <= 253 and count}
            days[day] = (below, detected, bins[255])
    return days


def load_points():
    """Daily point readings per area: {area: {date: cells/mL}}."""
    points = {}
    for area, (lat, lng) in POINTS.items():
        url = f"https://cyan.epa.gov/cyan/cyano/location/data/{lat}/{lng}/all"
        outputs = get_json(url, f"point_{area}.json")["outputs"]
        points[area] = {
            datetime.fromtimestamp(o["imageDateLong"] / 1000, tz=timezone.utc).date(): o["cellConcentration"]
            for o in outputs
            if o.get("satelliteImageFrequency") == "Daily" and o.get("validCellsCount", 0) > 0
        }
    return points


def load_weather():
    """Daily weather at the lake: {date: {temp, rain, wind, sun}}."""
    url = ("https://archive-api.open-meteo.com/v1/archive?latitude=35.73&longitude=-79.02"
           "&start_date=2019-12-01&end_date=2026-10-08&timezone=America%2FNew_York"
           "&wind_speed_unit=ms&daily=temperature_2m_mean,precipitation_sum,"
           "wind_speed_10m_mean,shortwave_radiation_sum")
    d = get_json(url, "weather.json")["daily"]
    return {
        date.fromisoformat(t): {"temp": d["temperature_2m_mean"][i], "rain": d["precipitation_sum"][i],
                                "wind": d["wind_speed_10m_mean"][i], "sun": d["shortwave_radiation_sum"][i]}
        for i, t in enumerate(d["time"])
    }


def load_flow():
    """Haw River near Bynum daily mean flow (cubic feet per second): {date: flow}."""
    url = ("https://api.waterdata.usgs.gov/ogcapi/v0/collections/daily/items?f=json"
           "&monitoring_location_id=USGS-02096960&parameter_code=00060&statistic_id=00003"
           "&datetime=2019-12-01/2026-10-08&limit=10000&properties=time,value")
    features = get_json(url, "flow.json")["features"]
    return {date.fromisoformat(f["properties"]["time"]): float(f["properties"]["value"])
            for f in features if f["properties"]["value"] not in (None, "")}


# ---------- building the two series ----------

def cells(dn):
    """CyAN pixel value (1-253) -> cells/mL (EPA's published formula)."""
    return 10 ** (0.012 * dn - 4.2) * 1e8


def lake_series(lake_days):
    """Whole-lake average level per usable day (below detection = 3,000)."""
    series = {}
    for day, (below, detected, cloud) in lake_days.items():
        seen = below + sum(detected.values())
        if seen / LAKE_PIXELS < USABLE_LAKE:
            continue
        total = below * BELOW_DETECTION + sum(cells(dn) * n for dn, n in detected.items())
        series[day] = total / seen
    return series


def area_series(points, lake_days):
    """Per-area level per day: the point reading, or 'below detection' on a
    clear-lake day when the point has no reading (bug 9 gap-fill)."""
    clear_days = {day for day, (below, detected, cloud) in lake_days.items()
                  if (below + sum(detected.values())) / LAKE_PIXELS >= CLEAR_LAKE}
    series = {}
    for area, readings in points.items():
        filled = dict(readings)
        for day in clear_days:
            filled.setdefault(day, BELOW_DETECTION)
        series[area] = filled
    return series


# ---------- examples: (features, label) ----------

def label(now, later):
    ratio = later / now
    if ratio > RATIO:
        return "rise"
    if ratio < 1 / RATIO:
        return "fall"
    return "steady"


def flow_normals(flow):
    """Median flow for each day of the year (±15 days), training years only,
    so the test years never leak into the model."""
    by_day = {d: [] for d in range(1, 367)}
    for day, value in flow.items():
        if day.year in TRAIN_YEARS:
            for offset in range(-15, 16):
                by_day[(day.timetuple().tm_yday - 1 + offset) % 366 + 1].append(value)
    return {d: float(np.median(v)) for d, v in by_day.items() if v}


def mean_over(weather, start, days, field):
    values = [weather[start + timedelta(i)][field] for i in range(days) if start + timedelta(i) in weather]
    return sum(values) / len(values) if values else float("nan")


def features(series, day, previous_day, weather, flow, normals, lake_detected):
    """The model's inputs for one image day. Weather for the next 7 days uses
    what actually happened (live, it would use the weather forecast)."""
    now, before = series[day], series[previous_day]
    day_of_year = day.timetuple().tm_yday
    week_ago = day - timedelta(6)
    flow_now = flow.get(day)
    return [
        math.log10(now),                                   # level now
        math.log10(now) - math.log10(before),              # recent trend
        (day - previous_day).days,                         # days since the image before
        lake_detected,                                     # share of the lake with a detection
        mean_over(weather, week_ago, 7, "temp"),           # last 7 days
        mean_over(weather, week_ago, 7, "temp") - mean_over(weather, week_ago - timedelta(7), 7, "temp"),
        mean_over(weather, week_ago, 7, "rain") * 7,
        mean_over(weather, week_ago, 7, "wind"),
        mean_over(weather, week_ago, 7, "sun"),
        mean_over(weather, day + timedelta(1), HORIZON, "temp"),   # next 7 days
        mean_over(weather, day + timedelta(1), HORIZON, "rain") * HORIZON,
        mean_over(weather, day + timedelta(1), HORIZON, "wind"),
        math.log10(flow_now / normals[day_of_year]) if flow_now and day_of_year in normals else 0.0,
        math.sin(2 * math.pi * day_of_year / 365.25),       # season
        math.cos(2 * math.pi * day_of_year / 365.25),
    ]


def next_image(series, day):
    """The image closest to 7 days later, within 5-9 days, or None."""
    for offset in (0, -1, 1, -2, 2):
        later = day + timedelta(HORIZON + offset)
        if WINDOW[0] <= (later - day).days <= WINDOW[1] and later in series:
            return later
    return None


def examples(series, weather, flow, normals, lake_days, area_index=None, n_areas=0):
    rows = []
    days = sorted(series)
    for i, day in enumerate(days[1:], start=1):
        previous_day = days[i - 1]
        later = next_image(series, day)
        if later is None or (day - previous_day).days > 14:
            continue
        below, detected, cloud = lake_days.get(day, (0, {}, 0))
        seen = below + sum(detected.values())
        lake_detected = sum(detected.values()) / seen if seen else 0.0
        x = features(series, day, previous_day, weather, flow, normals, lake_detected)
        if area_index is not None:
            x += [1.0 if j == area_index else 0.0 for j in range(n_areas)]
        if any(math.isnan(v) for v in x):
            continue
        rows.append((day, x, label(series[day], series[later])))
    return rows


# ---------- scoring ----------

def report(name, rows):
    train = [r for r in rows if r[0].year in TRAIN_YEARS]
    test = [r for r in rows if r[0].year in TEST_YEARS]
    X_train = np.array([r[1] for r in train]); y_train = [r[2] for r in train]
    X_test = np.array([r[1] for r in test]); y_test = [r[2] for r in test]

    print(f"\n=== {name} ===")
    print(f"examples: train {len(train)} (2020-23), test {len(test)} (2025-26)")
    print("test labels:", dict(Counter(y_test)), " train labels:", dict(Counter(y_train)))

    baseline = ["steady"] * len(y_test)
    models = {
        "same as last image (baseline)": None,
        "logistic regression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000)),
        "logistic regression, balanced classes": make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=2000, class_weight="balanced")),
        "random forest (only if LR fails)": RandomForestClassifier(
            n_estimators=300, min_samples_leaf=5, random_state=0),
    }
    base_acc = accuracy(y_test, baseline)
    results = {}
    for model_name, model in models.items():
        if model is None:
            predicted = baseline
        else:
            model.fit(X_train, y_train)
            predicted = list(model.predict(X_test))
        acc = accuracy(y_test, predicted)
        rise_recall, rise_precision = catch(y_test, predicted, "rise")
        passed = model is not None and acc >= base_acc + 0.05 and rise_recall > 0
        results[model_name] = (acc, rise_recall, rise_precision, passed)
        print(f"  {model_name:40} accuracy {acc:6.1%}   rises caught {rise_recall:6.1%}"
              f"   rise calls right {rise_precision:6.1%}" + ("   PASS" if passed else ""))
        if model is not None:
            print("      confusion (rows = real fall/steady/rise, cols = predicted):",
                  [[sum(1 for t, p in zip(y_test, predicted) if t == a and p == b) for b in CLASSES]
                   for a in CLASSES])
    return results


def accuracy(truth, predicted):
    return sum(t == p for t, p in zip(truth, predicted)) / len(truth) if truth else float("nan")


def catch(truth, predicted, cls):
    """recall = share of real rises the model called; precision = share of
    its rise calls that were real."""
    real = sum(t == cls for t in truth)
    called = sum(p == cls for p in predicted)
    hit = sum(t == cls and p == cls for t, p in zip(truth, predicted))
    return (hit / real if real else 0.0), (hit / called if called else 0.0)


def bug9_summary(points, lake_days):
    """Step 1: how often the point data skips clean, cloud-free days."""
    clean = [d for d, (below, detected, cloud) in lake_days.items()
             if d.year in TEST_YEARS and (below + sum(detected.values())) / LAKE_PIXELS >= CLEAR_LAKE
             and below / max(below + sum(detected.values()), 1) >= 0.8]
    print(f"Bug 9 check (2025-26): {len(clean)} cloud-free days with >= 80% of the lake below detection")
    for area, readings in points.items():
        print(f"  {area:18} point has a reading on {sum(d in readings for d in clean):3} of them")


def main():
    CACHE.mkdir(exist_ok=True)
    lake_days = load_lake_days()
    points = load_points()
    weather = load_weather()
    flow = load_flow()
    normals = flow_normals(flow)

    bug9_summary(points, lake_days)

    lake = lake_series(lake_days)
    report("LAKE: whole-lake forecast", examples(lake, weather, flow, normals, lake_days))

    areas = area_series(points, lake_days)
    rows = []
    for i, area in enumerate(POINTS):
        rows += examples(areas[area], weather, flow, normals, lake_days, i, len(POINTS))
    report("AREA: per-area forecast (bug 9 gap-filled)", rows)

    raw = []
    for i, area in enumerate(POINTS):
        raw += examples(points[area], weather, flow, normals, lake_days, i, len(POINTS))
    report("AREA, raw point data (no gap-fill; for comparison only)", raw)


if __name__ == "__main__":
    main()
