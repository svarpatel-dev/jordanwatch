"""
Radar-smooth satellite tiles for the close-up zooms (10-12), used by
make_tiles.py. Decided Oct 19 (design decision 1), from the Oct 17 prototype.

Below zoom 10, one map tile pixel is already about as big as one satellite
pixel (340 m), so make_tiles.py cuts those tiles as before. Closer in, the
browser used to stretch the 340 m squares into a blur that spilled onto
land. These tiles fix that without inventing data:

1. Levels, not colors, are blended. Each tile pixel's satellite level is a
   smooth curve (Catmull-Rom) through the nearby satellite pixels, then
   clamped like Python's min(max(value, lowest), highest) to the lowest and
   highest of the 4 closest REAL readings. So it can never show more (or
   less) than a real reading next to it. Pixels with no reading (clean,
   cloud, land, no pass) are never counted as level 0; they only lend their
   neighbors' value to keep the curve smooth, and the clamp keeps that from
   mattering.
2. Color only where the satellite measured: a tile pixel gets color only if
   its nearest satellite pixel had a reading. The square corners of that
   area are rounded INWARD (never outward) and the edge fades out over
   about 70 m. Every reading keeps at least a dot at its middle, so a
   single hot-spot pixel shrinks but never disappears.
3. The same 6 color bands as the rest of the map (so the legend doesn't
   change), each in 15 see-through steps for the soft edge: 91 colors.
4. Clipped to the lake's real shoreline (USGS NHD, fetch_shorelines.py),
   drawn 4x finer than the tile: no color on land. Lakes without an NHD
   shoreline use EPA's own outline.

The tiles are drawn by several processes at once (one per CPU core). Each
process reads the satellite levels from a file on disk instead of getting
its own copy (np.load with mmap_mode, like opening a file instead of
reading it all into memory).
"""

import math
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

MIN_ZOOM, MAX_ZOOM = 10, 12
TILE = 256
WORLD_M = 2 * math.pi * 6378137   # the width of the whole Web Mercator map, in meters
ALPHA_STEPS = 15                  # see-through steps per color band
SUPERSAMPLE = 4                   # shoreline drawing detail
CORNER_ROUND = 0.45               # corners rounded inward by 0.45 satellite pixel
EDGE_FADE = 0.25                  # the edge fades out over 0.25 satellite pixel (about 70-85 m)
CURVE_MARGIN = 3                  # satellite pixels around a tile needed for the curve
FILL_STEPS = 3                    # how far empty pixels borrow neighbors' values (curve support only)
CHANGE_MARGIN = 6                 # a changed satellite pixel can change tiles up to this many pixels away
EDGE_CHUNK = 4000                 # shoreline edges handled at a time (keeps memory small)


def smoothstep(t):
    """0 below 0, 1 above 1, a smooth S-curve between."""
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def catmull_rom(t):
    """Curve weights for the neighbors at offsets -1, 0, 1, 2 (they add up to 1)."""
    return [(-t ** 3 + 2 * t ** 2 - t) / 2, (3 * t ** 3 - 5 * t ** 2 + 2) / 2,
            (-3 * t ** 3 + 4 * t ** 2 + t) / 2, (t ** 3 - t ** 2) / 2]


def distance_to(mask, limit):
    """For every pixel, the straight-line distance (in pixels) to the nearest
    True pixel of mask, checked out to `limit` pixels; farther = infinity.
    Tries every offset inside a circle, like a loop over a small stencil."""
    reach = int(math.ceil(limit))
    padded = np.pad(mask, reach, constant_values=False)
    height, width = mask.shape
    nearest = np.full(mask.shape, np.inf, dtype=np.float32)
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            step = math.hypot(dx, dy)
            if step > limit:
                continue
            shifted = padded[reach + dy:reach + dy + height, reach + dx:reach + dx + width]
            np.minimum(nearest, np.where(shifted, np.float32(step), np.float32(np.inf)), out=nearest)
    return nearest


def palette_and_transparency(severity):
    """The 91-color palette: color 0 = transparent, then each band in 15 steps."""
    colors, see_through = [0, 0, 0], [0]
    for _, rgb in severity:
        for step in range(1, ALPHA_STEPS + 1):
            colors += list(rgb)
            see_through.append(round(step * 255 / ALPHA_STEPS))
    return colors, bytes(see_through)


# ---------- shorelines ----------

