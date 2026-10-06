// Reads the satellite data file (cyan.json) that GitHub Actions refreshes
// every 6 hours, and works out how old each lake point's image is.
// Knows nothing about the page or the verdict rules.

const CYAN_FILE = "cyan.json";

export async function fetchCyanData() {
  // "no-cache" makes the browser check for a newer copy instead of
  // reusing an old one, so new satellite data shows up right away.
  const response = await fetch(CYAN_FILE, { cache: "no-cache" });

  if (!response.ok) {
    throw new Error(`Satellite data request failed (HTTP ${response.status})`);
  }

  const data = await response.json();

  return {
    updatedAt: data.updatedAt,
    points: data.points.map(point => ({
      ...point,
      imageAgeDays: getImageAgeDays(point.imageDate)
    }))
  };
}

// Whole days between a satellite image's date and today.
// Returns null when a point has no image.
function getImageAgeDays(imageDate) {
  if (!imageDate) return null;

  // imageDate is "YYYY-MM-DD"; read it as midnight UTC, the same way
  // fetch_cyan.py wrote it.
  const imageTime = new Date(imageDate + "T00:00:00Z").getTime();
  const ageMs = Date.now() - imageTime;
  return Math.floor(ageMs / (1000 * 60 * 60 * 24));
}
