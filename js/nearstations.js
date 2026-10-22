// The "Live stations near you" card: every live USGS station near the
// place the user chose, with its verdict and the state standards it was
// compared with. Only draws; nearby.js finds and judges the stations.

import { stationBadge, metaChipsHtml, readingsGridHtml } from "./cardparts.js";
import { icon } from "./icons.js";

const TIER_NAMES = {
  full: "Full data",
  partial: "Partial data",
  limited: "Limited data"
};

// USGS site type codes in plain words
const SITE_TYPE_NAMES = {
  ST: "Stream",
  "ST-CA": "Canal",
  "ST-DCH": "Ditch",
  "ST-TS": "Tidal stream",
  LK: "Lake",
  WE: "Wetland",
  SP: "Spring",
  ES: "Estuary",
  OC: "Ocean",
  "OC-CO": "Coastal ocean"
};

// The class of water every state's numbers are for (decided Oct 10): its
// warm-water fish class, or its closest general one (listed under the list)
const CLASS_WORDS = "fish and aquatic life";

// A reading at least this old gets its age next to it (the same 3 hours
// risk.js calls "outdated")
const OLD_READING_HOURS = 3;

// Each group shows this many stations; the rest open with "Show more"
const SHOW_FIRST = 8;

const MILES_PER_KM = 0.621371;

function box() {
  return document.getElementById("near-stations");
}

// While the two USGS requests run (the card's heading is in index.html)
export function showStationsNearLoading() {
  box().innerHTML = "<p>Finding live USGS stations nearby…</p>";
}

export function showStationsNearError(message) {
  box().innerHTML = `<p>${icon("warning")} Couldn't load stations: ${message} Try again soon.</p>`;
}

// "Clear": the list goes away with the place
export function clearStationsNear() {
  box().innerHTML = "";
}

// result = { stations, miles } from nearby.js; place = the chosen place
export function showStationsNear(result, place) {
  const where = place.source === "zip" ? `ZIP ${place.zip}` : "your location";
  box().innerHTML = stationsHtml(null, result, where);
}

// The same list inside a lake card, for the stations near the lake (decided
// Oct 13: every lake card offers them). lakeName must already be safe HTML.
export function showStationsNearLake(element, result, lakeName) {
  element.innerHTML = stationsHtml(`Live stations near ${lakeName}`, result, lakeName);
}

// heading = null when the card already has one
function stationsHtml(heading, result, where) {
  const { stations, miles } = result;
  const title = heading ? `<h3>${heading}</h3>` : "";

  if (stations.length === 0) {
    return `
      ${title}
      <p>No live stations within ${miles} miles of ${where}.</p>
    `;
  }

  const quality = stations.filter(s => s.tier !== "limited");
  const flowOnly = stations.filter(s => s.tier === "limited");
  const count = stations.length === 1 ? "1 live USGS station" : `${stations.length} live USGS stations`;

  return `
    ${title}
    <p class="small">${count} within ${miles} miles · nearest first</p>
    ${stationGroup("Water quality", quality)}
    ${stationGroup("Flow and lake level only (no rating)", flowOnly)}
    ${aboutStandards(quality)}
  `;
}

// A heading, the nearest few stations, and the rest behind "Show more"
function stationGroup(title, stations) {
  if (stations.length === 0) return "";
  const rest = stations.slice(SHOW_FIRST);
  return `
    <h3>${title} (${stations.length})</h3>
    ${stations.slice(0, SHOW_FIRST).map(stationCard).join("")}
    ${rest.length > 0 ? `
      <details class="more">
        <summary>Show ${rest.length} more, farther away</summary>
        ${rest.map(stationCard).join("")}
      </details>` : ""}
  `;
}

// One station: tap its name to open its readings as a small grid, its
// reason in one line, and the standards it was compared with one tap away
function stationCard(station) {
  const risk = station.risk;
  const site = SITE_TYPE_NAMES[station.siteType] ?? "Surface water";
  const number = station.id.replace("USGS-", "");
  const chips = [`USGS ${number}`, site, TIER_NAMES[station.tier], `Updated ${howLongAgo(latestTime(station.readings))} ago`];
  if (risk.isOutdated) chips.push(`${icon("warning")} 3–24 hours old`);
  const more = [risk.note, ...standardsLines(station)].filter(t => t);

  return `
    <details class="station">
      <summary>
        <span><strong>${readableName(station.name)}</strong><small>${describeDistance(station.km)}</small></span>
        ${stationBadge(risk.level)}
        ${icon("chevron-right")}
      </summary>
      ${metaChipsHtml(chips)}
      ${readingsGridHtml(station.readings, readingAge)}
      <p class="station-reason">${risk.reason}</p>
      ${more.length > 0 ? `<details class="more"><summary>Standards used</summary>
        <ul class="bullets">${more.map(t => `<li>${t}</li>`).join("")}</ul></details>` : ""}
    </details>
  `;
}

// "3 hours old" under a value that's a few hours old, or nothing
function readingAge(reading) {
  const hours = (Date.now() - new Date(reading.timestamp).getTime()) / (1000 * 60 * 60);
  return hours >= OLD_READING_HOURS ? `${howLongAgo(reading.timestamp)} old` : "";
}

