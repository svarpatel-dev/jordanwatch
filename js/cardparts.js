// Pieces shared by the "Why" and "What to do" cards of a Jordan Lake area
// (ui.js) and of any other lake (lakecard.js), so both look and read the
// same (decided Oct 5: one area card, reused everywhere). Only HTML text.

import { icon, SIGNAL_ICONS } from "./icons.js";
import { activitiesFor, escapeHtml, VERDICT_NAMES, STATION_LEVELS, NO_VERDICT_ADVICE,
         AVOID_SIGHTING, TOXIN_NOTE } from "./advice.js";

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
// Oct 21: every section says what it does in one line)
const WHY_DESCRIPTION = "Every signal behind this rating, in plain words, with the numbers. The worst one sets the rating.";
const TODO_DESCRIPTION = "What's OK today for people, kids and dogs, and how to report a bloom.";

// A card's heading and its one-line description. which = "why" or "todo"
export function cardHeadHtml(title, which) {
  const description = which === "why" ? WHY_DESCRIPTION : TODO_DESCRIPTION;
  return `<h2>${title}</h2>
    <p class="card-desc">${description}</p>`;
}

// The rows of a Why card. rows = [{ source, level, raises, off, headline, text }]:
//   level    the verdict this signal gives (null when it gives none)
//   raises   true when it pushes the verdict one level up (wind, camera)
//   off      true when its data is missing here or couldn't load (gray row)
//   headline a short plain line (decided Oct 21), e.g. "Heavy rain recently";
//            the exact numbers stay in text, in smaller type
// A signal that makes things worse gets a tag in its verdict's color.
export function whyRowsHtml(rows) {
  const items = rows.map(row => {
    const bad = row.level === "avoid" || row.level === "caution";
    const tag = bad
      ? `<span class="why-tag tag-${row.level}">${VERDICT_NAMES[row.level]}</span>`
      : row.raises ? `<span class="why-tag tag-up">one level up</span>` : "";
    const tone = row.off ? " why-off" : "";
    const name = SIGNAL_NAMES[row.source] ?? "Note";
    return `
      <li class="why-row${tone}">
        ${icon(SIGNAL_ICONS[row.source] ?? "info", "md")}
        <div><span class="why-name">${name}</span> ${tag}
          ${row.headline ? `<strong class="why-head">${escapeHtml(row.headline)}</strong>` : ""}
          <p>${escapeHtml(withoutLabel(row.text))}</p></div>
      </li>
    `;
  });
  return `<ul class="why-list">${items.join("")}</ul>`;
}

// The row's name is already in bold above the sentence, so drop a repeated
// "Wind: " or "Satellite: " at its start: "Wind: light (5 mph)..." → "Light (5 mph)..."
function withoutLabel(text) {
  const rest = text.replace(/^(Wind|Satellite): /, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Suggested / Not suggested (or Always) and the pets and kids tags.
// petsLine replaces the general pets advice (Jordan Lake's park rule).
export function todoHtml(item, petsLine = null) {
  if (!item.level) return `<p>${NO_VERDICT_ADVICE}</p>`;
  const activities = activitiesFor(item);
  const second = activities.notSuggested
    ? `<div><h3>Not suggested</h3><p>${activities.notSuggested}</p></div>`
    : `<div><h3>Always</h3><p>${activities.always}</p></div>`;
  return `
    <div class="todo">
      <div><h3>Suggested</h3><p>${activities.suggested}</p></div>
      ${second}
    </div>
    ${item.level === "avoid" ? `<p class="note">${icon("warning")} ${AVOID_SIGHTING}</p>` : ""}
    <p class="tags">
      <span>${icon("paw")} ${petsLine ?? activities.pets}</span>
      <span>${icon("family")} ${activities.families}</span>
    </p>
  `;
}

// The small note at the bottom of every Why card: why the app counts cells
// instead of measuring toxins (NC DHHS feedback, Oct 21)
export function toxinNoteHtml() {
  return `<p class="small toxin-note">${icon("info")} ${TOXIN_NOTE}</p>`;
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
      <p class="small">This state has no freshwater bloom report route that JordanWatch found.</p>`;
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
