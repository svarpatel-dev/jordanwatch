// Draws a lake's card (tap a lake pin, or a lake in "See what's near you")
// and the list of lakes near the user's place (decided Oct 16). Only draws;
// lakes.js and lakesignals.js work out the verdicts. The same look as the
// Jordan Lake area cards for now; icons come in the Week 4 design pass.

import { JORDAN_LAKE_ID, LARGE_LAKE_KM2 } from "./lakes.js";
import { describeDistance } from "./nearyou.js";
import { coverageText, SIGNAL_COUNT } from "./lakesignals.js";

// The same words as the area cards (decided Oct 4: never "OK" or "Safe")
const VERDICT_NAMES = {
  avoid: "Avoid",
  caution: "Caution",
  low: "Low Risk"
};

const SEVERITY_NAMES = {
  high: "high",
  "very-high": "very high",
  extreme: "extreme"
};

// Shown instead of a verdict
const STATUS_NAMES = {
  "no-recent": "No recent reading",
  "too-small": "Too small for the satellite"
};

// What to do at each verdict: the same advice as the Jordan Lake area
// cards (CDC and state health guidance), without Jordan Lake's park rules
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
    pets: "Keep pets out of any scum or discolored water, and check the local rules for pets",
    families: "Low risk for families"
  }
};

// No verdict (missing data never gives an all-clear, decided Oct 13)
const NO_VERDICT_ADVICE = "No satellite verdict here. Check the water yourself: if it looks green, scummy or like spilled paint, or smells bad, stay out and keep pets away. The camera scan can help.";

// Where each satellite reading comes from
const SOURCE_NAMES = {
  check: "EPA's pixel counts for this lake",
  image: "EPA's nationwide satellite image"
};

// OpenStreetMap's beach kinds in plain words
const BEACH_KINDS = { b: "beach", s: "swimming area", p: "beach park" };
// How many beaches show before "Show more"
const BEACHES_SHOWN = 5;

// How each state takes bloom reports (data/report_routes.json)
const ROUTE_WORDS = { form: "online form", email: "email", phone: "phone", page: "how to report" };
// EPA's app for reporting blooms anywhere, and its list of every state's program
const BLOOMWATCH_URL = "https://www.epa.gov/habs/bloomwatch";
const ALL_STATES_URL = "https://www.epa.gov/habs/state-tribal-hab-programs-and-resources";

const FEET_PER_MILE = 5280;
const MILES_PER_KM = 0.621371;

