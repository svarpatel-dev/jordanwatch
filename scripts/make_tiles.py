"""
Make the nationwide satellite map layer for JordanWatch.

Downloads EPA CyAN's newest nationwide cyanobacteria images (cyan_images.py),
recolors them with JordanWatch's own 6-color scale, and cuts them into
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
cells/mL with EPA's formula, then painted with our 6 bands of cells/mL. The
map is a measurement, not a verdict (decided Oct 21): the legend marks only
the WHO 1999/2003 levels (20,000 and 100,000) as ticks.

Only covered lakes get color, at every zoom (decided Oct 21): EPA's image
also colors water outside its ~7,000 US lakes (mostly in Canada). A pixel
keeps its color only if its middle is inside a CyAN lake's outline or its
NHD shoreline (the same shapes the zoom 10-12 tiles are clipped to).

Two kinds of tiles (radar-smooth decided Oct 19, design decision 1):
- Zoom 4-9: cut straight from the image, small 7-color PNGs. Here one tile
  pixel is already about one satellite pixel, so smoothing would change
  nothing you could see.
- Zoom 10-12: radar-smooth tiles from radar_tiles.py: the levels blended
  between real readings only, never above the highest one next to them,
  and clipped to the lakes' real shorelines (fetch_shorelines.py), so no
  color touches land.

Only what changed is redrawn: the satellite levels used last time are saved
in a state folder (kept in the Actions cache with the tiles), and the
zoom 10-12 tiles are redrawn only around pixels that changed. A code push
with no new satellite data redraws nothing.

Fails soft: if no EPA image can be downloaded, it exits without touching the
tiles, so the deploy reuses the last good tiles. If it stops halfway, the
tiles folder has no info.json, so the deploy doesn't save it and the map
skips the layer for that one deploy.

Run:  python3 scripts/make_tiles.py tiles [state]   (needs Pillow and NumPy;
      without a state folder, every tile is redrawn)
"""

import hashlib
import json
import math
import shutil
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

import radar_tiles
from cyan_images import CELLS, image_levels, load_outlines, prepare_masks, recent_images
from fetch_lakes import GOOD_LOOK_SHARE, READINGS_FILE, is_warning
from fetch_shorelines import OUT_FILE as SHORELINES_FILE, load_shorelines

LOOK_BACK_DAYS = 10    # EPA's newest weekly image can be a few days behind
DAILY_DAYS = 7         # how many days of daily images to stack
MIN_ZOOM, MAX_ZOOM = 4, 9     # tiles cut straight from the image; 10-12 are radar_tiles.py's
TILE = 256
# Change this when radar_tiles.py draws differently, so every tile is redrawn once
RADAR_VERSION = 1
STATE_FILE = "levels.npz"

