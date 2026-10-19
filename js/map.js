// The Jordan Lake map: a pin for each area colored by its verdict, gray
// markers where the satellite can't see, and the drinking-water intake.
// Uses Leaflet (loaded in index.html) with OpenStreetMap map tiles.

export const PIN_COLORS = {
  avoid: "#d93025",   // red
  caution: "#e8a200", // amber
  low: "#1e8e3e"      // green
};

// Avoid pins get darker as the satellite reading gets worse (decided Oct 13),
// in the same colors as the satellite legend below. An Avoid with no severity
// (raised by wind or a camera scan) keeps the plain red.
export const AVOID_SEVERITY_COLORS = {
  high: "#f03b20",
  "very-high": "#bd0026",
  extreme: "#54278f"
};

const PIN_LABELS = {
  avoid: "Avoid",
  caution: "Caution",
  low: "Low Risk"
};

// Same words as the area cards: "Avoid: very high"
const SEVERITY_LABELS = {
  high: "high",
  "very-high": "very high",
  extreme: "extreme"
};

// Parts of the lake the satellite can't see, because its 300 m pixels
// there touch land (decided Oct 3). Approximate spots for gray markers.
const NO_COVERAGE = [
  { name: "Northern tip of the New Hope arm", lat: 35.830, lng: -78.990 },
  { name: "Haw River arm", lat: 35.705, lng: -79.070 },
  { name: "Southern end, toward the dam", lat: 35.688, lng: -79.040 }
];

// Cary/Apex drinking-water intake (approximate; context only)
const INTAKE = { lat: 35.7385, lng: -79.0222 };

// The nationwide satellite severity layer (decided Oct 12-13): tiles made by
// scripts/make_tiles.py on every deploy, showing each spot's newest bloom
// detection from the past week (clean water and clouds have no color; bug 13,
// Oct 16). The legend uses the same colors and levels.
const SATELLITE_TILES = "tiles/{z}/{x}/{y}.png";
const SATELLITE_INFO = "tiles/info.json";
const SEVERITY_LEGEND = [
  { color: "#fff1a8", label: "Low Risk", detail: "under 20,000" },
  { color: "#fec44f", label: "Caution", detail: "20,000–50,000" },
  { color: "#fd8d3c", label: "Caution", detail: "50,000–100,000" },
  { color: "#f03b20", label: "Avoid", detail: "100,000–500,000" },
  { color: "#bd0026", label: "Avoid", detail: "500,000–1 million" },
  { color: "#54278f", label: "Avoid", detail: "over 1 million" }
];

// How close the map zooms in on the user's place: GPS is precise, a ZIP
// code's middle is only roughly where they are
const GPS_ZOOM = 11;
const ZIP_ZOOM = 10;
// Far from Jordan Lake (any place), zoom out so the satellite colors of the
// lakes around the user show (decided Oct 15)
const FAR_ZOOM = 9;
// How far above the map's middle the "You are here" dot sits (pixels)
const DOT_ABOVE_MIDDLE_PX = 90;

// The map is built once; after that only the area pins are redrawn (e.g.
// when a camera scan changes a verdict). Leaflet can't set up the same
// map box twice.
let map = null;
let pinLayer = null;

// "See what's near you": the user's place and how far to zoom in. It can
// arrive before the map is built (a saved ZIP loads fast), so it's kept here
// and drawn as soon as the map exists.
let youAreHere = null;
let hereZoom = null;
let hereLayer = null;

// The area pins' spots, to zoom back to Jordan Lake after "Clear"
let lakeView = null;

