// The map in the Satellite card: a pin for each Jordan Lake area colored by
// its verdict, gray markers where the satellite can't see, the
// drinking-water intake, the satellite colors and the "You are here" dot. Uses Leaflet (loaded in index.html) with OpenStreetMap tiles.

import { verdictLabel, shortDate } from "./advice.js";

// Pin colors: the same values as the color tokens in styles.css. One red
// for every Avoid (decided Oct 21: three WHO levels only)
export const PIN_COLORS = {
  avoid: "#d93025",
  caution: "#e39b00",
  low: "#1b8a3a"
};

// Parts of the lake the satellite can't see, because its 300 m pixels
// there touch land (decided Oct 3). Approximate spots for gray markers.
const NO_COVERAGE = [
  { name: "Northern tip of the New Hope arm", lat: 35.830, lng: -78.990 },
  { name: "Haw River arm", lat: 35.705, lng: -79.070 },
  { name: "Southern end, toward the dam", lat: 35.688, lng: -79.040 }
];
const NO_COVERAGE_COLOR = "#6b7680";

// Cary/Apex drinking-water intake (approximate; context only)
const INTAKE = { lat: 35.7385, lng: -79.0222 };

// The base map: OpenStreetMap, shown in muted gray by CSS (.basemap-muted
// in styles.css) so only the verdict and satellite colors stand out
const BASE_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const BASE_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ODbL';

// ---------------------------------------------------------------------
// The satellite layer (decided Oct 12-13): tiles made by
// scripts/make_tiles.py on every deploy, showing each spot's newest bloom
// detection from the past week (clean water and clouds have no color).
// Radar-smooth tiles (decided Oct 19) for zoom 10-12, made by
// scripts/radar_tiles.py and kept inside the lake shorelines.
const SATELLITE_TILES = "tiles/{z}/{x}/{y}.png";
const SATELLITE_INFO = "tiles/info.json";
const SATELLITE_LAYER_OPTIONS = {
  maxNativeZoom: 12,   // radar-smooth tiles go up to zoom 12; closer in, Leaflet enlarges them
  opacity: 0.85,
  className: "satellite-tiles",
  attribution: "Satellite: EPA CyAN"
};
// ---------------------------------------------------------------------

// How close the map zooms in on the user's place: GPS is precise, a ZIP
// code's middle is only roughly where they are
const GPS_ZOOM = 11;
const ZIP_ZOOM = 10;
// Far from Jordan Lake (any place), zoom out so the satellite colors of the
// lakes around the user show (decided Oct 15)
const FAR_ZOOM = 9;

// The map is built once; after that only the area pins are redrawn (e.g.
// when a camera scan changes a verdict). Leaflet can't set up the same
// map box twice.
let map = null;
let pinLayer = null;
let satelliteLayer = null;

// "See what's near you": the user's place and how far to zoom in. It can
// arrive before the map is built (a saved ZIP loads fast), so it's kept here
// and drawn as soon as the map exists.
let youAreHere = null;
let hereZoom = null;
let hereLayer = null;

// The area pins' spots, to zoom back to Jordan Lake after "Clear"
let lakeView = null;

