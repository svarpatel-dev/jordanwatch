// Fetches the extra signals for one lake card (decided Oct 13): first which
// gauges and beaches belong to the lake (data/lakes/extras/NC.json and so
// on, made by scripts/fetch_lake_extras.py), then today's numbers:
//   1. wind at the lake (Open-Meteo)
//   2. rain, river flow and lake level from its gauges (one USGS request)
//   3. the usual range for this date at the river and lake-level gauges
//      (one USGS request per gauge, so 0-2)
//   4. only when the user's GPS point may be at this lake: its outline
//      (EPA), to see which shore they're on
// A big lake (100 km² or more: it has shore points, like Lake Michigan) is
// checked near the part of it closest to the user: the wind there, and the
// rain and river gauges along its shore nearest that spot.
// Each piece that fails becomes "failed" instead of stopping the card.
// lakesignals.js turns all of it into reasons; this file only fetches.

import { fetchWind } from "./weather.js";
import { fetchRecentReadings, fetchDailyPercentiles } from "./usgs.js";
import { distanceKm } from "./location.js";
import { closestPointOfLake } from "./lakes.js";
import { shoreSpot } from "./shore.js";

const EXTRAS_FOLDER = "data/lakes/extras";
const REPORT_ROUTES_FILE = "data/report_routes.json";
// EPA's lake outlines (the same ones the scripts use), one lake per request
const OUTLINE_URL = "https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services/waterbodies_9/FeatureServer/0/query";

const RAIN_CODE = "00045";
const FLOW_CODE = "00060";
// Rain gauges count within this distance (decided Oct 13), river gauges
// only within the closer one: a river gauge farther away is often a
// different, much bigger river or below a dam (decided Oct 20)
const RUNOFF_MAX_KM = 25;
const FLOW_MAX_KM = 10;
const RAIN_HOURS = 48;
// A rain total only counts if the record covers (nearly) all 48 hours and is
// up to date, so a gauge that stopped sending can't look like "no rain"
const RAIN_COVERS_HOURS = 40;
const RAIN_NEWEST_HOURS = 6;
// A river reading must be from the last day (like the stations' 24-hour rule)
const FLOW_NEWEST_HOURS = 24;

// Ask for the outline only when the GPS point could be at the lake: within
// twice its rough radius + 1 km of its middle (reservoirs are long), or
// within 4 km of a big lake's shore points (they're 5 km apart)
const NEAR_EXTRA_KM = 1;
const NEAR_SHORE_POINT_KM = 4;

// The numbers are kept this long, so reopening a card asks nobody again
// (USGS allows about 1,000 requests an hour without a key)
const CACHE_MINUTES = 15;

const HOUR_MS = 1000 * 60 * 60;

const stateFiles = {};   // "NC" → the promise of data/lakes/extras/NC.json
const cache = {};        // lake id (a big lake: id@spot) → { time, promise }
const outlines = {};     // lake id → the promise of its outline
let reportRoutes = null; // the promise of data/report_routes.json

// Everything for one lake card: { wind, rain, flow, level, beaches, spot }.
// place = the user's chosen place or null; only a GPS place gets a spot.
export async function fetchLakeExtras(lake, place) {
  // A big lake: the part closest to the user's place (null without a place)
  const near = lake.shore && place ? closestPointOfLake(lake, place) : null;
  const [shared, spot] = await Promise.all([sharedExtras(lake, near), spotFor(lake, place)]);

  // Beaches nearest the place first, so "Go here instead" picks a close one
  let beaches = shared.beaches;
  if (place && beaches.status === "ok") {
    const list = beaches.list
      .map(beach => ({ ...beach, km: distanceKm(place, beach) }))
      .sort((a, b) => a.km - b.km);
    beaches = { ...beaches, list };
  }
  return { ...shared, beaches, spot, bigLake: Boolean(lake.shore), nearYou: near !== null };
}

// Everything but the user's spot, kept for 15 minutes (like nearby.js): per
// lake, or for a big lake per part of its shore
function sharedExtras(lake, near) {
  const key = near ? `${lake.id}@${near.lat},${near.lng}` : String(lake.id);
  const saved = cache[key];
  if (saved && Date.now() - saved.time < CACHE_MINUTES * 60 * 1000) {
    return saved.promise;
  }
  const promise = loadShared(lake, near);
  cache[key] = { time: Date.now(), promise };
  // If anything couldn't load, ask again next time instead of in 15 minutes
  promise.then(result => {
    const parts = [result.rain, result.flow, result.level, result.beaches];
    if (result.wind === null || parts.some(part => part.status === "failed")) {
      delete cache[key];
    }
  });
  return promise;
}