// Which standards the station was compared with, and what couldn't be
// compared: a list of short lines (each one a bullet)
function standardsLines(station) {
  const rules = station.rules;
  if (!rules) return [];

  const state = rules.state ?? "this station's state";
  const lines = [];
  const fromEpa = [];
  if (rules.doFromEpa) fromEpa.push("DO");
  if (rules.phFromEpa && station.risk.rated.includes("pH")) fromEpa.push("pH");
  const epaLink = `<a href="${rules.epa.sourceUrl}" target="_blank" rel="noopener">EPA national recommended criteria</a>`;

  if (!rules.row) {
    // A place the table doesn't cover (e.g. a US territory)
    lines.push(`Compared with ${epaLink}, because JordanWatch's table has no numbers for ${state}.`);
  } else if (fromEpa.length === station.risk.rated.length) {
    // Nothing the state has a number for was measured here (e.g. California)
    lines.push(`Compared with ${epaLink}, because ${state} has no single statewide number for ${fromEpa.join(" or ")}.`);
  } else {
    const rule = `<a href="${rules.row.sourceUrl}" target="_blank" rel="noopener">${rules.row.citation}</a>`;
    lines.push(`Compared with ${state}'s standards for ${CLASS_WORDS} (${rule}).`);
    if (fromEpa.length > 0) {
      lines.push(`${fromEpa.join(" and ")}: ${epaLink} (${state} has no single number).`);
    }
  }

  // Turbidity is only judged at full-data stations
  if (station.tier === "full") {
    if (rules.turbidityMax !== null) {
      lines.push("Turbidity is measured in FNU; standards use NTU, so this is approximate.");
    } else {
      lines.push(`${state} has no numeric turbidity limit for ${rules.isLake ? "lakes" : "streams"}, so turbidity isn't rated.`);
    }
  }
  // Tidal streams and estuaries (decided Oct 18): still rated, with a warning
  if (rules.isTidal) {
    lines.push("Tidal (partly salty) water: freshwater standards may not fit exactly.");
  }
  return lines;
}

// Under the list: which class of water each state's numbers are for
function aboutStandards(quality) {
  // Each state once, in the order its first station appears (like a Python
  // dict keeps insertion order)
  const rows = {};
  for (const station of quality) {
    if (station.rules?.row) rows[station.rules.row.name] = station.rules.row;
  }
  const lines = Object.values(rows).map(row => {
    const rougher = row.confidence === "high"
      ? ""
      : " (numbers vary by water body or season here, so the comparison is rougher)";
    return `<strong>${row.name}:</strong> ${row.useClass}.${rougher}`;
  });
  if (lines.length === 0) return "";

  return `
    <details class="more"><summary>About the standards</summary>
      <ul class="bullets">
        <li>Each state's warm-water fish class, or its closest general one</li>
        ${lines.map(line => `<li>${line}</li>`).join("")}
        <li>A station's official class may be stricter or looser</li>
        <li>Caution is JordanWatch's own early-warning band, not a state rule</li>
        <li>Not an official advisory</li>
      </ul>
    </details>
  `;
}

// The newest reading time of a station, as ISO text
function latestTime(readings) {
  const times = Object.values(readings).filter(r => r).map(r => r.timestamp);
  // ISO times sort correctly as text, so the biggest is the newest
  return times.reduce((newest, t) => (t > newest ? t : newest));
}

// "12 minutes", "3 hours", "2 days"
function howLongAgo(timestamp) {
  const minutes = Math.round((Date.now() - new Date(timestamp).getTime()) / (1000 * 60));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

// "1.4 miles" up close, "22 miles" farther away (like nearyou.js)
function describeDistance(km) {
  const miles = km * MILES_PER_KM;
  return miles < 10 ? `${miles.toFixed(1)} miles` : `${Math.round(miles)} miles`;
}

// Short words that are written normally even right before a number
// ("At 5th Street", "Nr 2"); any other two-letter word before a number is a
// road name and stays in capitals ("US 64", "SR 1100", "NC 55")
const SMALL_WORDS = ["At", "Nr", "Ab", "Bl", "Of", "On", "In", "To", "By", "No"];

// Most USGS names are in capitals ("ROCKY RIVER AT US 64 NR SILER CITY, NC").
// Easier to read: "Rocky River At US 64 Nr Siler City, NC". Road names and
// the state code at the end (with or without a comma) stay in capitals.
// Names already in mixed case are left as they are. (Also used for the
// gauges on lake cards.)
export function readableName(name) {
  if (name !== name.toUpperCase()) return name;
  let words = name.toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
  // A two-letter word right before a number: "Us 64" → "US 64", "Sr1100" → "SR1100"
  words = words.replace(/\b([A-Z][a-z])(?=[ -]?\d)/g,
    word => (SMALL_WORDS.includes(word) ? word : word.toUpperCase()));
  // The state code at the very end: ", Nc" or " Nc" → ", NC" or " NC"
  return words.replace(/([ ,])([A-Z][a-z])$/, (match, before, state) => before + state.toUpperCase());
}
