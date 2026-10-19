"""
Make the nationwide satellite map layer for JordanWatch.

Downloads EPA CyAN's newest nationwide cyanobacteria images (cyan_images.py),
recolors them with JordanWatch's own severity scale, and cuts them into
256 x 256 map tiles (tiles/z/x/y.png) that the map loads as a layer. Runs in
GitHub Actions on every deploy (deploy.yml).

Newest data first (decided Oct 13, so the map agrees with the verdict pins):
every pixel shows its newest satellite reading. The DAILY images from the
last 7 days are stacked newest first; where a day was cloudy, an older day
fills in, and the newest WEEKLY image (the past 7 days combined) fills
whatever is still empty.

Each image is used once and dated by its own date (bug 14, fixed Oct 16):
EPA answers a missing day with an older image, which used to be stacked
several times and labeled with the day that was asked for.

Old blooms over clean water (bug 13, fixed Oct 16): EPA's image only draws
detected blooms; clean water is transparent, just like clouds. So an older
image's bloom could show through where a newer image saw clean water. The
per-lake check in fetch_lakes.py can tell clean water from clouds: inside a
lake whose newest check saw most of it and found no bloom at the Caution
level, every image OLDER than that check is left out. The colors are
"newest bloom detections": no color means clean, cloudy or not seen.

Recoloring (decided Oct 12-13): each satellite level is converted to
cells/mL with EPA's formula, then painted with our scale: Low Risk below
20,000, Caution 20,000-100,000, Avoid above 100,000 (WHO 1999/2003 levels).
Tiles are small 7-color PNGs.

Fails soft: if no EPA image can be downloaded, it exits without touching the
tiles, so the deploy reuses the last good tiles.

Run:  python3 scripts/make_tiles.py tiles      (needs Pillow and NumPy)
"""

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from cyan_images import CELLS, image_levels, load_outlines, prepare_masks, recent_images
from fetch_lakes import GOOD_LOOK_SHARE, READINGS_FILE, is_warning

LOOK_BACK_DAYS = 10    # EPA's newest weekly image can be a few days behind
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


def severity_band(cells):
    """1-6: which row of SEVERITY these cells/mL fall in (0 is kept for "no color")."""
    band = 1
    for number, (threshold, _) in enumerate(SEVERITY, start=1):
        if cells >= threshold:
            band = number
    return band


# The band for every satellite level 0-255 (level 0 = nothing drawn = band 0)
LEVEL_BANDS = np.array([0] + [severity_band(CELLS[level]) for level in range(1, 256)], dtype=np.uint8)


def lakes_seen_clean():
    """Lakes whose newest per-lake check (fetch_lakes.py) had a good look
    (half the lake or more) and found no bloom at the Caution level:
    {lake id: date of that check's satellite day}."""
    try:
        readings = json.loads(READINGS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    clean = {}
    for lake_id, entry in readings["lakes"].items():
        if "c" not in entry:
            continue
        check = dict(zip(readings["checkFields"], entry["c"]))
        if check["date"] is None:
            continue
        good_look = check["seen"] >= GOOD_LOOK_SHARE * check["lakePixels"]
        if good_look and not is_warning(check, check["seen"]):
            clean[int(lake_id)] = check["date"]
    return clean


def stack_newest_first(images):
    """One grid of satellite levels: each pixel from the newest image that
    drew it, minus old blooms over lakes seen clean since (bug 13).
    Returns (levels, grid, how many lakes were cleaned up)."""
    clean = lakes_seen_clean()
    clean_lakes = []
    if clean:
        try:
            clean_lakes = [lake for lake in load_outlines() if lake["id"] in clean]
        except Exception as error:
            print(f"Lake outlines FAILED ({error}); old blooms over clean lakes stay on the map")

    stacked, grid, masks = None, None, None
    cleaned = set()
    for im in images:
        levels, grid = image_levels(im["image"])
        im["image"].close()
        if masks is None:
            masks = prepare_masks(clean_lakes, grid)

        # Bug 13: this image is older than the clean check, so its blooms in that lake are out of date
        for lake, box in zip(clean_lakes, masks):
            if box and clean[lake["id"]] > im["date"].isoformat():
                top, bottom, left, right, mask = box
                inside = levels[top:bottom, left:right]
                if inside[mask].any():
                    inside[mask] = 0
                    cleaned.add(lake["id"])

        if stacked is None:
            stacked = levels
        else:
            empty = stacked == 0
            stacked[empty] = levels[empty]
            del empty
        del levels
    return stacked, grid, len(cleaned)


def to_tiles_image(levels):
    """Levels -> a 7-color image in our severity colors (color 0 = transparent)."""
    image = Image.fromarray(LEVEL_BANDS[levels])
    palette = [0, 0, 0] + [value for _, rgb in SEVERITY for value in rgb]
    image.putpalette(palette)
    return image


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
                tile.save(path, optimize=True, transparency=0)
                written += 1
    return written


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "tiles")

    today = datetime.now(timezone.utc).date()
    images = recent_images(today, DAILY_DAYS, LOOK_BACK_DAYS)
    if not images:
        # Fail soft: keep whatever tiles are already there
        print("No EPA image found; keeping the previous tiles")
        return

    levels, grid, cleaned = stack_newest_first(images)
    image = to_tiles_image(levels)
    del levels

    # Start fresh so old tiles from an earlier week never linger
    if out_dir.exists():
        for old in sorted(out_dir.rglob("*"), reverse=True):
            old.unlink() if old.is_file() else old.rmdir()
    out_dir.mkdir(parents=True, exist_ok=True)

    written = cut_tiles(image, grid["bounds"], out_dir)

    # The images' own dates (bug 14). A weekly image covers its first day + 6.
    dailies = [im["date"] for im in images if im["kind"] == "daily"]
    weekly = next((im["date"] for im in images if im["kind"] == "weekly"), None)
    newest = min(max(dailies + ([weekly + timedelta(days=6)] if weekly else [])), today)
    info = {"newestDate": newest.isoformat(),
            "dailyDates": [day.isoformat() for day in dailies],
            "weeklyDate": weekly.isoformat() if weekly else None,
            "cleanLakesMasked": cleaned,
            "source": "EPA CyAN",
            "madeAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    (out_dir / "info.json").write_text(json.dumps(info, indent=2) + "\n")
    print(f"{written} tiles written to {out_dir}/ (daily images {info['dailyDates']}, weekly {info['weeklyDate']}, "
          f"old blooms removed from {cleaned} lakes seen clean since)")


if __name__ == "__main__":
    main()
