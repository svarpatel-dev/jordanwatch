// Station helpers: how old a reading is, and what a "limited" station
// (flow or lake level only) shows. Knows nothing about USGS or the page.
// Stations with water quality sensors are judged in nearby.js.

// How old is a reading, and what should we tell the user?
// <3h = current, 3-24h = outdated (show with a warning), >24h = stale
// (too old to trust — no badge should be shown).
export function getStaleness(timestampString) {
  const readingTime = new Date(timestampString);
  const ageMs = Date.now() - readingTime.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  let status;
  if (ageHours < 3) status = "current";
  else if (ageHours < 24) status = "outdated";
  else status = "stale";

  return { status, ageHours };
}

// The result for a "limited" station (flow or lake level only, no water
// quality sensors): no risk rating, just today's flow vs. normal.
// flowNormal is the station's normal flow range for today (from USGS), or
// null. Full and partial stations are judged by their state's standards
// instead (judgeStation in nearby.js, decided Oct 18).
export function describeLimitedStation(readings, flowNormal = null) {
  return {
    level: "limited",
    reason: "This station measures water flow or lake level, not water quality, so it can't give a risk rating.",
    flowStatus: describeFlow(readings.flowCfs, flowNormal)
  };
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
