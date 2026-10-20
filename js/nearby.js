// "Live stations near you": finds every live USGS water station near a
// place, works out its tier from what it measures, and compares it with
// ITS OWN state's standards (decided Oct 10; rules settled Oct 18). Only
// finds and judges; nearstations.js draws the list.
//
// Two USGS requests per place: the newest readings of every station in a
// box around it, then the names, states and site types of the ones we keep.

import { fetchLatestInBox, fetchStationInfo } from "./usgs.js";
import { getStaleness } from "./risk.js";
import { distanceKm } from "./location.js";

// How far to look (about 25 miles)
const SEARCH_KM = 40;
const MILES_PER_KM = 0.621371;

// A place asked about again within 15 minutes gets the saved answer, so
// moving the map or reopening the page doesn't ask USGS again
const CACHE_MINUTES = 15;

// Made by scripts/make_standards.py from data/standards.csv
const STANDARDS_FILE = "data/standards.json";

// USGS site types we list: streams (ST, ST-TS tidal, ST-CA canal...),
// lakes (LK), estuaries (ES), wetlands (WE), springs (SP) and the ocean
// (OC). Wells (GW), rain gauges (AT) and land sites are left out.
const SURFACE_WATER = ["ST", "LK", "ES", "WE", "SP", "OC"];
// Water that can be partly salty with the tide (decided Oct 18: judged,
// with a note that freshwater standards may not fit exactly)
const TIDAL = ["ST-TS", "ES"];
// The ocean: freshwater standards don't apply at all, so no rating
const OCEAN = ["OC", "OC-CO"];

// JordanWatch's own early-warning band, NOT a state rule (the same band the
// station picker used with NC's numbers: DO ≤ 6, pH < 6.5 or > 8.5,
// turbidity ≥ 15 of 25)
const DO_CAUTION_MARGIN = 2;           // mg/L above the minimum
const PH_CAUTION_MARGIN = 0.5;         // pH units inside either end
const TURBIDITY_CAUTION_SHARE = 0.6;   // 60% of the limit

// Saved answers: { "35.79,-78.78": { time, result } }, like a Python dict
const cache = {};
// The standards file, loaded once (a Promise, so two lists asking at the
// same time share one download)
let standardsPromise = null;

// place = { lat, lng }. Returns { stations, miles }: stations nearest
// first, each { id, name, state, siteType, lat, lng, km, tier, readings,
// risk, rules }.
export async function findStationsNear(place) {
  // Rounded to 2 decimals (about 1 km), so tiny GPS changes reuse the answer
  const key = `${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;
  const saved = cache[key];
  if (saved && Date.now() - saved.time < CACHE_MINUTES * 60 * 1000) {
    return saved.result;
  }

  const [found, standards] = await Promise.all([
    fetchLatestInBox(boxAround(place, SEARCH_KM)),
    loadStandards()
  ]);

  // Tier first, so we only ask for the names of stations we'll show. The box's
  // corners are farther than SEARCH_KM, so cut those off too.
  const kept = found
    .map(station => ({ ...station, km: distanceKm(place, station), tier: tierOf(station.readings) }))
    .filter(station => station.tier !== null && station.km <= SEARCH_KM);
  const info = kept.length > 0 ? await fetchStationInfo(kept.map(s => s.id)) : {};

  const stations = [];
  for (const station of kept) {
    // If USGS has no details for a station, show its number instead of a name
    const about = info[station.id] ?? { name: station.id.replace("USGS-", ""), state: null, siteType: null };
    if (!isSurfaceWater(about.siteType)) continue;
    stations.push(judge({ ...station, ...about }, standards));
  }
  stations.sort((a, b) => a.km - b.km);

  const result = { stations, miles: Math.round(SEARCH_KM * MILES_PER_KM) };
  // Only a full answer is saved: a failed request throws above and is
  // simply asked again next time
  cache[key] = { time: Date.now(), result };
  return result;
}

// The state standards table (also used by the station picker)
export function loadStandards() {
  if (!standardsPromise) {
    standardsPromise = fetch(STANDARDS_FILE).then(response => {
      if (!response.ok) {
        throw new Error(`Couldn't load the state standards (HTTP ${response.status}).`);
      }
      return response.json();
    });
    // If it failed, forget it, so the next try downloads it again
    standardsPromise.catch(() => { standardsPromise = null; });
  }
  return standardsPromise;
}

