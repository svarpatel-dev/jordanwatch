// Trend charts (decided Oct 13, every lake decided Oct 21): a small chart
// of the last 30 days of satellite readings on every Why card, with the
// WHO 1999/2003 levels shaded in the verdict colors. The bots save the
// history (scripts/fetch_cyan.py for Jordan Lake's 10 areas,
// scripts/fetch_lakes.py for every other lake); this file reads it and
// draws the chart as SVG (a picture made of shapes written as text, so it
// needs no chart library).
//
// It's a satellite estimate and a look back, never a forecast, and the
// chart says so.

import { escapeHtml, shortDate } from "./advice.js";
import { compactCells } from "./lake.js";

const JORDAN_FILE = "data/history/jordan.json";
const LAKES_FOLDER = "data/history/lakes";

// The chart shows this many days, ending today
const CHART_DAYS = 30;
// Readings this many days apart or closer are joined by a line; a longer
// gap (clouds, no pass) stays a gap
const JOIN_DAYS = 3;

// WHO 1999/2003 levels (cells/mL), the same as lake.js
const WHO_LOW_RISK = 20000;
const WHO_MODERATE_RISK = 100000;
// The chart's range (a log scale, like counting zeros): below detection
// sits at the bottom, 3 million at the top
const BOTTOM_CELLS = 3000;
const TOP_CELLS = 3000000;

// The chart's size in SVG units (it stretches to the card's width)
const WIDTH = 320;
const HEIGHT = 120;
const LEFT = 34;      // room for the 20k / 100k / 1M labels
const RIGHT = 6;
const TOP = 6;
const BOTTOM = 18;    // room for the dates

const DAY_MS = 1000 * 60 * 60 * 24;

// Each file once, like a Python dict used as a cache. Each value is a
// promise, so two cards asking at once share one download.
const files = new Map();

// --- Reading the history ---

// A Jordan Lake area's days: [{ date: "2026-10-20", cells: 672977 }, ...]
export async function areaHistory(areaId) {
  const file = await getFile(JORDAN_FILE);
  return (file.points[areaId] ?? []).map(([date, cells]) => ({ date, cells }));
}

// Any other lake's days, from its state's file (each lake is saved as
// [day, level, day, level, ...]: day = days since Jan 1, 1970, level =
// EPA's satellite level 0-253, which is shorter to save than cells/mL)
export async function lakeHistory(lake) {
  const file = await getFile(`${LAKES_FOLDER}/${lake.state}.json`);
  const pairs = file.lakes[lake.id] ?? [];
  const days = [];
  for (let i = 0; i < pairs.length; i += 2) {
    days.push({ date: new Date(pairs[i] * DAY_MS).toISOString().slice(0, 10), cells: levelToCells(pairs[i + 1]) });
  }
  return days;
}

// EPA's formula (the same as scripts/cyan_images.py); level 0 = below detection
function levelToCells(level) {
  return level === 0 ? 0 : Math.round(10 ** (0.012 * level - 4.2) * 1e8);
}

// A missing file (a state no bot run has saved yet) counts as no history
function getFile(path) {
  if (!files.has(path)) {
    const promise = fetch(path, { cache: "no-cache" }).then(response => {
      if (response.status === 404) return { points: {}, lakes: {} };
      if (!response.ok) throw new Error(`history request failed (HTTP ${response.status})`);
      return response.json();
    });
    // If it fails, try again next time
    promise.catch(() => files.delete(path));
    files.set(path, promise);
  }
  return files.get(path);
}

// --- Drawing ---

// Loads the days (load = areaHistory or lakeHistory, already given its
// area or lake) and draws the chart into element. today = "YYYY-MM-DD".
export async function showHistoryChart(element, load, today = todayText()) {
  try {
    const days = await load();
    element.innerHTML = chartHtml(days, today);
  } catch (error) {
    console.error("Failed to load the satellite history", error);
    element.innerHTML = `<p class="small">Couldn't load the last 30 days right now.</p>`;
  }
}

// The chart's whole box: a small heading, the SVG, and the numbers as a
// table one tap away (for anyone who can't see the chart)
export function chartHtml(allDays, today) {
  const first = addDays(today, -(CHART_DAYS - 1));
  const days = allDays.filter(d => d.date >= first && d.date <= today);
  const head = `<p class="trend-head">Last 30 days · Satellite estimate, not a forecast</p>`;
  if (days.length === 0) {
    return `${head}<p class="trend-empty">No satellite readings saved in the last 30 days yet</p>`;
  }
  const summary = summaryText(days);
  return `
    ${head}
    <svg class="trend-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(summary)}">
      <title>${escapeHtml(summary)}</title>
      ${bandsSvg()}
      ${axesSvg(first, today)}
      ${lineSvg(days, first)}
      ${dotsSvg(days, first)}
    </svg>
    <ul class="trend-key">
      <li><i class="key-low"></i>Low Risk</li><li><i class="key-caution"></i>Caution</li><li><i class="key-avoid"></i>Avoid</li>
      <li><i class="key-none"></i>Below detection</li>
    </ul>
    <details class="more"><summary>Readings (${days.length})</summary>
      <table class="trend-table"><thead><tr><th>Day</th><th>Cells/mL</th></tr></thead>
        <tbody>${[...days].reverse().map(d => `<tr><td>${shortDate(d.date)}</td><td>${cellsWords(d.cells)}</td></tr>`).join("")}</tbody>
      </table>
    </details>
  `;
}

