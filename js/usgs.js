// Everything that talks to the USGS Water Services API:
// fetching a station's data and pulling out the readings we use.

// USGS parameter codes → our names for them
const PARAMS = {
  "00010": "tempC",
  "00300": "doMgL",
  "00400": "ph",
  "63680": "turbidityFnu",  // turbidity in FNU (formazin nephelometric units)
  "00060": "flowCfs",       // streamflow, cubic feet per second
  "62614": "lakeLevelFt"    // lake surface elevation, feet above NGVD 1929
};

export async function fetchStationData(stationId) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${stationId}&period=P1D`;
  let response = await fetch(url);

  // Bug 7 fix: USGS sometimes returns a temporary 502/503/504 for a few
  // seconds. Wait 2 seconds and try once more before giving up.
  if ([502, 503, 504].includes(response.status)) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    response = await fetch(url);
  }

  // Bug 3 fix: fetch() only fails on network errors. A 404 or 500 still
  // "succeeds", so we have to check the status ourselves.
  if (!response.ok) {
    throw new Error(`USGS returned an error (HTTP ${response.status}).`);
  }

  const data = await response.json();
  return data;
}

function findReading(series, paramCode) {
  const match = series.find(ts => ts.variable.variableCode[0].value === paramCode);
  if (!match) return null;

  // Bug 2 fix: USGS marks missing values with a "no data" number (-999999).
  // Drop those, and anything that isn't a number, before picking the latest.
  const noDataValue = match.variable.noDataValue;
  const rawValues = match.values[0]?.value ?? [];
  const values = rawValues.filter(v => {
    const num = parseFloat(v.value);
    return !Number.isNaN(num) && num !== noDataValue;
  });

  // Bug 1 fix: if nothing is left, there is no reading. Return null
  // instead of crashing on an empty list.
  if (values.length === 0) return null;

  const latest = values[values.length - 1];
  return {
    value: parseFloat(latest.value),
    timestamp: latest.dateTime
  };
}

export function extractAllReadings(data) {
  const series = data.value.timeSeries;
  const readings = {};

  for (const code in PARAMS) {
    const key = PARAMS[code];
    readings[key] = findReading(series, code);
  }

  return readings;
}
