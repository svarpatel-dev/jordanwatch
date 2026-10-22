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
const ACTIVITIES = {
  avoid: {
    action: "Avoid water contact: no swimming or wading, and keep dogs out of the water. If you touch the water, rinse off with tap water.",
    suggested: "Picnics, trails, activities away from the water",
    notSuggested: "Swimming, wading, tubing, water skiing, boating or paddling, touching the water",
    pets: "Keep dogs out of the water",
    families: "Keep kids out of the water"
  },
  caution: {
    action: "No swimming or wading today. Boating and fishing are OK; rinse off with tap water after any contact.",
    suggested: "Boating, kayaking, paddleboarding, fishing, shore activities",
    notSuggested: "Swimming or wading. Don't swallow lake water, and rinse off with tap water after any contact",
    pets: "Keep pets out of the water",
    families: "No swimming for kids today"
  },
  low: {
    action: "Low risk today. Swim at designated beaches and stay away from any scum or discolored water.",
    suggested: "Swimming at designated beaches, boating, fishing",
    always: "Stay away from any scum or discolored water, and rinse off after swimming",
    pets: "Keep pets out of any scum or discolored water, and check the local rules for pets",
    families: "Low risk for families"
  }
};

// Shown with every Avoid: what to do if you can see a bloom yourself
export const AVOID_SIGHTING = "If you see scum or green, paint-like water, stay away from the shore.";

// Why the app counts cells instead of measuring toxins (NC DHHS feedback,
// Oct 21), on the Why cards and in About
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

// When every Jordan Lake area is at Avoid (decided Oct 13, reworded Oct 21):
// where the satellite reading is lowest. It's still Avoid, so it never
// suggests swimming.
export function leastAffectedText(least) {
  return `All areas are at Avoid. The lowest satellite reading today is at ${least.name} (still Avoid).`;
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

// Lake and gauge names come from EPA's and USGS's data, so make sure a "<"
// or "&" in one shows as text instead of being read as HTML
export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
