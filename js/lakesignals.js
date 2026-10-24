// The extra signals for any lake (decided Oct 13: wind, lake level and
// beaches go nationwide, plus runoff from the nearest gauge), and how they
// combine with the satellite verdict from lakes.js. Knows nothing about the
// page or where the data came from (lakeextras.js fetches it).
//
// The same rules as Jordan Lake's areas (lake.js), generalized:
// - the lake's verdict is the worst of satellite, runoff and lake level
//   (runoff and lake level can only add a Caution, never an Avoid)
// - wind never changes the whole lake's verdict: it raises one level only
//   for a SPOT on the downwind shore (a beach there, or the user's GPS point)
// - missing data never lowers a verdict or gives an all-clear: each signal
//   is used, "not available here" (with the reason), or "couldn't load right now"

import { worstLevel, raiseOneLevel, angleBetween, compassName, mphText, rainValue, flowValue, windValue, HEAVY_RAIN_IN,
         CALM_MS, SCUM_WIND_MAX_MS, ONSHORE_WINDOW_DEG } from "./lake.js";
import { describeDistance } from "./nearyou.js";
import { readableName } from "./nearstations.js";

const FEET_PER_METER = 3.28084;

// Everything for one lake card. satellite = lakeVerdict() from lakes.js;
// extras = what lakeextras.js fetched. Returns the satellite verdict's
// fields (level, status, source, reading, satelliteHeadline, reasons) with
// the combined level, plus otherReasons (one row per extra signal for the
// Why card: { source, level, status, raises, headline, value, text }), warnings,
// beaches, spot, goInstead and signals.
export function combineLakeSignals(satellite, extras) {
  const runoff = runoffSignal(extras.rain, extras.flow, extras.bigLake);
  const level = lakeLevelSignal(extras.level);
  const wind = windSignal(extras.wind, satellite);
  // A big lake's wind is from the part closest to the user, when there's a place
  if (extras.nearYou && extras.wind) wind.text += " (Checked near the part of the lake closest to you.)";

  // Worst of the signals that give a level (decided Oct 4, like lake.js).
  // A lake with no satellite verdict keeps none: a Caution from rain or high
  // water is shown as a warning instead (missing data never gives a verdict).
  let combined = satellite.level;
  const warnings = [runoff, level].filter(s => s.level === "caution").map(s => s.warning);
  if (combined) {
    combined = worstLevel([combined, runoff.level, level.level].filter(l => l));
  }

  const beaches = beachSpots(extras.beaches, combined, wind);
  const spot = userSpot(extras.spot, combined, wind);

  return {
    ...satellite,
    level: combined,
    otherReasons: [
      whyRow("runoff", runoff),
      whyRow("lake-level", level),
      whyRow("wind", wind)
    ],
    warnings: combined ? [] : warnings,
    beaches,
    beachesNote: beachesNote(extras.beaches),
    spot,
    goInstead: goInstead(beaches, spot),
    signals: [satelliteUse(satellite), runoff.use, level.use, wind.use, beachesUse(extras.beaches)]
  };
}