// "12 readings in 30 days. Latest Oct 20: 673k cells/mL, Avoid level.
// Highest 990k. 9 at the Avoid level, 2 Caution, 1 Low Risk."
function summaryText(days) {
  const latest = days[days.length - 1];
  const highest = Math.max(...days.map(d => d.cells));
  const count = level => days.filter(d => levelOf(d.cells) === level).length;
  return `Satellite readings, last 30 days: ${days.length} ${days.length === 1 ? "day" : "days"} with a reading. ` +
    `Latest ${shortDate(latest.date)}: ${cellsWords(latest.cells)}, ${LEVEL_WORDS[levelOf(latest.cells)]} level. ` +
    `Highest: ${cellsWords(highest)}. ${count("avoid")} at the Avoid level, ${count("caution")} Caution, ${count("low")} Low Risk.`;
}

const LEVEL_WORDS = { avoid: "Avoid", caution: "Caution", low: "Low Risk" };

function levelOf(cells) {
  if (cells >= WHO_MODERATE_RISK) return "avoid";
  if (cells >= WHO_LOW_RISK) return "caution";
  return "low";
}

// The three bands behind the readings, each in its verdict's color
function bandsSvg() {
  const band = (from, to, tone) => {
    const top = y(to);
    return `<rect class="band-${tone}" x="${LEFT}" y="${top}" width="${WIDTH - LEFT - RIGHT}" height="${y(from) - top}"/>`;
  };
  return band(BOTTOM_CELLS, WHO_LOW_RISK, "low") + band(WHO_LOW_RISK, WHO_MODERATE_RISK, "caution") +
    band(WHO_MODERATE_RISK, TOP_CELLS, "avoid");
}

// The 20k / 100k / 1M labels on the left, and three dates along the bottom
function axesSvg(first, today) {
  const levels = [[WHO_LOW_RISK, "20k"], [WHO_MODERATE_RISK, "100k"], [1000000, "1M"]];
  const left = levels.map(([cells, label]) =>
    `<line class="grid" x1="${LEFT}" x2="${WIDTH - RIGHT}" y1="${y(cells)}" y2="${y(cells)}"/>` +
    `<text class="tick" x="${LEFT - 4}" y="${y(cells) + 3.5}" text-anchor="end">${label}</text>`).join("");
  const middle = addDays(first, Math.floor(CHART_DAYS / 2));
  const bottom = HEIGHT - 4;
  return left +
    `<text class="tick" x="${LEFT}" y="${bottom}">${shortDate(first)}</text>` +
    `<text class="tick" x="${x(middle, first)}" y="${bottom}" text-anchor="middle">${shortDate(middle)}</text>` +
    `<text class="tick" x="${WIDTH - RIGHT}" y="${bottom}" text-anchor="end">Today</text>`;
}

// A line between readings at most 3 days apart; longer gaps stay empty
function lineSvg(days, first) {
  const parts = [];
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i - 1].date, days[i].date) <= JOIN_DAYS) {
      parts.push(`M${x(days[i - 1].date, first)},${y(days[i - 1].cells)}L${x(days[i].date, first)},${y(days[i].cells)}`);
    }
  }
  return parts.length > 0 ? `<path class="trend-line" d="${parts.join("")}"/>` : "";
}

// One dot per reading (hollow = below detection), each with its own
// tooltip, and a bigger invisible circle around it so it's easy to tap
function dotsSvg(days, first) {
  return days.map(d => {
    const cx = x(d.date, first);
    const cy = y(d.cells);
    const tip = `${shortDate(d.date)}: ${cellsWords(d.cells)}`;
    return `<g class="trend-dot"><title>${tip}</title>
      <circle class="${d.cells === 0 ? "dot-none" : "dot-reading"}" cx="${cx}" cy="${cy}" r="4"/>
      <circle class="dot-hit" cx="${cx}" cy="${cy}" r="10"/></g>`;
  }).join("");
}

// --- Scales: a day → across, cells/mL → up (log, like counting zeros) ---
function x(date, first) {
  const share = daysBetween(first, date) / (CHART_DAYS - 1);
  return round(LEFT + share * (WIDTH - LEFT - RIGHT));
}

function y(cells) {
  const clamped = Math.min(Math.max(cells, BOTTOM_CELLS), TOP_CELLS);
  const share = Math.log10(clamped / BOTTOM_CELLS) / Math.log10(TOP_CELLS / BOTTOM_CELLS);
  return round(HEIGHT - BOTTOM - share * (HEIGHT - BOTTOM - TOP));
}

// --- Helpers ---

// 672977 → "673k cells/mL", 0 → "below detection"
function cellsWords(cells) {
  return cells === 0 ? "below detection" : `${compactCells(cells)} cells/mL`;
}

function round(number) {
  return Math.round(number * 10) / 10;
}

// "YYYY-MM-DD" dates, read as midnight UTC (like cyan.js)
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
}

function addDays(date, count) {
  return new Date(Date.parse(date + "T00:00:00Z") + count * DAY_MS).toISOString().slice(0, 10);
}

// Today's date where the user is, as "YYYY-MM-DD"
function todayText() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
}