async function loadShared(lake, near) {
  const windAt = near ?? lake;
  const [info, wind] = await Promise.all([
    lakeInfo(lake, near).catch(error => {
      console.error("Failed to load the lake's gauges and beaches", error);
      return null;
    }),
    fetchWind(windAt.lat, windAt.lng).catch(error => {
      console.error("Failed to load wind", error);
      return null;
    })
  ]);
  if (info === null) {
    const failed = { status: "failed" };
    return { wind, rain: failed, flow: failed, level: failed, beaches: failed };
  }

  const { level, rain, flow } = info;
  if (rain === NEED_PLACE || flow === NEED_PLACE) {
    // A big lake and no place: only its lake level can be checked
    const [readings, levelNormals] = await Promise.all([recentReadings({ level }), level ? normalsFor(level) : null]);
    return { wind, rain: { status: "need-place" }, flow: { status: "need-place" },
             level: levelResult(level, readings, levelNormals), beaches: info.beaches };
  }
  const [readings, levelNormals, flowNormals] = await Promise.all([
    recentReadings(info),
    level && level.id !== flow?.id ? normalsFor(level) : null,
    flow ? normalsFor(flow) : null
  ]);

  return {
    wind,
    rain: rainResult(rain, readings),
    flow: flowResult(flow, readings, flowNormals),
    level: levelResult(level, readings, level?.id === flow?.id ? flowNormals : levelNormals),
    beaches: info.beaches
  };
}

// A big lake's rain and river gauges when there's no place to look near
const NEED_PLACE = "need-place";

// The lake's gauges and beaches from its state's file:
// { level, rain, flow (each { id, name, km, from, levelCodes }, null or
// NEED_PLACE), beaches }. km is from the lake's shore, or for a big lake
// from the part closest to the user (from: "you").
async function lakeInfo(lake, near) {
  const file = await stateFile(lake.state);
  const row = file.lakes[lake.id] ?? null;
  const gauge = (id, km, from = "lake") => {
    if (!id) return null;
    const [name, lat, lng, levelCodes] = file.gauges[id];
    return { id, name, lat, lng, km, from, levelCodes: levelCodes ? levelCodes.split(",") : [] };
  };
  // A big lake: the nearest of its shore gauges to the user's part of it,
  // within maxKm (like Python's min() with a key)
  const nearest = (ids, maxKm) => {
    if (!near) return NEED_PLACE;
    let best = null;
    for (const id of ids) {
      const [, lat, lng] = file.gauges[id];
      const km = distanceKm(near, { lat, lng });
      if (km <= maxKm && (best === null || km < best.km)) best = { id, km };
    }
    return best ? gauge(best.id, best.km, "you") : null;
  };
  const shoreGauges = row?.[7] ?? null;

  // beaches: null = not looked up yet, [] = none mapped (no row = none too,
  // unless the lake is on the "not looked up yet" list)
  const list = row ? row[6] : file.beachesNotLookedUp.includes(lake.id) ? null : [];
  let beaches;
  if (list === null) {
    beaches = { status: "not-looked-up" };
  } else if (list.length === 0) {
    beaches = { status: "none" };
  } else {
    beaches = { status: "ok", list: list.map(b => Object.fromEntries(file.beachFields.map((f, i) => [f, b[i]]))) };
  }

  return {
    level: row ? gauge(row[0], row[1]) : null,
    rain: shoreGauges ? nearest(shoreGauges[0], RUNOFF_MAX_KM) : row ? gauge(row[2], row[3]) : null,
    flow: shoreGauges ? nearest(shoreGauges[1], FLOW_MAX_KM)
      : row && row[5] <= FLOW_MAX_KM ? gauge(row[4], row[5]) : null,
    beaches
  };
}

// One file per state, loaded once (the browser keeps it too)
function stateFile(state) {
  if (!stateFiles[state]) {
    stateFiles[state] = getJson(`${EXTRAS_FOLDER}/${state}.json`);
    // If it fails, try again next time
    stateFiles[state].catch(() => {
      delete stateFiles[state];
    });
  }
  return stateFiles[state];
}

// Each state's official way to report a bloom: { NC: [agency, route type,
// url, true if it's for fresh water], ... }, or null if it can't load
export function fetchReportRoutes() {
  if (reportRoutes === null) {
    reportRoutes = getJson(REPORT_ROUTES_FILE).catch(error => {
      console.error("Failed to load the report routes", error);
      reportRoutes = null;
      return null;
    });
  }
  return reportRoutes;
}

async function getJson(file) {
  const response = await fetch(file);
  if (!response.ok) {
    throw new Error(`${file} request failed (HTTP ${response.status})`);
  }
  return response.json();
}

// --- Rain, river flow and lake level ---

// One USGS request for every reading of the lake's gauges in the last 48
// hours, or null if it fails. {} if the lake has no gauges (no request).
async function recentReadings({ level, rain, flow }) {
  const ids = [...new Set([level?.id, rain?.id, flow?.id].filter(id => id))];
  if (ids.length === 0) return {};
  const codes = [...new Set([
    ...(rain ? [RAIN_CODE] : []),
    ...(flow ? [FLOW_CODE] : []),
    ...(level ? level.levelCodes : [])
  ])];
  try {
    return await fetchRecentReadings(ids, codes, RAIN_HOURS);
  } catch (error) {
    console.error("Failed to load the lake's gauge readings", error);
    return null;
  }
}