// --- Rain and river flow (runoff after storms, decided Oct 4 for Jordan Lake) ---
// General guidance about bacteria after storms, not a rule for any one lake
function runoffSignal(rain, flow, bigLake) {
  const facts = [];
  const missing = [];
  let heavyRain = false;
  let highFlow = false;

  if (rain.status === "ok") {
    heavyRain = rain.inches >= HEAVY_RAIN_IN;
    facts.push(`${rain.inches.toFixed(2)} in of rain in the last 48 hours at ${gaugeWhere(rain.gauge)}`);
  } else {
    missing.push(rainMissing(rain));
  }
  if (flow.status === "ok") {
    highFlow = flow.cfs > flow.percentiles.p90;
    facts.push(`${gaugeName(flow.gauge)} at ${Math.round(flow.cfs).toLocaleString()} cubic ft/sec, ${flowCompared(flow)} its usual range for this date`);
  } else {
    missing.push(flowMissing(flow));
  }

  // Neither part: not available here (with why), or couldn't load
  if (facts.length === 0) {
    if (rain.status === "need-place") {
      return { level: null, headline: "Choose a place to check rain", value: "Lake too big", text: "This lake is too big for one rain or river gauge: choose a place (See what's near you, at the top) to check the ones near you.",
               use: use("rain and river flow", "not-here", "too big a lake for one gauge (choose a place)") };
    }
    if (rain.status === "none" && flow.status === "none") {
      const where = bigLake ? "the part of this lake closest to you" : "this lake";
      return { level: null, headline: "No rain or river gauge nearby", value: "No gauge nearby", text: `No USGS rain gauge within about 15 miles or river gauge within about 6 miles of ${where}.`,
               use: use("rain and river flow", "not-here", "no USGS rain or river gauge close enough") };
    }
    if (rain.status === "failed" || flow.status === "failed") {
      return { level: null, headline: "Couldn't load rain and river data", value: "Not available", text: "Rain and river data couldn't load right now.", use: use("rain and river flow", "failed") };
    }
    return { level: null, headline: "No usable rain or river reading", value: "No reading", text: `${capitalize(missing.join("; "))}.`,
             use: use("rain and river flow", "not-here", missing.join("; ")) };
  }

  const label = rain.status === "ok" && flow.status === "ok" ? "rain and river flow"
    : rain.status === "ok" ? "rain" : "river flow";
  // The card's key value: whichever part sets the level (high river flow
  // without heavy rain shows the flow), else the rain if there's a reading
  const value = highFlow && !heavyRain ? flowValue(flow.cfs)
    : rain.status === "ok" ? rainValue(rain.inches) : flowValue(flow.cfs);
  const also = missing.length > 0 ? ` (${capitalize(missing.join("; "))}.)` : "";
  if (heavyRain || highFlow) {
    const warning = heavyRain ? "Heavy rain recently: wait 48 hours before swimming" : "The nearest river is running high after rain: wait 48 hours before swimming";
    return {
      level: "caution",
      headline: heavyRain ? "Heavy rain recently" : "River running high after rain",
      value,
      warning: `${warning}.`,
      text: `${warning} (${facts.join("; ")}). Storm runoff can carry bacteria into the water: general guidance after storms, not a rule for this lake.${also}`,
      use: use(label, "used")
    };
  }
  return { level: "low", headline: "No heavy rain recently", value, text: `${capitalize(facts.join("; "))}.${also}`, use: use(label, "used") };
}

function rainMissing(rain) {
  if (rain.status === "none") return "no USGS rain gauge within about 15 miles";
  if (rain.status === "need-place") return "this lake is too big for one rain gauge (choose a place)";
  if (rain.status === "failed") return "rain couldn't load right now";
  return `the rain gauge at ${gaugeName(rain.gauge)} has no complete record for the last 48 hours`;
}

function flowMissing(flow) {
  if (flow.status === "none") return "no USGS river gauge within about 6 miles";
  if (flow.status === "need-place") return "this lake is too big for one river gauge (choose a place)";
  if (flow.status === "failed") return "river flow couldn't load right now";
  if (flow.status === "no-normals") return `${gaugeName(flow.gauge)} has no usual range for this date, so its flow isn't compared`;
  return `${gaugeName(flow.gauge)} has no reading in the last day`;
}

// "well above" (over the 90th percentile), "above", "within" or "below", like lake.js
function flowCompared(flow) {
  const p = flow.percentiles;
  if (flow.cfs > p.p90) return "well above";
  if (flow.cfs > p.p75) return "above";
  if (flow.cfs < p.p25) return "below";
  return "within";
}

