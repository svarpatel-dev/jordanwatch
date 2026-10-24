// The guided tour (decided Oct 24): walks through the real app, one part
// at a time. The page goes dark except a bright "spotlight" around one
// part, and a small card next to it says what that part does.
//
// It scrolls and switches tabs by itself. Steps whose part isn't on the
// screen right now (no "Go here instead" today, no tap water card before
// a place is chosen) are skipped, so the spotlight never points at nothing.
// At the end it always puts the app back: sheets closed, full map closed,
// the Lake tab, scrolled to the top.
//
// Python parallel: STEPS is a list of dicts; goTo() is like a for loop
// you can step through forward and back with the buttons.

import { showTab } from "./screens.js";

// Each step: the tab it's on, the parts to light up (CSS selectors; more
// than one = one box around all of them), a title, and 1-2 short lines,
// each a [label, sentence] pair.
const STEPS = [
  {
    tab: "lake", targets: ["#place-button"],
    title: "Choose your place",
    lines: [["Tap it", "Type a ZIP code or a lake name, or use your location."],
            ["Privacy", "Your exact location stays on this phone."]]
  },
  {
    tab: "lake", targets: ["#favorites"],
    title: "Your lakes",
    lines: [["Saved lakes", "The lakes and areas you starred, first."],
            ["Tap one", "Opens its rating."]]
  },
  {
    tab: "lake", targets: ["#now .now-where", "#now .now-verdict", "#now .now-meta"],
    title: "Today's rating",
    lines: [["Rating", "Avoid, Caution or Low Risk for harmful algal blooms."],
            ["Below it", "The satellite image date, and whether it's getting better or worse."]]
  },
  {
    tab: "lake", targets: ["#now .now-star"],
    title: "Save this lake",
    lines: [["Star", "Tap it to save this lake or area."],
            ["Your lakes", "Saved ones appear in a row at the top, on this phone only."]]
  },
  {
    tab: "lake", targets: ["#now .now-chips"],
    title: "What to do today",
    lines: [["Tips", "Short advice for people, kids and dogs."],
            ["Example", "Whether swimming or boating is OK, and to rinse off after contact."]]
  },
  {
    tab: "lake", targets: ["#now .now-go"],
    title: "A better spot nearby",
    lines: [["Go here instead", "The nearest area or lake with a better rating today."],
            ["Only sometimes", "It shows only when a nearby spot rates better."]]
  },
  {
    tab: "lake", targets: ["#row-title", "#tiles"],
    title: "Areas and lakes",
    lines: [["Tiles", "One per area or nearby lake, with its rating."],
            ["Tap one", "Its rating, Why and What to do fill the page."]]
  },
  {
    tab: "lake", targets: [".legend-strip"],
    title: "Satellite colors",
    lines: [["Colors", "Algae the satellite saw this past week: yellow is low, red and purple are very high."],
            ["No color", "Clean water, clouds or no satellite pass."]]
  },
  {
    tab: "lake", targets: ["#map", "#full-map-button"],
    title: "Rating pins",
    lines: [["Pins", "Every lake has a pin in its rating's color. Gray means no recent reading."],
            ["Tap a pin", "Opens that lake. Full map shows a bigger view."]]
  },
  {
    tab: "lake", targets: ["#why .why-grid"],
    title: "Why this rating",
    lines: [["One card per signal", "Satellite algae, rain and river flow, lake level, wind."],
            ["Worst wins", "The worst signal sets the rating. Tap Details for the numbers."]]
  },
  {
    tab: "lake", targets: ["#why .trend-chart"],
    title: "The last 30 days",
    lines: [["Dots", "Each one is a satellite reading, colored by its rating."],
            ["Readings", "Tap Readings for the full list."]]
  },
  {
    tab: "lake", targets: ["#todo > h2", "#todo .todo-row"],
    title: "What to do",
    lines: [["Suggested", "Activities that are OK today."],
            ["Not suggested", "What to skip until the rating improves."]]
  },
  {
    tab: "lake", targets: ["#todo > a.button-line"],
    title: "Report a bloom",
    lines: [["Seeing a bloom?", "This opens your state's way to report it."],
            ["No place chosen", "It opens EPA's list of state programs."]]
  },
  {
    tab: "lake", targets: ["#tap-title", "#tap-body .pick-card", "#tap-body .tap-lakes"],
    title: "Your tap water",
    lines: [["Source", "The lake your water likely comes from. Context only, not a tap-water rating."],
            ["On the map", "A droplet marks that lake."]]
  },
  {
    tab: "lake", targets: ["#near-lakes-title", "#near-lakes"],
    title: "Lakes nearby",
    lines: [["Closest lakes", "Each with its rating."],
            ["Tap one", "Opens that lake."]]
  },
  {
    tab: "lake", targets: ["#stations-title", "#stations-card > .card-desc"],
    title: "Live stations",
    lines: [["Sensors", "Live USGS readings like oxygen, pH, turbidity and flow."],
            ["Judged by", "Each station's own state standards."]]
  },
  {
    tab: "lake", targets: ["#exposed-button"],
    title: "If exposed",
    lines: [["Touched bloom water?", "Steps for people and pets, and numbers to call."]]
  },
  {
    tab: "lake", targets: [".tabbar [data-tab='scan']"],
    title: "The Scan tab",
    lines: [["At the shore", "Satellites can't see the shoreline or small ponds. Your camera can."]]
  },
  {
    tab: "scan", targets: [".scan-actions"],
    title: "Scan the water",
    lines: [["Live", "Tap Start camera, aim at the water, then tap Scan."],
            ["Photo", "Or use a photo. A screening aid, not a diagnosis."]]
  },
  {
    tab: "more", targets: ["#directory-title", ".directory .card-desc", ".directory li:nth-child(-n+3)"],
    title: "The More tab",
    lines: [["Every feature", "Listed here, with where to find it."],
            ["Further down", "How it works, data sources and About."]]
  },
  {
    tab: "more", targets: ["#intro-button"],
    title: "Reopen the guide",
    lines: [["(i) button", "Reopens the 6-card guide."],
            ["This tour", "Start it again from the More tab."]]
  }
];

