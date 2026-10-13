"""
Make the nationwide satellite map layer for JordanWatch.

Downloads EPA CyAN's newest nationwide cyanobacteria images, recolors them
with JordanWatch's own severity scale, and cuts them into 256 x 256 map
tiles (tiles/z/x/y.png) that the map loads as a layer. Runs in GitHub
Actions on every deploy (deploy.yml).

Newest data first (decided Oct 13, so the map agrees with the verdict pins):
every pixel shows its newest satellite reading. The DAILY images from the
last 7 days are stacked newest first; where a day was cloudy, an older day
fills in, and the newest WEEKLY image (the past 7 days combined) fills
whatever is still empty.

Recoloring (decided Oct 12-13): EPA draws each satellite level 1-253 in its
own color scale. epa_cyan_colors.json maps every EPA color back to its level
(rebuilt Oct 13 by ordering EPA's 248 colors and checking them against our
lake points' real readings). Each level is converted to cells/mL with EPA's
formula, then painted with our scale: Low Risk below 20,000, Caution
20,000-100,000, Avoid above 100,000 (WHO 1999/2003 levels).

Fails soft: if no EPA image can be downloaded, it exits without touching the
tiles, so the deploy reuses the last good tiles.

Run:  python3 scripts/make_tiles.py tiles      (needs Pillow and NumPy)
"""

import ast
import io
import json
import math
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None   # EPA's image is 263 million pixels, on purpose

IMAGE_URL = "https://cyan.epa.gov/waterbody/conus_image/?year={year}&day={day}&daily={daily}"
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}
COLOR_TABLE = Path(__file__).resolve().parent / "epa_cyan_colors.json"

LOOK_BACK_DAYS = 10    # EPA's newest image can be a few days behind
DAILY_DAYS = 7         # how many days of daily images to stack
MIN_ZOOM, MAX_ZOOM = 4, 9
TILE = 256

# Our severity scale: (cells/mL at or above, color). Colorblind-safe
# (light yellow -> orange -> red -> dark purple, brighter = lower).
# Final colors come in the Week 4 design pass.
SEVERITY = [
    (0,       (255, 241, 168)),   # Low Risk: below 20,000
    (20000,   (254, 196, 79)),    # Caution
    (50000,   (253, 141, 60)),    # Caution, higher
    (100000,  (240, 59, 32)),     # Avoid: above 100,000
    (500000,  (189, 0, 38)),      # Avoid, very high
    (1000000, (84, 39, 143)),     # Avoid, extreme (over 1 million)
]


def level_to_cells(level):
    """EPA's formula: satellite level 1-253 -> cyanobacteria cells/mL."""
    return 10 ** (0.012 * level - 4.2) * 1e8


def severity_color(cells):
    color = SEVERITY[0][1]
    for threshold, rgb in SEVERITY:
        if cells >= threshold:
            color = rgb
    return color


def download_image(day, daily):
    """EPA's daily or weekly image for one day, or None if there isn't one."""
    kind = "daily" if daily else "weekly"
    url = IMAGE_URL.format(year=day.year, day=day.timetuple().tm_yday, daily=daily)
    try:
        request = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(request, timeout=300) as response:
            data = response.read()
    except Exception as error:
        print(f"{day} {kind}: download failed ({error})")
        return None
    # A missing day comes back as a short JSON message, not a PNG
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        print(f"{day} {kind}: no image")
        return None
    print(f"{day} {kind}: got it ({len(data) // 1_000_000} MB)")
    return Image.open(io.BytesIO(data))


def download_dailies():
    """Daily images from the last 7 days, newest first: [(day, image), ...]."""
    today = datetime.now(timezone.utc).date()
    found = []
    for back in range(DAILY_DAYS):
        day = today - timedelta(days=back)
        image = download_image(day, daily=True)
        if image is not None:
            found.append((day, image))
    return found


def download_newest_weekly():
    """The newest weekly image from the last 10 days: (day, image) or (None, None)."""
    today = datetime.now(timezone.utc).date()
    for back in range(LOOK_BACK_DAYS + 1):
        day = today - timedelta(days=back)
        image = download_image(day, daily=False)
        if image is not None:
            return day, image
    return None, None


