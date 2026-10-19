// Draws a lake's card (tap a lake pin, or a lake in "See what's near you")
// and the list of lakes near the user's place (decided Oct 16). Only draws;
// lakes.js works out the verdicts. The same look as the Jordan Lake area
// cards for now; icons come in the Week 4 design pass.

import { JORDAN_LAKE_ID } from "./lakes.js";
import { describeDistance } from "./nearyou.js";

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

// The signals a lake's verdict can use. Only the satellite for now; wind,
// lake level and beaches come next (decided Oct 13).
const SIGNALS = ["satellite"];

// Where each reading comes from
const SOURCE_NAMES = {
  check: "EPA's pixel counts for this lake",
  image: "EPA's nationwide satellite image"
};

// One lake's card, under the map
export function showLakeCard(lake, updatedAt) {
  const verdict = lake.verdict;
  const box = document.getElementById("lake-card");

  box.innerHTML = `
    <details open>
      <summary><strong>${escapeHtml(lake.name)}</strong> (${lake.state}): ${verdictLabel(verdict)}</summary>
      <p><small>${readingLine(verdict)}</small></p>
      <p><strong>Why:</strong></p>
      <ul>${verdict.reasons.map(reason => `<li>${reason}</li>`).join("")}</ul>
      ${adviceText(verdict)}
      ${lake.id === JORDAN_LAKE_ID ? "<p>Jordan Lake also has a verdict for each of its 10 areas, below the map.</p>" : ""}
      <p><small>${coverageLine(verdict)}</small></p>
      <p><small>Satellite estimates from EPA CyAN (about 300 m pixels), lake data updated
        ${new Date(updatedAt).toLocaleString()}. Not an official advisory.</small></p>
    </details>
  `;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
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
    <p><strong>${heading}</strong> <small>(satellite verdicts; tap a lake for why)</small></p>
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

// The coverage line (the missing-data rule, decided Oct 13), e.g.
// "Based on 1 of 1 signals: satellite."
function coverageLine(verdict) {
  const used = verdict.level ? SIGNALS : [];
  const missing = verdict.status === "too-small" ? "too small for the satellite" : "no recent satellite reading";
  const which = used.length > 0 ? used.join(", ") : missing;
  return `Based on ${used.length} of ${SIGNALS.length} signals: ${which}.`;
}

// Lake names come from EPA's data, so make sure a "<" or "&" in one shows
// as text instead of being read as HTML
export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
