// Verdicts for every lake EPA CyAN covers in the lower 48 (decided Oct 16):
// Avoid / Caution / Low Risk from the lake's own satellite data, with the
// reasons, or why there's no verdict. Reads the two files that
// scripts/fetch_lakes.py refreshes 4 times a day. Knows nothing about the
// page. Jordan Lake's 10 areas keep their own, more detailed engine (lake.js).
//
// Two kinds of satellite reading per lake (see fetch_lakes.py):
// - "check": EPA's own pixel counts for the lake. It tells clean water from
//   clouds, so it's the only reading that can give Low Risk.
// - "image": EPA's nationwide image. It only shows blooms (clean water and
//   clouds both look empty), so it can warn but never give Low Risk.

import { distanceKm } from "./location.js";
import { compactCells } from "./lake.js";

const INDEX_FILE = "data/lakes/index.json";
const READINGS_FILE = "data/lakes/readings.json";

// EPA names that don't match what people call the lake (decided Oct 20): a
// data correction by lake id, like fixing a typo in the source
const NAME_FIXES = {
  2300042: "Falls Lake",   // EPA: "Brinkley Lake"
  2764219: "Jordan Lake"   // EPA: "B Everett Jordan Lake" (the search finds it as "jordan")
};

// Jordan Lake shows its 10 areas (lake.js) instead of one whole-lake pin
export const JORDAN_LAKE_ID = 2764219;

// WHO 1999/2003 recreational guideline levels for cyanobacteria (cells/mL),
// the same as lake.js
const WHO_LOW_RISK = 20000;
const WHO_MODERATE_RISK = 100000;

// A level counts for the whole lake when at least 5% of what the satellite
// saw (and at least 2 pixels) reaches it (proposed Oct 15)
const BLOOM_SHARE = 0.05;
const MIN_BLOOM_PIXELS = 2;

// Low Risk needs a good look (at least half the lake seen) and no
// Avoid-level pixel in the week before, like bug 11's fix for Jordan Lake
const GOOD_LOOK_SHARE = 0.5;
const RECENT_BLOOM_DAYS = 7;

// Satellite image age limits, in days (the same as lake.js)
const IMAGE_CURRENT_DAYS = 7;
const IMAGE_MAX_DAYS = 14;

// Fewer water pixels than this: too small for the satellite, no verdict.
// Fewer than FEW_PIXELS: the card says it's a rough reading.
const MIN_LAKE_PIXELS = 3;
const FEW_PIXELS = 10;
// Lakes this big (km²) can be very different from one part to another, and
// can cross state lines (lakecard.js)
export const LARGE_LAKE_KM2 = 100;
const SQ_MILES_PER_KM2 = 0.386102;

const DAY_MS = 1000 * 60 * 60 * 24;

// --- Loading the lake files ---

// Returns { lakes: [...], updatedAt }. Each lake: { id, name, state, lat,
// lng, km2, pixels, shore, image, check, verdict }.
export async function fetchLakes() {
  const [index, readings] = await Promise.all([getJson(INDEX_FILE), getJson(READINGS_FILE)]);

  const lakes = index.lakes.map(row => {
    const lake = toObject(index.fields, row);
    lake.name = NAME_FIXES[lake.id] ?? lake.name;
    lake.shore = lake.shore ?? null;    // only big lakes have shore points
    const saved = readings.lakes[lake.id] ?? {};
    lake.image = saved.i ? withAge(toObject(readings.imageFields, saved.i)) : null;
    lake.check = saved.c ? withAge(toObject(readings.checkFields, saved.c)) : null;
    lake.verdict = lakeVerdict(lake);
    return lake;
  });

  return { lakes, updatedAt: readings.updatedAt };
}