def newest_first(images):
    """Stack images (newest first) into one: each pixel comes from the first
    image that saw it. Transparent = no data there (clouds, land, no pass)."""
    pixels = np.asarray(images[0].convert("RGBA")).copy()
    for older in images[1:]:
        older_pixels = np.asarray(older.convert("RGBA"))
        empty = pixels[..., 3] == 0
        pixels[empty] = older_pixels[empty]
    return pixels


def recolor(pixels):
    """EPA colors -> our severity colors (transparent stays transparent)."""
    table = json.loads(COLOR_TABLE.read_text())
    epa_colors = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in table])
    our_colors = np.array([severity_color(level_to_cells(level)) for level in table.values()])

    seen = pixels[..., 3] > 0
    rgb = pixels[seen][:, :3].astype(int)

    # Every distinct color in the image, matched to the closest EPA table color
    # (exact match almost always; closest one if EPA ever adds a new shade)
    unique, which = np.unique(rgb, axis=0, return_inverse=True)
    distance = ((unique[:, None, :] - epa_colors[None, :, :]) ** 2).sum(axis=2)
    closest = distance.argmin(axis=1)

    pixels[seen, :3] = our_colors[closest][which.ravel()]
    return Image.fromarray(pixels)


def mercator_y(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def tile_bounds(z, x, y):
    """West, south, east, north (degrees) of map tile z/x/y."""
    n = 2 ** z
    west = x / n * 360 - 180
    east = (x + 1) / n * 360 - 180
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return west, south, east, north


def tile_range(z, west, south, east, north):
    n = 2 ** z
    xs = range(int((west + 180) / 360 * n), int((east + 180) / 360 * n) + 1)
    ys = range(int((1 - mercator_y(north) / math.pi) / 2 * n), int((1 - mercator_y(south) / math.pi) / 2 * n) + 1)
    return xs, ys


def cut_tiles(image, bounds, out_dir):
    width, height = image.size
    W, S, E, N = bounds["left"], bounds["bottom"], bounds["right"], bounds["top"]
    top_y, bottom_y = mercator_y(N), mercator_y(S)

    def to_pixel(lng, lat):
        return ((lng - W) / (E - W) * width,
                (top_y - mercator_y(lat)) / (top_y - bottom_y) * height)

    written = 0
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        xs, ys = tile_range(z, W, S, E, N)
        for x in xs:
            for y in ys:
                west, south, east, north = tile_bounds(z, x, y)
                left, top = to_pixel(west, north)
                right, bottom = to_pixel(east, south)
                tile = image.crop((round(left), round(top), round(right), round(bottom)))
                tile = tile.resize((TILE, TILE), Image.Resampling.NEAREST)
                if tile.getbbox() is None:   # no lake data in this square
                    continue
                path = out_dir / str(z) / str(x) / f"{y}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                tile.save(path, optimize=True)
                written += 1
    return written


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "tiles")

    dailies = download_dailies()
    weekly_day, weekly = download_newest_weekly()
    images = [image for _, image in dailies] + ([weekly] if weekly is not None else [])
    if not images:
        # Fail soft: keep whatever tiles are already there
        print("No EPA image found; keeping the previous tiles")
        return

    # All of EPA's images cover the same area with the same pixel grid
    bounds = ast.literal_eval(images[0].info["Bounds"])
    recolored = recolor(newest_first(images))

    # Start fresh so old tiles from an earlier week never linger
    if out_dir.exists():
        for old in sorted(out_dir.rglob("*"), reverse=True):
            old.unlink() if old.is_file() else old.rmdir()
    out_dir.mkdir(parents=True, exist_ok=True)

    written = cut_tiles(recolored, bounds, out_dir)
    info = {"newestDate": dailies[0][0].isoformat() if dailies else None,
            "dailyDates": [day.isoformat() for day, _ in dailies],
            "weeklyDate": weekly_day.isoformat() if weekly_day else None,
            "source": "EPA CyAN",
            "madeAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    (out_dir / "info.json").write_text(json.dumps(info, indent=2) + "\n")
    print(f"{written} tiles written to {out_dir}/ ({len(dailies)} daily images, weekly {weekly_day})")


if __name__ == "__main__":
    main()