// --- Lake level vs. its usual range for this date ---
function lakeLevelSignal(level) {
  const name = level.gauge ? gaugeName(level.gauge) : "";
  if (level.status === "none") {
    return { level: null, headline: "No lake-level gauge", value: "No gauge", text: "No USGS lake-level gauge on this lake.", use: use("lake level", "not-here", "no USGS lake-level gauge on this lake") };
  }
  if (level.status === "failed") {
    return { level: null, headline: "Couldn't load the lake level", value: "Not available", text: "Lake level couldn't load right now.", use: use("lake level", "failed") };
  }
  if (level.status === "no-recent") {
    return { level: null, headline: "No recent lake-level reading", value: "No recent reading", text: `The USGS lake-level gauge (${name}) has no reading in the last 2 days.`,
             use: use("lake level", "not-here", "no recent reading at the lake-level gauge") };
  }

  const feet = `${level.feet.toFixed(1)} ft`;
  if (level.status === "no-normals") {
    return { level: null, headline: "Lake level not compared", value: feet, text: `Lake level ${feet} at the USGS gauge (${name}). USGS has no usual range for this date there, so it isn't compared.`,
             use: use("lake level", "not-here", "no usual range for this date at the lake-level gauge") };
  }

  // High water: above its 90th percentile for this date (decided Oct 13; the
  // same line as the Haw River flow check). Jordan Lake keeps its 220 ft rule.
  const p = level.percentiles;
  const usual = `usually ${p.p25.toFixed(1)}–${p.p75.toFixed(1)} ft on this date`;
  if (level.feet > p.p90) {
    return {
      level: "caution",
      headline: "High water",
      value: feet,
      warning: "High water: beaches may be closed; check local rules.",
      text: `High water: the lake is at ${feet} at the USGS gauge (${name}), higher than in 9 of 10 past years on this date (${usual}). Beaches may be closed; check local rules.`,
      use: use("lake level", "used")
    };
  }
  const compared = level.feet > p.p75 ? "above" : level.feet < p.p25 ? "below" : "within";
  const headline = { above: "Lake level a little high", below: "Lake level a little low", within: "Lake level normal" }[compared];
  return { level: "low", headline, value: feet, text: `Lake level ${feet} at the USGS gauge (${name}), ${compared} its usual range (${usual}).`,
           use: use("lake level", "used") };
}

// --- Wind (decided Oct 5 for Jordan Lake; any lake since Oct 13) ---
// pushes = light wind with algae to push. Then it's likely piling floating
// algae on the downwind shore, and spots there go up one level.
function windSignal(wind, satellite) {
  if (wind === null) {
    return { pushes: false, headline: "Couldn't load wind", value: "Not available", text: "Wind couldn't load right now.", use: use("wind", "failed") };
  }

  // Every wind row's key value: "6 mph NW"
  const value = windValue(wind);
  const result = (headline, text, extra = {}) => ({ pushes: false, headline, value, text, use: use("wind", "used"), ...extra });

  // The rules stay in m/s like lake.js; the text says mph (decided Oct 19)
  const speed = mphText(wind.speedMs);
  const from = compassName(wind.fromDeg);
  const towardShore = `the ${compassName(wind.fromDeg + 180)} shore`;
  if (wind.speedMs < CALM_MS) return result("Nearly calm", `Wind: nearly calm (${speed}).`);
  if (wind.speedMs >= SCUM_WIND_MAX_MS) {
    return result("Wind strong enough to mix algae down", `Wind: ${speed} from the ${from}, strong enough to mix floating algae down.`);
  }

  // Light wind only matters if the satellite shows algae to push: like
  // lake.js, at least the WHO 1999/2003 low-risk level (n20 = how many pixels
  // reached 20,000 cells/mL)
  const reading = satellite.reading;
  if (!reading) {
    return result(`Light wind toward ${towardShore}`, `Wind: light (${speed}) from the ${from}, toward ${towardShore} (no recent satellite reading to show how much algae there is).`);
  }
  if (reading.n20 === 0) {
    return result("Light wind, little algae to push", `Wind: light (${speed}) from the ${from}, toward ${towardShore}, but the satellite shows little algae to push.`);
  }
  return result(`Light wind toward ${towardShore}`, `Light wind (${speed}) from the ${from} is likely pushing floating algae toward ${towardShore}.`,
                { pushes: true, fromDeg: wind.fromDeg, shore: towardShore });
}

// Is a spot on the downwind shore? onshoreWindFrom = the direction from the
// spot toward the water (like areas.js), so wind from there blows onto it
function downwind(wind, onshoreWindFrom) {
  return wind.pushes && onshoreWindFrom !== null
    && angleBetween(wind.fromDeg, onshoreWindFrom) <= ONSHORE_WINDOW_DEG;
}