async function getJson(file) {
  // "no-cache": check for a newer copy, like cyan.js
  const response = await fetch(file, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Lake data request failed (HTTP ${response.status})`);
  }
  return response.json();
}

// The files save each lake as a short list, with the names listed once:
// (["id", "name"], [2764219, "B Everett Jordan Lake"]) → { id: 2764219, name: "B Everett Jordan Lake" }
// (like Python's dict(zip(fields, row)))
function toObject(fields, row) {
  return Object.fromEntries(fields.map((field, i) => [field, row[i]]));
}

// Adds ageDays: whole days between the satellite day and today
function withAge(reading) {
  reading.ageDays = reading.date ? daysBetween(reading.date, new Date()) : null;
  return reading;
}

// --- The verdict for one lake ---

// Returns { level ("avoid", "caution", "low" or null), status ("ok",
// "no-recent" or "too-small"), source ("check" or "image"), reading,
// satelliteHeadline (a short plain headline for the Why card, decided
// Oct 21), satelliteValue (its short key value, e.g. "217k cells/mL"),
// reasons: [sentences] }. Three WHO levels only, with no
// stratification within Avoid (decided Oct 21, after NC DHHS's feedback).
export function lakeVerdict(lake) {
  // EPA's own count of the water pixels it can see, once the lake has been
  // checked; before that, the pixels inside its outline on the image
  const pixels = lake.check?.lakePixels ?? lake.pixels;
  if (pixels < MIN_LAKE_PIXELS) {
    return noVerdict("too-small", "Too small for the satellite", "Too small",
      "Too small for the satellite: its 300 m pixels here all touch the shore, and EPA leaves those out.");
  }

  // Readings older than 14 days aren't used (old data can't give an all-clear)
  const check = isRecent(lake.check) ? lake.check : null;
  const image = isRecent(lake.image) ? lake.image : null;

  // The newest reading wins, like lake.js. On the same day the check wins,
  // because it can tell clean water from clouds.
  const imageWarning = image ? imageSignal(image) : null;
  let signal;
  if (imageWarning && (!check || image.date > check.date)) {
    signal = imageWarning;
  } else if (check) {
    // The newest Avoid-level pixel from either reading, for the week-before rule
    const lastAvoidPixel = newestDate(lake.check.last100, lake.image?.last100);
    signal = checkSignal(check, lastAvoidPixel);
  } else {
    const looked = lake.check || lake.image;
    const headline = looked ? "No recent satellite look" : "Not checked yet";
    return noVerdict("no-recent", headline, looked ? "No recent reading" : "Not checked yet", noRecentReason(lake));
  }

  return {
    level: signal.level,
    status: "ok",
    source: signal.source,
    reading: signal.reading,
    satelliteHeadline: signal.headline,
    satelliteValue: signal.value,
    reasons: [signal.text, ...sizeNotes(lake, pixels)]
  };
}

// --- Per-lake check: EPA's pixel counts (clean water vs. clouds known) ---
function checkSignal(check, lastAvoidPixel) {
  const seen = check.seen;
  const looked = `Satellite (${check.date}): it saw ${percent(seen / check.lakePixels)} of the lake`;
  // (max is null when nothing was detected; it's only used when something was)
  const highest = check.max === null ? "" : `the highest pixel was about ${cellsText(check.max)}`;
  const result = (level, headline, value, text) => ({ source: "check", reading: check, level, headline, value, text });

  // At least 5% of what it saw is at the Avoid level
  if (reaches(check.n100, seen)) {
    return result("avoid", "Strong bloom in parts of the lake", `${compactCells(check.avoidMean)} cells/mL`,
      `${looked}, and ${percent(check.n100 / seen)} of what it saw was above the WHO 1999/2003 moderate-risk level (100,000 cells/mL). Those pixels averaged about ${cellsText(check.avoidMean)}; ${highest}.`);
  }
  // At least 5% at the Caution level
  if (reaches(check.n20, seen)) {
    const avoidPixels = check.n100 > 0 ? ` ${pixelCount(check.n100)} reached the Avoid level (100,000+); ${highest}.` : "";
    return result("caution", "Some algae, below the Avoid level", `${percent(check.n20 / seen)} above 20k`,
      `${looked}, and ${percent(check.n20 / seen)} of what it saw was above the WHO 1999/2003 low-risk level (20,000 cells/mL).${avoidPixels}`);
  }
  // Rule B (decided Oct 13): even one Avoid-level pixel means it can't be Low Risk
  if (check.n100 > 0) {
    return result("caution", "Mostly low, but a few strong-bloom pixels", peakValue(check.max),
      `${looked}. Most of it was below 20,000 cells/mL, but ${pixelCount(check.n100)} reached the Avoid level (100,000+; ${highest}), so low levels can't be confirmed.`);
  }

  // No bloom at the Caution level. Low Risk needs a good look...
  const clean = check.detected === 0
    ? "all of it below detection (under about 6,500 cells/mL), under the WHO 1999/2003 low-risk level (20,000)"
    : `${percent((seen - check.detected) / seen)} of it below detection, and ${check.n20 === 0 ? "none" : "under 5%"} of it above the WHO 1999/2003 low-risk level (20,000 cells/mL)`;
  const text = `${looked}: ${clean}.`;
  const lowValue = check.detected === 0 ? "Below detection" : "Under 20k cells/mL";
  if (seen < GOOD_LOOK_SHARE * check.lakePixels) {
    return result("caution", "No bloom seen, but only part of the lake", `Saw ${percent(seen / check.lakePixels)} of lake`, `${text} That's too little of the lake to confirm low levels.`);
  }
  // ...a current image (7–14 days old can't give an all-clear)...
  if (check.ageDays > IMAGE_CURRENT_DAYS) {
    return result("caution", "No bloom seen, but the reading is old", `${check.ageDays} days old`, `${text} But the reading is ${check.ageDays} days old, so low levels can't be confirmed.`);
  }
  // ...and no Avoid-level pixel in the week before
  if (lastAvoidPixel && daysBetween(lastAvoidPixel, check.date) <= RECENT_BLOOM_DAYS) {
    return result("caution", "No bloom seen, but one within the last week", lowValue, `${text} But part of the lake was at the Avoid level on ${lastAvoidPixel}, within a week of this reading, so low levels can't be confirmed yet.`);
  }
  return result("low", "No bloom seen", lowValue, text);
}