export function showMap(lake, areas) {
  // Leaflet is a regular <script> in index.html, so it lives on window.L
  const L = window.L;

  const firstTime = map === null;
  if (firstTime) {
    map = L.map("map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    addFixedMarkers(L);
    pinLayer = L.layerGroup().addTo(map);
    hereLayer = L.layerGroup().addTo(map);

    // Not awaited: the pins show right away, the satellite colors when ready
    addSatelliteLayer(L).catch(error => console.error("Failed to add the satellite layer", error));
  }
  pinLayer.clearLayers();

  // Look up each area's verdict by id
  const verdictsById = Object.fromEntries(lake.areas.map(v => [v.id, v]));
  const pinSpots = [];

  // One colored pin per area; tapping it opens that area's card below
  for (const area of areas) {
    const verdict = verdictsById[area.id];
    if (!verdict) continue;

    // severity is only set for Avoid areas, so other pins keep their color
    const fill = AVOID_SEVERITY_COLORS[verdict.severity] ?? PIN_COLORS[verdict.level];
    const severity = verdict.severity ? `: ${SEVERITY_LABELS[verdict.severity]}` : "";

    const pin = L.circleMarker([area.lat, area.lng], {
      radius: 10,
      color: "#ffffff",
      weight: 2,
      fillColor: fill,
      fillOpacity: 0.9
    }).addTo(pinLayer);

    pin.bindTooltip(`${area.name}: ${PIN_LABELS[verdict.level]}${severity}`);
    pin.on("click", () => openAreaCard(area.id));
    pinSpots.push([area.lat, area.lng]);
  }

  // Zoom the map so every area pin fits on screen (only the first time,
  // so a redraw doesn't jump away from where the user has panned). If the
  // user already chose a place, center on it instead.
  if (firstTime) {
    lakeView = pinSpots;
    if (youAreHere) {
      drawYouAreHere();
    } else {
      map.fitBounds(lakeView, { padding: [20, 20] });
    }
  }
}

// Put the "You are here" dot on the map and center on it.
// place = { lat, lng, source: "gps" or "zip", accuracyM (GPS) or zip (ZIP) };
// nearLake = true when it's close to a Jordan Lake area
export function showYouAreHere(place, nearLake) {
  youAreHere = place;
  if (!nearLake) {
    hereZoom = FAR_ZOOM;
  } else {
    hereZoom = place.source === "gps" ? GPS_ZOOM : ZIP_ZOOM;
  }
  if (map !== null) {
    drawYouAreHere();
  }
}

// Remove the dot and zoom back out to Jordan Lake
export function clearYouAreHere() {
  youAreHere = null;
  if (map !== null) {
    hereLayer.clearLayers();
    map.fitBounds(lakeView, { padding: [20, 20] });
  }
}

// A plain dot for now (decided Oct 11; its own look comes in the design
// pass). With GPS, a light circle shows how accurate the location is.
function drawYouAreHere() {
  const L = window.L;
  const place = youAreHere;
  hereLayer.clearLayers();

  if (place.accuracyM) {
    L.circle([place.lat, place.lng], {
      radius: place.accuracyM,
      color: "#1a73e8",
      weight: 1,
      fillOpacity: 0.1,
      interactive: false   // taps go through to the pins underneath
    }).addTo(hereLayer);
  }

  // A <div> drawn by CSS (.you-are-here in styles.css), not an image
  const dot = L.divIcon({ className: "you-are-here", iconSize: [18, 18] });
  const label = place.source === "zip" ? `Near ZIP ${place.zip}` : "You are here";
  L.marker([place.lat, place.lng], { icon: dot }).addTo(hereLayer).bindTooltip(label);

  map.setView([place.lat, place.lng], hereZoom, { animate: false });
  // Then slide the view down a little so the dot sits above the legend
  // (bottom left), which covers the middle of the map on a phone screen
  map.panBy([0, DOT_ABOVE_MIDDLE_PX], { animate: false });
}

// Markers that never change: the satellite's blind spots and the intake
function addFixedMarkers(L) {
  // Gray markers for the satellite's blind spots
  for (const spot of NO_COVERAGE) {
    L.circleMarker([spot.lat, spot.lng], {
      radius: 8,
      color: "#ffffff",
      weight: 2,
      fillColor: "#8a8a8a",
      fillOpacity: 0.7
    }).addTo(map).bindTooltip(`${spot.name}: no satellite coverage`);
  }

  // The intake, drawn as a 💧 instead of a pin
  const dropIcon = L.divIcon({ html: "💧", className: "intake-icon", iconSize: [24, 24] });
  L.marker([INTAKE.lat, INTAKE.lng], { icon: dropIcon })
    .addTo(map)
    .bindTooltip("Cary/Apex drinking-water intake (approximate; context only)");
}

// The satellite severity colors + a switch + a legend. Skipped quietly if the
// tiles aren't there: the rest of the map still works. The colors sit under
// the verdict pins (pins are the answer, colors the evidence).
async function addSatelliteLayer(L) {
  const response = await fetch(SATELLITE_INFO, { cache: "no-cache" });
  if (!response.ok) return;
  const info = await response.json();

  const satellite = L.tileLayer(SATELLITE_TILES, {
    maxNativeZoom: 9,   // tiles go up to zoom 9; closer in, Leaflet enlarges them
    opacity: 0.85,
    attribution: "Satellite: EPA CyAN"
  }).addTo(map);

  L.control.layers(null, { "Satellite: newest bloom detections": satellite }, { collapsed: false }).addTo(map);
  addLegend(L, info.newestDate ?? info.weeklyDate);
}

function addLegend(L, newestDate) {
  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const box = L.DomUtil.create("div", "map-legend");
    const rows = SEVERITY_LEGEND
      .map(s => `<span class="swatch" style="background:${s.color}"></span>${s.label}: ${s.detail}`)
      .join("<br>");
    box.innerHTML = `
      <strong>Satellite: cells/mL</strong><br>
      ${rows}<br>
      <small>EPA CyAN estimate: newest bloom seen<br>up to ${newestDate}. No color: clean water,<br>clouds or no pass. WHO 1999/2003 levels.</small>
    `;
    return box;
  };
  legend.addTo(map);
}

// The Leaflet map, or null until showMap builds it (lakemap.js puts the
// nationwide lake pins on it)
export function getMap() {
  return map;
}

// Opens an area's card in the list and scrolls to it (also used by the
// "See what's near you" panel)
export function openAreaCard(id) {
  const card = document.getElementById(`area-${id}`);
  if (!card) return;
  card.open = true;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}