const GAP = 12;        // space between the spotlight and the card
const PAD = 6;         // the spotlight's margin around its part
const EDGE = 8;        // the card never comes closer than this to the screen edge

let active = false;
let steps = [];        // the steps that exist on this screen today
let index = 0;
let opener = null;     // the button that started the tour (focus goes back there)
let layer, spot, card, arrow, titleEl, countEl, bodyEl, backButton, nextButton;
let frame = 0;
let resizeWatch = null;

// --- Starting and ending ---

export function startTour() {
  if (active) return;
  active = true;
  opener = document.activeElement;
  buildLayer();

  // Start clean: no open sheet or intro, no full map, the Lake tab at the top
  closeEverything();
  showTab("lake");
  window.scrollTo(0, 0);

  // The page behind can't be clicked or tabbed into while the tour runs
  for (const part of pageParts()) part.inert = true;

  steps = STEPS.filter(stepExists);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", schedulePlace);
  window.addEventListener("scroll", schedulePlace, { passive: true });
  resizeWatch = new ResizeObserver(schedulePlace);
  resizeWatch.observe(document.querySelector("main"));

  layer.hidden = false;
  goTo(0, 1);
}

export function endTour() {
  if (!active) return;
  active = false;
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", schedulePlace);
  window.removeEventListener("scroll", schedulePlace);
  resizeWatch?.disconnect();
  layer.hidden = true;
  for (const part of pageParts()) part.inert = false;

  // Put the app back the way it opens
  closeEverything();
  showTab("lake");
  window.scrollTo(0, 0);
  const back = opener && document.contains(opener) && opener.offsetParent !== null
    ? opener : document.getElementById("intro-button");
  back.focus({ preventScroll: true });
}

export function tourIsOn() {
  return active;
}

function pageParts() {
  return [document.querySelector(".topbar"), document.querySelector("main"), document.querySelector(".tabbar")];
}

function closeEverything() {
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  // The full map: its own button closes it (main.js knows what to undo)
  if (document.getElementById("sat-card").classList.contains("is-full")) {
    document.getElementById("full-map-button").click();
  }
}

// --- Moving between steps ---

