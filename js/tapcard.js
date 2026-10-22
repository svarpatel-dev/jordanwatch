// The "Your tap water" card on the Lake tab (decided Oct 10 and Oct 13,
// card design Oct 22): the water system that likely serves the chosen
// place, and its source lakes with each lake's rating. Only draws;
// tapwater.js finds the system and its sources.
//
// Context only: a lake's rating is about swimming and pets at the lake,
// never about tap water, which is treated before it reaches the tap. Short
// labels and small cards; the longer notes are one tap away (decided Oct 21).

import { escapeHtml, verdictLabel } from "./advice.js";
import { verdictBadge, metaChipsHtml } from "./cardparts.js";
import { describeDistance } from "./nearyou.js";
import { icon } from "./icons.js";

// Shown on every answer (decided Oct 20: "likely; confirm with your utility")
const LIKELY = "Likely · confirm with your utility";
const NOT_A_RATING = "Context only, not a tap-water rating";

// Long lists of sources are cut to this many names
const MAX_NAMES = 3;

function body() {
  return document.getElementById("tap-body");
}

// The card shows only once a place is chosen
export function showTapCard(visible) {
  document.getElementById("tap-card").hidden = !visible;
}

// A short message instead of the answer, e.g. "Looking up your water system…"
export function showTapWaterStatus(message) {
  showTapCard(true);
  body().innerHTML = `<p class="small">${message}</p>`;
}

export function clearTapWater() {
  body().innerHTML = "";
  showTapCard(false);
}

// result = { systems, inside } from findWaterSystems (tapwater.js).
// lakes = every covered lake with its verdict (lakes.js), or null while
// they load. onOpenLake(id) opens a lake on the Lake tab.
export function showTapWater(result, lakes, onOpenLake) {
  showTapCard(true);
  const [first, ...others] = result.systems;
  if (!first) {
    body().innerHTML = `
      <p class="tap-none">${icon("info")} No water system mapped near here</p>
      ${metaChipsHtml(["May be a private well", "Your water bill or town can tell you"])}
      ${aboutHtml(null)}
    `;
    return;
  }

  // Outside every mapped area: the nearest one, labeled as a guess (decided Oct 20)
  const label = result.inside
    ? "Your water system"
    : `Nearest mapped system · ${describeDistance(first.km)} away`;
  body().innerHTML = `
    ${systemHtml(first, label)}
    ${result.inside ? "" : `<p class="small">This spot isn't inside a mapped area. You may be on a well.</p>`}
    ${sourcesHtml(first.sources, lakes)}
    <ul class="fact-chips tap-chips"><li>${LIKELY}</li><li>${NOT_A_RATING}</li></ul>
    ${othersHtml(others, result.inside)}
    ${aboutHtml(first)}
  `;
  for (const button of body().querySelectorAll("button[data-lake]")) {
    button.addEventListener("click", () => onOpenLake(Number(button.dataset.lake)));
  }
}

// The system's name, and who it buys water from
function systemHtml(system, label) {
  const sellers = system.sources?.from ?? [];
  const buys = sellers.length > 0
    ? `<p class="small">Buys water from ${shortList(sellers.map(systemName))}</p>`
    : "";
  return `
    <div class="pick-card">
      <p class="pick-label">${icon("droplet")} ${label}</p>
      <p class="pick-main"><strong>${systemName(system.name)}</strong></p>
      ${buys}
    </div>
  `;
}

// Where the water comes from: each satellite lake with its rating, then the
// other sources as small chips
function sourcesHtml(sources, lakes) {
  if (!sources) {
    return `<p class="small">EPA's records don't list this system's sources</p>`;
  }
  const covered = sources.lakes ?? [];
  const rows = covered.map(([id, name]) => lakeRow(id, name, lakes));
  const chips = otherChips(sources);
  if (rows.length === 0 && chips.length === 0) {
    return `<p class="small">EPA's records don't say where its water comes from</p>`;
  }
  return `
    ${rows.length > 0 ? `<h3>Source lakes</h3><ul class="beach-list tap-lakes">${rows.join("")}</ul>` : ""}
    ${chips.length > 0 ? `<h3>${rows.length > 0 ? "Other sources" : "Sources"}</h3>${metaChipsHtml(chips)}` : ""}
  `;
}

