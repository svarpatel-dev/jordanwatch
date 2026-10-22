// Draws the Jordan Lake area cards ("Why" and "What to do"), the example
// station picker, and the camera scan's results.
// Takes results from the other files and shows them; does no data work itself.

import { icon, TREND_ICONS } from "./icons.js";
import { shortDate, leastAffectedText, VERDICT_NAMES } from "./advice.js";
import { whyRowsHtml, todoHtml, reportHtml, stationBadge, toxinNoteHtml, cardHeadHtml } from "./cardparts.js";

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

// Jordan Lake's park rule for dogs (NC State Parks): on Low Risk days the
// pets tag says this instead of the general advice
const JORDAN_LOW_RISK_PETS = "Leashed only, and not on swim beaches (park rule)";

// Camera scan results in plain words (never "safe"; a screening aid), and
// the color of the result strip: red for a possible bloom, green when no
// bloom is visible, gray otherwise
const SCAN_LABELS = {
  bloom: ["Possible algae bloom or scum", "scan-bloom"],
  vegetation: ["Plants or other harmless vegetation", "scan-plain"],
  clear_water: ["No bloom visible", "scan-clear"],
  not_water: ["Point the camera at the water", "scan-plain"],
  uncertain: ["Uncertain: move closer or try another angle", "scan-plain"]
};

const TREND_WORDS = {
  worse: "getting worse",
  better: "getting better",
  steady: "about the same"
};

// Extra line for areas without a recent satellite reading (decided Oct 5)
const NO_RECENT_SATELLITE = "No recent satellite reading here. Check the water yourself: if it looks green, scummy or smells bad, stay out.";

// --- The example station picker (no place chosen) ---

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
  document.getElementById("status").textContent = `Loading the latest readings from ${station.name}…`;
}

export function showResult(station, risk, readings) {
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

  document.getElementById("status").innerHTML = `
    <p class="station-head"><strong>${station.name}</strong> ${stationBadge(risk.level)}</p>
    <p class="small">USGS ${station.id}</p>
    <p>${risk.reason}</p>
    ${risk.note ? `<p class="small">${icon("info")} ${risk.note}</p>` : ""}
    ${risk.flowStatus ? `<p>Flow is ${risk.flowStatus}.</p>` : ""}
    ${risk.isOutdated ? `<p class="small">${icon("warning")} The reading is 3–24 hours old.</p>` : ""}
    <p>${readingLines || "No recent readings from this station."}</p>
    ${latestTime ? `<p class="small">Latest reading: ${latestTime}</p>` : ""}
  `;
}

// Shown when loading a station fails (bug 4).
export function showError(station, message) {
  document.getElementById("status").innerHTML = `
    <p><strong>${station.name}</strong> (USGS ${station.id})</p>
    <p>${icon("warning")} Couldn't load data: ${message} Try again in a few minutes.</p>
  `;
}

// --- A Jordan Lake area's cards ---

// The Why and What to do cards for one area. lake = computeLakeVerdicts()'s
// whole result; reportRoutes = data/report_routes.json (or null)
export function showAreaDetails(area, lake, reportRoutes) {
  const verdict = VERDICT_NAMES[area.level];
  const image = area.imageDate
    ? `Satellite image ${shortDate(area.imageDate)} (${describeAge(area.imageAgeDays)}), ${FREQUENCY_LABELS[area.frequency] || "estimate"}`
    : "No satellite image";

  // lake.js's reasons, one row each; "unavailable" ones are gray
  const rows = area.reasons.map(reason => ({
    source: reason.source,
    level: reason.level,
    raises: reason.raises === true || reason.source === "camera",
    off: reason.unavailable === true,
    headline: reason.headline,
    text: reason.text
  }));

  document.getElementById("why").innerHTML = `
    ${cardHeadHtml(`Why ${area.name} is at ${verdict}`, "why")}
    <p class="small">${area.swimBeach ? "Swim beach" : "No designated swim beach"}. ${image}.</p>
    ${area.borrowedFrom ? `<p class="small">No satellite coverage in this narrow arm, so the nearest reading (${area.borrowedFrom}) is shown.</p>` : ""}
    ${whyRowsHtml(rows)}
    ${area.noRecentSatellite ? `<p class="small">${NO_RECENT_SATELLITE}</p>` : ""}
    ${trendLine(area.trend)}
    ${intakeNote(lake.intake)}
    ${toxinNoteHtml()}
    <p class="small">Satellite estimates from EPA CyAN (about 300 m pixels), last checked
      ${new Date(lake.checkedAt).toLocaleString()}. Not an official advisory.</p>
  `;

  document.getElementById("todo").innerHTML = `
    ${cardHeadHtml("What to do", "todo")}
    ${todoHtml(area, area.level === "low" ? JORDAN_LOW_RISK_PETS : null)}
    ${lake.leastAffected ? `<p class="note">${leastAffectedText(lake.leastAffected)}</p>` : ""}
    ${reportHtml("NC", reportRoutes)}
  `;
}

