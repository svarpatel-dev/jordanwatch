// A lake's "Why" and "What to do" cards (tap a lake pin, a lake tile, or a
// search suggestion; decided Oct 16), the same two cards as a Jordan Lake
// area. Only draws; lakes.js and lakesignals.js work out the verdicts.
// Short labels, chips and small cards first; anything long is one tap away
// (decided Oct 21: nothing on the app is a wall of text).

import { LARGE_LAKE_KM2 } from "./lakes.js";
import { describeDistance } from "./nearyou.js";
import { pendingSignals } from "./lakesignals.js";
import { shortDate, escapeHtml, VERDICT_NAMES } from "./advice.js";
import { whyRowsHtml, todoHtml, reportHtml, sourcesHtml, coverageHtml, metaChipsHtml, verdictBadge,
         cardHeadHtml, ALL_STATES_URL } from "./cardparts.js";
import { icon } from "./icons.js";
import { showHistoryChart, lakeHistory } from "./history.js";

// Where each satellite reading comes from
const SOURCE_NAMES = {
  check: "EPA lake pixel counts",
  image: "EPA nationwide image"
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
//   better          betterLakeNearby() (lakes.js): a lake nearby with a
//                   better rating, { lake: null } if none, or null
//   onOpenLake      (id) => opens another lake
export function showLakeDetails(lake, options) {
  const { satellite, full, updatedAt, reportRoutes, extrasFailed, onShowStations, onScan,
          better = null, onOpenLake = null } = options;
  const verdict = full ?? satellite;
  const heading = verdict.level
    ? `Why ${escapeHtml(lake.name)} is at ${VERDICT_NAMES[verdict.level]}`
    : `Why ${escapeHtml(lake.name)} has no verdict`;

  // The satellite first, then notes about the lake's size, then (once they
  // load) rain and river flow, lake level and wind
  const rows = [
    { source: "satellite", level: satellite.level, off: !satellite.level,
      headline: satellite.satelliteHeadline, value: satellite.satelliteValue, text: satellite.reasons[0] },
    ...satellite.reasons.slice(1).map(text => ({ source: "note", level: null, text }))
  ];
  if (full) {
    for (const row of full.otherReasons) {
      rows.push({ ...row, off: row.status !== "used" });
    }
  }
  const loading = full ? "" : `<p class="small">${extrasFailed
    ? "Couldn't load rain, river, lake level and wind."
    : "Checking rain, river, lake level and wind…"}</p>`;
  const signals = full ? full.signals : pendingSignals(satellite, extrasFailed);

  document.getElementById("why").innerHTML = `
    ${cardHeadHtml(heading, "why")}
    ${metaChipsHtml(readingChips(verdict))}
    ${(verdict.warnings ?? []).map(w => `<p class="note">${icon("warning")} ${escapeHtml(w)}</p>`).join("")}
    ${full ? spotHtml(full.spot) : ""}
    ${coverageHtml(signals, verdict.level !== null)}
    ${whyRowsHtml(rows)}
    ${loading}
    <div class="trend-chart"></div>
    ${sourcesHtml(updatedAt, true)}
  `;
  // The last 30 days (decided Oct 21), drawn once its state's history loads
  showHistoryChart(document.querySelector("#why .trend-chart"), () => lakeHistory(lake));

  const todo = document.getElementById("todo");
  todo.innerHTML = `
    ${cardHeadHtml("What to do", "todo")}
    ${todoHtml(verdict)}
    ${betterLakeHtml(better)}
    ${full ? beachesHtml(full) : ""}
    ${reportHtml(lake.state, reportRoutes)}
    ${crossStateNote(lake)}
    <div class="card-actions">
      <button type="button" class="button-line lake-scan-button">${icon("camera")} Scan the water</button>
      <button type="button" class="button-line lake-stations-button">${icon("gauge")} Live stations near this lake</button>
    </div>
    <div class="lake-card-stations"></div>
  `;
  todo.querySelector(".lake-scan-button").addEventListener("click", onScan);
  const betterButton = todo.querySelector(".better-lake-button");
  if (betterButton && onOpenLake) betterButton.addEventListener("click", () => onOpenLake(better.lake.id));
  const stationsBox = todo.querySelector(".lake-card-stations");
  todo.querySelector(".lake-stations-button").addEventListener("click", () => onShowStations(lake, stationsBox));
}

// ["Satellite Oct 15", "2 days old", "EPA lake pixel counts"]
function readingChips(verdict) {
  if (!verdict.reading) return ["No recent satellite reading"];
  const days = verdict.reading.ageDays;
  const age = days === 0 ? "Today" : days === 1 ? "1 day old" : `${days} days old`;
  return [`Satellite ${shortDate(verdict.reading.date)}`, age, SOURCE_NAMES[verdict.source]];
}

// Where the user is, when their GPS point is at this lake's shore
// (the wind rule for a spot, decided Oct 13): a small highlighted card
function spotHtml(spot) {
  if (!spot || !spot.level) return "";
  const away = spot.feetFromWater === 0 ? "at the water's edge"
    : spot.feetFromWater < 1000 ? `${roundTo(spot.feetFromWater, 50).toLocaleString()} ft from the water`
    : `${(spot.feetFromWater / FEET_PER_MILE).toFixed(1)} miles from the water`;
  const why = spot.raised
    ? "Wind pushing algae to your shore · one level up"
    : "Same as the whole lake · wind not pushing algae here";
  return `
    <div class="pick-card">
      <p class="pick-label">${icon("locate")} Where you are</p>
      <p class="pick-main"><span>${capitalize(spot.shore)} · ${away}</span>${verdictBadge(spot)}</p>
      <p class="small">${why}</p>
    </div>
  `;
}

// The lake's beaches from OpenStreetMap, each with its own level, and
// "Go here instead" when the wind raises the one nearest the user
function beachesHtml(full) {
  if (full.beachesNote) return `<p class="small">${full.beachesNote}</p>`;
  const rows = full.beaches.map(beachRow);
  const rest = rows.slice(BEACHES_SHOWN);
  return `
    ${full.goInstead ? goInsteadHtml(full.goInstead) : ""}
    <h3>Beaches</h3>
    <p class="small">OpenStreetMap, not verified · Check pet rules</p>
    <ul class="beach-list">${rows.slice(0, BEACHES_SHOWN).join("")}</ul>
    ${rest.length > 0 ? `<details class="more"><summary>Show ${rest.length} more</summary><ul class="beach-list">${rest.join("")}</ul></details>` : ""}
  `;
}

// One beach: name, kind and distance, its verdict badge, and a small tag
// when the wind is likely pushing floating algae toward it (one level up)
function beachRow(beach) {
  const name = beach.name ? escapeHtml(beach.name) : `Unnamed ${BEACH_KINDS[beach.kind]}`;
  const sub = [beach.name && beach.kind !== "b" ? BEACH_KINDS[beach.kind] : null,
               beach.km !== undefined ? awayFromYou(beach.km) : null].filter(t => t);
  const raised = beach.raised ? `<small class="wind-tag">${icon("wind")} Wind pushing algae here</small>` : "";
  return `
    <li>
      ${icon("waves")}
      <span class="beach-name">${name}${sub.length > 0 ? `<small>${sub.join(" · ")}</small>` : ""}${raised}</span>
      ${beach.level ? verdictBadge(beach) : ""}
    </li>
  `;
}

// Another beach on the same lake that the wind isn't raising
function goInsteadHtml(beach) {
  const name = beach.name ? escapeHtml(beach.name) : `An unnamed ${BEACH_KINDS[beach.kind]}`;
  const distance = beach.km !== undefined ? ` · ${awayFromYou(beach.km)}` : "";
  return `
    <div class="pick-card">
      <p class="pick-label">${icon("arrow-right")} Go here instead</p>
      <p class="pick-main"><span><strong>${name}</strong>${distance}</span>${verdictBadge(beach)}</p>
      <p class="small">Wind isn't pushing algae toward it</p>
    </div>
  `;
}

// Another lake within about 30 miles with a better rating (decided Oct 21),
// or one line saying there isn't one. Its rating is from its pin: its own
// rain and wind are checked when it's opened.
function betterLakeHtml(better) {
  if (!better) return "";
  if (!better.lake) {
    return `<p class="note">${icon("info")} No lake within 30 miles has a better rating today</p>`;
  }
  const beach = better.hasBeach ? " · has beaches" : "";
  return `
    <div class="pick-card">
      <p class="pick-label">${icon("arrow-right")} Go here instead</p>
      <p class="pick-main"><span><strong>${escapeHtml(better.lake.name)}</strong> · ${describeDistance(better.km)}${beach}</span>${verdictBadge(better.lake.verdict)}</p>
      <button type="button" class="button-line better-lake-button">Open ${escapeHtml(better.lake.name)} ${icon("chevron-right")}</button>
    </div>
  `;
}

// Big lakes can cross state lines, but EPA lists each lake under one state
// (decided Oct 20): say so in one line, and point to every state's program
function crossStateNote(lake) {
  if (lake.km2 < LARGE_LAKE_KM2) return "";
  return `<p class="small">EPA lists this lake under ${lake.state}. Bloom in another state?
    <a href="${ALL_STATES_URL}" target="_blank" rel="noopener">Report it there</a>.</p>`;
}

// "2.1 miles from you", or "right by you" under a tenth of a mile
function awayFromYou(km) {
  return km * MILES_PER_KM < 0.1 ? "right by you" : `${describeDistance(km)} from you`;
}

// 437 → 450 (to the nearest 50)
function roundTo(number, step) {
  return Math.round(number / step) * step;
}

// "the east shore" → "The east shore"
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
