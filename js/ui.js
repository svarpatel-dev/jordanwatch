// Everything that draws on the page.
// Takes results from the other files and shows them; does no data work itself.

const RISK_LABELS = {
  safe: "🟢 Low Risk",
  caution: "🟡 Caution",
  high: "🔴 High Risk",
  "no-data": "⚪ No Data Available"
};

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
  statusEl.innerHTML = `
    <strong>${station.name}</strong> (USGS ${station.id})<br>
    <strong>${RISK_LABELS[risk.level]}</strong>
    ${risk.isOutdated ? '<br><em>⚠️ Reading is 3–24h old</em>' : ''}
    <br><br>
    Temp: ${readings.tempC ? readings.tempC.value + "°C" : "—"}<br>
    DO: ${readings.doMgL ? readings.doMgL.value + " mg/L" : "—"}<br>
    pH: ${readings.ph ? readings.ph.value : "—"}<br>
    Turbidity: ${readings.turbidityFnu ? readings.turbidityFnu.value + " FNU" : "—"}
  `;
}
