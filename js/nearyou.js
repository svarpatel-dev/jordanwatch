// The "See what's near you" panel (decided Oct 10-11): what's near the
// place the user chose, by GPS or ZIP code. Only draws; main.js finds the
// place and the nearest area. Plain text for now; icons come in the Week 4
// design pass.

// Verdict words without the emoji dots (the same words as the area cards)
const VERDICT_NAMES = {
  avoid: "Avoid",
  caution: "Caution",
  low: "Low Risk"
};

// Distances are worked out in km and m and shown in miles and feet, like
// the app's other US units (decided Oct 15)
const MILES_PER_KM = 0.621371;
const FEET_PER_METER = 3.28084;

// How bad an Avoid is (decided Oct 13), the same words as the area cards
const SEVERITY_NAMES = {
  high: "high",
  "very-high": "very high",
  extreme: "extreme"
};

// A message in the panel, e.g. "Finding your location…" or what went wrong
export function showNearYouStatus(message) {
  document.getElementById("near-result").textContent = message;
}

// Near Jordan Lake: the nearest area, its verdict and a button that opens
// its card. verdict is null while the lake data is still loading.
export function showNearestArea(place, area, km, verdict, onOpenArea) {
  const verdictText = verdict ? `: ${verdictName(verdict)}` : "";
  document.getElementById("near-result").innerHTML = `
    <p>${describePlace(place)}</p>
    <p>Nearest Jordan Lake area: <strong>${area.name}</strong> (${describeDistance(km)})${verdictText}
      <button type="button" id="near-open-card">Open its card</button></p>
  `;
  document.getElementById("near-open-card").addEventListener("click", () => onOpenArea(area.id));
}

// Farther away: how far Jordan Lake is, and what the map still shows
export function showFarFromLake(place, km) {
  const who = place.source === "zip" ? `ZIP ${place.zip} is` : "You're";
  document.getElementById("near-result").innerHTML = `
    <p>${describePlace(place)}</p>
    <p>${who} about ${describeDistance(km)} from Jordan Lake. Full verdicts cover Jordan Lake
      for now; the satellite map shows lakes near you.</p>
  `;
}

// "Using your location (accurate to about 100 ft)." or
// "Using the middle of ZIP 27519 (approximate)."
function describePlace(place) {
  if (place.source === "zip") {
    return `Using the middle of ZIP ${place.zip} (approximate).`;
  }
  const feet = Math.round(place.accuracyM * FEET_PER_METER);
  const accuracy = place.accuracyM ? ` (accurate to about ${feet.toLocaleString()} ft)` : "";
  return `Using your location${accuracy}.`;
}

// "Avoid: very high", "Caution", "Low Risk"
function verdictName(verdict) {
  const severity = verdict.severity ? `: ${SEVERITY_NAMES[verdict.severity]}` : "";
  return `${VERDICT_NAMES[verdict.level]}${severity}`;
}

// "1.4 miles" up close, "330 miles" farther away
function describeDistance(km) {
  const miles = km * MILES_PER_KM;
  return miles < 10 ? `${miles.toFixed(1)} miles` : `${Math.round(miles).toLocaleString()} miles`;
}
