// The top of the Lake tab (decided Oct 19, modeled on a weather app's
// "current conditions"): one big block in the verdict's color for the area
// or lake the user is looking at, and the rows of tiles (Jordan Lake's
// areas, lakes near you) to pick another one. Only draws.

import { icon, TREND_ICONS } from "./icons.js";
import { verdictLabel, activitiesFor, verdictClass, shortDate, escapeHtml, leastAffectedText,
         VERDICT_NAMES, NO_VERDICT_ADVICE, AVOID_SIGHTING } from "./advice.js";
import { describeDistance } from "./nearyou.js";

const TREND_WORDS = {
  worse: "getting worse",
  steady: "about the same",
  better: "getting better"
};

// The colored dot on a tile: the same colors as the map pins
const DOT_COLORS = {
  avoid: "var(--avoid)",
  caution: "var(--caution)",
  low: "var(--low)",
  none: "var(--nodata)"
};

// The block's color fills in only the first time it's drawn (the one load
// animation, decided Oct 19)
let firstDraw = true;

// A Jordan Lake area. area = one of computeLakeVerdicts()'s areas; lake =
// the whole result (for the all-Avoid line); where = the small words after
// its name, e.g. "nearest area, 6.3 miles"; onPick(id) opens another area;
// onHint (only when no place is chosen) opens the place search
export function showAreaConditions(area, lake, where, onPick, onHint = null) {
  const meta = [];
  if (area.imageDate) {
    const cells = area.cellsPerMl === 0 ? "below detection" : `${area.cellsPerMl.toLocaleString()} cells/mL`;
    meta.push(`<span>Satellite ${shortDate(area.imageDate)} · ${cells}</span>`);
  } else {
    meta.push("<span>No recent satellite reading</span>");
  }
  if (area.trend) {
    meta.push(`<span>${icon(TREND_ICONS[area.trend.direction])} ${TREND_WORDS[area.trend.direction]}</span>`);
  }

  // Every area at Avoid (decided Oct 13): where the reading is lowest,
  // still Avoid, never a suggestion to swim
  const allAvoid = lake.leastAffected
    ? `<p class="now-line">${leastAffectedText(lake.leastAffected)}</p>`
    : "";

  const go = area.goInstead
    ? `<button type="button" class="now-go" data-area="${area.goInstead.id}">
         <span>Go to <strong>${area.goInstead.name}</strong> instead (${verdictLabel(area.goInstead)}${area.goInstead.swimBeach ? ", swim beach" : ""})</span>
         ${icon("chevron-right")}
       </button>`
    : "";

  // No place chosen: Jordan Lake is the example (decided Oct 19), and this
  // line says how to see your own lake
  const hint = onHint
    ? `<button type="button" class="now-hint">${icon("search")}
         <span>Showing Jordan Lake. Search your ZIP or a lake to see yours.</span></button>`
    : "";

  draw(area, `<strong>${area.name}</strong> <span>${where}</span>`, meta, allAvoid, go + hint);
  const goButton = document.querySelector("#now .now-go");
  if (goButton) goButton.addEventListener("click", () => onPick(goButton.dataset.area));
  const hintButton = document.querySelector("#now .now-hint");
  if (hintButton) hintButton.addEventListener("click", onHint);
}

// Any other lake. verdict = lakeVerdict() or combineLakeSignals() (lakes.js,
// lakesignals.js); where = e.g. "CA, 2.1 miles"
export function showLakeConditions(lake, verdict, where) {
  const meta = [];
  if (verdict.reading) {
    const highest = verdict.reading.max ? ` · highest pixel ${verdict.reading.max.toLocaleString()} cells/mL` : "";
    meta.push(`<span>Satellite ${shortDate(verdict.reading.date)}${highest}</span>`);
  }

  // A beach on the same lake the wind isn't pushing algae toward (decided Oct 13)
  const beach = verdict.goInstead;
  const go = beach
    ? `<p class="now-go now-go-text">Go to <strong>${beach.name ? escapeHtml(beach.name) : "an unnamed beach"}</strong>
         instead (${verdictLabel(beach)}): the wind isn't pushing algae toward it.</p>`
    : "";

  // No verdict: the reason why, in the gray block
  const why = verdict.level ? "" : `<p class="now-line">${escapeHtml(verdict.reasons[0])}</p>`;
  draw(verdict, `<strong>${escapeHtml(lake.name)}</strong> <span>${where}</span>`, meta, why, go);
}

// While the data loads, or when it can't load
export function showConditionsMessage(message) {
  const block = document.getElementById("now");
  block.className = "now now-none";
  block.innerHTML = `<p class="now-line">${message}</p>`;
}

// The block itself. item has a level (or a status when there's no
// verdict); the parts are already HTML.
function draw(item, whereHtml, meta, extraLine, goHtml) {
  const block = document.getElementById("now");
  const enter = firstDraw ? " now-enter" : "";
  firstDraw = false;
  block.className = `now now-${verdictClass(item)}${enter}`;

  const word = item.level ? VERDICT_NAMES[item.level] : verdictLabel(item);
  // Every Avoid also says what to do if you can see a bloom (decided Oct 21)
  const action = item.level ? activitiesFor(item).action : NO_VERDICT_ADVICE;
  const sighting = item.level === "avoid" ? ` ${AVOID_SIGHTING}` : "";

  block.innerHTML = `
    <p class="now-where">${whereHtml}</p>
    <p class="now-verdict${item.level ? "" : " now-verdict-none"}">${word}</p>
    <p class="now-meta">${meta.join("")}</p>
    ${extraLine}
    <p class="now-action">${icon("waves", "md")}<span>${action}${sighting}</span></p>
    ${goHtml}
  `;
}

// A row of tiles. items = [{ key, name, level, status, sub }],
// selectedKey = the one being looked at; onPick(key) when one is tapped
export function showTiles(container, items, selectedKey, onPick) {
  container.innerHTML = items.map(item => `
    <button type="button" class="tile" data-key="${item.key}" aria-pressed="${item.key === selectedKey}">
      <span class="dot" style="--dot: ${dotColor(item)}"></span>
      <strong>${escapeHtml(item.name)}</strong>
      <span>${verdictLabel(item)}</span>
      <small>${item.sub}</small>
    </button>
  `).join("");
  for (const tile of container.querySelectorAll(".tile")) {
    tile.addEventListener("click", () => onPick(tile.dataset.key));
  }
}

// The small line on a Jordan Lake area's tile: "beach · 229k" or "no beach"
export function areaTileSub(area) {
  const beach = area.swimBeach ? "beach" : "no beach";
  if (area.cellsPerMl === null) return beach;
  return `${beach} · ${compactCells(area.cellsPerMl)}`;
}

// The small line on a lake's tile: "NC, 4.2 miles", or just "NC"
export function lakeTileSub(lake, km) {
  return km === null ? lake.state : `${lake.state}, ${describeDistance(km)}`;
}

// The dot's color: by verdict, gray when there's no verdict
function dotColor(item) {
  return DOT_COLORS[item.level ?? "none"];
}

// 229,312 → "229k", 1,250,000 → "1.3M", 0 → "below detection"
function compactCells(cells) {
  if (cells === 0) return "below detection";
  if (cells < 1000) return String(cells);
  if (cells < 1000000) return `${Math.round(cells / 1000)}k`;
  return `${(cells / 1000000).toFixed(1)}M`;
}