// direction: +1 going forward, -1 going back (a missing step is skipped
// the same way)
function goTo(newIndex, direction) {
  let i = newIndex;
  while (i >= 0 && i < steps.length) {
    switchTab(steps[i].tab);
    if (visibleParts(steps[i]).length > 0) break;
    // Gone since the tour started (the page re-drew): drop it
    steps.splice(i, 1);
    if (direction < 0) i -= 1;
  }
  if (i < 0 || i >= steps.length) {
    if (direction > 0 || steps.length === 0) {
      endTour();
    } else {
      goTo(0, 1);
    }
    return;
  }
  index = i;
  fillCard();
  scrollToStep();
  place();
  nextButton.focus({ preventScroll: true });
}

function switchTab(name) {
  if (document.getElementById(`tab-${name}`).hidden) showTab(name);
}

// A step exists if at least one of its parts is on the page and not
// hidden. Parts on the Scan and More tabs are inside a hidden tab until
// the tour switches to it, so the tab itself doesn't count.
function stepExists(step) {
  return step.targets.some(selector => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const hiddenParent = element.closest("[hidden]");
    if (hiddenParent && !hiddenParent.classList.contains("tab")) return false;
    if (hiddenParent) return true;
    return element.getClientRects().length > 0;
  });
}

function visibleParts(step) {
  return step.targets
    .map(selector => document.querySelectorAll(selector))
    .flatMap(list => [...list])
    .filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
}

// --- Drawing ---

function buildLayer() {
  if (layer) return;
  layer = document.createElement("div");
  layer.className = "tour";
  layer.hidden = true;
  layer.innerHTML = `
    <div class="tour-catch"></div>
    <div class="tour-spot"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <span class="tour-arrow" aria-hidden="true"></span>
      <div class="tour-top">
        <p class="tour-count" id="tour-count"></p>
        <button type="button" class="tour-end">End tour</button>
      </div>
      <div class="tour-text" aria-live="polite">
        <h2 id="tour-title" class="tour-title"></h2>
        <ul class="tour-lines"></ul>
      </div>
      <div class="tour-nav">
        <button type="button" class="button-line tour-back">Back</button>
        <button type="button" class="button-solid tour-next">Next</button>
      </div>
    </div>`;
  document.body.append(layer);
  spot = layer.querySelector(".tour-spot");
  card = layer.querySelector(".tour-card");
  arrow = layer.querySelector(".tour-arrow");
  titleEl = layer.querySelector(".tour-title");
  countEl = layer.querySelector(".tour-count");
  bodyEl = layer.querySelector(".tour-lines");
  backButton = layer.querySelector(".tour-back");
  nextButton = layer.querySelector(".tour-next");
  backButton.addEventListener("click", () => goTo(index - 1, -1));
  nextButton.addEventListener("click", () => goTo(index + 1, 1));
  layer.querySelector(".tour-end").addEventListener("click", endTour);
}

function fillCard() {
  const step = steps[index];
  countEl.textContent = `Step ${index + 1} of ${steps.length}`;
  titleEl.textContent = step.title;
  bodyEl.innerHTML = "";
  for (const [label, sentence] of step.lines) {
    const line = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = `${label}. `;
    line.append(strong, sentence);
    bodyEl.append(line);
  }
  backButton.disabled = index === 0;
  nextButton.textContent = index === steps.length - 1 ? "Done" : "Next";
}

// The part of the screen not covered by the sticky header or the tab bar
function safeZone() {
  const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
  const bottom = document.querySelector(".tabbar").getBoundingClientRect().top;
  return { top, bottom };
}

