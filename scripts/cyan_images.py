"""
EPA CyAN's nationwide satellite images and lake outlines: the parts shared
by make_tiles.py (the map's satellite colors) and fetch_lakes.py (a verdict
for every lake). Written Oct 16 for the nationwide lake verdicts.

What EPA's nationwide image is (checked Oct 15, see the project notes):
- One PNG of the lower 48, already in the map's projection (Web Mercator),
  about 340 m per pixel. Every colored pixel is one satellite level (1-253);
  epa_cyan_colors.json turns each of EPA's 248 colors back into its level.
- Only DETECTED cyanobacteria are drawn. Clean water (below detection),
  clouds, land and "no satellite pass" are all fully transparent, so the
  image alone can never say that a lake is clean.
- Nothing is drawn south of about 29.86 N (southern Florida, Louisiana and
  the Texas coast).
- Asking for a day with no image returns an OLDER image, and old images get
  deleted. So each image is dated by its own "Year" and "Day" fields, and an
  image that comes back twice is only used once (bug 14, fixed Oct 16).
- The weekly image is each pixel's highest level over 7 days, dated by the
  week's first day.

Bug 12 (fixed Oct 16): EPA has 253 levels but only 248 colors, because
levels 76 and 77 share one color and 249-253 all use the top one. The old
color table numbered the colors 1-248, so from level 77 up every color read
one level too low (2.8% fewer cells/mL). epa_cyan_colors.json now holds each
color's real level (1-76, then 78-249).
"""

import ast
import gzip
import io
import json
import math
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None   # EPA's image is 263 million pixels, on purpose

IMAGE_URL = "https://cyan.epa.gov/waterbody/conus_image/?year={year}&day={day}&daily={daily}"
# EPA's lake outlines (6,951 lakes), already in Web Mercator meters like the
# image. 2,000 lakes per request, outlines simplified to about 50 m.
OUTLINE_URL = ("https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services/waterbodies_9/"
               "FeatureServer/0/query?where=1%3D1&outFields=OBJECTID,GNIS_NAME,STATE_ABBR,AREASQKM,c_lat,c_lng"
               "&returnGeometry=true&outSR=3857&maxAllowableOffset=50&geometryPrecision=0"
               "&orderByFields=FID&resultOffset={offset}&resultRecordCount=2000&f=json")
OUTLINE_PAGES = 4
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}
COLOR_TABLE = Path(__file__).resolve().parent / "epa_cyan_colors.json"

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
EARTH_RADIUS_M = 6378137        # the map projection's Earth (Web Mercator)
SUPERSAMPLE = 4                 # outline drawing detail, see prepare_masks


def level_to_cells(level):
    """EPA's formula: satellite level 1-253 -> cyanobacteria cells/mL."""
    return 10 ** (0.012 * level - 4.2) * 1e8


# cells/mL for every level 0-255 (the list position is the level), rounded so
# that level 100 is exactly 100,000. Level 0 = nothing detected there.
CELLS = np.array([0] + [round(level_to_cells(level)) for level in range(1, 256)])


