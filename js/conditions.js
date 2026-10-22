// The top of the Lake tab (decided Oct 19, modeled on a weather app's
// "current conditions"): one big block in the verdict's color for the area
// or lake the user is looking at, and the rows of tiles (Jordan Lake's
// areas, lakes near you) to pick another one. Only draws.

import { icon, TREND_ICONS } from "./icons.js";
import { verdictLabel, verdictClass, shortDate, escapeHtml, leastAffectedText,
         VERDICT_NAMES, ACTION_CHIPS, actionSentence } from "./advice.js";
import { describeDistance } from "./nearyou.js";
import { compactCells } from "./lake.js";

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
// onHint (only when no place is chosen) opens the place search; star =
// { key, saved, onToggle } for the favorites star (decided Oct 22), or null
export function showAreaConditions(area, lake, where, onPick, onHint = null, star = null) {
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
    ? `<p class="now-line">${leastAffectedText(lake.leastAffected, lake.areas.length)}</p>`
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
         <span>Showing Jordan Lake · Search your ZIP or a lake</span></button>`
    : "";

  draw(area, `<strong>${area.name}</strong> <span>${where}</span>`, meta, allAvoid, go + hint, star, area.name);
  const goButton = document.querySelector("#now .now-go");
  if (goButton) goButton.addEventListener("click", () => onPick(goButton.dataset.area));
  const hintButton = document.querySelector("#now .now-hint");
  if (hintButton) hintButton.addEventListener("click", onHint);
}

// Any other lake. verdict = lakeVerdict() or combineLakeSignals() (lakes.js,
// lakesignals.js); where = e.g. "CA, 2.1 miles". options:
//   star        { key, saved, onToggle } for the favorites star, or null
//   better      betterLakeNearby() (lakes.js): another lake with a better
//               rating within about 30 miles, { lake: null } if none, or
//               null when the lake isn't at Avoid or Caution
//   onOpenLake  (id) => opens another lake
export function showLakeConditions(lake, verdict, where, { star = null, better = null, onOpenLake = null } = {}) {
  const meta = [];
  if (verdict.reading) {
    const highest = verdict.reading.max ? ` · peak ${compactCells(verdict.reading.max)} cells/mL` : "";
    meta.push(`<span>Satellite ${shortDate(verdict.reading.date)}${highest}</span>`);
  }

  // A beach on the same lake the wind isn't pushing algae toward (decided Oct 13)
  const beach = verdict.goInstead;
  const beachLine = beach
    ? `<p class="now-go now-go-text">Go to <strong>${beach.name ? escapeHtml(beach.name) : "an unnamed beach"}</strong>
         instead · ${verdictLabel(beach)} · wind not pushing algae there</p>`
    : "";
  // Another lake nearby with a better rating (decided Oct 21), or a short
  // line saying there isn't one
  let otherLake = "";
  if (better?.lake) {
    otherLake = `<button type="button" class="now-go now-go-lake" data-lake="${better.lake.id}">
         <span>Try <strong>${escapeHtml(better.lake.name)}</strong> instead (${verdictLabel(better.lake.verdict)} · ${describeDistance(better.km)})</span>
         ${icon("chevron-right")}
       </button>`;
  } else if (better) {
    otherLake = `<p class="now-line">No lake nearby has a better rating today</p>`;
  }

  // No verdict: the short reason (the whole sentence is on the Why card)
  const why = verdict.level ? "" : `<p class="now-line">${escapeHtml(verdict.satelliteHeadline)}</p>`;
  draw(verdict, `<strong>${escapeHtml(lake.name)}</strong> <span>${where}</span>`, meta, why, beachLine + otherLake,
       star, lake.name);
  const lakeButton = document.querySelector("#now .now-go-lake");
  if (lakeButton && onOpenLake) lakeButton.addEventListener("click", () => onOpenLake(Number(lakeButton.dataset.lake)));
}

// While the data loads, or when it can't load
export function showConditionsMessage(message) {
  const block = document.getElementById("now");
  block.className = "now now-none";
  block.innerHTML = `<p class="now-line">${message}</p>`;
}

// The block itself. item has a level (or a status when there's no
// verdict); the parts are already HTML. star = { key, saved, onToggle } or null;
// name = the area's or lake's plain name (for the star's label).
function draw(item, whereHtml, meta, extraLine, goHtml, star = null, name = "") {
  const block = document.getElementById("now");
  const enter = firstDraw ? " now-enter" : "";
  firstDraw = false;
  block.className = `now now-${verdictClass(item)}${enter}`;

  const word = item.level ? VERDICT_NAMES[item.level] : verdictLabel(item);

  block.innerHTML = `
    <div class="now-top">
      <p class="now-where">${whereHtml}</p>
      ${star ? starButtonHtml(star.saved, name, "now-star", star.key) : ""}
    </div>
    <p class="now-verdict${item.level ? "" : " now-verdict-none"}">${word}</p>
    <p class="now-meta">${meta.join("")}</p>
    ${extraLine}
    ${chipsHtml(item)}
    ${goHtml}
  `;
  if (star) {
    const button = block.querySelector(".now-star");
    button.addEventListener("click", () => setStarPressed(button, star.onToggle()));
  }
}

// The favorites star (decided Oct 22): an outline star, filled when saved.
// aria-pressed tells screen readers whether it's on, like a checkbox.
// fav = the favorites key, kept on a tile's star (data-fav) for its tap.
function starButtonHtml(saved, name, className, fav = "") {
  return `<button type="button" class="star-button ${className}" aria-pressed="${saved}" data-fav="${fav}"
    aria-label="Save ${escapeHtml(name)} to Your lakes" title="${saved ? "Saved to Your lakes" : "Save to Your lakes"}">${icon("star", "md")}</button>`;
}

// After a tap: show the new state (onToggle returns true when it's now saved)
function setStarPressed(button, saved) {
  button.setAttribute("aria-pressed", String(saved));
  button.title = saved ? "Saved to Your lakes" : "Save to Your lakes";
}

// What to do, as a 2x2 grid of chips (decided Oct 21): an icon and 2-3
// words each. The whole sentence (with Avoid's "if you see scum" line) is
// the list's label for screen readers and its tooltip, so nothing is lost.
function chipsHtml(item) {
  const chips = ACTION_CHIPS[item.level ?? "none"];
  const sentence = escapeHtml(actionSentence(item));
  // map + join builds one string from the list, like Python's
  // "".join(f"<li>...</li>" for name, words in chips)
  const items = chips.map(([name, words]) => `<li class="chip">${icon(name, "md")}<span>${words}</span></li>`);
  return `<ul class="now-chips" aria-label="What to do: ${sentence}" title="${sentence}">${items.join("")}</ul>`;
}

// A row of tiles. items = [{ key, name, level, status, sub, fav }],
// selectedKey = the one being looked at; onPick(key) when one is tapped.
// star = { isSaved(fav), onToggle(fav) } adds a favorites star to each tile
// (fav = its favorites key, e.g. "lake:2300042"); null for no stars.
export function showTiles(container, items, selectedKey, onPick, star = null) {
  container.innerHTML = items.map(item => `
    <div class="tile-wrap">
      <button type="button" class="tile" data-key="${item.key}" aria-pressed="${item.key === selectedKey}">
        <span class="dot" style="--dot: ${dotColor(item)}"></span>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${verdictLabel(item)}</span>
        <small>${item.sub}</small>
      </button>
      ${star && item.fav ? starButtonHtml(star.isSaved(item.fav), item.name, "tile-star", item.fav) : ""}
    </div>
  `).join("");
  for (const tile of container.querySelectorAll(".tile")) {
    tile.addEventListener("click", () => onPick(tile.dataset.key));
  }
  for (const button of container.querySelectorAll(".tile-star")) {
    button.addEventListener("click", () => setStarPressed(button, star.onToggle(button.dataset.fav)));
  }
}

// The small line on a Jordan Lake area's tile: "beach · 229k" or "no beach"
export function areaTileSub(area) {
  const beach = area.swimBeach ? "beach" : "no beach";
  if (area.cellsPerMl === null) return beach;
  return `${beach} · ${tileCells(area.cellsPerMl)}`;
}

// The small line on a lake's tile: "NC, 4.2 miles", or just "NC"
export function lakeTileSub(lake, km) {
  return km === null ? lake.state : `${lake.state}, ${describeDistance(km)}`;
}

// The dot's color: by verdict, gray when there's no verdict
function dotColor(item) {
  return DOT_COLORS[item.level ?? "none"];
}

// 229,312 → "229k" (compactCells in lake.js), 0 → "below detection"
function tileCells(cells) {
  return cells === 0 ? "below detection" : compactCells(cells);
}