// One box around all of a step's parts (screen coordinates)
function unionBox(parts) {
  const boxes = parts.map(part => part.getBoundingClientRect());
  const left = Math.min(...boxes.map(b => b.left));
  const top = Math.min(...boxes.map(b => b.top));
  const right = Math.max(...boxes.map(b => b.right));
  const bottom = Math.max(...boxes.map(b => b.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Parts in the header or the tab bar never scroll; neither does the
// laptop's sticky map once it's stuck
function isFixed(parts) {
  return parts.every(part => part.closest(".topbar, .tabbar"));
}

// Scroll so the part and the card both fit between the header and the tab bar
function scrollToStep() {
  const parts = visibleParts(steps[index]);
  if (isFixed(parts)) return;
  const box = unionBox(parts);
  const zone = safeZone();
  const room = zone.bottom - zone.top;
  const cardHeight = card.getBoundingClientRect().height || 180;

  const fullyIn = box.top >= zone.top + 4 && box.bottom <= zone.bottom - 4;
  const fitsBelow = zone.bottom - box.bottom >= cardHeight + GAP + 8;
  const fitsAbove = box.top - zone.top >= cardHeight + GAP + 8;
  const fitsBeside = window.innerWidth - box.right >= 300 || box.left >= 300;
  if (fullyIn && (fitsBelow || fitsAbove || fitsBeside)) return;

  let wantTop;
  if (box.height + cardHeight + GAP + 24 <= room) {
    wantTop = zone.top + 16;                  // the part near the top, the card under it
  } else {
    wantTop = zone.top + 8;                   // too tall for both: show its top
  }
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: window.scrollY + box.top - wantTop, behavior: smooth ? "smooth" : "auto" });
}

function schedulePlace() {
  if (!active) return;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(place);
}

// Put the spotlight over the part and the card next to it
function place() {
  if (!active) return;
  const parts = visibleParts(steps[index]);
  if (parts.length === 0) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const zone = safeZone();
  const fixed = isFixed(parts);
  const box = unionBox(parts);

  // The spotlight: the part plus a margin, kept on screen (and, for parts
  // that scroll, out from under the header and the tab bar)
  const minTop = fixed ? 0 : zone.top;
  const maxBottom = fixed ? height : zone.bottom;
  const s = {
    left: Math.max(2, box.left - PAD),
    top: Math.max(minTop + 2, box.top - PAD),
    right: Math.min(width - 2, box.right + PAD),
    bottom: Math.min(maxBottom - 2, box.bottom + PAD)
  };
  if (s.bottom < s.top + 8) s.bottom = s.top + 8;   // scrolled away: keep a sliver
  spot.style.left = `${s.left}px`;
  spot.style.top = `${s.top}px`;
  spot.style.width = `${s.right - s.left}px`;
  spot.style.height = `${s.bottom - s.top}px`;

  // The card: below, above, right, left; otherwise over the bottom of the part
  const cardWidth = Math.min(340, width - 2 * EDGE);
  card.style.width = `${cardWidth}px`;
  const cardHeight = card.getBoundingClientRect().height;
  const lowest = Math.min(height, zone.bottom) - EDGE;
  const highest = Math.max(0, zone.top) + EDGE;
  let side;
  let x;
  let y;
  if (lowest - s.bottom >= cardHeight + GAP) {
    side = "below"; y = s.bottom + GAP;
  } else if (s.top - highest >= cardHeight + GAP) {
    side = "above"; y = s.top - GAP - cardHeight;
  } else if (width - s.right >= cardWidth + GAP + EDGE) {
    side = "right"; x = s.right + GAP;
  } else if (s.left >= cardWidth + GAP + EDGE) {
    side = "left"; x = s.left - GAP - cardWidth;
  } else {
    side = "over"; y = lowest - cardHeight;
  }
  if (side === "below" || side === "above" || side === "over") {
    x = (s.left + s.right) / 2 - cardWidth / 2;
  } else {
    y = (s.top + s.bottom) / 2 - cardHeight / 2;
  }
  x = clamp(x, EDGE, width - cardWidth - EDGE);
  y = clamp(y, highest, Math.max(highest, lowest - cardHeight));
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;

  // The arrow sits on the card's edge, pointing at the middle of the part
  arrow.dataset.side = side;
  arrow.hidden = side === "over";
  if (side === "below" || side === "above") {
    arrow.style.left = `${clamp((s.left + s.right) / 2 - x, 18, cardWidth - 18)}px`;
    arrow.style.top = "";
  } else {
    arrow.style.top = `${clamp((s.top + s.bottom) / 2 - y, 18, cardHeight - 18)}px`;
    arrow.style.left = "";
  }
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

// --- Keyboard ---

function onKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    endTour();
  } else if (event.key === "ArrowRight") {
    goTo(index + 1, 1);
  } else if (event.key === "ArrowLeft" && index > 0) {
    goTo(index - 1, -1);
  } else if (event.key === "Tab") {
    // Keep the keyboard inside the card (the page behind is inert)
    const buttons = [...card.querySelectorAll("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement);
    event.preventDefault();
    const next = event.shiftKey ? at - 1 : at + 1;
    buttons[(next + buttons.length) % buttons.length].focus();
  }
}