// [west, south, east, north] in degrees, km in every direction from the place
function boxAround(place, km) {
  const dLat = km / 111;   // one degree of latitude is about 111 km
  // Degrees of longitude get shorter toward the poles
  const dLng = km / (111 * Math.cos(place.lat * Math.PI / 180));
  return [place.lng - dLng, place.lat - dLat, place.lng + dLng, place.lat + dLat]
    .map(degrees => degrees.toFixed(4));
}

// The tier from what a station measures (decided Oct 8):
// DO + turbidity → full · DO + pH → partial · flow or lake level → limited
// · anything else (e.g. temperature only) → null, not listed
function tierOf(readings) {
  if (readings.doMgL && readings.turbidityFnu) return "full";
  if (readings.doMgL && readings.ph) return "partial";
  if (readings.flowCfs || readings.lakeLevelFt) return "limited";
  return null;
}

// Unknown (null) counts as surface water: better to list it than to hide it
function isSurfaceWater(siteType) {
  return siteType === null || SURFACE_WATER.some(code => siteType.startsWith(code));
}

// Adds risk and rules to a station. rules is null when nothing was rated,
// so the list doesn't show standards that weren't used.
function judge(station, standards) {
  if (station.tier === "limited") {
    const risk = {
      level: "limited",
      reason: "This station measures water flow or lake level, not water quality, so it can't give a risk rating.",
      rated: []
    };
    return { ...station, risk, rules: null };
  }
  if (OCEAN.includes(station.siteType)) {
    const risk = {
      level: "not-rated",
      reason: "Ocean water: the freshwater standards JordanWatch uses don't apply here, so it isn't rated.",
      rated: []
    };
    return { ...station, risk, rules: null };
  }

  const rules = rulesFor(standards, station.state, station.siteType);
  const risk = judgeStation(station.readings, station.tier, rules);
  return { ...station, risk, rules: risk.rated.length > 0 ? rules : null };
}

// The numbers a station is compared with: its state's, or EPA's national
// recommended criteria for any measurement the state has no single number
// for (decided Oct 18), e.g. Texas pH, Florida DO, all of California.
export function rulesFor(standards, stateName, siteType) {
  const row = standards.states[stateName] ?? null;   // null: not in the table
  const epa = standards.epa;
  const own = row ?? {};
  const isLake = siteType === "LK";

  // == null is true for both null and undefined (an empty cell, or no row)
  const doFromEpa = own.doMin == null;
  const phFromEpa = own.phMin == null;
  // EPA has no national turbidity number, so there's no fallback for it
  const turbidityMax = (isLake ? own.turbidityLakes : own.turbidityStreams) ?? null;

  return {
    state: row ? row.name : stateName,
    row,
    epa,
    doMin: doFromEpa ? epa.doMin : own.doMin,
    phMin: phFromEpa ? epa.phMin : own.phMin,
    phMax: phFromEpa ? epa.phMax : own.phMax,
    doFromEpa,
    phFromEpa,
    turbidityMax,
    isLake,
    isTidal: TIDAL.includes(siteType)
  };
}