def shoreline_edges(lakes, nhd):
    """Every lake's shoreline as straight edges (x1, y1, x2, y2 in Web Mercator
    meters) plus each lake's box. Uses the NHD shoreline where there is one,
    EPA's outline otherwise. Returns (edges, starts, boxes, how many from NHD)."""
    pieces, starts, boxes, from_nhd = [], [0], [], 0
    for lake in lakes:
        rings = nhd.get(lake["id"])
        if rings:
            from_nhd += 1
        else:
            rings = lake["rings"]
        lake_edges = []
        for flat in rings:
            points = np.asarray(flat, dtype=np.float64).reshape(-1, 2)
            if len(points) < 3:
                continue
            lake_edges.append(np.hstack([points, np.roll(points, -1, axis=0)]))
        lake_edges = np.vstack(lake_edges) if lake_edges else np.zeros((0, 4))
        pieces.append(lake_edges)
        starts.append(starts[-1] + len(lake_edges))
        if len(lake_edges):
            boxes.append((lake_edges[:, 0].min(), lake_edges[:, 1].min(),
                          lake_edges[:, 0].max(), lake_edges[:, 1].max()))
        else:
            boxes.append((0, 0, -1, -1))   # an empty box that never matches
    return np.vstack(pieces), np.array(starts), np.array(boxes, dtype=np.float64), from_nhd


# ---------- one tile ----------

