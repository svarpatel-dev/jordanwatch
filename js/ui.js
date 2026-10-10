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

// How to describe each kind of satellite estimate. CyAN makes daily
// estimates from single images and weekly ones that combine a week of images.
const FREQUENCY_LABELS = {
  Daily: "daily estimate",
  Weekly: "weekly estimate"
};

// Lake verdict labels (decided Oct 4: never "OK" or "Safe")
const VERDICT_LABELS = {
  avoid: "🔴 Avoid",
  caution: "🟡 Caution",
  low: "🟢 Low Risk"
};

// What to do at each verdict (decided Oct 5; based on CDC, NC DHHS and
// NC State Parks guidance)
const ACTIVITIES = {
  avoid: {
    suggested: "Picnics, trails, activities away from the water",
    notSuggested: "Swimming, wading, tubing, water skiing, boating or paddling, touching the water",
    pets: "Keep pets away from the water and shoreline",
    families: "Keep kids out of the water"
  },
  caution: {
    suggested: "Boating, kayaking, paddleboarding, fishing, shore activities",
    notSuggested: "Swimming or wading. Don't swallow lake water, and rinse off with tap water after any contact",
    pets: "Keep pets out of the water",
    families: "No swimming for kids today"
  },
  low: {
    suggested: "Swimming at designated beaches, boating, fishing",
    always: "Stay away from any scum or discolored water, and rinse off after swimming",
    pets: "Leashed only, and not on swim beaches (park rule)",
    families: "Low risk for families"
  }
};

// Extra line for areas without a recent satellite reading (decided Oct 5)
const NO_RECENT_SATELLITE = "No recent satellite reading here. Check the water yourself: if it looks green, scummy or smells bad, stay out.";

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
    ${risk.flowStatus ? `<br>Flow is ${risk.flowStatus}.` : ""}
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

// The Jordan Lake section: a summary line, then every area ranked best
// first. Each area is a <details> box: tap its name to open its card.
export function showLake(lake) {
  const lakeEl = document.getElementById("lake");

  // How many areas got each verdict, e.g. { avoid: 8, caution: 2, low: 0 }
  const counts = { avoid: 0, caution: 0, low: 0 };
  for (const area of lake.areas) {
    counts[area.level] += 1;
  }

  lakeEl.innerHTML = `
    <p><strong>Today at Jordan Lake:</strong>
      ${counts.avoid} Avoid · ${counts.caution} Caution · ${counts.low} Low Risk</p>
    <h3>Best spots today</h3>
    <p><small>Tap an area to see why and what to do.</small></p>
    ${lake.ranked.map(areaCard).join("")}
    ${intakeNote(lake.intake)}
    <p><small>Satellite estimates from EPA CyAN, last checked
      ${new Date(lake.checkedAt).toLocaleString()}. Not an official advisory.</small></p>
  `;
}

// One area's card: verdict, why, what to do, and where to go instead
function areaCard(area) {
  const activities = ACTIVITIES[area.level];
  const reasons = area.reasons.map(r => `<li>${r.text}</li>`).join("");

  const image = area.imageDate
    ? `Satellite image: ${area.imageDate} (${describeAge(area.imageAgeDays)}), ${FREQUENCY_LABELS[area.frequency] || "estimate"}`
    : "No satellite image";

  return `
    <details id="area-${area.id}">
      <summary><strong>${area.name}</strong>: ${VERDICT_LABELS[area.level]}</summary>
      <p><small>${area.swimBeach ? "🏖 Swim beach" : "No designated swim beach"} · ${image}</small></p>
      ${area.borrowedFrom ? `<p><em>No satellite coverage in this narrow arm, so the nearest reading (${area.borrowedFrom}) is shown.</em></p>` : ""}
      <p><strong>Why:</strong></p>
      <ul>${reasons}</ul>
      <p>
        <strong>Suggested:</strong> ${activities.suggested}<br>
        ${activities.notSuggested ? `<strong>Not suggested:</strong> ${activities.notSuggested}<br>` : ""}
        ${activities.always ? `<strong>Always:</strong> ${activities.always}<br>` : ""}
        🐕 ${activities.pets} · 👨‍👩‍👧 ${activities.families}
      </p>
      ${area.noRecentSatellite ? `<p><em>${NO_RECENT_SATELLITE}</em></p>` : ""}
      ${area.goInstead ? `<p>➡️ <strong>Go to ${area.goInstead.name} instead</strong> (${VERDICT_LABELS[area.goInstead.level]}${area.goInstead.swimBeach ? ", swim beach" : ""})</p>` : ""}
    </details>
  `;
}

// The drinking-water intake: context only, never a verdict (decided Oct 3)
function intakeNote(intake) {
  if (!intake || intake.status !== "ok") return "";

  // Below detection (bug 9 fix, Oct 10): say so instead of "about 0 cells/mL"
  const amount = intake.belowDetection
    ? "below detection (under about 6,500 cells/mL)"
    : `about ${intake.cellsPerMl.toLocaleString()} cells/mL`;

  return `
    <p><small>💧 Near the Cary/Apex drinking-water intake: ${amount}
      (satellite image ${intake.imageDate}).
      Context only: this water is treated before it reaches taps, so this is
      not a tap-water rating.</small></p>
  `;
}

// "today", "1 day old", "5 days old"
function describeAge(days) {
  if (days === 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

// Shown when the Jordan Lake data can't be loaded.
export function showLakeError(message) {
  const lakeEl = document.getElementById("lake");
  lakeEl.innerHTML = `
    ⚠️ Couldn't load Jordan Lake data: ${message}<br>
    Try again in a few minutes.
  `;
}