// lake = computeLakeVerdicts()'s result; onPickArea(id) runs when a pin is tapped
export function showMap(lake, areas, onPickArea) {
  // Leaflet is a regular <script> in index.html, so it lives on window.L
  const L = window.L;

  const firstTime = map === null;
  if (firstTime) {
    map = L.map("map", { zoomControl: false });
    L.control.zoom({ position: "topleft" }).addTo(map);
    // className: gray map, so only the bloom colors and pins stand out (Oct 19)
    L.tileLayer(BASE_TILES, { maxZoom: 18, className: "basemap-muted", attribution: BASE_CREDIT }).addTo(map);
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

  // One colored pin per area (a white ring with a dark outline, drawn by
  // .area-pin in styles.css); tapping it opens that area
  for (const area of areas) {
    const verdict = verdictsById[area.id];
    if (!verdict) continue;

    const pinIcon = L.divIcon({
      className: "area-pin",
      html: `<span style="background:${PIN_COLORS[verdict.level]}"></span>`,
      iconSize: [22, 22]
    });
    const pin = L.marker([area.lat, area.lng], { icon: pinIcon, title: area.name, keyboard: true })
      .addTo(pinLayer);
    pin.bindTooltip(`${area.name}: ${verdictLabel(verdict)}`);
    pin.on("click", () => onPickArea(area.id));
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

// The round locate button: back to the user's place, or to Jordan Lake
// when there's none
export function recenter() {
  if (map === null) return;
  if (youAreHere) {
    map.setView([youAreHere.lat, youAreHere.lng], hereZoom);
  } else {
    map.fitBounds(lakeView, { padding: [20, 20] });
  }
}

// Move to a lake (a lake card was opened), zoomed in at least this far
export function showOnMap(lat, lng, minZoom) {
  if (map === null) return;
  map.setView([lat, lng], Math.max(map.getZoom(), minZoom));
}

// The map's box changed size (tab shown again, full map opened or closed):
// Leaflet has to measure it again
export function refreshMapSize() {
  if (map !== null) map.invalidateSize();
}

// A blue dot with a soft halo (.you-are-here in styles.css). With GPS, a
// light circle shows how accurate the location is.
function drawYouAreHere() {
  const L = window.L;
  const place = youAreHere;
  hereLayer.clearLayers();

  if (place.accuracyM) {
    L.circle([place.lat, place.lng], {
      radius: place.accuracyM,
      color: "#0b5cad",
      weight: 1,
      fillOpacity: 0.08,
      interactive: false   // taps go through to the pins underneath
    }).addTo(hereLayer);
  }

  const dot = L.divIcon({ className: "you-are-here", iconSize: [16, 16] });
  const label = place.source === "zip" ? `Near ZIP ${place.zip}` : "You are here";
  L.marker([place.lat, place.lng], { icon: dot, interactive: true }).addTo(hereLayer).bindTooltip(label);

  map.setView([place.lat, place.lng], hereZoom, { animate: false });
}

// Markers that never change: the satellite's blind spots and the intake
function addFixedMarkers(L) {
  for (const spot of NO_COVERAGE) {
    L.circleMarker([spot.lat, spot.lng], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: NO_COVERAGE_COLOR,
      fillOpacity: 0.8
    }).addTo(map).bindTooltip(`${spot.name}: no satellite coverage`);
  }

  // The intake, drawn as the droplet icon from the icon sprite
  const dropIcon = L.divIcon({
    className: "intake-pin",
    html: '<svg class="i i-md" aria-hidden="true"><use href="#i-droplet"></use></svg>',
    iconSize: [26, 26]
  });
  L.marker([INTAKE.lat, INTAKE.lng], { icon: dropIcon, title: "Drinking-water intake" })
    .addTo(map)
    .bindTooltip("Cary/Apex drinking-water intake (approximate; context only)");
}

// The satellite colors under the verdict pins (pins are the
// answer, colors the evidence). Skipped quietly if the tiles aren't there:
// the rest of the map still works. The legend strip and its switch are in
// index.html; this fills in the date.
async function addSatelliteLayer(L) {
  const response = await fetch(SATELLITE_INFO, { cache: "no-cache" });
  if (!response.ok) return;
  const info = await response.json();

  satelliteLayer = L.tileLayer(SATELLITE_TILES, SATELLITE_LAYER_OPTIONS);
  if (document.getElementById("satellite-switch").checked) satelliteLayer.addTo(map);
  document.getElementById("legend-date").textContent = shortDate(info.newestDate ?? info.weeklyDate);
}

// The legend's switch turns the satellite colors on and off
export function setSatelliteVisible(on) {
  if (map === null || satelliteLayer === null) return;
  if (on) {
    satelliteLayer.addTo(map);
  } else {
    satelliteLayer.remove();
  }
}

// The Leaflet map, or null until showMap builds it (lakemap.js puts the
// nationwide lake pins on it)
export function getMap() {
  return map;
}
