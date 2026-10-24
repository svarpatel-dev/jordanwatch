// Everything that talks to the USGS water data API: fetching a station's
// latest readings and pulling out the ones we use.
// Moved Oct 5 to api.waterdata.usgs.gov, because USGS is shutting down the
// old waterservices.usgs.gov (outages from January 2027, gone Feb 22, 2027).
// The data collections use version 1 of the new API (same replies as v0,
// whose own "next page" links already point to v1); the normals still live
// under statistics/v0, since statistics/v1 doesn't exist yet (checked Oct 24).

// USGS parameter codes → our names for them
const PARAMS = {
  "00010": "tempC",
  "00300": "doMgL",
  "00400": "ph",
  "63680": "turbidityFnu",  // turbidity in FNU (formazin nephelometric units)
  "00060": "flowCfs",       // streamflow, cubic feet per second
  "62614": "lakeLevelFt"    // lake surface elevation, feet above NGVD 1929
};

// "continuous" = USGS's live sensor readings (every 5–15 minutes)
const API_URL = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items";

// "observationNormals" = what's typical for each date, from past years
const NORMALS_URL = "https://api.waterdata.usgs.gov/statistics/v0/observationNormals";

// "latest-continuous" = only the newest reading of each sensor. With a box
// (bbox) it covers every station inside it in one request (tested Oct 8).
const LATEST_URL = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items";

// "monitoring-locations" = each station's name, state and site type
const LOCATIONS_URL = "https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items";

// Many small lakes report their level above a newer sea-level datum (NAVD
// 1988, code 62615) instead of 62614. Only used for stations near the user:
// Jordan Lake's dam keeps 62614, the datum its 216 ft normal pool is in.
const LAKE_LEVEL_NAVD88 = "62615";

// USGS's old "no data" marker; kept as a safety check (bug 2)
const NO_DATA = -999999;

export async function fetchStationData(stationId) {
  // One request for the last day (P1D) of every parameter we use.
  // limit is high so a whole day of 5-minute readings fits in one reply.
  const query = new URLSearchParams({
    f: "json",
    monitoring_location_id: `USGS-${stationId}`,
    parameter_code: Object.keys(PARAMS).join(","),
    time: "P1D",
    limit: "10000"
  });
  return fetchUsgs(`${API_URL}?${query}`);
}

// Total rain (inches) at a station over the last `hours` hours. USGS
// reports rain (code 00045) as the amount in each 15-minute interval,
// so we add them up. Returns null if the station sent no rain data.
export async function fetchRainTotal(stationId, hours) {
  const query = new URLSearchParams({
    f: "json",
    monitoring_location_id: `USGS-${stationId}`,
    parameter_code: "00045",
    time: `PT${hours}H`,
    limit: "10000"
  });
  const data = await fetchUsgs(`${API_URL}?${query}`);

  const amounts = (data.features ?? [])
    .map(f => parseFloat(f.properties.value))
    .filter(num => !Number.isNaN(num) && num >= 0);

  if (amounts.length === 0) return null;
  return amounts.reduce((total, num) => total + num, 0);
}

// Today's normal flow range at a station, from past years' daily averages:
// e.g. { p25: 124.5, p50: 229, p75: 444.5, p90: 1640 } in cubic ft/sec.
// Returns null if USGS has no normals for this station.
export async function fetchFlowPercentiles(stationId) {
  // Today's date as "MM-DD", e.g. "10-06"
  const today = new Date();
  const monthDay = String(today.getMonth() + 1).padStart(2, "0") + "-"
                 + String(today.getDate()).padStart(2, "0");

  const query = new URLSearchParams({
    monitoring_location_id: `USGS-${stationId}`,
    parameter_code: "00060",
    normal_type: "DOY",   // DOY = "day of year"
    start_date: monthDay,
    end_date: monthDay
  });
  const data = await fetchUsgs(`${NORMALS_URL}?${query}`);

  // Find the percentiles of the daily mean flow (statistic code 00003)
  for (const feature of data.features ?? []) {
    for (const series of feature.properties.data ?? []) {
      if (series.parameter_code !== "00060" || series.parent_statistic_id !== "00003") continue;

      const record = series.values.find(v => v.computation === "percentile");
      if (!record) continue;

      // Pair up ["25", "50", ...] with ["124.5", "229.0", ...]
      const percentiles = {};
      record.percentiles.forEach((p, i) => {
        percentiles[`p${p}`] = parseFloat(record.values[i]);
      });
      return percentiles;
    }
  }
  return null;
}

