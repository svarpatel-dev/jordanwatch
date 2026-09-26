// The risk engine: turns readings into a risk level.
// Knows nothing about USGS or the page. It just takes readings and returns a verdict.

// How old is a reading, and what should we tell the user?
// <3h = current, 3-24h = outdated (show with a warning), >24h = stale
// (too old to trust — no badge should be shown).
function getStaleness(timestampString) {
  const readingTime = new Date(timestampString);
  const ageMs = Date.now() - readingTime.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  let status;
  if (ageHours < 3) status = "current";
  else if (ageHours < 24) status = "outdated";
  else status = "stale";

  return { status, ageHours };
}

// Thresholds sourced from NC DEQ's Jordan Lake water quality standards
// (chlorophyll a >40 µg/L, turbidity >25 NTU, DO <4 mg/L, pH >9 or <6
// count as exceeding state standards). DEQ doesn't define a middle
// "Caution" tier, so the caution band below is our own reasonable
// interpolation between "clearly fine" and the DEQ exceedance line —
// not itself an official number. Worth saying so in the app.
export function computeRisk(readings) {
  const doReading = readings.doMgL;
  const turbReading = readings.turbidityFnu;
  const phReading = readings.ph;

  if (!doReading || !turbReading) {
    return { level: "no-data", reason: "Missing DO or turbidity reading." };
  }

  // --- Staleness gate: check BEFORE trusting any number ---
  const doStale = getStaleness(doReading.timestamp);
  const turbStale = getStaleness(turbReading.timestamp);

  if (doStale.status === "stale" || turbStale.status === "stale") {
    return { level: "no-data", reason: "Most recent reading is over 24 hours old." };
  }

  const isOutdated = doStale.status === "outdated" || turbStale.status === "outdated";

  const doVal = doReading.value;
  const turbVal = turbReading.value;
  const phVal = phReading ? phReading.value : null;

  const doExceeds = doVal < 4.0;
  const turbExceeds = turbVal > 25;
  const phExceeds = phVal !== null && (phVal > 9 || phVal < 6);

  if (doExceeds || turbExceeds || phExceeds) {
    const reasons = [];
    if (doExceeds) reasons.push("DO below NC standard (4 mg/L)");
    if (turbExceeds) reasons.push("turbidity above NC standard (25 NTU)");
    if (phExceeds) reasons.push("pH outside NC standard (6–9)");
    return { level: "high", reason: reasons.join(", "), isOutdated };
  }

  const doCaution = doVal <= 6.0;
  const turbCaution = turbVal >= 15;
  const phCaution = phVal !== null && (phVal > 8.5 || phVal < 6.5);

  if (doCaution || turbCaution || phCaution) {
    return { level: "caution", reason: "Approaching NC water quality standards.", isOutdated };
  }

  return { level: "safe", reason: null, isOutdated };
}
