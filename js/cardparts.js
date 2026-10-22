// Pieces shared by the "Why" and "What to do" cards of a Jordan Lake area
// (ui.js) and of any other lake (lakecard.js), so both look and read the
// same (decided Oct 5: one area card, reused everywhere). Only HTML text.

import { icon, SIGNAL_ICONS } from "./icons.js";
import { activitiesFor, escapeHtml, verdictLabel, verdictClass, shortDateTime, VERDICT_NAMES, STATION_LEVELS,
         NO_VERDICT_ADVICE, ACTION_CHIPS, AVOID_SIGHTING, TOXIN_SHORT } from "./advice.js";

// Each "why" row's name
const SIGNAL_NAMES = {
  satellite: "Satellite algae",
  runoff: "Rain and river flow",
  "lake-level": "Lake level",
  wind: "Wind",
  camera: "Your camera scan",
  note: "Note"
};

// How each state takes bloom reports (data/report_routes.json)
const ROUTE_WORDS = { form: "online form", email: "email", phone: "phone", page: "how to report" };
// EPA's app for reporting blooms anywhere, and its list of every state's program
const BLOOMWATCH_URL = "https://www.epa.gov/habs/bloomwatch";
export const ALL_STATES_URL = "https://www.epa.gov/habs/state-tribal-hab-programs-and-resources";

// What the Why and What to do cards say under their heading (decided
// Oct 21: every section says what it does in one short line)
const WHY_DESCRIPTION = "Each signal behind the rating. The worst one wins.";
const TODO_DESCRIPTION = "What's OK today, and how to report a bloom.";

// The coverage pills' short names (lakesignals.js labels → 1-2 words)
const PILL_NAMES = {
  satellite: "Satellite",
  "rain and river flow": "Rain/river",
  "lake level": "Lake level",
  wind: "Wind",
  beaches: "Beaches"
};
// Each pill's state: [icon, words for the tooltip and screen readers]
const PILL_STATES = {
  used: ["check", "used"],
  "not-here": ["dash", "not available here"],
  failed: ["warning", "couldn't load right now"],
  loading: ["dash", "loading"]
};

// A card's heading and its one-line description. which = "why" or "todo"
export function cardHeadHtml(title, which) {
  const description = which === "why" ? WHY_DESCRIPTION : TODO_DESCRIPTION;
  return `<h2>${title}</h2>
    <p class="card-desc">${description}</p>`;
}

// The Why card's small cards, two per row (decided Oct 21: compact cards
// instead of paragraphs). rows = [{ source, level, raises, off, headline, value, text }]:
//   level    the verdict this signal gives (null when it gives none)
//   raises   true when it pushes the verdict one level up (wind, camera)
//   off      true when its data is missing here or couldn't load (gray card)
//   headline a short plain line, e.g. "Heavy rain recently"
//   value    one short key value, e.g. "217k cells/mL" or "6 mph NW"
//   text     the full sentence with the exact numbers, one tap away under
//            "Details" (<details> opens and closes by itself, no code needed)
// A signal that makes things worse gets a tag in its verdict's color in the
// card's top-right corner. A "note" (a lake's size) is one full-width card,
// put after the signals so it never leaves a gap in the two columns.
export function whyRowsHtml(rows) {
  // filter keeps the items that pass the test, like a Python list comprehension
  const signals = rows.filter(row => row.source !== "note").map(whyCardHtml);
  const notes = rows.filter(row => row.source === "note").map(noteCardHtml);
  return `<ul class="why-grid">${[...signals, ...notes].join("")}</ul>`;
}

function whyCardHtml(row) {
  const bad = row.level === "avoid" || row.level === "caution";
  const tag = bad
    ? `<span class="why-tag tag-${row.level}">${VERDICT_NAMES[row.level]}</span>`
    : row.raises ? `<span class="why-tag tag-up">one level up</span>` : "";
  const tone = row.off ? " why-off" : "";
  const name = SIGNAL_NAMES[row.source] ?? "Note";
  return `
    <li class="why-card${tone}">
      <div class="why-top">${icon(SIGNAL_ICONS[row.source] ?? "info")}<span class="why-name">${name}</span>${tag}</div>
      ${row.headline ? `<strong class="why-head">${escapeHtml(row.headline)}</strong>` : ""}
      ${row.value ? `<p class="why-value">${escapeHtml(row.value)}</p>` : ""}
      <details class="why-more"><summary>Details</summary><p>${escapeHtml(withoutLabel(row.text))}</p></details>
    </li>
  `;
}

