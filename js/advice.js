// The app's words for verdicts and what to do, in one place (decided Oct 19:
// one vocabulary everywhere). Before the design pass, ui.js, lakecard.js,
// nearyou.js and map.js each had their own copy of these lists.
// Only words: no page drawing, no data fetching.

// The three verdicts (decided Oct 4: never "OK" or "Safe")
export const VERDICT_NAMES = {
  avoid: "Avoid",
  caution: "Caution",
  low: "Low Risk"
};

// Water stations use the same words as lakes (decided Oct 19). Their
// engines (risk.js, nearby.js) still call a broken standard "high"; the page
// says Avoid. Each one: [words, color class].
export const STATION_LEVELS = {
  high: ["Avoid", "avoid"],
  caution: ["Caution", "caution"],
  low: ["Low Risk", "low"],
  limited: ["Limited data", "none"],
  "no-data": ["No data", "none"],
  "not-rated": ["Not rated", "none"]
};

// Shown instead of a verdict when a lake has none (lakes.js statuses)
const STATUS_NAMES = {
  "no-recent": "No recent reading",
  "too-small": "Too small for the satellite"
};

// What to do at each verdict (decided Oct 5; CDC, state health and park
// guidance). Avoid has one message everywhere (decided Oct 21, after NC
// DHHS's feedback: three WHO levels only, no levels within Avoid).
// action is the whole message as one sentence: the page shows it as chips
// (ACTION_CHIPS below) and keeps the sentence for screen readers.
// suggested / notSuggested / always are lists (like Python lists of
// strings), each shown as a row of small chips on the What to do card.
const ACTIVITIES = {
  avoid: {
    action: "Avoid water contact: no swimming or wading, and keep dogs out of the water. If you touch the water, rinse off with tap water.",
    suggested: ["Picnics", "Trails", "Activities away from the water"],
    notSuggested: ["Swimming", "Wading", "Tubing", "Water skiing", "Boating or paddling", "Touching the water"],
    pets: "Keep dogs out of the water",
    families: "Keep kids out of the water"
  },
  caution: {
    action: "No swimming or wading today. Boating and fishing are OK; rinse off with tap water after any contact.",
    suggested: ["Boating", "Kayaking", "Paddleboarding", "Fishing", "Shore activities"],
    notSuggested: ["Swimming or wading", "Swallowing lake water"],
    always: ["Rinse off with tap water after any contact"],
    pets: "Keep pets out of the water",
    families: "No swimming for kids today"
  },
  low: {
    action: "Low risk today. Swim at designated beaches and stay away from any scum or discolored water.",
    suggested: ["Swimming at designated beaches", "Boating", "Fishing"],
    always: ["Stay away from any scum or discolored water", "Rinse off after swimming"],
    pets: "Pets: avoid scum, check local rules",
    families: "Low risk for families"
  }
};

// The conditions block's 2x2 grid of chips (decided Oct 21: short chips
// instead of a paragraph). Each chip is [icon name, 2-3 words], like a
// Python list of tuples. "none" = no verdict (no recent reading, too small).
export const ACTION_CHIPS = {
  avoid: [["ban", "No swimming"], ["paw", "Keep dogs out"], ["droplet", "Rinse off with tap water"], ["warning", "Stay away from scum"]],
  caution: [["ban", "No swimming"], ["waves", "Boating & fishing OK"], ["paw", "Keep pets out"], ["droplet", "Rinse off after contact"]],
  low: [["waves", "Swim at beaches"], ["warning", "Avoid scum"], ["paw", "Pets: check local rules"], ["droplet", "Rinse off after swimming"]],
  none: [["search", "Check the water yourself"], ["warning", "Stay out if green or scummy"], ["camera", "Use the camera scan"], ["paw", "Keep pets away"]]
};

// The whole message as one sentence, for the chips' screen-reader label
// and their tooltip (so nothing in the old paragraph is lost)
export function actionSentence(item) {
  if (!item.level) return NO_VERDICT_ADVICE;
  const sighting = item.level === "avoid" ? ` ${AVOID_SIGHTING}` : "";
  return ACTIVITIES[item.level].action + sighting;
}

// Shown with every Avoid: what to do if you can see a bloom yourself
export const AVOID_SIGHTING = "If you see scum or green, paint-like water, stay away from the shore.";

// Why the app counts cells instead of measuring toxins (NC DHHS feedback,
// Oct 21): the whole note in About, the short one under "Sources & notes"
// on every Why card
export const TOXIN_SHORT = "NC DHHS and EPA judge recreation by microcystin (8 µg/L), a toxin that needs a water test; satellites count cells, as an early warning.";
export const TOXIN_NOTE = "NC DHHS and EPA judge recreation by a toxin, microcystin (8 µg/L), which needs a water test. Satellites can't measure toxins, so JordanWatch uses WHO's cell-count levels as an early warning.";

// No verdict (missing data never gives an all-clear, decided Oct 13)
export const NO_VERDICT_ADVICE = "Check the water yourself: if it looks green, scummy or like spilled paint, or smells bad, stay out and keep pets away. The camera scan can help.";

// "Avoid", "Low Risk", "No recent reading". item = anything with a level
// (an area, a lake verdict, a beach), or a status when there's no verdict
export function verdictLabel(item) {
  if (!item.level) return STATUS_NAMES[item.status] ?? "No verdict";
  return VERDICT_NAMES[item.level];
}

// The activities for a verdict
export function activitiesFor(item) {
  return ACTIVITIES[item.level];
}

// When every Jordan Lake area is at Avoid (decided Oct 13, shortened Oct 21):
// where the satellite reading is lowest. It's still Avoid, so it never
// suggests swimming. count = how many areas there are.
export function leastAffectedText(least, count) {
  return `All ${count} areas at Avoid · Lowest reading: ${least.name}`;
}

// The CSS class for a verdict's color: "avoid", "caution", "low" or "none"
export function verdictClass(item) {
  return item.level ?? "none";
}

// "2026-10-19" → "Oct 19" (read as a calendar day, like cyan.js)
export function shortDate(isoDate) {
  const date = new Date(isoDate + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// An ISO time → "Oct 21, 8:39 PM"
export function shortDateTime(isoTime) {
  return new Date(isoTime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Lake and gauge names come from EPA's and USGS's data, so make sure a "<"
// or "&" in one shows as text instead of being read as HTML
export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
