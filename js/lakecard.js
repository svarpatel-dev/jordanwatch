// A lake's "Why" and "What to do" cards (tap a lake pin, a lake tile, or a
// search suggestion; decided Oct 16), the same two cards as a Jordan Lake
// area. Only draws; lakes.js and lakesignals.js work out the verdicts.

import { LARGE_LAKE_KM2 } from "./lakes.js";
import { describeDistance } from "./nearyou.js";
import { coverageText, SIGNAL_COUNT } from "./lakesignals.js";
import { verdictLabel, shortDate, escapeHtml, VERDICT_NAMES } from "./advice.js";
import { whyRowsHtml, todoHtml, reportHtml, toxinNoteHtml, cardHeadHtml, ALL_STATES_URL } from "./cardparts.js";
import { icon } from "./icons.js";

// Where each satellite reading comes from
const SOURCE_NAMES = {
  check: "EPA's pixel counts for this lake",
  image: "EPA's nationwide satellite image"
};

// OpenStreetMap's beach kinds in plain words
const BEACH_KINDS = { b: "beach", s: "swimming area", p: "beach park" };
// How many beaches show before "Show more"
const BEACHES_SHOWN = 5;

const FEET_PER_MILE = 5280;
const MILES_PER_KM = 0.621371;

// Both cards for one lake. options:
//   satellite       lakeVerdict(lake): the satellite-only verdict (lakes.js)
//   full            combineLakeSignals() once the wind, rain, river and lake
//                   level are in; null while they load
//   updatedAt       when the lake data was updated
//   reportRoutes    data/report_routes.json, or null
//   extrasFailed    true if the other signals couldn't be put together
//   onShowStations  (lake, element) => shows the live stations near the lake
//   onScan          () => opens the Scan tab
export function showLakeDetails(lake, options) {
  const { satellite, full, updatedAt, reportRoutes, extrasFailed, onShowStations, onScan } = options;
  const verdict = full ?? satellite;
  const heading = verdict.level
    ? `Why ${escapeHtml(lake.name)} is at ${VERDICT_NAMES[verdict.level]}`
    : `Why ${escapeHtml(lake.name)} has no verdict`;

  // The satellite first, then notes about the lake's size, then (once they
  // load) rain and river flow, lake level and wind
  const rows = [
    { source: "satellite", level: satellite.level, off: !satellite.level,
      headline: satellite.satelliteHeadline, text: satellite.reasons[0] },
    ...satellite.reasons.slice(1).map(text => ({ source: "note", level: null, text }))
  ];
  if (full) {
    for (const row of full.otherReasons) {
      rows.push({ ...row, off: row.status !== "used" });
    }
  }
  const loading = full ? "" : `<p class="small">${extrasFailed
    ? "Couldn't load rain, river flow, lake level and wind right now."
    : "Checking rain, river flow, lake level and wind…"}</p>`;

  document.getElementById("why").innerHTML = `
    ${cardHeadHtml(heading, "why")}
    <p class="small">${readingLine(verdict)}</p>
    ${(verdict.warnings ?? []).map(w => `<p class="note">${icon("warning")} ${escapeHtml(w)}</p>`).join("")}
    ${full ? spotHtml(full.spot) : ""}
    ${whyRowsHtml(rows)}
    ${loading}
    <p class="small">${full ? escapeHtml(coverageText(full.signals, full.level !== null)) : loadingCoverage(verdict, extrasFailed)}</p>
    ${toxinNoteHtml()}
    <p class="small">Satellite estimates from EPA CyAN (about 300 m pixels), lake data updated
      ${new Date(updatedAt).toLocaleString()}. Rain, river flow and lake level from USGS,
      wind from Open-Meteo, beaches from OpenStreetMap (© OpenStreetMap contributors, ODbL).
      Not an official advisory.</p>
  `;

  const todo = document.getElementById("todo");
  todo.innerHTML = `
    ${cardHeadHtml("What to do", "todo")}
    ${todoHtml(verdict)}
    ${full ? beachesHtml(full) : ""}
    ${reportHtml(lake.state, reportRoutes)}
    ${crossStateNote(lake)}
    <div class="card-actions">
      <button type="button" class="button-line lake-scan-button">${icon("camera")} Scan the water with your camera</button>
      <button type="button" class="button-line lake-stations-button">${icon("gauge")} Live water stations near this lake</button>
    </div>
    <div class="lake-card-stations"></div>
  `;
  todo.querySelector(".lake-scan-button").addEventListener("click", onScan);
  const stationsBox = todo.querySelector(".lake-card-stations");
  todo.querySelector(".lake-stations-button").addEventListener("click", () => onShowStations(lake, stationsBox));
}