// One lake's card, under the map. options:
//   updatedAt       when the lake data was updated
//   full            combineLakeSignals() once the wind, rain, river and lake
//                   level are in; null while they load (then only the satellite)
//   reportRoutes    data/report_routes.json, or null
//   onShowStations  (lake, element) => shows the live stations near the lake
//   scroll          true the first time, so the page moves to the card
//   extrasFailed    true if the other signals couldn't be put together
// Drawn again when the other signals arrive: then only its text changes, so
// a station list the user already opened stays.
export function showLakeCard(lake, options) {
  const { updatedAt, full, reportRoutes, onShowStations, scroll, extrasFailed } = options;
  const isJordan = lake.id === JORDAN_LAKE_ID;
  const verdict = full ?? lake.verdict;
  const box = document.getElementById("lake-card");

  // A new lake: a fresh card with three parts (the stations part is only
  // filled when the user asks)
  if (box.dataset.lake !== String(lake.id)) {
    box.dataset.lake = lake.id;
    box.innerHTML = `
      <details open>
        <summary></summary>
        <div class="lake-card-main"></div>
        <div class="lake-card-stations"></div>
        <div class="lake-card-footer"></div>
      </details>
    `;
  }

  box.querySelector("summary").innerHTML =
    `<strong>${escapeHtml(lake.name)}</strong> (${lake.state}): ${verdictLabel(verdict)}`;

  box.querySelector(".lake-card-main").innerHTML = `
    <p><small>${readingLine(verdict)}</small></p>
    ${(verdict.warnings ?? []).map(w => `<p><strong>${escapeHtml(w)}</strong></p>`).join("")}
    ${full ? spotHtml(full.spot) : ""}
    <p><strong>Why:</strong></p>
    <ul>${verdict.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
    ${!full && !isJordan ? `<p><small>${extrasFailed ? "Couldn't load rain, river flow, lake level and wind right now." : "Checking rain, river flow, lake level and wind…"}</small></p>` : ""}
    ${full ? beachesHtml(full) : ""}
    ${full?.goInstead ? goInsteadHtml(full.goInstead) : ""}
    ${adviceText(verdict)}
    ${isJordan ? "<p>Jordan Lake also has a verdict for each of its 10 areas, below the map, with rain, river flow, lake level and wind.</p>" : ""}
    ${moreHtml(lake, reportRoutes)}
  `;

  box.querySelector(".lake-card-footer").innerHTML = `
    <p><small>${full ? escapeHtml(coverageText(full.signals, full.level !== null)) : loadingCoverage(verdict, isJordan, extrasFailed)}</small></p>
    <p><small>Satellite estimates from EPA CyAN (about 300 m pixels), lake data updated
      ${new Date(updatedAt).toLocaleString()}. Rain, river flow and lake level from USGS,
      wind from Open-Meteo, beaches from OpenStreetMap (© OpenStreetMap contributors, ODbL).
      Not an official advisory.</small></p>
  `;

  const stationsBox = box.querySelector(".lake-card-stations");
  box.querySelector(".lake-stations-button").addEventListener("click", () => onShowStations(lake, stationsBox));
  if (scroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// "See what's near you": the closest lakes and their verdicts.
// nearby = [{ lake, km }]; nearJordan = true when Jordan Lake's areas are
// already shown above, so this list is the OTHER lakes.
export function showNearbyLakes(nearby, nearJordan, onOpenLake) {
  const box = document.getElementById("near-lakes");
  const heading = nearJordan ? "Other lakes near you" : "Lakes near you";
  const rows = nearby.map(({ lake, km }) => `
    <li><button type="button" data-lake="${lake.id}">${escapeHtml(lake.name)}</button>
      (${lake.state}), ${describeDistance(km)}: ${verdictLabel(lake.verdict)}</li>
  `).join("");

  box.innerHTML = `
    <p><strong>${heading}</strong> <small>(satellite verdicts; tap a lake for why, with rain, lake level and wind)</small></p>
    <ul>${rows}</ul>
  `;
  for (const button of box.querySelectorAll("button")) {
    button.addEventListener("click", () => onOpenLake(Number(button.dataset.lake)));
  }
}

// Remove the lake card (a new place was chosen, or Clear)
export function clearLakeCard() {
  document.getElementById("lake-card").innerHTML = "";
}

export function clearNearbyLakes() {
  document.getElementById("near-lakes").innerHTML = "";
}

// The lake files couldn't be loaded (temporarily unavailable, decided Oct 13)
export function showLakesUnavailable() {
  document.getElementById("near-lakes").innerHTML =
    "<p>Couldn't load the lake verdicts right now. Try again in a few minutes.</p>";
}

// "Avoid: very high", "Low Risk", "No recent reading"
export function verdictLabel(verdict) {
  if (!verdict.level) return STATUS_NAMES[verdict.status];
  const severity = verdict.severity ? `: ${SEVERITY_NAMES[verdict.severity]}` : "";
  return `${VERDICT_NAMES[verdict.level]}${severity}`;
}

// "Satellite day: 2026-10-15 (2 days old), EPA's pixel counts for this lake"
function readingLine(verdict) {
  if (!verdict.reading) return "No recent satellite reading";
  const days = verdict.reading.ageDays;
  const age = days === 0 ? "today" : days === 1 ? "1 day old" : `${days} days old`;
  return `Satellite day: ${verdict.reading.date} (${age}), ${SOURCE_NAMES[verdict.source]}`;
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
  return `<p><strong>Where you are</strong> (${spot.shore}, ${away}): <strong>${verdictLabel(spot)}</strong>. ${why}</p>`;
}

// The lake's beaches from OpenStreetMap, each with its own level
function beachesHtml(full) {
  if (full.beachesNote) return `<p><small>${full.beachesNote}</small></p>`;
  const rows = full.beaches.map(beachLine);
  const rest = rows.slice(BEACHES_SHOWN);
  return `
    <p><strong>Beaches</strong> <small>(OpenStreetMap, not officially verified; follow posted signs,
      and check the local rules before bringing a dog)</small></p>
    <ul>${rows.slice(0, BEACHES_SHOWN).join("")}</ul>
    ${rest.length > 0 ? `<details><summary>Show ${rest.length} more</summary><ul>${rest.join("")}</ul></details>` : ""}
  `;
}

// "Kings Beach (2.1 miles from you): Caution, one level up: ..."
function beachLine(beach) {
  const name = beach.name ? escapeHtml(beach.name) : `Unnamed ${BEACH_KINDS[beach.kind]}`;
  const kind = beach.name && beach.kind !== "b" ? ` (${BEACH_KINDS[beach.kind]})` : "";
  const distance = beach.km !== undefined ? `, ${awayFromYou(beach.km)}` : "";
  const level = beach.level ? `: ${verdictLabel(beach)}` : "";
  const raised = beach.raised ? ", one level up: the wind is likely pushing floating algae toward this shore" : "";
  return `<li>${name}${kind}${distance}${level}${raised}</li>`;
}

// Another beach on the same lake that the wind isn't raising
function goInsteadHtml(beach) {
  const name = beach.name ? escapeHtml(beach.name) : `an unnamed ${BEACH_KINDS[beach.kind]}`;
  const distance = beach.km !== undefined ? `, ${awayFromYou(beach.km)}` : "";
  return `<p><strong>Go here instead:</strong> ${name}${distance} (${verdictLabel(beach)}): the wind isn't pushing algae toward it.</p>`;
}

function adviceText(verdict) {
  if (!verdict.level) return `<p><em>${NO_VERDICT_ADVICE}</em></p>`;
  const activities = ACTIVITIES[verdict.level];
  return `
    <p>
      <strong>Suggested:</strong> ${activities.suggested}<br>
      ${activities.notSuggested ? `<strong>Not suggested:</strong> ${activities.notSuggested}<br>` : ""}
      ${activities.always ? `<strong>Always:</strong> ${activities.always}<br>` : ""}
      <strong>Pets:</strong> ${activities.pets} · <strong>Families:</strong> ${activities.families}
    </p>
  `;
}

// Every lake card, with or without a verdict: the camera scan, the live
// stations near the lake, and the state's way to report a bloom
function moreHtml(lake, reportRoutes) {
  return `
    <p><strong>More for this lake:</strong></p>
    <ul>
      <li><a href="#scan-start">Scan the water with your camera</a> (a screening aid, not a diagnosis)</li>
      <li><button type="button" class="lake-stations-button">Show live water stations near this lake</button></li>
      <li>${reportLine(lake.state, reportRoutes)}${crossStateNote(lake)}</li>
    </ul>
  `;
}

// "Report a bloom: NC Dept of Environmental Quality (online form)"
function reportLine(state, reportRoutes) {
  const route = reportRoutes?.[state];
  if (!route) {
    return `Report a bloom: <a href="${ALL_STATES_URL}" target="_blank" rel="noopener">EPA's list of every state's program</a>`;
  }
  const [agency, type, url, freshWater] = route;
  if (!freshWater) {
    return `Report a bloom: this state has no freshwater bloom report route that JordanWatch found, so use
      <a href="${BLOOMWATCH_URL}" target="_blank" rel="noopener">EPA's bloomWatch app</a>`;
  }
  // Web links open in a new tab; email and phone links open the phone's app
  const newTab = url.startsWith("http") ? ' target="_blank" rel="noopener"' : "";
  return `Report a bloom: <a href="${url}"${newTab}>${escapeHtml(agency)}</a> (${ROUTE_WORDS[type]})`;
}

// Big lakes can cross state lines, but EPA lists each lake under one state
// (decided Oct 20): say so, and point to every state's program
function crossStateNote(lake) {
  if (lake.km2 < LARGE_LAKE_KM2) return "";
  return `<br><small>Big lakes can cross state lines, and EPA lists this one under ${lake.state}.
    If you saw the bloom in another state, report it there:
    <a href="${ALL_STATES_URL}" target="_blank" rel="noopener">EPA's list of every state's program</a>.</small>`;
}

// While the other signals load, or for Jordan Lake's whole-lake card
function loadingCoverage(verdict, isJordan, extrasFailed) {
  if (isJordan) {
    return "This whole-lake card uses the satellite only; the 10 area cards below the map add rain, river flow, lake level and wind.";
  }
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

// Lake names come from EPA's data and gauge names from USGS's (inside the
// reasons), so make sure a "<" or "&" in one shows as text instead of being
// read as HTML
export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