// The newest readings of every station inside a box ([west, south, east,
// north] in degrees), in one request. USGS leaves out sensors with nothing
// in the last 7 days (time=P7D), so long-dead gauges don't show up.
// Returns [{ id: "USGS-02096960", lat, lng, readings }], with the same
// readings as extractAllReadings.
export async function fetchLatestInBox(box) {
  const query = new URLSearchParams({
    f: "json",
    bbox: box.join(","),
    parameter_code: [...Object.keys(PARAMS), LAKE_LEVEL_NAVD88].join(","),
    time: "P7D",
    limit: "10000"   // one row per sensor: far more than any box near a place holds
  });
  const data = await fetchUsgs(`${LATEST_URL}?${query}`);

  // Group the rows by station, like a Python dict of lists:
  // { "USGS-02096960": [row, row, ...], ... }
  const rowsByStation = {};
  for (const feature of data.features ?? []) {
    if (!feature.geometry) continue;   // no location, so it can't be placed
    const id = feature.properties.monitoring_location_id;
    rowsByStation[id] = rowsByStation[id] ?? [];
    rowsByStation[id].push(feature);
  }

  return Object.entries(rowsByStation).map(([id, features]) => {
    const readings = extractAllReadings({ features });
    // A lake that only reports the newer datum still gets a lake level
    if (!readings.lakeLevelFt) {
      readings.lakeLevelFt = findReading(features, LAKE_LEVEL_NAVD88);
    }
    // GeoJSON points are [longitude, latitude]: longitude comes first
    const [lng, lat] = features[0].geometry.coordinates;
    return { id, lat, lng, readings };
  });
}

// The name, state and site type ("ST" stream, "LK" lake, ...) of each
// station in a list of ids, in one request.
// Returns { "USGS-02096960": { name, state, siteType }, ... }
export async function fetchStationInfo(ids) {
  const query = new URLSearchParams({
    f: "json",
    id: ids.join(","),
    properties: "monitoring_location_name,state_name,site_type_code",
    limit: "10000"
  });
  const data = await fetchUsgs(`${LOCATIONS_URL}?${query}`);

  const info = {};
  for (const feature of data.features ?? []) {
    const p = feature.properties;
    info[feature.id] = { name: p.monitoring_location_name, state: p.state_name, siteType: p.site_type_code };
  }
  return info;
}

// Every reading of some parameters at a few stations over the last `hours`
// hours, in one request (a lake card's rain, river and lake-level gauges,
// decided Oct 13). Returns { "02098197": { "62614": [{ value, time }, ...] } },
// oldest first, without values that aren't real numbers (bug 2).
export async function fetchRecentReadings(stationIds, parameterCodes, hours) {
  const query = new URLSearchParams({
    f: "json",
    monitoring_location_id: stationIds.map(id => `USGS-${id}`).join(","),
    parameter_code: parameterCodes.join(","),
    time: `PT${hours}H`,
    properties: "monitoring_location_id,parameter_code,time,value",
    skipGeometry: "true",   // the lake card already knows where its gauges are
    limit: "10000"
  });
  const data = await fetchUsgs(`${API_URL}?${query}`);

  // Group by station, then by parameter, like a Python dict of dicts of lists
  const byStation = {};
  for (const feature of data.features ?? []) {
    const p = feature.properties;
    const value = parseFloat(p.value);
    if (Number.isNaN(value) || value === NO_DATA) continue;
    const id = p.monitoring_location_id.replace("USGS-", "");
    byStation[id] = byStation[id] ?? {};
    byStation[id][p.parameter_code] = byStation[id][p.parameter_code] ?? [];
    byStation[id][p.parameter_code].push({ value, time: p.time });
  }
  // Oldest first (ISO times sort correctly as text)
  for (const codes of Object.values(byStation)) {
    for (const readings of Object.values(codes)) {
      readings.sort((a, b) => (a.time < b.time ? -1 : 1));
    }
  }
  return byStation;
}

