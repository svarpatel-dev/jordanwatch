// A pin for every lake EPA CyAN covers (decided Oct 16), on the same map as
// Jordan Lake's areas, so blank water is never a mystery: colored by
// verdict, gray when there's no recent reading, hollow when the lake is too
// small for the satellite. About 7,000 pins, so Leaflet draws them all on
// one <canvas> instead of 7,000 separate shapes (much faster on a phone).

import { PIN_COLORS, AVOID_SEVERITY_COLORS } from "./map.js";
import { JORDAN_LAKE_ID } from "./lakes.js";
import { verdictLabel, escapeHtml } from "./lakecard.js";

// The same gray as the satellite's blind spots on Jordan Lake
const NO_READING_COLOR = "#8a8a8a";

// Pins grow as the map zooms in: [from this zoom level, radius in pixels,
// white border width]
const PIN_SIZES = [[0, 2, 0.5], [6, 3.5, 1], [8, 5, 1], [10, 7, 1.5]];
// How close (pixels) a tap has to be to count as a tap on a pin
const TAP_TOLERANCE_PX = 6;

// EPA's nationwide image has nothing south of this (found Oct 15)
const IMAGE_SOUTH_EDGE_LAT = 29.86;

// The map the pins are on, so they're only drawn once
let drawnOn = null;

// onOpenLake(id) runs when a pin is tapped
export function showLakePins(map, lakes, onOpenLake) {
  if (drawnOn === map) return;
  drawnOn = map;
  const L = window.L;

  // Their own layer, under the Jordan Lake area pins (Leaflet's overlay
  // layer is at 400), so the 10 area pins stay on top
  map.createPane("lake-pins");
  map.getPane("lake-pins").style.zIndex = 390;
  const renderer = L.canvas({ pane: "lake-pins", tolerance: TAP_TOLERANCE_PX });

  const size = pinSize(map.getZoom());
  const pins = [];
  for (const lake of lakes) {
    // Jordan Lake has its 10 area pins instead
    if (lake.id === JORDAN_LAKE_ID) continue;

    const pin = L.circleMarker([lake.lat, lake.lng], { renderer, ...pinStyle(lake.verdict, size) });
    pin.bindTooltip(`${escapeHtml(lake.name)} (${lake.state}): ${verdictLabel(lake.verdict)}`);
    pin.on("click", () => onOpenLake(lake.id));
    pins.push(pin);
  }
  L.layerGroup(pins).addTo(map);

  map.on("zoomend", () => {
    const newSize = pinSize(map.getZoom());
    for (const pin of pins) {
      pin.setRadius(newSize.radius);
      pin.setStyle({ weight: newSize.weight });
    }
  });

  addSouthNote(L, map);
}

// Verdict colors like the Jordan Lake pins (darker reds for worse Avoid).
// A lake too small for the satellite gets a hollow gray ring.
function pinStyle(verdict, size) {
  const shape = { radius: size.radius, weight: size.weight };
  if (verdict.status === "too-small") {
    return { ...shape, color: NO_READING_COLOR, fillColor: "#ffffff", fillOpacity: 0.7 };
  }
  const fill = verdict.level
    ? AVOID_SEVERITY_COLORS[verdict.severity] ?? PIN_COLORS[verdict.level]
    : NO_READING_COLOR;
  return { ...shape, color: "#ffffff", fillColor: fill, fillOpacity: 0.9 };
}

// { radius, weight } for this zoom level
function pinSize(zoom) {
  let size = PIN_SIZES[0];
  for (const row of PIN_SIZES) {
    if (zoom >= row[0]) size = row;
  }
  return { radius: size[1], weight: size[2] };
}

// A note on the map whenever it shows the south, where EPA's image has no
// satellite colors (the per-lake check still gives those lakes verdicts)
function addSouthNote(L, map) {
  // Top right, under the satellite switch (the legend fills the bottom left)
  const note = L.control({ position: "topright" });
  note.onAdd = () => {
    const box = L.DomUtil.create("div", "map-legend lake-south-note");
    box.textContent = "Satellite colors aren't available south of about 30°N; lake pins still show verdicts.";
    return box;
  };
  note.addTo(map);

  const update = () => {
    note.getContainer().hidden = map.getBounds().getSouth() > IMAGE_SOUTH_EDGE_LAT;
  };
  map.on("moveend", update);
  update();
}
