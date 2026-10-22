// "Where your tap water likely comes from" (decided Oct 10 and Oct 13):
// the water system that likely serves a place, from EPA's map of water
// system service areas, and where that system's water comes from, from
// data/tapwater/ (made by scripts/make_tapwater.py from EPA's records).
// Knows nothing about the page; tapcard.js draws it.
//
// Privacy: the exact location never leaves the phone. EPA's map is only
// asked about a spot rounded to about 1 km; it sends back the outlines of
// the water systems around that spot, and this file works out on the phone
// which outline the exact location is inside.

import { distanceKm } from "./location.js";

// EPA's Community Water System Service Area Boundaries (public, CORS open)
const SERVICE_AREAS_URL = "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/" +
  "Water_System_Boundaries/FeatureServer/0/query";
const TAPWATER_FOLDER = "data/tapwater";

// The spot sent to EPA is rounded to 2 decimals (at most about 0.7 km from
// the real place), and EPA returns every system within 1.5 km of it, so
// the outline the real place is inside is always among them
const ROUND_TO = 100;          // 2 decimals
const SEARCH_KM = 1.5;
// Outlines are simplified to about 50 m (0.0005 degrees), so they're small
const SIMPLIFY_DEGREES = 0.0005;
// At most this many systems are shown
const MAX_SYSTEMS = 3;

// Each data/tapwater/ file once (data/tapwater/NC.json holds North Carolina),
// like a Python dict used as a cache
const sourceFiles = new Map();

// The water systems for a place ({ lat, lng }), most likely first:
// { systems: [{ id, name, people, modeled, mappedYear, km, sources }], inside }
// inside = true when the place is inside their mapped areas; false when no
// mapped area covers it and these are the nearest ones (within about a mile).
export async function findWaterSystems(place) {
  const outlines = await fetchOutlines(place);

  let systems = outlines.filter(system => insideOutline(place, system.rings));
  const inside = systems.length > 0;
  if (!inside) {
    systems = outlines.filter(system => system.km <= SEARCH_KM);
  }

  // Most likely first: inside the area (or closest), then areas the state or
  // utility mapped before ones EPA estimated, then the one serving more people
  // (true - false is 1 in JavaScript, so "modeled" sorts after "mapped")
  systems.sort((a, b) => (a.km - b.km) || (a.modeled - b.modeled) || (b.people - a.people));
  // A system can be on the map twice: keep its first (best) entry
  systems = systems.filter((system, i) => systems.findIndex(s => s.id === system.id) === i);
  systems = systems.slice(0, MAX_SYSTEMS);

  // Where each one's water comes from (null if EPA's records don't say)
  for (const system of systems) {
    system.sources = await fetchSources(system.id);
    delete system.rings;   // not needed any more
  }
  return { systems, inside };
}

// The water systems around a place, with their outlines and how far the
// place is from each outline (0 if inside)
async function fetchOutlines(place) {
  const spot = {
    lat: Math.round(place.lat * ROUND_TO) / ROUND_TO,
    lng: Math.round(place.lng * ROUND_TO) / ROUND_TO
  };
  // Like Python's urllib.parse.urlencode
  const query = new URLSearchParams({
    f: "json",
    geometry: `${spot.lng},${spot.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: SEARCH_KM,
    units: "esriSRUnit_Kilometer",
    outFields: "PWSID,PWS_Name,Population_Served_Count,Symbology_Field,Original_Data_Created_Date",
    returnGeometry: "true",
    maxAllowableOffset: SIMPLIFY_DEGREES,
    geometryPrecision: "4"
  });
  const response = await fetch(`${SERVICE_AREAS_URL}?${query}`);
  if (!response.ok) {
    throw new Error(`water system map request failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  // This kind of server reports errors inside a normal-looking answer
  if (data.error) {
    throw new Error(`water system map error (${data.error.message})`);
  }

  return data.features.map(feature => {
    const info = feature.attributes;
    const rings = feature.geometry?.rings ?? [];
    return {
      id: info.PWSID.trim(),
      name: info.PWS_Name,
      people: info.Population_Served_Count ?? 0,
      modeled: info.Symbology_Field === "Modeled",
      // A date (sent as milliseconds since 1970), or nothing
      mappedYear: info.Original_Data_Created_Date ? new Date(info.Original_Data_Created_Date).getUTCFullYear() : null,
      rings,
      km: insideOutline(place, rings) ? 0 : nearestCornerKm(place, rings)
    };
  });
}

// Is the place inside the outline? The ray-casting test: walk east from the
// place and count how many edges of the outline it crosses; an odd number
// means inside. Rings are lists of [lng, lat] corners, and holes (areas a
// system doesn't serve) count the same way, so a place in a hole is outside.
function insideOutline(place, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [lngA, latA] = ring[i];
      const [lngB, latB] = ring[j];
      const crossesLatitude = (latA > place.lat) !== (latB > place.lat);
      if (crossesLatitude && place.lng < lngA + (place.lat - latA) * (lngB - lngA) / (latB - latA)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

// Roughly how far the place is from an outline: to its nearest corner
// (corners are about 50 m apart or less along curves, so it's close enough)
function nearestCornerKm(place, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      best = Math.min(best, distanceKm(place, { lat, lng }));
    }
  }
  return best;
}

// Where one system's water comes from, from data/tapwater/{first 2 letters}.json:
// { uses, lakes: [[lake id, name]], other: [names], unnamed, from: [names], wells }
// or null if the system isn't in EPA's records of active systems
export async function fetchSources(systemId) {
  const prefix = systemId.slice(0, 2);
  if (!sourceFiles.has(prefix)) {
    const response = await fetch(`${TAPWATER_FOLDER}/${prefix}.json`);
    if (response.status === 404) {
      sourceFiles.set(prefix, {});   // no systems with this prefix
    } else if (!response.ok) {
      throw new Error(`tap water list request failed (HTTP ${response.status})`);
    } else {
      sourceFiles.set(prefix, await response.json());
    }
  }
  return sourceFiles.get(prefix)[systemId] ?? null;
}