class Renderer:
    """Draws one tile at a time. Built once per process from files on disk."""

    def __init__(self, levels_file, grid, shores_file, severity, level_bands):
        self.levels = np.load(levels_file, mmap_mode="r")
        self.height, self.width = self.levels.shape
        self.x0, self.y0 = grid["x0"], grid["y0"]
        self.pixel_w = (grid["x1"] - grid["x0"]) / grid["width"]
        self.pixel_h = (grid["y0"] - grid["y1"]) / grid["height"]
        shores = np.load(shores_file)
        self.edges, self.starts, self.boxes = shores["edges"], shores["starts"], shores["boxes"]
        self.level_bands = level_bands
        self.palette, self.see_through = palette_and_transparency(severity)

    def water(self, left, top, res):
        """Share (0-1) of each tile pixel inside a lake (islands left out).
        Even-odd fill: walking along a row, every shoreline crossed flips
        "inside" on or off. Done 4x finer, then averaged."""
        span = res * TILE
        near = np.flatnonzero((self.boxes[:, 0] < left + span) & (self.boxes[:, 2] > left) &
                              (self.boxes[:, 1] < top) & (self.boxes[:, 3] > top - span))
        if near.size == 0:
            return None
        edges = np.vstack([self.edges[self.starts[i]:self.starts[i + 1]] for i in near])
        fine_res = res / SUPERSAMPLE
        size = TILE * SUPERSAMPLE
        row_y = top - (np.arange(size) + 0.5) * fine_res          # each fine row's middle, top to bottom
        ya, yb = edges[:, 1], edges[:, 3]
        # Only edges whose height overlaps the tile and that start left of its right side
        keep = ((np.minimum(ya, yb) < top) & (np.maximum(ya, yb) > top - span) &
                (np.minimum(edges[:, 0], edges[:, 2]) < left + span))
        edges = edges[keep]
        if edges.shape[0] == 0:
            return None
        flips = np.zeros((size, size + 1), dtype=np.int32)
        for start in range(0, edges.shape[0], EDGE_CHUNK):
            xa, ya, xb, yb = edges[start:start + EDGE_CHUNK].T
            Y = row_y[:, None]
            crosses = ((ya <= Y) & (Y < yb)) | ((yb <= Y) & (Y < ya))
            rows, which = np.nonzero(crosses)
            if rows.size == 0:
                continue
            t = (row_y[rows] - ya[which]) / (yb[which] - ya[which])
            x = xa[which] + t * (xb[which] - xa[which])
            column = np.clip(np.ceil((x - left) / fine_res - 0.5), 0, size).astype(np.int64)
            np.add.at(flips, (rows, column), 1)
        inside = (np.cumsum(flips[:, :size], axis=1) & 1).astype(np.float32)
        return inside.reshape(TILE, SUPERSAMPLE, TILE, SUPERSAMPLE).mean(axis=(1, 3))

    def render(self, z, x, y):
        """-> (palette image as an array, checks) or None if the tile is empty."""
        tile_m = WORLD_M / 2 ** z
        res = tile_m / TILE                          # meters per tile pixel
        per_pixel = self.pixel_w / res               # one satellite pixel, in tile pixels
        margin = int(math.ceil(0.5 * per_pixel)) + 3  # extra tile pixels so neighboring tiles join seamlessly
        left = -WORLD_M / 2 + x * tile_m
        top = WORLD_M / 2 - y * tile_m

        index = np.arange(-margin, TILE + margin)
        gx = (left + (index + 0.5) * res - self.x0) / self.pixel_w - 0.5   # whole number = a satellite pixel's middle
        gy = (self.y0 - (top - (index + 0.5) * res)) / self.pixel_h - 0.5
        ix, iy = np.floor(gx).astype(np.int64), np.floor(gy).astype(np.int64)
        fx, fy = gx - ix, gy - iy

        # The satellite pixels this tile needs (zeros outside EPA's image)
        c0, c1 = ix.min() - CURVE_MARGIN, ix.max() + CURVE_MARGIN + 2
        r0, r1 = iy.min() - CURVE_MARGIN, iy.max() + CURVE_MARGIN + 2
        if c1 <= 0 or r1 <= 0 or c0 >= self.width or r0 >= self.height:
            return None
        sub = np.zeros((r1 - r0, c1 - c0), dtype=np.float32)
        a0, a1, b0, b1 = max(r0, 0), min(r1, self.height), max(c0, 0), min(c1, self.width)
        sub[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = self.levels[a0:a1, b0:b1]
        if not sub.any():
            return None
        valid = sub > 0
        rx, ry = ix - c0, iy - r0
        n = index.size

        # The honest range: lowest and highest real reading among the 4 closest pixels
        highest = np.zeros((n, n), dtype=np.float32)
        lowest = np.full((n, n), np.inf, dtype=np.float32)
        for oy in (0, 1):
            for ox in (0, 1):
                v = sub[(ry + oy)[:, None], (rx + ox)[None, :]]
                np.maximum(highest, v, out=highest)
                np.minimum(lowest, np.where(v > 0, v, np.inf), out=lowest)
        has_reading = highest > 0

        # Curve support only: empty pixels next to readings borrow their neighbors' average
        filled, known = sub.copy(), valid.copy()
        for _ in range(FILL_STEPS):
            total, count = np.zeros_like(filled), np.zeros_like(filled)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    total += np.roll(np.roll(filled * known, dy, 0), dx, 1)
                    count += np.roll(np.roll(known.astype(np.float32), dy, 0), dx, 1)
            grow = ~known & (count > 0)
            filled[grow] = total[grow] / count[grow]
            known |= grow

        value = np.zeros((n, n), dtype=np.float32)
        for j, wy in zip(range(-1, 3), catmull_rom(fy)):
            for i, wx in zip(range(-1, 3), catmull_rom(fx)):
                value += wy[:, None] * wx[None, :] * filled[(ry + j)[:, None], (rx + i)[None, :]]
        value = np.clip(value, np.where(has_reading, lowest, 0), highest)

        # Where the satellite measured: the nearest satellite pixel had a reading
        near_col, near_row = np.rint(gx).astype(np.int64) - c0, np.rint(gy).astype(np.int64) - r0
        measured = valid[near_row[:, None], near_col[None, :]]

        # Round its corners inward: keep the points at least CORNER_ROUND deep
        # inside (plus every reading's middle), then grow them back by the same
        # amount with a soft edge. Never larger than what was measured.
        radius = CORNER_ROUND * per_pixel
        fade = max(EDGE_FADE * per_pixel, 1.0)
        depth = distance_to(~measured, radius + 1)
        core = depth > radius
        half_step = 0.5 / per_pixel + 1e-9           # half a tile pixel, in satellite pixels
        middle_col = np.abs(gx - np.rint(gx)) <= half_step
        middle_row = np.abs(gy - np.rint(gy)) <= half_step
        core |= measured & middle_row[:, None] & middle_col[None, :]
        if not core.any():
            return None
        edge = smoothstep((radius - distance_to(core, radius + 0.5) + 0.5) / fade)
        edge = np.where(measured, edge, 0.0)

        inner = (slice(margin, margin + TILE), slice(margin, margin + TILE))
        value, highest, edge, measured = value[inner], highest[inner], edge[inner], measured[inner]
        if not edge.any():
            return None
        water = self.water(left, top, res)
        if water is None:
            return None
        alpha = edge * water
        level = np.clip(np.rint(value), 0, 255).astype(np.uint8)
        band = np.where(alpha > 0, self.level_bands[level], 0)
        steps = np.rint(alpha * ALPHA_STEPS).astype(np.int16)
        colors = np.where((steps > 0) & (band > 0), (band.astype(np.int16) - 1) * ALPHA_STEPS + steps, 0)
        if not colors.any():
            return None
        shown = colors > 0
        checks = {
            "aboveNeighbors": int((shown & (value > highest + 1e-3)).sum()),
            "onLand": int((shown & (water == 0)).sum()),
            "outsideMeasured": int((shown & ~measured).sum()),
        }
        return colors.astype(np.uint8), checks

    def save(self, colors, path):
        image = Image.fromarray(colors, mode="P")
        image.putpalette(self.palette)
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, optimize=True, transparency=self.see_through)