// --- Nationwide image: only blooms show, so it only ever warns ---
// Returns null if the image shows no bloom at the Caution level (then it
// says nothing: fetch_lakes.py only keeps image readings that warn).
function imageSignal(image) {
  const pixels = image.pixels;
  const where = image.kind === "w"
    ? `EPA's weekly satellite image (the worst day of the week of ${weekText(image.date)})`
    : `EPA's nationwide satellite image (${image.date})`;
  const cantConfirm = "Clouds and clean water both look empty in this image, so it can show a bloom but can't confirm low levels.";
  const result = (level, headline, value, text) => ({ source: "image", reading: image, level, headline, value, text: `${text} ${cantConfirm}` });

  if (reaches(image.n100, pixels)) {
    return result("avoid", "Strong bloom in parts of the lake", `${compactCells(image.avoidMean)} cells/mL`,
      `${where}: ${percent(image.n100 / pixels)} of the lake was above the WHO 1999/2003 moderate-risk level (100,000 cells/mL). Those pixels averaged about ${cellsText(image.avoidMean)}; the highest was about ${cellsText(image.max)}.`);
  }
  if (reaches(image.n20, pixels)) {
    return result("caution", "Some algae, below the Avoid level", `${percent(image.n20 / pixels)} above 20k`,
      `${where}: ${percent(image.n20 / pixels)} of the lake was above the WHO 1999/2003 low-risk level (20,000 cells/mL).`);
  }
  if (image.n100 === 0) return null;
  // Rule B: an Avoid-level pixel or two, not 5% of the lake
  return result("caution", "A few strong-bloom pixels", peakValue(image.max),
    `${where}: ${pixelCount(image.n100)} reached the Avoid level (100,000+; the highest about ${cellsText(image.max)}).`);
}

// --- No verdict ---
function noVerdict(status, headline, value, reason) {
  return { level: null, status, source: null, reading: null, satelliteHeadline: headline, satelliteValue: value, reasons: [reason] };
}

// Why there's no recent reading (the missing-data rule, decided Oct 13:
// say what's missing and why)
function noRecentReason(lake) {
  const tooOld = [lake.check, lake.image].filter(r => r?.date && r.ageDays > IMAGE_MAX_DAYS);
  const newest = tooOld.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (newest) {
    return `No recent satellite reading: the newest is from ${newest.date} (${newest.ageDays} days old), too old to use.`;
  }
  if (lake.check) {
    return "No recent satellite reading: the satellite hasn't had a clear look at this lake in the last 14 days (clouds, or no pass).";
  }
  return "No satellite reading yet: this lake hasn't been checked. Lakes are checked one at a time, so its turn hasn't come yet.";
}

// Extra notes about the lake's size
function sizeNotes(lake, pixels) {
  const notes = [];
  if (pixels < FEW_PIXELS) {
    notes.push(`Only ${pixels} satellite pixels: a rough reading.`);
  }
  if (lake.km2 >= LARGE_LAKE_KM2) {
    const sqMiles = Math.round(lake.km2 * SQ_MILES_PER_KM2).toLocaleString();
    notes.push(`Large lake (about ${sqMiles} sq mi): one verdict for all of it, but parts can differ a lot.`);
  }
  return notes;
}

// --- Nearby lakes ("See what's near you") ---

