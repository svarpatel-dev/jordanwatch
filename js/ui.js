// Draws the Jordan Lake area cards ("Why" and "What to do"), the example
// station picker, and the camera scan's results.
// Takes results from the other files and shows them; does no data work itself.

import { icon, TREND_ICONS } from "./icons.js";
import { shortDate, shortDateTime, leastAffectedText, VERDICT_NAMES } from "./advice.js";
import { compactCells } from "./lake.js";
import { showHistoryChart, areaHistory } from "./history.js";
import { whyRowsHtml, todoHtml, reportHtml, stationBadge, sourcesHtml, cardHeadHtml, metaChipsHtml,
         infoRowHtml, readingsGridHtml } from "./cardparts.js";

// Headings for the groups in the station dropdown, in display order
const TIER_LABELS = {
  full: "Full data",
  partial: "Partial data",
  limited: "Limited data (Jordan Lake area)"
};

// How to describe each kind of satellite estimate. CyAN makes daily
// estimates from single images and weekly ones that combine a week of images.
const FREQUENCY_LABELS = {
  Daily: "Daily estimate",
  Weekly: "Weekly estimate"
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
  worse: "Getting worse",
  better: "Getting better",
  steady: "About the same"
};

// Extra line for areas without a recent satellite reading (decided Oct 5)
const NO_RECENT_SATELLITE = "No recent satellite reading · Green or scummy? Stay out.";

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
  // Time of the newest reading, e.g. "Sep 28, 4:15 PM"
  const times = Object.values(readings)
    .filter(r => r)
    .map(r => new Date(r.timestamp).getTime());
  const latestTime = times.length > 0 ? shortDateTime(Math.max(...times)) : null;

  // Small chips first (station number, flow, age), then the values as a
  // grid, the reason in one line, and the longer note one tap away
  const chips = [`USGS ${station.id}`];
  if (risk.flowStatus) chips.push(`Flow ${risk.flowStatus}`);
  if (latestTime) chips.push(`Updated ${latestTime}`);
  if (risk.isOutdated) chips.push(`${icon("warning")} 3–24 hours old`);

  document.getElementById("status").innerHTML = `
    <p class="station-head"><strong>${station.name}</strong> ${stationBadge(risk.level)}</p>
    ${metaChipsHtml(chips)}
    ${readingsGridHtml(readings)}
    <p class="station-reason">${risk.reason}</p>
    ${risk.note ? `<details class="more"><summary>About this rating</summary><p class="small">${risk.note}</p></details>` : ""}
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
  // Small chips instead of a sentence: "Swim beach" · "Image Oct 20 · 2 days old" · "Daily estimate"
  const chips = [area.swimBeach ? "Swim beach" : "No swim beach"];
  if (area.imageDate) {
    chips.push(`Image ${shortDate(area.imageDate)} · ${describeAge(area.imageAgeDays)}`);
    chips.push(FREQUENCY_LABELS[area.frequency] || "Estimate");
  } else {
    chips.push("No satellite image");
  }
  if (area.borrowedFrom) chips.push(`Nearest reading: ${area.borrowedFrom}`);

  // lake.js's reasons, one row each; "unavailable" ones are gray
  const rows = area.reasons.map(reason => ({
    source: reason.source,
    level: reason.level,
    raises: reason.raises === true || reason.source === "camera",
    off: reason.unavailable === true,
    headline: reason.headline,
    value: reason.value,
    text: reason.text
  }));

  document.getElementById("why").innerHTML = `
    ${cardHeadHtml(`Why ${area.name} is at ${verdict}`, "why")}
    ${metaChipsHtml(chips)}
    ${area.borrowedFrom ? `<p class="small">This narrow arm has no satellite coverage.</p>` : ""}
    ${area.noRecentSatellite ? `<p class="note">${icon("warning")} ${NO_RECENT_SATELLITE}</p>` : ""}
    ${whyRowsHtml(rows)}
    ${trendRow(area.trend)}
    <div class="trend-chart"></div>
    ${intakeRow(lake.intake)}
    ${sourcesHtml(lake.checkedAt)}
  `;
  // The last 30 days at this area's satellite point (decided Oct 21). An
  // area with no point of its own (Robeson Creek) uses its nearest one.
  showHistoryChart(document.querySelector("#why .trend-chart"), () => areaHistory(area.pointId));

  document.getElementById("todo").innerHTML = `
    ${cardHeadHtml("What to do", "todo")}
    ${todoHtml(area, area.level === "low" ? JORDAN_LOW_RISK_PETS : null)}
    ${lake.leastAffected ? `<p class="note">${leastAffectedText(lake.leastAffected, lake.areas.length)}</p>` : ""}
    ${reportHtml("NC", reportRoutes)}
  `;
}

// "Trend since Oct 19 · Getting better" over "525k → 217k cells/mL · two images, not a forecast"
function trendRow(trend) {
  if (!trend) return "";
  const to = trend.toBelowDetection ? "below detection" : `${compactCells(trend.toCells)} cells/mL`;
  return infoRowHtml(TREND_ICONS[trend.direction],
    `Trend since ${shortDate(trend.sinceDate)} · ${TREND_WORDS[trend.direction]}`,
    `${compactCells(trend.fromCells)} → ${to} · Two images, not a forecast`);
}

// The drinking-water intake: context only, never a verdict (decided Oct 3)
function intakeRow(intake) {
  if (!intake || intake.status !== "ok") return "";
  // Below detection (bug 9 fix, Oct 10): say so instead of "about 0 cells/mL"
  const amount = intake.belowDetection ? "below detection (under ~6,500)" : `${compactCells(intake.cellsPerMl)} cells/mL`;
  return infoRowHtml("droplet", `Cary/Apex intake · ${amount}`,
    `Image ${shortDate(intake.imageDate)} · Context only, not a tap-water rating`);
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

// One short line on the camera view, e.g. "Camera off" or the hint.
// An empty message hides the line.
export function showScanStatus(message) {
  const line = document.getElementById("scan-status");
  line.textContent = message;
  line.hidden = !message;
}

// The progress while a scan looks at the water: done of total frames.
// done = null hides it.
export function showScanLooking(done, total) {
  const box = document.getElementById("scan-looking");
  box.hidden = done === null;
  if (done !== null) {
    document.getElementById("scan-progress-bar").style.width = `${Math.round((done / total) * 100)}%`;
  }
}

// The one result of a scan or a photo, under the picture, with how confident
// the model is. reportLink = reportHtml() for the user's state (bloom only).
export function showScanResult(result, reportLink) {
  const percent = Math.round(result.confidence * 100);
  const [words, color] = SCAN_LABELS[result.label];
  const looks = result.frames > 1 ? `Average of ${result.frames} looks` : "One photo";
  const box = document.getElementById("scan-result");
  box.innerHTML = `
    <div class="scan-result-head ${color}">
      <strong>${words}</strong> <span>${percent}% confident</span>
    </div>
    <div class="scan-result-body">
      ${result.label === "bloom" ? "<p>Stay out and keep pets away.</p>" : ""}
      <p class="small">${looks} · Screening aid, not a diagnosis</p>
      ${result.label === "bloom" ? `<div id="scan-report">${reportLink}</div>` : ""}
    </div>
  `;
  box.hidden = false;
}

// After a bloom answer, the report link for the state the user is in
export function updateScanReport(reportLink) {
  const slot = document.getElementById("scan-report");
  if (slot) slot.innerHTML = reportLink;
}

export function clearScanResult() {
  const box = document.getElementById("scan-result");
  box.innerHTML = "";
  box.hidden = true;
}

// Asked when a scan or a photo shows a bloom at 70% or more (decided Oct 11;
// since Oct 24 after one averaged scan, not a few seconds of frames), in a sheet. onAnswer(true) for Yes, onAnswer(false) for No (closing the
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

// After the user says Yes: what happened (the report link is in the result,
// updated for the user's state)
export function showBloomSaved(areaName) {
  showScanNote(`Saved on this phone only: <strong>${areaName}</strong> is one level higher today.`);
}

export function showBloomNotNear() {
  showScanNote("Not near a covered lake, so no verdict changed. Report it so it gets checked.");
}

export function showBloomNoLocation(message) {
  showScanNote(`No location (${message}), so no verdict changed. Report it so it gets checked.`);
}

export function clearScanNote() {
  document.getElementById("scan-note").innerHTML = "";
}

function showScanNote(text) {
  document.getElementById("scan-note").innerHTML = `<p>${text}</p>`;
}
