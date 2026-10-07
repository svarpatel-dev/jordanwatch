// The risk engine: turns readings into a risk level.
// Knows nothing about USGS or the page. It takes readings plus the
// station's tier ("full", "partial" or "limited") and returns a verdict.

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

// Picks the right rules for the station's tier. flowNormal is the
// station's normal flow range for today (from USGS), or null.
export function computeRisk(readings, tier, flowNormal = null) {
  if (tier === "limited") {
    return {
      level: "limited",
      reason: "This station measures water flow or lake level, not water quality, so it can't give a risk rating.",
      flowStatus: describeFlow(readings.flowCfs, flowNormal)
    };
  }
  if (tier === "partial") return computePartialRisk(readings);
  return computeFullRisk(readings);
}

// Thresholds sourced from NC DEQ's Jordan Lake water quality standards
// (chlorophyll a >40 µg/L, turbidity >25 NTU, DO <4 mg/L, pH >9 or <6
// count as exceeding state standards). DEQ's turbidity standard is written
// in NTU; the USGS sensors we use report FNU, a closely related unit, and we
// compare the FNU reading to the NTU number directly. DEQ doesn't define a
// middle "Caution" tier, so the caution band below is our own reasonable
// interpolation between "clearly fine" and the DEQ exceedance line —
// not itself an official number. Worth saying so in the app.
function computeFullRisk(readings) {
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
    if (turbExceeds) reasons.push("turbidity above NC standard (25)");
    if (phExceeds) reasons.push("pH outside NC standard (6–9)");
    return { level: "high", reason: reasons.join(", "), isOutdated };
  }

  const doCaution = doVal <= 6.0;
  const turbCaution = turbVal >= 15;
  const phCaution = phVal !== null && (phVal > 8.5 || phVal < 6.5);

  if (doCaution || turbCaution || phCaution) {
    return { level: "caution", reason: "Approaching NC water quality standards.", isOutdated };
  }

  return { level: "low", reason: "All readings are within NC water quality standards.", isOutdated };
}

// Compares today's flow with the station's normal range for this date
// (decided Oct 5, question 4). e.g. "below normal for this date (usual
// range: 124–445 cubic ft/sec)". Returns null if either piece is missing.
function describeFlow(flowReading, normal) {
  if (!flowReading || !normal) return null;

  const flow = flowReading.value;
  let status;
  if (flow > normal.p90) status = "well above normal";
  else if (flow > normal.p75) status = "above normal";
  else if (flow < normal.p25) status = "below normal";
  else status = "near normal";

  return `${status} for this date (usual range: ${formatFlow(normal.p25)}–${formatFlow(normal.p75)} cubic ft/sec)`;
}

// Small creeks have tiny flows, so keep one decimal under 10:
// 0.18 → "0.2", 444.5 → "445", 1640 → "1,640"
function formatFlow(cfs) {
  return cfs < 10 ? cfs.toFixed(1) : Math.round(cfs).toLocaleString();
}

// For stations with live DO + pH but no turbidity (decided Sept 27).
// Without turbidity we can't confirm low risk, so the baseline is Caution.
function computePartialRisk(readings) {
  const doReading = readings.doMgL;
  const phReading = readings.ph;

  if (!doReading) {
    return { level: "no-data", reason: "Missing DO reading." };
  }

  const doStale = getStaleness(doReading.timestamp);
  if (doStale.status === "stale") {
    return { level: "no-data", reason: "Most recent reading is over 24 hours old." };
  }

  const isOutdated = doStale.status === "outdated";

  const doVal = doReading.value;
  const phVal = phReading ? phReading.value : null;

  const doExceeds = doVal < 4.0;
  const phExceeds = phVal !== null && (phVal > 9 || phVal < 6);

  if (doExceeds || phExceeds) {
    const reasons = [];
    if (doExceeds) reasons.push("DO below NC standard (4 mg/L)");
    if (phExceeds) reasons.push("pH outside NC standard (6–9)");
    return { level: "high", reason: reasons.join(", "), isOutdated };
  }

  return {
    level: "caution",
    reason: "DO and pH are within NC standards, but turbidity isn't measured here.",
    note: "Turbidity isn't measured at this station, so JordanWatch can't confirm low risk. Caution is shown as a precaution, not because the water is known to be dangerous.",
    isOutdated
  };
}
