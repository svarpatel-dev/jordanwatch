// Everything that talks to the USGS Water Services API:
// fetching a station's data and pulling out the readings we use.

// USGS parameter codes → our names for them
const PARAMS = {
  "00010": "tempC",
  "00300": "doMgL",
  "00400": "ph",
  "63680": "turbidityFnu"
};

export async function fetchStationData(stationId) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${stationId}&period=P1D`;
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

function findReading(series, paramCode) {
  const match = series.find(ts => ts.variable.variableCode[0].value === paramCode);
  if (!match) return null;

  const values = match.values[0].value;
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
