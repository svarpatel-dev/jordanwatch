// The Jordan Lake map: a pin for each area colored by its verdict, gray
// markers where the satellite can't see, and the drinking-water intake.
// Uses Leaflet (loaded in index.html) with OpenStreetMap map tiles.

const PIN_COLORS = {
  avoid: "#d93025",   // red
  caution: "#e8a200", // amber
  low: "#1e8e3e"      // green
};

const PIN_LABELS = {
  avoid: "Avoid",
  caution: "Caution",
  low: "Low Risk"
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

export function showMap(lake, areas) {
  // Leaflet is a regular <script> in index.html, so it lives on window.L
  const L = window.L;

  const map = L.map("map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Look up each area's verdict by id
  const verdictsById = Object.fromEntries(lake.areas.map(v => [v.id, v]));
  const pinSpots = [];

  // One colored pin per area; tapping it opens that area's card below
  for (const area of areas) {
    const verdict = verdictsById[area.id];
    if (!verdict) continue;

    const pin = L.circleMarker([area.lat, area.lng], {
      radius: 10,
      color: "#ffffff",
      weight: 2,
      fillColor: PIN_COLORS[verdict.level],
      fillOpacity: 0.9
    }).addTo(map);

    pin.bindTooltip(`${area.name}: ${PIN_LABELS[verdict.level]}`);
    pin.on("click", () => openAreaCard(area.id));
    pinSpots.push([area.lat, area.lng]);
  }

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

  // Zoom the map so every area pin fits on screen
  map.fitBounds(pinSpots, { padding: [20, 20] });
}

// Opens an area's card in the list and scrolls to it
function openAreaCard(id) {
  const card = document.getElementById(`area-${id}`);
  if (!card) return;
  card.open = true;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}