async function normalsFor(gauge) {
  try {
    return await fetchDailyPercentiles(gauge.id);
  } catch (error) {
    console.error("Failed to load the usual range at", gauge.id, error);
    return null;
  }
}

// { status: "ok", inches, gauge }, or status "none" (no gauge within 25 km),
// "failed" (couldn't load) or "no-recent" (no complete 48-hour record)
function rainResult(gauge, readings) {
  if (!gauge) return { status: "none" };
  if (readings === null) return { status: "failed", gauge };
  const list = readings[gauge.id]?.[RAIN_CODE] ?? [];
  if (list.length === 0) return { status: "no-recent", gauge };

  const newest = list[list.length - 1].time;
  const covers = (new Date(newest) - new Date(list[0].time)) / HOUR_MS;
  if (hoursAgo(newest) > RAIN_NEWEST_HOURS || covers < RAIN_COVERS_HOURS) {
    return { status: "no-recent", gauge };
  }
  // Rain comes as the amount in each interval, so add them up (like fetchRainTotal)
  const inches = list.filter(r => r.value >= 0).reduce((total, r) => total + r.value, 0);
  return { status: "ok", inches, gauge };
}

// { status: "ok", cfs, percentiles, gauge }, or "none", "failed",
// "no-recent" (nothing in the last day) or "no-normals" (no usual range)
function flowResult(gauge, readings, normals) {
  if (!gauge) return { status: "none" };
  if (readings === null) return { status: "failed", gauge };
  const list = readings[gauge.id]?.[FLOW_CODE] ?? [];
  if (list.length === 0 || hoursAgo(list[list.length - 1].time) > FLOW_NEWEST_HOURS) {
    return { status: "no-recent", gauge };
  }
  if (normals === null) return { status: "failed", gauge };
  const percentiles = normals[FLOW_CODE];
  if (!hasRange(percentiles)) return { status: "no-normals", gauge };
  return { status: "ok", cfs: list[list.length - 1].value, percentiles, gauge };
}

// The newest lake level from the first of the gauge's level codes (best
// first) that has both a reading and a usual range for this date
function levelResult(gauge, readings, normals) {
  if (!gauge) return { status: "none" };
  if (readings === null) return { status: "failed", gauge };
  const withData = gauge.levelCodes.filter(code => (readings[gauge.id]?.[code] ?? []).length > 0);
  if (withData.length === 0) return { status: "no-recent", gauge };
  const newestOf = code => {
    const list = readings[gauge.id][code];
    return list[list.length - 1].value;
  };
  if (normals === null) return { status: "failed", gauge };

  const code = withData.find(c => hasRange(normals[c]));
  if (!code) return { status: "no-normals", feet: newestOf(withData[0]), gauge };
  return { status: "ok", feet: newestOf(code), code, percentiles: normals[code], gauge };
}

// A usual range needs the 25th, 75th and 90th percentiles
function hasRange(percentiles) {
  return Boolean(percentiles) && ["p25", "p75", "p90"].every(p => typeof percentiles[p] === "number");
}

function hoursAgo(isoTime) {
  return (Date.now() - new Date(isoTime).getTime()) / HOUR_MS;
}

// --- The user's spot (GPS only) ---

// null unless the GPS point may be at this lake; then the shoreSpot()
// answer, or { status: "failed" } if the outline couldn't load
async function spotFor(lake, place) {
  if (!place || place.source !== "gps" || !mayBeAt(lake, place)) return null;
  try {
    return shoreSpot(place, await outline(lake.id));
  } catch (error) {
    console.error("Failed to load the lake's outline", error);
    return { status: "failed" };
  }
}

function mayBeAt(lake, place) {
  if (lake.shore) {
    return distanceKm(place, closestPointOfLake(lake, place)) <= NEAR_SHORE_POINT_KM;
  }
  const roughRadiusKm = Math.sqrt(lake.km2 / Math.PI);
  return distanceKm(place, lake) <= 2 * roughRadiusKm + NEAR_EXTRA_KM;
}

// The lake's outline from EPA: a list of rings, each a list of [lng, lat]
function outline(lakeId) {
  if (!outlines[lakeId]) {
    const query = new URLSearchParams({
      where: `OBJECTID=${lakeId}`,
      returnGeometry: "true",
      outSR: "4326",                 // longitude and latitude in degrees
      maxAllowableOffset: "0.0003",  // simplified to about 30 m, so it stays small
      geometryPrecision: "5",
      f: "json"
    });
    outlines[lakeId] = getJson(`${OUTLINE_URL}?${query}`).then(data => {
      const rings = data.features?.[0]?.geometry?.rings;
      if (!rings) throw new Error("EPA sent no outline for this lake");
      return rings;
    });
    outlines[lakeId].catch(() => {
      delete outlines[lakeId];
    });
  }
  return outlines[lakeId];
}
