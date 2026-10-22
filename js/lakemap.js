// A pin for every lake EPA CyAN covers (decided Oct 16), on the same map as
// Jordan Lake's areas, so blank water is never a mystery: colored by
// verdict, gray when there's no recent reading, hollow when the lake is too
// small for the satellite. About 7,000 pins, so Leaflet draws them all on
// one <canvas> instead of 7,000 separate shapes (much faster on a phone).

import { PIN_COLORS } from "./map.js";
import { JORDAN_LAKE_ID } from "./lakes.js";
import { verdictLabel, escapeHtml } from "./advice.js";

// The design's gray for "no data" (--nodata in styles.css)
const NO_READING_COLOR = "#6b7680";
// Lakes with no recent reading get a smaller, lighter pin (decided Oct 19),
// so the lakes WITH a verdict stand out: this share of a verdict pin's size,
// in a light gray
const NO_READING_SIZE = 0.6;
const NO_READING_FILL = "#b9c1c8";

// Pins grow as the map zooms in: [from this zoom level, radius in pixels,
// white border width]
const PIN_SIZES = [[0, 2, 0.5], [6, 3.5, 1], [8, 5, 1], [10, 7, 1.5]];
// How close (pixels) a tap has to be to count as a tap on a pin
const TAP_TOLERANCE_PX = 6;

// EPA's nationwide image has nothing south of this (found Oct 15)
const IMAGE_SOUTH_EDGE_LAT = 29.86;

// The map the pins are on, so they're only drawn once
let drawnOn = null;
// Each lake's pin by lake id, so one pin can be redrawn (updateLakePin)
const pinsById = new Map();

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
    pinsById.set(lake.id, pin);
  }
  L.layerGroup(pins).addTo(map);

  // Zooming changes every pin's size (each keeps its own style)
  map.on("zoomend", () => {
    const newSize = pinSize(map.getZoom());
    for (const lake of lakes) {
      pinsById.get(lake.id)?.setStyle(pinStyle(lake.verdict, newSize));
    }
  });

  addSouthNote(L, map);
}

// The lakes your tap water likely comes from (decided Oct 22, nationwide):
// a droplet badge on each source lake, from the same lookup as the "Your
// tap water" card. Only the lake, never an intake spot (decided Oct 7:
// intake locations are security-sensitive). sources = [{ lake, name }];
// an empty list removes the badges.
let sourceLayer = null;
export function showWaterSources(map, sources) {
  const L = window.L;
  if (!map) return;
  if (!sourceLayer) sourceLayer = L.layerGroup().addTo(map);
  sourceLayer.clearLayers();
  for (const { lake, name } of sources) {
    const badge = L.divIcon({
      className: "source-pin",
      html: '<svg class="i i-md" aria-hidden="true"><use href="#i-droplet"></use></svg>',
      iconSize: [26, 26]
    });
    L.marker([lake.lat, lake.lng], { icon: badge, title: `Your tap water source: ${name}` })
      .addTo(sourceLayer)
      .bindTooltip(`Your tap water likely comes from ${escapeHtml(name)} (context only, not a tap-water rating)`);
  }
}

// After a lake card adds rain, river flow and lake level to the satellite
// verdict (decided Oct 13), its pin shows the same verdict as the card
export function updateLakePin(lake) {
  const pin = pinsById.get(lake.id);
  if (!pin || !drawnOn) return;
  pin.setStyle(pinStyle(lake.verdict, pinSize(drawnOn.getZoom())));
  pin.setTooltipContent(`${escapeHtml(lake.name)} (${lake.state}): ${verdictLabel(lake.verdict)}`);
}

// Verdict colors like the Jordan Lake pins (one red for every Avoid).
// No recent reading: a smaller, lighter gray dot. A lake too small for the
// satellite gets a small hollow gray ring.
function pinStyle(verdict, size) {
  const shape = { radius: size.radius, weight: size.weight };
  const small = { radius: size.radius * NO_READING_SIZE, weight: size.weight };
  if (verdict.status === "too-small") {
    return { ...small, color: NO_READING_COLOR, fillColor: "#ffffff", fillOpacity: 0.7 };
  }
  if (!verdict.level) {
    return { ...small, color: "#ffffff", fillColor: NO_READING_FILL, fillOpacity: 0.8 };
  }
  return { ...shape, color: "#ffffff", fillColor: PIN_COLORS[verdict.level], fillOpacity: 0.95 };
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
  // A small strip at the bottom left (the legend is above the map)
  const note = L.control({ position: "bottomleft" });
  note.onAdd = () => {
    const box = L.DomUtil.create("div", "map-note");
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
