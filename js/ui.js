// Everything that draws on the page.
// Takes results from the other files and shows them; does no data work itself.

const RISK_LABELS = {
  low: "🟢 Low Risk",
  caution: "🟡 Caution",
  high: "🔴 High Risk",
  limited: "🔵 Limited Data Available",
  "no-data": "⚪ No Data Available"
};

// How to show each reading, in display order. Readings a station
// doesn't have are skipped.
const READING_DISPLAY = [
  { key: "tempC", label: "Temp", unit: "°C" },
  { key: "doMgL", label: "DO", unit: " mg/L" },
  { key: "ph", label: "pH", unit: "" },
  { key: "turbidityFnu", label: "Turbidity", unit: " FNU" },
  { key: "flowCfs", label: "Flow", unit: " cubic ft/sec" },
  { key: "lakeLevelFt", label: "Lake level", unit: " ft above sea level" }
];

// Headings for the groups in the station dropdown, in display order
const TIER_LABELS = {
  full: "Full data",
  partial: "Partial data",
  limited: "Limited data (Jordan Lake area)"
};

// Builds the dropdown's options from the STATIONS list, grouped by tier.
export function fillStationPicker(stations) {
  const picker = document.getElementById("station-picker");

  for (const tier in TIER_LABELS) {
    const group = document.createElement("optgroup");
    group.label = TIER_LABELS[tier];

    for (const station of stations.filter(s => s.tier === tier)) {
      const option = document.createElement("option");
      option.value = station.id;
      option.textContent = station.name;
      group.appendChild(option);
    }

    picker.appendChild(group);
  }
}

// Shown while a station's data is being fetched.
export function showLoading(station) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = `Loading ${station.name}…`;
}

export function showResult(station, risk, readings) {
  const statusEl = document.getElementById("status");

  // One line per reading this station actually has
  const readingLines = READING_DISPLAY
    .filter(r => readings[r.key])
    .map(r => `${r.label}: ${readings[r.key].value}${r.unit}`)
    .join("<br>");

  // Time of the newest reading, e.g. "9/28/2026, 4:15 PM"
  const times = Object.values(readings)
    .filter(r => r)
    .map(r => new Date(r.timestamp).getTime());
  const latestTime = times.length > 0
    ? new Date(Math.max(...times)).toLocaleString()
    : null;

  statusEl.innerHTML = `
    <strong>${station.name}</strong> (USGS ${station.id})<br>
    <strong>${RISK_LABELS[risk.level]}</strong><br>
    ${risk.reason}
    ${risk.note ? `<br><em>ℹ️ ${risk.note}</em>` : ""}
    ${risk.isOutdated ? "<br><em>⚠️ Reading is 3–24h old</em>" : ""}
    <br><br>
    ${readingLines || "No recent readings from this station."}
    ${latestTime ? `<br><br><small>Latest reading: ${latestTime}</small>` : ""}
  `;
}

// Shown when loading a station fails (bug 4).
export function showError(station, message) {
  const statusEl = document.getElementById("status");
  statusEl.innerHTML = `
    <strong>${station.name}</strong> (USGS ${station.id})<br>
    ⚠️ Couldn't load data: ${message}<br>
    Try again in a few minutes.
  `;
}