// The closest lakes to a point, as [{ lake, km }], closest first. Lakes too
// small for the satellite are left out; skipId leaves out one lake (Jordan
// Lake, when its areas are already shown).
export function nearestLakes(lakes, point, count, skipId = null) {
  return lakes
    .filter(lake => lake.id !== skipId && lake.verdict.status !== "too-small")
    .map(lake => ({ lake, km: lakeDistanceKm(lake, point) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, count);
}

// --- "Go here instead" for any lake (decided Oct 21) ---

// Search this far for a lake with a better rating (about 30 miles)
export const BETTER_LAKE_KM = 48;
const LEVEL_ORDER = ["low", "caution", "avoid"];

// For a lake at Avoid or Caution: the nearest covered lake within about 30
// miles whose rating is better, preferring lakes with mapped beaches
// (beachLakeIds = a Set of lake ids that have OpenStreetMap beaches).
// verdict = the lake's own verdict (all its signals when they've loaded).
// from = where to measure from: the lake's middle, or for a big lake the
// part closest to the user. Jordan Lake's 10 areas keep their own
// "Go here instead" (lake.js); this is for every other lake.
// Returns null when the lake isn't at Avoid or Caution; otherwise
// { lake, km, hasBeach } for the pick, or { lake: null } when no lake
// nearby is better, plus states: the states of every lake it looked at
// (so the page can load their beach lists and ask again).
export function betterLakeNearby(lake, verdict, lakes, beachLakeIds, from = lake) {
  if (verdict.level !== "avoid" && verdict.level !== "caution") return null;
  const rank = LEVEL_ORDER.indexOf(verdict.level);

  const near = lakes
    .filter(other => other.id !== lake.id && other.verdict.status === "ok")
    .map(other => ({ lake: other, km: lakeDistanceKm(other, from) }))
    .filter(({ km }) => km <= BETTER_LAKE_KM);
  const states = [...new Set(near.map(({ lake: other }) => other.state))];

  const better = near
    .filter(({ lake: other }) => LEVEL_ORDER.indexOf(other.verdict.level) < rank)
    .map(pick => ({ ...pick, hasBeach: beachLakeIds.has(pick.lake.id) }))
    // Lakes with beaches first, then the nearest (true - false = 1, like
    // sorting on Python's (not has_beach, km))
    .sort((a, b) => (b.hasBeach - a.hasBeach) || (a.km - b.km));

  return better.length > 0 ? { ...better[0], states } : { lake: null, states };
}

// To the lake's middle, or for a big lake to the nearest point along its
// shore (Lake Michigan's middle is 150 miles from Chicago)
function lakeDistanceKm(lake, point) {
  return distanceKm(point, closestPointOfLake(lake, point));
}

// The lake's middle, or for a big lake whichever of its shore points is
// closer to `point` (also used for a lake card's nearby stations and GPS spot)
export function closestPointOfLake(lake, point) {
  let best = { lat: lake.lat, lng: lake.lng };
  let bestKm = distanceKm(point, best);
  const shore = lake.shore ?? [];
  for (let i = 0; i < shore.length; i += 2) {
    const candidate = { lat: shore[i], lng: shore[i + 1] };
    const km = distanceKm(point, candidate);
    if (km < bestKm) {
      best = candidate;
      bestKm = km;
    }
  }
  return best;
}

// --- Helpers ---

function isRecent(reading) {
  return reading !== null && reading.date !== null && reading.ageDays <= IMAGE_MAX_DAYS;
}

// At least 5% of the pixels, and at least 2
function reaches(count, outOf) {
  return count >= MIN_BLOOM_PIXELS && count >= BLOOM_SHARE * outOf;
}

// The later of two "YYYY-MM-DD" dates (either can be null)
function newestDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

// Whole days from date a to date b ("YYYY-MM-DD" text, read as midnight
// UTC like cyan.js, or a Date)
function daysBetween(a, b) {
  const time = d => (typeof d === "string" ? new Date(d + "T00:00:00Z") : d).getTime();
  return Math.floor((time(b) - time(a)) / DAY_MS);
}

// "Oct 4–10" for a weekly image dated by its first day
function weekText(firstDay) {
  const start = new Date(firstDay + "T00:00:00Z");
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const options = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${start.toLocaleDateString("en-US", options)}–${end.toLocaleDateString("en-US", options)}`;
}

// 0.4234 → "42%", 0.003 → "under 1%", 0.998 → "over 99%" (so rounding
// never turns a few pixels into 0% or 100%)
function percent(share) {
  if (share > 0 && share < 0.01) return "under 1%";
  if (share > 0.99 && share < 1) return "over 99%";
  return `${Math.round(share * 100)}%`;
}

// The highest pixel, short: "Peak 155k cells/mL"
function peakValue(cells) {
  return `Peak ${compactCells(cells)} cells/mL`;
}

function cellsText(cells) {
  return `${cells.toLocaleString()} cells/mL`;
}

// 1 → "1 pixel", 2477 → "2,477 pixels"
function pixelCount(count) {
  return count === 1 ? "1 pixel" : `${count.toLocaleString()} pixels`;
}