# The map's 6 bands: (cells/mL at or above, color). Colorblind-safe
# (light yellow -> orange -> red -> dark purple, brighter = lower). A
# measurement scale; the WHO levels are the 20,000 and 100,000 edges.
SEVERITY = [
    (0,       (255, 241, 168)),   # below 20,000
    (20000,   (254, 196, 79)),    # 20,000-50,000
    (50000,   (253, 141, 60)),    # 50,000-100,000
    (100000,  (240, 59, 32)),     # 100,000-500,000
    (500000,  (189, 0, 38)),      # 500,000-1 million
    (1000000, (84, 39, 143)),     # over 1 million
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


def stack_newest_first(images, lakes):
    """One grid of satellite levels: each pixel from the newest image that
    drew it, minus old blooms over lakes seen clean since (bug 13).
    lakes = EPA's outlines ([] if they couldn't be loaded).
    Returns (levels, grid, how many lakes were cleaned up)."""
    clean = lakes_seen_clean()
    clean_lakes = [lake for lake in lakes if lake["id"] in clean]
    if clean and not lakes:
        print("No lake outlines; old blooms over clean lakes stay on the map")

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


def covered_lake_pixels(lakes, shorelines, grid, shape):
    """True for every satellite pixel whose middle is inside a covered lake:
    its EPA outline, or its NHD shoreline where there is one."""
    shapes = lakes + [{"rings": rings} for rings in shorelines.values()]
    keep = np.zeros(shape, dtype=bool)
    for box in prepare_masks(shapes, grid):
        if box:
            top, bottom, left, right, mask = box
            keep[top:bottom, left:right] |= mask
    return keep


def to_tiles_image(levels, keep):
    """Levels -> a 7-color image in our colors (color 0 = transparent),
    colored only inside covered lakes (keep)."""
    bands = LEVEL_BANDS[levels]
    bands[~keep] = 0
    image = Image.fromarray(bands)
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


def what_changed(levels, grid, state_dir, drawing):
    """The satellite pixels that differ from last time, as flat positions in
    the grid, or None if everything must be redrawn (no saved state, a
    different grid, or new shorelines / drawing rules)."""
    if state_dir is None:
        return None
    try:
        old = np.load(state_dir / STATE_FILE)
        same = (old["shape"].tolist() == list(levels.shape) and
                str(old["bounds"]) == json.dumps(grid["bounds"], sort_keys=True) and
                str(old["drawing"]) == drawing)
    except (FileNotFoundError, KeyError, ValueError, OSError):
        return None
    if not same:
        return None
    before = np.zeros(levels.size, dtype=np.uint8)
    before[old["where"]] = old["levels"]
    return np.flatnonzero(before != levels.ravel())


def save_state(levels, grid, state_dir, drawing):
    """Saves only the drawn pixels (about 1% of the grid): where and which level."""
    state_dir.mkdir(parents=True, exist_ok=True)
    where = np.flatnonzero(levels).astype(np.uint32)
    np.savez_compressed(state_dir / STATE_FILE, where=where, levels=levels.ravel()[where],
                        shape=np.array(levels.shape), bounds=json.dumps(grid["bounds"], sort_keys=True),
                        drawing=drawing)


def remove_zooms(out_dir, zooms):
    for z in zooms:
        shutil.rmtree(out_dir / str(z), ignore_errors=True)


def remove_empty_folders(out_dir, zooms):
    """Folders left empty after tiles were removed."""
    for z in zooms:
        for folder in (out_dir / str(z)).glob("*"):
            if folder.is_dir() and not any(folder.iterdir()):
                folder.rmdir()


def main():
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "tiles")
    state_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    started = time.time()

    today = datetime.now(timezone.utc).date()
    images = recent_images(today, DAILY_DAYS, LOOK_BACK_DAYS)
    if not images:
        # Fail soft: keep whatever tiles are already there
        print("No EPA image found; keeping the previous tiles")
        return

    try:
        lakes = load_outlines()
    except Exception as error:
        print(f"Lake outlines FAILED ({error}); keeping the previous tiles")
        return
    shorelines = load_shorelines()
    if not shorelines:
        print("No shorelines file; colors are clipped to EPA's blocky outlines")
    shore_hash = hashlib.sha1(SHORELINES_FILE.read_bytes()).hexdigest()[:12] if shorelines else "none"
    drawing = f"radar {RADAR_VERSION}, shorelines {shore_hash}"

    levels, grid, cleaned = stack_newest_first(images, lakes)
    changed = what_changed(levels, grid, state_dir, drawing)
    if changed is not None and changed.size == 0:
        print("Satellite levels unchanged since the last run; keeping the tiles")
        return

    # Until the end, the folder has no info.json (see "Fails soft" above)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "info.json").unlink(missing_ok=True)

    # Zoom 4-9: cut again from scratch (about 20 seconds), covered lakes only
    keep = covered_lake_pixels(lakes, shorelines, grid, levels.shape)
    outside = int(np.count_nonzero(levels[~keep]))
    remove_zooms(out_dir, range(MIN_ZOOM, MAX_ZOOM + 1))
    written = cut_tiles(to_tiles_image(levels, keep), grid["bounds"], out_dir)
    del keep

    # Zoom 10-12: radar-smooth, only around what changed
    smooth_zooms = range(radar_tiles.MIN_ZOOM, radar_tiles.MAX_ZOOM + 1)
    with tempfile.TemporaryDirectory() as scratch:
        levels_file, shores_file = Path(scratch) / "levels.npy", Path(scratch) / "shores.npz"
        np.save(levels_file, levels)
        from_nhd, boxes = radar_tiles.save_shore_file(shores_file, lakes, shorelines)
        if changed is None:
            remove_zooms(out_dir, smooth_zooms)
            rows, cols = np.nonzero(levels)
            keys = radar_tiles.tiles_touched(rows, cols, grid, smooth_zooms)
        else:
            rows, cols = np.divmod(changed, levels.shape[1])
            keys = radar_tiles.tiles_touched(rows, cols, grid, smooth_zooms, radar_tiles.CHANGE_MARGIN)
        # Only tiles that overlap a lake can get color (EPA's image also colors
        # lakes outside the US, mostly in Canada; those get no color at any zoom)
        keys = radar_tiles.overlapping_lakes(keys, boxes)
        if changed is None:
            print(f"Drawing every radar-smooth tile ({len(keys)} to try)")
        else:
            print(f"{changed.size} satellite pixels changed; redrawing {len(keys)} radar-smooth tiles")
        del rows, cols, changed
        smooth = radar_tiles.draw_tiles(keys, out_dir, (levels_file, grid, shores_file, SEVERITY, LEVEL_BANDS))
    remove_empty_folders(out_dir, smooth_zooms)
    smooth["lakesWithNhdShoreline"] = from_nhd
    smooth["lakesWithEpaOutline"] = len(lakes) - from_nhd
    if state_dir is not None:
        save_state(levels, grid, state_dir, drawing)
    del levels

    # The images' own dates (bug 14). A weekly image covers its first day + 6.
    dailies = [im["date"] for im in images if im["kind"] == "daily"]
    weekly = next((im["date"] for im in images if im["kind"] == "weekly"), None)
    newest = min(max(dailies + ([weekly + timedelta(days=6)] if weekly else [])), today)
    info = {"newestDate": newest.isoformat(),
            "dailyDates": [day.isoformat() for day in dailies],
            "weeklyDate": weekly.isoformat() if weekly else None,
            "cleanLakesMasked": cleaned,
            "pixelsOutsideCoveredLakes": outside,
            "radarSmooth": smooth,
            "source": "EPA CyAN" + ("; shorelines USGS NHD" if shorelines else ""),
            "madeAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    (out_dir / "info.json").write_text(json.dumps(info, indent=2) + "\n")
    print(f"{written} tiles (zoom {MIN_ZOOM}-{MAX_ZOOM}) written to {out_dir}/ (daily images {info['dailyDates']}, "
          f"weekly {info['weeklyDate']}, old blooms removed from {cleaned} lakes seen clean since, "
          f"{outside} colored pixels outside covered lakes left out)")
    print(f"Radar-smooth zoom 10-12: {smooth['written']} tiles drawn of {smooth['tried']} tried {smooth['byZoom']}, "
          f"checks {smooth['checks']}, {time.time() - started:.0f} s in all")


if __name__ == "__main__":
    main()