// The verdict for a full or partial station. Returns { level, reason,
// note, isOutdated, rated }, rated = which measurements were compared.
export function judgeStation(readings, tier, rules) {
  const doReading = readings.doMgL;
  // A full station in a state without a turbidity limit is rated on DO and
  // pH alone (decided Oct 18), so its turbidity reading isn't needed
  const useTurbidity = tier === "full" && rules.turbidityMax !== null;

  if (!doReading || (useTurbidity && !readings.turbidityFnu)) {
    return noData(useTurbidity ? "Missing DO or turbidity reading." : "Missing DO reading.");
  }

  // Staleness gate, the same rules as the station picker (risk.js)
  const ages = [getStaleness(doReading.timestamp)];
  if (useTurbidity) ages.push(getStaleness(readings.turbidityFnu.timestamp));
  if (ages.some(age => age.status === "stale")) {
    return noData("Most recent reading is over 24 hours old.");
  }
  const isOutdated = ages.some(age => age.status === "outdated");

  const checks = [checkDo(doReading.value, rules)];
  // pH older than 24 hours isn't used (decided Oct 18); the rest still counts
  if (readings.ph && getStaleness(readings.ph.timestamp).status !== "stale") {
    checks.push(checkPh(readings.ph.value, rules));
  }
  if (useTurbidity) checks.push(checkTurbidity(readings.turbidityFnu.value, rules));

  const rated = checks.map(c => c.name);
  const high = checks.filter(c => c.level === "high");
  const caution = checks.filter(c => c.level === "caution");

  if (high.length > 0) {
    return { level: "high", reason: sentence(high.map(c => c.text).join(", ")), isOutdated, rated };
  }

  const ownBand = "Caution is JordanWatch's own early-warning band, not a state rule.";
  if (tier === "partial") {
    // Without turbidity we can't confirm low risk, so the baseline is Caution
    // (decided Sept 27)
    const close = caution.length > 0 ? ` Close to a limit: ${caution.map(c => c.text).join(", ")}.` : "";
    return {
      level: "caution",
      reason: `${listWords(rated)} ${rated.length === 1 ? "is" : "are"} within the standards, but turbidity isn't measured here.${close}`,
      note: "Turbidity isn't measured at this station, so JordanWatch can't confirm low risk. Caution is shown as a precaution, not because the water is known to be dangerous.",
      isOutdated,
      rated
    };
  }
  if (caution.length > 0) {
    return { level: "caution", reason: `Close to a limit: ${caution.map(c => c.text).join(", ")}. ${ownBand}`, isOutdated, rated };
  }
  // "DO is", "DO and pH are", "DO, pH and turbidity are all"
  const verb = ["is", "is", "are", "are all"][rated.length];
  return { level: "low", reason: `${listWords(rated)} ${verb} within the standards.`, isOutdated, rated };
}

function noData(reason) {
  return { level: "no-data", reason, rated: [] };
}

// "North Carolina's", or "EPA's national" when the number came from EPA
function whose(rules, fromEpa) {
  return fromEpa ? "EPA's national" : `${rules.state}'s`;
}

function checkDo(value, rules) {
  const limit = `${whose(rules, rules.doFromEpa)} minimum (${rules.doMin} mg/L)`;
  if (value < rules.doMin) return { name: "DO", level: "high", text: `DO below ${limit}` };
  if (value <= rules.doMin + DO_CAUTION_MARGIN) {
    return { name: "DO", level: "caution", text: `DO within ${DO_CAUTION_MARGIN} mg/L of ${limit}` };
  }
  return { name: "DO", level: "low" };
}

function checkPh(value, rules) {
  const range = `${whose(rules, rules.phFromEpa)} range (${rules.phMin}–${rules.phMax})`;
  if (value < rules.phMin || value > rules.phMax) {
    return { name: "pH", level: "high", text: `pH outside ${range}` };
  }
  if (value < rules.phMin + PH_CAUTION_MARGIN || value > rules.phMax - PH_CAUTION_MARGIN) {
    return { name: "pH", level: "caution", text: `pH near the edge of ${range}` };
  }
  return { name: "pH", level: "low" };
}

// Turbidity always comes from the state (EPA has no number for it). The
// reading is in FNU and the limit in NTU: close, but not the same unit.
function checkTurbidity(value, rules) {
  const limit = `${rules.state}'s limit for ${rules.isLake ? "lakes" : "streams"} (${rules.turbidityMax} NTU)`;
  if (value > rules.turbidityMax) return { name: "turbidity", level: "high", text: `turbidity above ${limit}` };
  if (value >= rules.turbidityMax * TURBIDITY_CAUTION_SHARE) {
    return { name: "turbidity", level: "caution", text: `turbidity near ${limit}` };
  }
  return { name: "turbidity", level: "low" };
}

// ["DO", "pH", "turbidity"] → "DO, pH and turbidity"
function listWords(words) {
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// A capital first letter and a period: "turbidity above the limit" →
// "Turbidity above the limit."
function sentence(text) {
  return text[0].toUpperCase() + text.slice(1) + ".";
}
