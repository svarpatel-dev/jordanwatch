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

// Camera scan results in plain words (never "safe"; a screening aid)
const SCAN_LABELS = {
  bloom: "Possible algae bloom or scum",
  vegetation: "Plants or other harmless vegetation",
  clear_water: "No bloom visible",
  not_water: "Point the camera at the water",
  uncertain: "Uncertain: move closer or try another angle"
};

// Where to report a bloom. Jordan Lake areas are in NC, so NC DEQ's online
// form (checked Oct 11). Anywhere else, EPA's list of every state's bloom
// program for now; a direct link for each state comes with the location step (Oct 13).
const NC_REPORT = { url: "https://survey123.arcgis.com/share/deb256fcc1134bbc83b72c80109392f1", name: "NC DEQ" };
const GENERAL_REPORT_URL = "https://www.epa.gov/habs/state-tribal-hab-programs-and-resources";

// Trend between the last two satellite images (decided Oct 12). Plain text
// arrows for now; real icons come in the Week 4 design pass.
const TREND_LABELS = {
  worse: "↑ getting worse",
  better: "↓ getting better",
  steady: "→ about the same"
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
      ${trendLine(area.trend)}
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

// "Trend since Oct 6: ↑ getting worse (210,000 → 602,560 cells/mL)"
function trendLine(trend) {
  if (!trend) return "";
  const to = trend.toBelowDetection ? "below detection" : `${trend.toCells.toLocaleString()} cells/mL`;
  return `
    <p><small>Trend since ${trend.sinceDate}: <strong>${TREND_LABELS[trend.direction]}</strong>
      (${trend.fromCells.toLocaleString()} → ${to}). A change between two satellite images, not a forecast.</small></p>
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

// A message under the camera, e.g. "Starting the camera…"
export function showScanStatus(message) {
  document.getElementById("scan-result").textContent = message;
}

// What the camera scan sees right now, with how confident the model is
export function showScanResult(result) {
  const percent = Math.round(result.confidence * 100);
  document.getElementById("scan-result").innerHTML = `
    <strong>${SCAN_LABELS[result.label]}</strong> <small>(${percent}% confident)</small>
    ${result.label === "bloom" ? "<br>Stay out of the water and keep pets away." : ""}
    <br><small>Screening aid, not a diagnosis. Not an official advisory.</small>
  `;
}

// Asked when the scan keeps seeing a bloom for a few seconds (decided Oct 11).
// onAnswer(true) for Yes, onAnswer(false) for No.
export function askAboutBloom(percent, onAnswer) {
  const box = document.getElementById("scan-confirm");
  box.innerHTML = `
    <p><strong>The scan keeps seeing a possible bloom (${percent}% confident).</strong><br>
      Does the water look green, scummy or like spilled paint?</p>
    <button type="button" data-answer="yes">Yes</button>
    <button type="button" data-answer="no">No</button>
  `;
  for (const button of box.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      box.innerHTML = "";
      onAnswer(button.dataset.answer === "yes");
    });
  }
}

// After the user says Yes: what happened, plus the report link
export function showBloomSaved(areaName) {
  showScanNote(`Saved on this phone only: your scan now counts toward <strong>${areaName}</strong>'s
    verdict for today (one level higher, up to Avoid). ${reportLink(NC_REPORT)}`);
}

export function showBloomNotNear() {
  showScanNote(`You're not near a lake JordanWatch covers yet, so no verdict changed. ${reportLink(null)}`);
}

export function showBloomNoLocation(message) {
  showScanNote(`Couldn't get your location (${message}), so no verdict changed. ${reportLink(null)}`);
}

export function clearScanNote() {
  document.getElementById("scan-confirm").innerHTML = "";
}

function showScanNote(html) {
  document.getElementById("scan-confirm").innerHTML = `<p>${html}</p>`;
}

// The "report it" sentence: a specific agency if we know it, otherwise
// general advice with EPA's page
function reportLink(agency) {
  const report = agency
    ? `<a href="${agency.url}" target="_blank" rel="noopener">report it to ${agency.name}</a>`
    : `report it to your state's environmental or health agency
       (<a href="${GENERAL_REPORT_URL}" target="_blank" rel="noopener">EPA lists every state's program</a>)`;
  return `If you see a bloom, ${report} so it can be checked. Stay out of the water and keep pets away.`;
}

// Shown when the Jordan Lake data can't be loaded.
export function showLakeError(message) {
  const lakeEl = document.getElementById("lake");
  lakeEl.innerHTML = `
    ⚠️ Couldn't load Jordan Lake data: ${message}<br>
    Try again in a few minutes.
  `;
}