def get_bytes(url, timeout=300):
    """Download one address. Asks for gzip, which makes the outlines about 4x smaller."""
    request = urllib.request.Request(url, headers={**HEADERS, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
    return data


# ---------- EPA's nationwide images ----------

def download_image(day, daily):
    """The image EPA gives for this day: {"kind", "date", "image"} with the
    image's OWN date, or None if EPA has none."""
    kind = "daily" if daily else "weekly"
    url = IMAGE_URL.format(year=day.year, day=day.timetuple().tm_yday, daily=daily)
    try:
        data = get_bytes(url)
    except Exception as error:
        print(f"{day} {kind}: download failed ({error})")
        return None
    # A missing day comes back as a short JSON message, not a PNG
    if data[:8] != PNG_SIGNATURE:
        print(f"{day} {kind}: no image")
        return None
    image = Image.open(io.BytesIO(data))
    image_date = date(int(image.info["Year"]), 1, 1) + timedelta(days=int(image.info["Day"]) - 1)
    return {"kind": kind, "date": image_date, "image": image}


def recent_images(today, daily_days, weekly_look_back):
    """EPA's daily images from the last few days plus the newest weekly one,
    each only once, newest first: [{"kind", "date", "image"}, ...].
    A weekly image goes by its week's first day; on the same date, the daily
    image comes first (it's one exact day)."""
    found = {}   # (kind, date) -> image, like a Python dict that drops repeats

    for back in range(daily_days):
        got = download_image(today - timedelta(days=back), daily=True)
        if got is None:
            continue
        key = (got["kind"], got["date"])
        if key in found:
            print(f"  (that's the {got['date']} image again, skipped)")
        elif (today - got["date"]).days < daily_days:
            found[key] = got
            print(f"  daily image of {got['date']}")

    for back in range(weekly_look_back + 1):
        got = download_image(today - timedelta(days=back), daily=False)
        if got is not None:
            found[(got["kind"], got["date"])] = got
            print(f"  weekly image of the week starting {got['date']}")
            break

    return sorted(found.values(), key=lambda im: (im["date"], im["kind"] == "daily"), reverse=True)


def image_levels(image):
    """One EPA image -> a grid of satellite levels (uint8: 0 = nothing drawn,
    otherwise the level) plus where the grid sits on the map (Web Mercator meters).
    Works one color channel at a time, because the whole image as numbers
    would need about 1 GB."""
    table = json.loads(COLOR_TABLE.read_text())
    width, height = image.size
    bounds = ast.literal_eval(image.info["Bounds"])

    # Only the drawn (non-transparent) pixels need a color lookup
    alpha = np.asarray(image.getchannel("A")).ravel()
    drawn = np.flatnonzero(alpha)
    del alpha
    # Each pixel's color as one number, e.g. #47186a -> 0x47186a
    packed = np.zeros(drawn.size, dtype=np.int64)
    for shift, band in ((16, "R"), (8, "G"), (0, "B")):
        packed |= np.asarray(image.getchannel(band)).ravel()[drawn].astype(np.int64) << shift

    # Look every color up in the table (sorted search, like bisect in Python).
    # A color that isn't in the table is left as 0.
    colors = np.array(sorted(int(c[1:], 16) for c in table))
    color_levels = np.array([table[f"#{c:06x}"] for c in colors], dtype=np.uint8)
    position = np.searchsorted(colors, packed).clip(0, len(colors) - 1)
    exact = colors[position] == packed

    levels = np.zeros(width * height, dtype=np.uint8)
    levels[drawn] = np.where(exact, color_levels[position], 0)

    grid = {"width": width, "height": height, "bounds": bounds,
            "x0": mercator_x(bounds["left"]), "x1": mercator_x(bounds["right"]),
            "y0": mercator_y(bounds["top"]), "y1": mercator_y(bounds["bottom"]),
            "unknownColors": int((~exact).sum())}
    return levels.reshape(height, width), grid


def mercator_x(lng):
    return EARTH_RADIUS_M * math.radians(lng)


def mercator_y(lat):
    return EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def to_lat_lng(x, y):
    """Web Mercator meters -> (lat, lng) in degrees."""
    lng = math.degrees(x / EARTH_RADIUS_M)
    lat = math.degrees(2 * math.atan(math.exp(y / EARTH_RADIUS_M)) - math.pi / 2)
    return lat, lng


# ---------- lake outlines ----------

def load_outlines():
    """Every CyAN lake with its outline: [{id, name, state, lat, lng, km2, rings}].
    Each ring is a flat list x1, y1, x2, y2, ... in Web Mercator meters."""
    lakes = []
    for page in range(OUTLINE_PAGES):
        data = json.loads(get_bytes(OUTLINE_URL.format(offset=page * 2000)))
        for feature in data["features"]:
            a = feature["attributes"]
            lakes.append({
                "id": int(a["OBJECTID"]),
                "name": a["GNIS_NAME"] or "Unnamed lake",
                "state": a["STATE_ABBR"],
                "lat": a["c_lat"],
                "lng": a["c_lng"],
                "km2": a["AREASQKM"] or 0,
                "rings": [[round(v) for xy in ring for v in xy] for ring in feature["geometry"]["rings"]],
            })
    print(f"Lake outlines: {len(lakes)} lakes")
    return lakes


def ring_is_outer(flat):
    """Outer boundaries go clockwise (negative area with y pointing up); island holes go the other way."""
    xs, ys = flat[0::2], flat[1::2]
    area = sum(xs[i] * ys[i + 1] - xs[i + 1] * ys[i] for i in range(len(xs) - 1))
    return area < 0


def prepare_masks(lakes, grid):
    """For each lake: (top, bottom, left, right, mask), the pixel box around it
    on the image grid and which pixels in that box are inside its outline
    (islands left out); None if it's off the grid. Every EPA image uses the
    same grid, so this is done once.

    A pixel counts only if its CENTER is inside the outline: the outline is
    drawn 4x bigger and sampled at each pixel's middle. (Drawing it at normal
    size would take every pixel the shoreline touches: 1,074 pixels for
    Jordan Lake instead of about 800.)"""
    pixel_w = (grid["x1"] - grid["x0"]) / grid["width"]
    pixel_h = (grid["y0"] - grid["y1"]) / grid["height"]
    k = SUPERSAMPLE
    masks = []
    for lake in lakes:
        rings = []
        for flat in lake["rings"]:
            px = [(flat[i] - grid["x0"]) / pixel_w for i in range(0, len(flat), 2)]
            py = [(grid["y0"] - flat[i]) / pixel_h for i in range(1, len(flat), 2)]
            rings.append((ring_is_outer(flat), px, py))
        left = max(0, math.floor(min(min(r[1]) for r in rings)))
        right = min(grid["width"], math.ceil(max(max(r[1]) for r in rings)) + 1)
        top = max(0, math.floor(min(min(r[2]) for r in rings)))
        bottom = min(grid["height"], math.ceil(max(max(r[2]) for r in rings)) + 1)
        if right <= left or bottom <= top:
            masks.append(None)
            continue

        canvas = Image.new("1", ((right - left) * k, (bottom - top) * k), 0)
        draw = ImageDraw.Draw(canvas)
        for want_outer in (True, False):       # every outer ring first, then the holes
            for is_outer, px, py in rings:
                if is_outer == want_outer and len(px) >= 3:
                    draw.polygon([((x - left) * k, (y - top) * k) for x, y in zip(px, py)],
                                 fill=1 if is_outer else 0)
        fine = np.asarray(canvas, dtype=bool)
        masks.append((top, bottom, left, right, fine[k // 2::k, k // 2::k]))
    return masks
