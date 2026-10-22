// The app's icons (decided Oct 19: no emoji icons). They're drawn once, as
// <symbol>s in the icon sprite at the bottom of index.html; this makes the
// small piece of HTML that shows one of them, like calling a function
// that returns a string in Python.

// icon("wind") → <svg class="i"><use href="#i-wind"></use></svg>
// size: "sm" (16 px, the default), "md" (20 px) or "lg" (24 px)
export function icon(name, size = "sm") {
  return `<svg class="i i-${size}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

// The icon for each kind of "why" row (lake.js and lakesignals.js sources)
export const SIGNAL_ICONS = {
  satellite: "satellite",
  runoff: "rain",
  "lake-level": "gauge",
  wind: "wind",
  camera: "camera",
  note: "info"
};

// The trend arrow between the last two satellite images (decided Oct 12)
export const TREND_ICONS = {
  worse: "trend-up",
  steady: "trend-flat",
  better: "trend-down"
};
