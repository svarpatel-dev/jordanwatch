// The lake verdict engine: turns satellite, lake level and wind data into
// an Avoid / Caution / Low Risk verdict for each Jordan Lake area, with the
// reasons. Knows nothing about the page or where the data came from.
// Rules decided Oct 3–5 (see the project notes: Key decisions → Risk engine).

// Verdict levels from best to worst. A higher position means worse.
const LEVELS = ["low", "caution", "avoid"];

// WHO 1999/2003 recreational guideline levels for cyanobacteria (cells/mL)
const WHO_LOW_RISK = 20000;
const WHO_MODERATE_RISK = 100000;

// Satellite image age limits, in days
const IMAGE_CURRENT_DAYS = 7;
const IMAGE_MAX_DAYS = 14;

// Lake level at the dam. Normal pool is 216.0 ft (USACE); 220 ft is our
// own "high water" line, since there's no official closure level.
const NORMAL_POOL_FT = 216;
const HIGH_WATER_FT = 220;

// Wind piles floating scum onto a shore when it's light (0.5–3 m/s) and
// blowing toward that shore (within 45° of it). Below 0.5 m/s the
// direction is too random to mean anything.
const CALM_MS = 0.5;
const SCUM_WIND_MAX_MS = 3;
const ONSHORE_WINDOW_DEG = 45;

export function computeLakeVerdicts(areas, cyan, lakeLevel, wind) {
  // Look up satellite points by id, like a Python dict: {"north": {...}, ...}
  const pointsById = Object.fromEntries(cyan.points.map(p => [p.id, p]));

  const verdicts = areas.map(area => {
    const point = pointsById[area.cyanPointId];
    const borrowed = area.cyanPointId !== area.id;

    // Each signal gives a level and a "why" sentence.
    const signals = [
      satelliteSignal(point, borrowed),
      lakeLevelSignal(lakeLevel)
    ];

    // The verdict is the worst level among the signals (decided Oct 4)
    let level = worstLevel(signals.map(s => s.level).filter(l => l !== null));

    // Wind can raise the verdict one step (decided Oct 5)
    const windReason = windSignal(area, point, wind);
    if (windReason.raises) {
      level = raiseOneLevel(level);
    }
    signals.push(windReason);

    return {
      id: area.id,
      name: area.name,
      level,
      cellsPerMl: point?.cellsPerMl ?? null,
      imageDate: point?.imageDate ?? null,
      imageAgeDays: point?.imageAgeDays ?? null,
      noRecentSatellite: signals[0].noRecentSatellite,
      borrowedFrom: borrowed ? point?.name ?? null : null,
      reasons: signals
    };
  });

  return {
    areas: verdicts,
    intake: pointsById["intake"] ?? null
  };
}

// --- Satellite (decided Oct 3) ---
function satelliteSignal(point, borrowed) {
  const prefix = borrowed && point ? `Nearest satellite reading (${point.name}): ` : "Satellite: ";

  // No reading, or too old to use: Caution, never Low Risk
  if (!point || point.status !== "ok") {
    return { source: "satellite", level: "caution", noRecentSatellite: true,
             text: "No satellite reading is available here." };
  }
  if (point.imageAgeDays > IMAGE_MAX_DAYS) {
    return { source: "satellite", level: "caution", noRecentSatellite: true,
             text: `No recent satellite data (the latest image is ${point.imageAgeDays} days old).` };
  }

  const cells = point.cellsPerMl;
  const amount = `${prefix}about ${cells.toLocaleString()} cells/mL`;
  let level;
  let text;

  if (cells >= WHO_MODERATE_RISK) {
    level = "avoid";
    text = `${amount}, above the WHO 1999/2003 moderate-risk level (100,000).`;
  } else if (cells >= WHO_LOW_RISK) {
    level = "caution";
    text = `${amount}, between the WHO 1999/2003 levels (20,000–100,000).`;
  } else {
    level = "low";
    text = `${amount}, below the WHO 1999/2003 low-risk level (20,000).`;
  }

  // An image 7–14 days old can keep a warning but can't give an all-clear
  if (point.imageAgeDays > IMAGE_CURRENT_DAYS && level === "low") {
    level = "caution";
    text += ` But the image is ${point.imageAgeDays} days old, so low levels can't be confirmed.`;
  }

  return { source: "satellite", level, noRecentSatellite: false, text };
}

// --- Lake level at the dam (decided Oct 4) ---
function lakeLevelSignal(lakeLevel) {
  if (!lakeLevel) {
    return { source: "lake-level", level: null, text: "Lake level is unavailable right now." };
  }

  const feet = lakeLevel.value.toFixed(1);
  if (lakeLevel.value >= HIGH_WATER_FT) {
    return { source: "lake-level", level: "caution",
             text: `High water: the lake is at ${feet} ft (normal: ${NORMAL_POOL_FT} ft). Beaches may be closed; check NC State Parks.` };
  }
  return { source: "lake-level", level: "low",
           text: `Lake level ${feet} ft (normal: ${NORMAL_POOL_FT} ft).` };
}

// --- Wind (decided Oct 5) ---
function windSignal(area, point, wind) {
  const noEffect = text => ({ source: "wind", level: null, raises: false, text });

  if (!wind) return noEffect("Wind data is unavailable right now.");

  const speed = wind.speedMs.toFixed(1);
  const from = compassName(wind.fromDeg);

  if (area.onshoreWindFrom === null) {
    return noEffect(`Wind: ${speed} m/s from the ${from}.`);
  }
  if (wind.speedMs < CALM_MS) {
    return noEffect(`Wind: nearly calm (${speed} m/s).`);
  }
  if (wind.speedMs >= SCUM_WIND_MAX_MS) {
    return noEffect(`Wind: ${speed} m/s from the ${from}, strong enough to mix floating algae down.`);
  }

  const onshore = angleBetween(wind.fromDeg, area.onshoreWindFrom) <= ONSHORE_WINDOW_DEG;
  if (!onshore) {
    return noEffect(`Wind: light (${speed} m/s) from the ${from}, not toward this shore.`);
  }

  // Light wind toward this shore only matters if a recent image shows
  // algae to push
  const hasRecentImage = point?.status === "ok" && point.imageAgeDays <= IMAGE_MAX_DAYS;
  if (!hasRecentImage) {
    return noEffect(`Wind: light (${speed} m/s) from the ${from}, toward this shore (no recent satellite image to show how much algae there is).`);
  }
  if (point.cellsPerMl < WHO_LOW_RISK) {
    return noEffect(`Wind: light (${speed} m/s) from the ${from}, toward this shore, but algae levels are low.`);
  }

  return { source: "wind", level: null, raises: true,
           text: `Light wind (${speed} m/s) from the ${from} is likely pushing floating algae toward this shore.` };
}

// --- Helpers ---

// The worst of a list of levels, e.g. ["low", "avoid"] → "avoid"
function worstLevel(levels) {
  const positions = levels.map(l => LEVELS.indexOf(l));
  return LEVELS[Math.max(...positions)];
}

// "low" → "caution" → "avoid" (already "avoid" stays "avoid")
function raiseOneLevel(level) {
  const position = Math.min(LEVELS.indexOf(level) + 1, LEVELS.length - 1);
  return LEVELS[position];
}

// The smaller angle between two compass directions, 0–180°.
// e.g. 350° and 10° are 20° apart, not 340°.
function angleBetween(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// 0° → "north", 90° → "east", 225° → "southwest"
function compassName(degrees) {
  const names = ["north", "northeast", "east", "southeast",
                 "south", "southwest", "west", "northwest"];
  return names[Math.round(degrees / 45) % 8];
}