// "Satellite day Oct 15 (2 days old), EPA's pixel counts for this lake"
function readingLine(verdict) {
  if (!verdict.reading) return "No recent satellite reading.";
  const days = verdict.reading.ageDays;
  const age = days === 0 ? "today" : days === 1 ? "1 day old" : `${days} days old`;
  return `Satellite day ${shortDate(verdict.reading.date)} (${age}), ${SOURCE_NAMES[verdict.source]}.`;
}

// Where the user is, when their GPS point is at this lake's shore
// (the wind rule for a spot, decided Oct 13)
function spotHtml(spot) {
  if (!spot || !spot.level) return "";
  const away = spot.feetFromWater === 0 ? "at the water's edge"
    : spot.feetFromWater < 1000 ? `about ${roundTo(spot.feetFromWater, 50).toLocaleString()} ft from the water`
    : `about ${(spot.feetFromWater / FEET_PER_MILE).toFixed(1)} miles from the water`;
  const why = spot.raised
    ? "Light wind is likely pushing floating algae toward your shore, so it's one level worse here."
    : "The same as the whole lake: the wind isn't pushing algae toward your shore.";
  return `<p class="note"><strong>Where you are</strong> (${spot.shore}, ${away}): <strong>${verdictLabel(spot)}</strong>. ${why}</p>`;
}

// The lake's beaches from OpenStreetMap, each with its own level, and
// "Go here instead" when the wind raises the one nearest the user
function beachesHtml(full) {
  if (full.beachesNote) return `<p class="small">${full.beachesNote}</p>`;
  const rows = full.beaches.map(beachLine);
  const rest = rows.slice(BEACHES_SHOWN);
  return `
    <h3>Beaches</h3>
    <p class="small">From OpenStreetMap, not officially verified. Follow posted signs, and check the
      local rules before bringing a dog.</p>
    <ul class="plain-list">${rows.slice(0, BEACHES_SHOWN).join("")}</ul>
    ${rest.length > 0 ? `<details class="more"><summary>Show ${rest.length} more</summary><ul class="plain-list">${rest.join("")}</ul></details>` : ""}
    ${full.goInstead ? goInsteadHtml(full.goInstead) : ""}
  `;
}

// "Kings Beach, 2.1 miles from you: Caution, one level up: ..."
function beachLine(beach) {
  const name = beach.name ? escapeHtml(beach.name) : `Unnamed ${BEACH_KINDS[beach.kind]}`;
  const kind = beach.name && beach.kind !== "b" ? ` (${BEACH_KINDS[beach.kind]})` : "";
  const distance = beach.km !== undefined ? `, ${awayFromYou(beach.km)}` : "";
  const level = beach.level ? `: ${verdictLabel(beach)}` : "";
  const raised = beach.raised ? ", one level up: the wind is likely pushing floating algae toward this shore" : "";
  return `<li>${icon("waves")} <span>${name}${kind}${distance}${level}${raised}</span></li>`;
}

// Another beach on the same lake that the wind isn't raising
function goInsteadHtml(beach) {
  const name = beach.name ? escapeHtml(beach.name) : `an unnamed ${BEACH_KINDS[beach.kind]}`;
  const distance = beach.km !== undefined ? `, ${awayFromYou(beach.km)}` : "";
  return `<p class="note"><strong>Go here instead:</strong> ${name}${distance} (${verdictLabel(beach)}): the wind isn't pushing algae toward it.</p>`;
}

// Big lakes can cross state lines, but EPA lists each lake under one state
// (decided Oct 20): say so, and point to every state's program
function crossStateNote(lake) {
  if (lake.km2 < LARGE_LAKE_KM2) return "";
  return `<p class="small">Big lakes can cross state lines, and EPA lists this one under ${lake.state}.
    If you saw the bloom in another state, report it there:
    <a href="${ALL_STATES_URL}" target="_blank" rel="noopener">EPA's list of every state's program</a>.</p>`;
}

// While the other signals load
function loadingCoverage(verdict, extrasFailed) {
  const satellite = verdict.level ? "satellite" : "no satellite verdict";
  const others = extrasFailed ? "the others couldn't load right now" : "the others are loading";
  return `So far: ${satellite} (1 of ${SIGNAL_COUNT} signals); ${others}.`;
}

// "2.1 miles from you", or "right by you" under a tenth of a mile
function awayFromYou(km) {
  return km * MILES_PER_KM < 0.1 ? "right by you" : `${describeDistance(km)} from you`;
}

// 437 → 450 (to the nearest 50)
function roundTo(number, step) {
  return Math.round(number / step) * step;
}