// A note about the lake (e.g. "A large lake..."): short, so no Details
function noteCardHtml(row) {
  return `
    <li class="why-card why-note">
      <div class="why-top">${icon("info")}<span class="why-name">${SIGNAL_NAMES.note}</span></div>
      <p>${escapeHtml(row.text)}</p>
    </li>
  `;
}

// The card's name is already shown above the sentence, so drop a repeated
// "Wind: " or "Satellite: " at its start: "Wind: light (5 mph)..." → "Light (5 mph)..."
function withoutLabel(text) {
  const rest = text.replace(/^(Wind|Satellite): /, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Suggested / Not suggested / Always as rows of small chips, and the pets
// and kids tags. petsLine replaces the general pets advice (Jordan Lake's
// park rule).
export function todoHtml(item, petsLine = null) {
  // No verdict: the same 4 short steps as the conditions block, as chips,
  // with the whole sentence kept as the label (decided Oct 21)
  if (!item.level) {
    const words = ACTION_CHIPS.none.map(([, text]) => text);
    return `<div class="todo-row"><h3>For now</h3>
      <ul class="todo-chips chips-always" aria-label="${NO_VERDICT_ADVICE}" title="${NO_VERDICT_ADVICE}">
        ${words.map(w => `<li>${w}</li>`).join("")}</ul></div>`;
  }
  const activities = activitiesFor(item);
  return `
    ${chipRowHtml("Suggested", activities.suggested, "chips-ok")}
    ${chipRowHtml("Not suggested", activities.notSuggested, "chips-no")}
    ${chipRowHtml("Always", activities.always, "chips-always")}
    ${item.level === "avoid" ? `<p class="note">${icon("warning")} ${AVOID_SIGHTING}</p>` : ""}
    <p class="tags">
      <span>${icon("paw")} ${petsLine ?? activities.pets}</span>
      <span>${icon("family")} ${activities.families}</span>
    </p>
  `;
}

// One labeled row of chips, or nothing when the list is missing (Low Risk
// has no "Not suggested", Avoid has no "Always"). tone = a CSS class.
function chipRowHtml(title, list, tone) {
  if (!list) return "";
  const chips = list.map(words => `<li>${words}</li>`).join("");
  return `<div class="todo-row"><h3>${title}</h3><ul class="todo-chips ${tone}">${chips}</ul></div>`;
}

// The bottom of every Why card (decided Oct 21: one short line, the rest
// one tap away): "Estimate, not an official advisory · Updated Oct 21,
// 8:39 PM", then "Sources & notes" with short bullets, including why the
// app counts cells instead of measuring toxins (NC DHHS feedback, Oct 21).
// beaches = true on lake cards (their beaches come from OpenStreetMap).
export function sourcesHtml(updatedAt, beaches = false) {
  const bullets = [
    "<strong>Satellite:</strong> EPA CyAN, about 300 m pixels",
    "<strong>Rain, river, lake level:</strong> USGS",
    "<strong>Wind:</strong> Open-Meteo",
    beaches ? "<strong>Beaches:</strong> © OpenStreetMap contributors, ODbL" : null,
    `<strong>Cells, not toxins:</strong> ${TOXIN_SHORT}`
  ].filter(b => b);
  return `
    <div class="sources">
      <p class="small">${icon("info")} Estimate, not an official advisory · Updated ${shortDateTime(updatedAt)}</p>
      <details class="more"><summary>Sources &amp; notes</summary>
        <ul class="bullets">${bullets.map(b => `<li>${b}</li>`).join("")}</ul>
      </details>
    </div>
  `;
}

// The coverage row on a lake's Why card (decided Oct 21, the missing-data
// rule of Oct 13 as pills): one pill per signal with a check (used), a dash
// (not available here, or still loading) or a warning (couldn't load), a
// short count, and the reasons under "What's missing".
// signals = [{ label, status, why }] from lakesignals.js
export function coverageHtml(signals, hasVerdict) {
  const used = signals.filter(s => s.status === "used").length;
  const count = hasVerdict
    ? `${used} of ${signals.length} signals`
    : `No verdict · ${used} of ${signals.length} signals checked`;
  const pills = signals.map(s => {
    const [iconName, state] = PILL_STATES[s.status];
    const tip = `${PILL_NAMES[s.label]}: ${state}${s.why ? ` (${s.why})` : ""}`;
    return `<li class="pill pill-${s.status}" title="${tip}" aria-label="${tip}">${icon(iconName)}${PILL_NAMES[s.label]}</li>`;
  });
  const missing = signals.filter(s => s.status === "not-here" || s.status === "failed")
    .map(s => `<li><strong>${PILL_NAMES[s.label]}:</strong> ${s.status === "failed" ? "couldn't load right now" : s.why}</li>`);
  return `
    <div class="coverage">
      <p class="coverage-count">${count}</p>
      <ul class="pills">${pills.join("")}</ul>
      ${missing.length > 0 ? `<details class="more"><summary>What's missing</summary><ul class="bullets">${missing.join("")}</ul></details>` : ""}
    </div>
  `;
}

// A row of small gray chips, e.g. ["Swim beach", "Image Oct 20 · 2 days old"]
export function metaChipsHtml(list) {
  return `<ul class="meta-chips">${list.map(text => `<li>${text}</li>`).join("")}</ul>`;
}

// A small row with an icon, a bold line and a gray line under it (the
// trend, the drinking-water intake)
export function infoRowHtml(iconName, title, sub) {
  return `<div class="info-row">${icon(iconName, "md")}<span><strong>${title}</strong><small>${sub}</small></span></div>`;
}

// A verdict as a small colored badge (beaches, "Go here instead")
export function verdictBadge(item) {
  return `<span class="badge badge-${verdictClass(item)}">${verdictLabel(item)}</span>`;
}

// A station's readings as a small grid of values (Temp / DO / pH /
// Turbidity / Flow / Lake level), skipping the ones it doesn't have.
// ageText(reading) adds a small "3 hours old" under an old value (or "").
const READING_DISPLAY = [
  { key: "tempC", label: "Temp", unit: " °C" },
  { key: "doMgL", label: "DO", unit: " mg/L" },
  { key: "ph", label: "pH", unit: "" },
  { key: "turbidityFnu", label: "Turbidity", unit: " FNU" },
  { key: "flowCfs", label: "Flow", unit: " cu ft/s" },
  { key: "lakeLevelFt", label: "Lake level", unit: " ft", sub: "above sea level" }
];
export function readingsGridHtml(readings, ageText = () => "") {
  const cells = READING_DISPLAY.filter(r => readings[r.key]).map(r => {
    const value = readings[r.key].value;
    // Near the coast the tide can push a river backward, and USGS then
    // reports the flow as a negative number: say so in words
    const upstream = r.key === "flowCfs" && value < 0;
    const subs = [upstream ? "upstream (tide)" : r.sub, ageText(readings[r.key])].filter(t => t);
    return `<div><dt>${r.label}</dt><dd>${upstream ? Math.abs(value) : value}${r.unit}</dd>${subs.map(t => `<small>${t}</small>`).join("")}</div>`;
  });
  if (cells.length === 0) return `<p class="small">No recent readings from this station.</p>`;
  return `<dl class="value-grid">${cells.join("")}</dl>`;
}

// The "Report a bloom" button: the state's official route
// (data/report_routes.json), EPA's bloomWatch where a state has no
// freshwater route, or EPA's list of every state's program
export function reportHtml(state, reportRoutes) {
  const route = state ? reportRoutes?.[state] : null;
  if (!route) {
    return `<a class="button-line" href="${ALL_STATES_URL}" target="_blank" rel="noopener">
      ${icon("warning")} Report a bloom: EPA's list of every state's program</a>`;
  }
  const [agency, type, url, freshWater] = route;
  if (!freshWater) {
    return `<a class="button-line" href="${BLOOMWATCH_URL}" target="_blank" rel="noopener">
      ${icon("warning")} Report a bloom with EPA's bloomWatch app</a>
      <p class="small">No state freshwater route found.</p>`;
  }
  // Web links open in a new tab; email and phone links open the phone's app
  const newTab = url.startsWith("http") ? ' target="_blank" rel="noopener"' : "";
  return `<a class="button-line" href="${url}"${newTab}>
    ${icon("warning")} Report a bloom: ${escapeHtml(agency)} (${ROUTE_WORDS[type]})</a>`;
}

// A water station's badge: "Avoid", "Caution", "Low Risk", "Limited data"...
// in its verdict's color
export function stationBadge(level) {
  const [words, color] = STATION_LEVELS[level];
  return `<span class="badge badge-${color}">${words}</span>`;
}