// "Trend since Oct 6: getting worse (210,000 → 602,560 cells/mL)"
function trendLine(trend) {
  if (!trend) return "";
  const to = trend.toBelowDetection ? "below detection" : `${trend.toCells.toLocaleString()} cells/mL`;
  return `
    <p class="small">${icon(TREND_ICONS[trend.direction])} Trend since ${shortDate(trend.sinceDate)}:
      <strong>${TREND_WORDS[trend.direction]}</strong> (${trend.fromCells.toLocaleString()} → ${to}).
      A change between two satellite images, not a forecast.</p>
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
    <p class="small">${icon("droplet")} Near the Cary/Apex drinking-water intake: ${amount}
      (satellite image ${shortDate(intake.imageDate)}). Context only: this water is treated
      before it reaches taps, so this is not a tap-water rating.</p>
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
  document.getElementById("why").innerHTML = `
    <h2>Jordan Lake</h2>
    <p>${icon("warning")} Couldn't load Jordan Lake data: ${message} Try again in a few minutes.</p>
  `;
}

// --- The camera scan ---

// A message on the camera view, e.g. "Starting the camera…"
export function showScanStatus(message) {
  const strip = document.getElementById("scan-result");
  strip.className = "scan-result scan-plain";
  strip.textContent = message;
}

// What the camera scan sees right now, with how confident the model is
export function showScanResult(result) {
  const percent = Math.round(result.confidence * 100);
  const [words, color] = SCAN_LABELS[result.label];
  const strip = document.getElementById("scan-result");
  strip.className = `scan-result ${color}`;
  strip.innerHTML = `
    <strong>${words}</strong> <span>${percent}% confident</span>
    ${result.label === "bloom" ? "<br>Stay out of the water and keep pets away." : ""}
  `;
}

// Asked when the scan keeps seeing a bloom for a few seconds (decided Oct 11),
// in a sheet. onAnswer(true) for Yes, onAnswer(false) for No (closing the
// sheet counts as No).
export function askAboutBloom(percent, onAnswer) {
  const sheet = document.getElementById("sheet-bloom");
  document.getElementById("bloom-percent").textContent = `${percent}%`;
  let answered = false;
  const answer = yes => {
    if (answered) return;
    answered = true;
    sheet.close();
    onAnswer(yes);
  };
  sheet.querySelector('[data-answer="yes"]').onclick = () => answer(true);
  sheet.querySelector('[data-answer="no"]').onclick = () => answer(false);
  sheet.onclose = () => answer(false);
  sheet.showModal();
}

// After the user says Yes: what happened, plus the report link (reportLink
// = reportHtml() for the user's state)
export function showBloomSaved(areaName, reportLink) {
  showScanNote(`Saved on this phone only: your scan now counts toward <strong>${areaName}</strong>'s
    verdict for today (one level higher, up to Avoid).`, reportLink);
}

export function showBloomNotNear(reportLink) {
  showScanNote("You're not near a lake JordanWatch covers yet, so no verdict changed.", reportLink);
}

export function showBloomNoLocation(message, reportLink) {
  showScanNote(`Couldn't get your location (${message}), so no verdict changed.`, reportLink);
}

export function clearScanNote() {
  document.getElementById("scan-note").innerHTML = "";
}

function showScanNote(text, reportLink) {
  document.getElementById("scan-note").innerHTML = `
    <p>${text}</p>
    <p>If you see a bloom, report it so it can be checked. Stay out of the water and keep pets away.</p>
    ${reportLink}
  `;
}