# ---------- which tiles ----------

def tiles_touched(rows, cols, grid, zooms, margin=0):
    """{(z, x, y)} for every tile that the given satellite pixels (and
    `margin` pixels around each) fall in."""
    pixel_w = (grid["x1"] - grid["x0"]) / grid["width"]
    pixel_h = (grid["y0"] - grid["y1"]) / grid["height"]
    keys = set()
    for z in zooms:
        n = 2 ** z
        tile_m = WORLD_M / n
        for dx in (-margin, 1 + margin):        # the box's corners are enough: it's smaller than a tile
            tx = np.floor((grid["x0"] + (cols + dx) * pixel_w + WORLD_M / 2) / tile_m).astype(np.int64)
            for dy in (-margin, 1 + margin):
                ty = np.floor((WORLD_M / 2 - (grid["y0"] - (rows + dy) * pixel_h)) / tile_m).astype(np.int64)
                keys.update((z, k // n, k % n) for k in np.unique(tx * n + ty).tolist())
    return keys


def overlapping_lakes(keys, boxes):
    """Only the tiles that overlap at least one lake's box (the same shorelines
    the tiles are clipped to, so no tile that could get color is left out)."""
    keys = sorted(keys)
    if not keys:
        return set()
    z, x, y = (np.array(column, dtype=np.float64) for column in zip(*keys))
    tile_m = WORLD_M / 2 ** z
    west, north = -WORLD_M / 2 + x * tile_m, WORLD_M / 2 - y * tile_m
    east, south = west + tile_m, north - tile_m
    keep = np.zeros(len(keys), dtype=bool)
    for start in range(0, len(keys), 500):      # 500 tiles x every lake at a time
        part = slice(start, start + 500)
        keep[part] = ((boxes[None, :, 0] < east[part, None]) & (boxes[None, :, 2] > west[part, None]) &
                      (boxes[None, :, 1] < north[part, None]) & (boxes[None, :, 3] > south[part, None])).any(axis=1)
    return {key for key, ok in zip(keys, keep) if ok}


# ---------- many tiles at once ----------

_renderer = None   # one per worker process


def _start_worker(args):
    global _renderer
    _renderer = Renderer(*args)


def _draw(job):
    z, x, y, out_dir = job
    path = Path(out_dir) / str(z) / str(x) / f"{y}.png"
    drawn = _renderer.render(z, x, y)
    if drawn is None:
        if path.exists():
            path.unlink()          # it had color before, now it doesn't
        return z, False, None
    colors, checks = drawn
    _renderer.save(colors, path)
    return z, True, checks


def draw_tiles(keys, out_dir, renderer_args, processes=None):
    """Draws (or removes) every tile in keys. Returns a summary dict."""
    jobs = [(z, x, y, str(out_dir)) for z, x, y in sorted(keys)]
    summary = {"tried": len(jobs), "written": 0, "byZoom": {},
               "checks": {"aboveNeighbors": 0, "onLand": 0, "outsideMeasured": 0}}
    processes = processes or os.cpu_count() or 1
    # "spawn" starts each worker fresh, the same way on Linux and macOS. If a
    # worker can't start, this stops with an error instead of hanging.
    with ProcessPoolExecutor(processes, multiprocessing.get_context("spawn"),
                             initializer=_start_worker, initargs=(renderer_args,)) as pool:
        for z, written, checks in pool.map(_draw, jobs, chunksize=16):
            if written:
                summary["written"] += 1
                summary["byZoom"][z] = summary["byZoom"].get(z, 0) + 1
                for key in checks:
                    summary["checks"][key] += checks[key]
    return summary


def save_shore_file(path, lakes, nhd):
    """Saves the shorelines for the worker processes. Returns (how many from NHD, lake boxes)."""
    edges, starts, boxes, from_nhd = shoreline_edges(lakes, nhd)
    np.savez(path, edges=edges, starts=starts, boxes=boxes)
    return from_nhd, boxes
