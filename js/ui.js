// Everything that draws on the page.
// Takes results from the other files and shows them; does no data work itself.

const RISK_LABELS = {
  safe: "🟢 Low Risk",
  caution: "🟡 Caution",
  high: "🔴 High Risk",
  "no-data": "⚪ No Data Available"
};

export function showResult(risk, readings) {
  const statusEl = document.getElementById("status");
  statusEl.innerHTML = `
    <strong>${RISK_LABELS[risk.level]}</strong>
    ${risk.isOutdated ? '<br><em>⚠️ Reading is 3–24h old</em>' : ''}
    <br><br>
    Temp: ${readings.tempC ? readings.tempC.value + "°C" : "—"}<br>
    DO: ${readings.doMgL ? readings.doMgL.value + " mg/L" : "—"}<br>
    pH: ${readings.ph ? readings.ph.value : "—"}<br>
    Turbidity: ${readings.turbidityFnu ? readings.turbidityFnu.value + " FNU" : "—"}
  `;
}
