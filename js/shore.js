// Where the user is compared with a lake's water (decided Oct 13: the wind
// rule for a spot on any lake): how far the water is, and which way. The
// same steps as onshore_wind_from in scripts/fetch_lake_extras.py, which
// does this for every beach. Only drawing-free math, so it can be tested.
//
// The lake's outline is EPA's: made of its 300 m satellite pixels, so it
// misses narrow coves and its edge can be a few hundred meters off the real
// shore. Good enough for "which way is the water", not for anything finer.

// The water within this distance decides which way it is, tested every 150 m
const WATER_RADIUS_M = 3000;
const WATER_STEP_M = 150;

// At the shore: within 700 m of the outline on land (the same distance a
// beach can be from it), or within 300 m inside it (the pixel edge can
// reach past the real shore). Farther out on the water isn't a shore spot.
const SHORE_MAX_M = 700;
const ON_WATER_MAX_M = 300;

const METERS_PER_DEGREE = 111320;

// point = { lat, lng }; rings = the outline as lists of [lng, lat] points
// (islands too). Returns { status: "ok", metersFromWater, onshoreWindFrom }
// at the shore, or { status: "far" } / { status: "on-water" }.
export function shoreSpot(point, rings) {
  // Work in meters east (x) and north (y) of the point, so the point is (0, 0)
  const metersEast = METERS_PER_DEGREE * Math.cos(point.lat * Math.PI / 180);
  const edges = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      edges.push([
        (ring[i][0] - point.lng) * metersEast, (ring[i][1] - point.lat) * METERS_PER_DEGREE,
        (ring[i + 1][0] - point.lng) * metersEast, (ring[i + 1][1] - point.lat) * METERS_PER_DEGREE
      ]);
    }
  }

  const distance = nearestEdgeDistance(edges);
  const onWater = isInside(edges, 0, 0);
  if (onWater && distance > ON_WATER_MAX_M) return { status: "on-water" };
  if (!onWater && distance > SHORE_MAX_M) return { status: "far" };

  const onshoreWindFrom = waterDirection(edges);
  if (onshoreWindFrom === null) return { status: "far" };
  return { status: "ok", metersFromWater: onWater ? 0 : distance, onshoreWindFrom };
}

// Meters from (0, 0) to the closest point of any edge
function nearestEdgeDistance(edges) {
  let best = Infinity;
  for (const [x1, y1, x2, y2] of edges) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    // How far along the edge its closest point is (0 = start, 1 = end)
    const t = Math.min(1, Math.max(0, (-x1 * dx - y1 * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return best;
}

// On the water? A line going east from (x, y) crosses the outline an odd
// number of times (an island's shore counts too, so an island is outside)
function isInside(edges, x, y) {
  let crossings = 0;
  for (const [x1, y1, x2, y2] of edges) {
    if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) {
      crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

// The compass direction (degrees) from (0, 0) toward the middle of the water
// within 3 km, nearer water counting more (each bit weighs 1 / its
// distance). Wind blowing FROM there pushes floating algae onto this shore,
// like onshoreWindFrom in areas.js. null if there's no water within 3 km.
function waterDirection(edges) {
  // Only edges that reach the circle's band can be crossed (see isInside)
  const band = edges.filter(([, y1, , y2]) => Math.min(y1, y2) <= WATER_RADIUS_M && Math.max(y1, y2) >= -WATER_RADIUS_M);
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let x = -WATER_RADIUS_M; x <= WATER_RADIUS_M; x += WATER_STEP_M) {
    for (let y = -WATER_RADIUS_M; y <= WATER_RADIUS_M; y += WATER_STEP_M) {
      const distance = Math.hypot(x, y);
      if (distance > WATER_RADIUS_M || !isInside(band, x, y)) continue;
      const weight = 1 / Math.max(distance, WATER_STEP_M);
      sumX += x * weight;
      sumY += y * weight;
      sumWeight += weight;
    }
  }
  if (sumWeight === 0) return null;
  // atan2(east, north) gives the compass angle: 0 = north, 90 = east
  const degrees = Math.atan2(sumX / sumWeight, sumY / sumWeight) * 180 / Math.PI;
  return (Math.round(degrees) + 360) % 360;
}