// A spot's level: the lake's, one higher on the downwind shore. raised is
// only true when that changes something (an Avoid stays an Avoid).
function spotLevel(lakeLevel, wind, onshoreWindFrom) {
  if (!lakeLevel) return { level: null, raised: false };
  const level = downwind(wind, onshoreWindFrom) ? raiseOneLevel(lakeLevel) : lakeLevel;
  return { level, raised: level !== lakeLevel };
}

// --- Beaches (OpenStreetMap, not officially verified) ---
function beachSpots(beaches, lakeLevel, wind) {
  if (beaches.status !== "ok") return [];
  return beaches.list.map(beach => ({ ...beach, ...spotLevel(lakeLevel, wind, beach.onshoreWindFrom) }));
}

function beachesNote(beaches) {
  if (beaches.status === "none") return "No beaches mapped here on OpenStreetMap.";
  if (beaches.status === "not-looked-up") return "Beaches not looked up yet for this lake.";
  if (beaches.status === "failed") return "Beaches couldn't load right now.";
  return null;
}

function beachesUse(beaches) {
  if (beaches.status === "ok") return use("beaches", "used");
  if (beaches.status === "failed") return use("beaches", "failed");
  return use("beaches", "not-here", beaches.status === "none" ? "no beaches mapped on OpenStreetMap" : "beaches not looked up yet");
}

// --- The user's own spot (GPS only, at the lake's shore) ---
function userSpot(spot, lakeLevel, wind) {
  if (!spot || spot.status !== "ok") return null;
  return {
    ...spotLevel(lakeLevel, wind, spot.onshoreWindFrom),
    // The spot's shore faces away from the water: water to the west = east shore
    shore: `the ${compassName(spot.onshoreWindFrom + 180)} shore`,
    feetFromWater: Math.round(spot.metersFromWater * FEET_PER_METER)
  };
}

// "Go here instead" on a lake (decided Oct 13): when the wind raises the
// user's own spot or the beach nearest them, the nearest beach it doesn't
// raise. Only with a chosen place (then beaches come nearest first, with
// km); without one, each beach's own line already says if it's raised.
function goInstead(beaches, spot) {
  const nearestRaised = beaches.length > 0 && beaches[0].km !== undefined && beaches[0].raised;
  if (!spot?.raised && !nearestRaised) return null;
  return beaches.find(b => b.level && !b.raised) ?? null;
}

// --- The coverage line (the missing-data rule, decided Oct 13) ---
function satelliteUse(satellite) {
  if (satellite.level) return use("satellite", "used");
  return use("satellite", "not-here", satellite.status === "too-small" ? "too small for the satellite" : "no recent satellite reading");
}

// One row of the Why card: which signal, the level it gives (null when it
// gives none), whether it was used, not available here, or failed, whether
// light wind is pushing algae toward a shore (raises spots there), and its
// headline, short value and sentence
function whyRow(source, signal) {
  return { source, level: signal.level ?? null, status: signal.use.status,
           raises: signal.pushes === true, headline: signal.headline, value: signal.value, text: signal.text };
}

// One signal for the coverage line: status "used", "not-here" (with the
// reason) or "failed" (couldn't load right now)
function use(label, status, why = null) {
  return { label, status, why };
}

// The signals while the extras are still loading (or couldn't load): the
// satellite as it is, the other four "loading" or "failed". The Why card
// shows them as pills (cardparts.js coverageHtml).
export function pendingSignals(satellite, failed) {
  const status = failed ? "failed" : "loading";
  const others = ["rain and river flow", "lake level", "wind", "beaches"].map(label => use(label, status));
  return [satelliteUse(satellite), ...others];
}

// --- Helpers ---

// "Falls Lake Above Dam Nr Falls, NC"
function gaugeName(gauge) {
  return readableName(gauge.name);
}

// "Falls Lake Above Dam Nr Falls, NC (on the lake)", "... (4.2 miles from
// the lake)", or for a big lake "... (3.0 miles from the part of the lake closest to you)"
function gaugeWhere(gauge) {
  const from = gauge.from === "you" ? "the part of the lake closest to you" : "the lake";
  const where = gauge.km < 0.1 && gauge.from !== "you" ? "on the lake" : `${describeDistance(gauge.km)} from ${from}`;
  return `${gaugeName(gauge)} (${where})`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