// Today's usual range of EVERY parameter a station has normals for, from
// past years' daily averages: { "62614": { p10, p25, p50, p75, p90 },
// "00060": { ... } }. Like fetchFlowPercentiles, but without picking a
// parameter, so a lake gauge's best level parameter can be chosen after.
// USGS's normals take one station per request.
export async function fetchDailyPercentiles(stationId) {
  const today = new Date();
  const monthDay = String(today.getMonth() + 1).padStart(2, "0") + "-"
                 + String(today.getDate()).padStart(2, "0");
  const query = new URLSearchParams({
    monitoring_location_id: `USGS-${stationId}`,
    normal_type: "DOY",
    start_date: monthDay,
    end_date: monthDay
  });
  const data = await fetchUsgs(`${NORMALS_URL}?${query}`);

  const byParameter = {};
  for (const feature of data.features ?? []) {
    for (const series of feature.properties.data ?? []) {
      // Percentiles of the daily mean (statistic code 00003) only
      if (series.parent_statistic_id !== "00003") continue;
      const record = series.values.find(v => v.computation === "percentile");
      if (!record) continue;
      const percentiles = {};
      record.percentiles.forEach((p, i) => {
        // "nan" (not enough years for that percentile) is left out
        const value = parseFloat(record.values[i]);
        if (!Number.isNaN(value)) percentiles[`p${p}`] = value;
      });
      byParameter[series.parameter_code] = percentiles;
    }
  }
  return byParameter;
}

// Every USGS request goes through here: one retry on temporary errors,
// and a clear error for anything else.
async function fetchUsgs(url) {
  let response = await fetch(url);

  // Bug 7 fix: USGS sometimes returns a temporary 502/503/504 for a few
  // seconds. Wait 2 seconds and try once more before giving up.
  if ([502, 503, 504].includes(response.status)) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    response = await fetch(url);
  }

  // 429 = too many requests from this network in the last hour
  if (response.status === 429) {
    throw new Error("USGS is limiting requests right now (HTTP 429). Try again in a few minutes.");
  }

  // Bug 3 fix: fetch() only fails on network errors. A 404 or 500 still
  // "succeeds", so we have to check the status ourselves.
  if (!response.ok) {
    throw new Error(`USGS returned an error (HTTP ${response.status}).`);
  }

  const data = await response.json();
  return data;
}

// The newest valid reading for one parameter, or null if there isn't one.
function findReading(features, paramCode) {
  // Each feature is one reading; its details are in .properties.
  // The API sends values as text ("7.9"), so convert and drop anything
  // that isn't a real number (bug 2).
  const values = features
    .map(f => f.properties)
    .filter(p => p.parameter_code === paramCode)
    .filter(p => {
      const num = parseFloat(p.value);
      return !Number.isNaN(num) && num !== NO_DATA;
    });

  // Bug 1 fix: if nothing is left, there is no reading. Return null
  // instead of crashing on an empty list.
  if (values.length === 0) return null;

  // Find the newest reading ourselves instead of trusting the order.
  // The times are ISO text ("2026-10-05T23:45:00+00:00"), which sorts
  // correctly when compared as text.
  let latest = values[0];
  for (const v of values) {
    if (v.time > latest.time) latest = v;
  }

  return {
    value: parseFloat(latest.value),
    timestamp: latest.time
  };
}

export function extractAllReadings(data) {
  const features = data.features ?? [];
  const readings = {};

  for (const code in PARAMS) {
    const key = PARAMS[code];
    readings[key] = findReading(features, code);
  }

  return readings;
}