// One source lake: its name (the app's name for it, e.g. "Falls Lake"), its
// rating for swimming and pets, and a button that opens it
function lakeRow(id, dataName, lakes) {
  const lake = lakes?.find(l => l.id === id) ?? null;
  const name = escapeHtml(lake ? lake.name : dataName);
  let badge;
  if (lakes === null) {
    badge = `<span class="small">Loading…</span>`;
  } else if (!lake) {
    badge = `<span class="small">No rating</span>`;
  } else {
    badge = verdictBadge(lake.verdict);
  }
  const sub = lake?.verdict.level ? "Lake rating, for swimming and pets" : lake ? verdictLabel(lake.verdict) : "Not on the satellite list";
  const open = lake
    ? `<button type="button" class="icon-button" data-lake="${id}" aria-label="Open ${name}">${icon("chevron-right", "md")}</button>`
    : "";
  return `
    <li>
      ${icon("waves")}
      <span class="beach-name">${name}<small>${sub}</small></span>
      ${badge}
      ${open}
    </li>
  `;
}

// "Lake Benson", "2 unnamed intakes", "Wells" as short chips. Sources that
// couldn't be matched may still be lakes the satellite covers (EPA's
// records don't always name them), so the app never says they aren't.
function otherChips(sources) {
  const names = (sources.other ?? []).map(escapeHtml);
  const chips = names.slice(0, MAX_NAMES);
  const more = names.length - chips.length;
  if (more > 0) chips.push(`${more} more`);
  const unnamed = sources.unnamed ?? 0;
  if (unnamed > 0) chips.push(`${unnamed} unnamed ${unnamed === 1 ? "intake" : "intakes"}`);
  if (sources.wells || (sources.uses ?? "").endsWith("wells")) chips.push("Wells");
  return chips;
}

// The other systems whose areas also cover the spot, one tap away
function othersHtml(systems, inside) {
  if (systems.length === 0) return "";
  const heading = inside ? "Other systems here" : "Other systems within a mile";
  const items = systems.map(system => `<li>${systemName(system.name)}: ${shortSources(system.sources)}</li>`);
  return `<details class="more"><summary>${heading} (${systems.length})</summary>
    <ul class="bullets">${items.join("")}</ul></details>`;
}

// "Falls Lake and Lake Benson", "wells", "sources not listed"
function shortSources(sources) {
  if (!sources) return "sources not listed";
  const names = [...(sources.lakes ?? []).map(([, name]) => escapeHtml(name)), ...(sources.other ?? []).map(escapeHtml)];
  if (names.length > 0) return shortList(names);
  return sources.wells || (sources.uses ?? "").endsWith("wells") ? "wells" : "sources not listed";
}

// Where the answer comes from, one tap away
function aboutHtml(system) {
  const mapped = !system ? null
    : system.modeled ? "This area's outline is EPA's estimate"
    : system.mappedYear ? `This area was mapped in ${system.mappedYear}`
    : null;
  const bullets = [
    "Water systems: EPA's map of service areas",
    "Sources: EPA's records (SDWIS)",
    "Lakes matched to the satellite by name",
    mapped,
    "Water is treated before it reaches your tap",
    "Only a rounded spot (about 1 km) is sent to EPA"
  ].filter(b => b);
  return `<details class="more"><summary>About this</summary>
    <ul class="bullets">${bullets.map(b => `<li>${b}</li>`).join("")}</ul></details>`;
}

// EPA's names are in capitals: "CARY, TOWN OF" → "Town of Cary",
// "ORANGE WATER & SEWER AUTHORITY" → "Orange Water & Sewer Authority"
// (like Python's str.title(), plus moving "Town of" to the front).
// Words without vowels are short forms and stay in capitals ("WTP").
function systemName(raw) {
  const titled = raw.trim().split(/\s+/).map(word =>
    word.length >= 3 && !/[AEIOUY]/.test(word) ? word
      : word.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase())
  ).join(" ");
  const moved = titled.match(/^(.+?),? (Town|City|Village|County|Borough|Township) Of$/);
  const name = moved ? `${moved[2]} of ${moved[1]}` : titled;
  return escapeHtml(name.replace(/ Of /g, " of ").replace(/ And /g, " and "));
}

// At most 3 names: "A, B, C and 3 more"
function shortList(items) {
  if (items.length <= MAX_NAMES) return listText(items);
  return listText([...items.slice(0, MAX_NAMES), `${items.length - MAX_NAMES} more`]);
}

// ["A"] → "A", ["A", "B"] → "A and B", ["A", "B", "C"] → "A, B and C"
function listText(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
