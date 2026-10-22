// The search box in the location sheet (decided Oct 20): ONE box for a ZIP
// code or a lake name. 5 digits → the ZIP code steps in main.js. Letters →
// suggestions from the lake list that's already loaded (no request).
// Only pure functions: they take data and return data, so they're easy to test.

import { distanceKm } from "./location.js";
import { closestPointOfLake } from "./lakes.js";

// How many suggestions to show
export const MAX_SUGGESTIONS = 8;
// A search needs at least this many letters (after dropping "lake")
const MIN_LETTERS = 2;

// True for exactly 5 digits, like Python's re.fullmatch(r"\d{5}", text)
export function isZip(text) {
  return /^\d{5}$/.test(text);
}

// Lowercase, and without a "lake" word at the start or end, so "Lake Tahoe",
// "tahoe" and "Tahoe Lake" all become "tahoe"
export function simplifyName(text) {
  return text.trim().toLowerCase()
    .replace(/^lake\s+/, "")
    .replace(/\s+lake$/, "")
    .trim();
}

// The lakes whose name contains the text, as [{ lake, km }] (km is null
// without a place). With a place: nearest first. Without: the exact name
// first ("falls" → Falls Lake), then names with a word that starts with the
// text ("jordan" → "B Everett Jordan Lake"), then bigger lakes first (more
// likely the one meant).
export function searchLakes(lakes, text, place = null, max = MAX_SUGGESTIONS) {
  const wanted = simplifyName(text);
  if (wanted.length < MIN_LETTERS) return [];

  const matches = lakes
    .filter(lake => simplifyName(lake.name).includes(wanted))
    .map(lake => ({
      lake,
      km: place ? distanceKm(place, closestPointOfLake(lake, place)) : null,
      rank: matchRank(simplifyName(lake.name), wanted)
    }));

  // Like Python's sort with a key: a negative number puts a first
  matches.sort((a, b) => {
    if (place) return a.km - b.km;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return b.lake.km2 - a.lake.km2;
  });

  return matches.slice(0, max).map(({ lake, km }) => ({ lake, km }));
}

// 0 = the exact name, 1 = one of its words starts with the text
// ("b everett jordan", "jordan"), 2 = the text is somewhere else in it
function matchRank(name, wanted) {
  if (name === wanted) return 0;
  if (name.split(/\s+/).some(word => word.startsWith(wanted))) return 1;
  return 2;
}
