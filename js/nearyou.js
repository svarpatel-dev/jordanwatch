// The place the user chose (decided Oct 10-11: GPS or a ZIP code) in
// words: the header's place button, the location sheet's status line, and
// distances in miles. Only words; main.js finds the place.

// Distances are worked out in km and m and shown in miles and feet, like
// the app's other US units (decided Oct 15)
const MILES_PER_KM = 0.621371;
const FEET_PER_METER = 3.28084;

// The header's place button: "27519", "My location" or "Set place". Kept
// short so it fits next to the logo and If exposed on a phone; the button's
// label says it's a ZIP code for screen readers.
export function placeName(place) {
  if (!place) return "Set place";
  return place.source === "zip" ? place.zip : "My location";
}

// A message under the search box, e.g. "Finding your location…" or what
// went wrong ("" clears it)
export function showNearYouStatus(message) {
  document.getElementById("near-result").textContent = message;
}

// "Using your location (accurate to about 100 ft)." or
// "Using the middle of ZIP 27519 (approximate)."
export function describePlace(place) {
  if (place.source === "zip") {
    return `Using the middle of ZIP ${place.zip} (approximate).`;
  }
  if (!place.accuracyM) return "Using your location.";
  const feet = Math.round(place.accuracyM * FEET_PER_METER);
  return `Using your location (accurate to about ${feet.toLocaleString()} ft).`;
}

// "1.4 miles" up close, "330 miles" farther away (also used by the lake
// cards and the tiles)
export function describeDistance(km) {
  const miles = km * MILES_PER_KM;
  return miles < 10 ? `${miles.toFixed(1)} miles` : `${Math.round(miles).toLocaleString()} miles`;
}
