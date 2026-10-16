// The user's location: the phone's GPS (only asked for when it's needed)
// or a ZIP code, distances between places, and remembering the user's
// choice. The location never leaves the phone.
//
// Testing aid: add ?at=LAT,LNG to the page address to pretend to be there,
// e.g. localhost:8000/?at=35.727,-79.027 (Seaforth).

const EARTH_RADIUS_KM = 6371;

// ZIP code → point files made by scripts/make_zip_points.py, one per first
// digit (data/zip/2.json holds every ZIP starting with 2)
const ZIP_FOLDER = "data/zip";

// Where the user's last "See what's near you" choice is saved on this phone
const STORAGE_KEY = "jordanwatch-place";

// Ask the phone where it is. Returns { lat, lng, accuracyM }
// (accuracyM = how accurate the location is, in meters).
export function getLocation() {
  const pretend = new URLSearchParams(window.location.search).get("at");
  if (pretend) {
    const [lat, lng] = pretend.split(",").map(Number);
    return Promise.resolve({ lat, lng });
  }

  // getCurrentPosition is older than async/await: it takes two callback
  // functions (success, failure), so we wrap it in a Promise to await it
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("this browser can't share its location"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: position.coords.accuracy
      }),
      error => reject(new Error(error.message || "location is unavailable")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

// True if the user already allowed this page to use the location, so asking
// again won't show a pop-up. False if not, or if the browser can't tell.
export async function locationAllowed() {
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    return permission.state === "granted";
  } catch (error) {
    return false;
  }
}

// The middle of a ZIP code's area, e.g. "27519" → { lat: 35.808, lng: -78.887 }.
// Returns null if the ZIP isn't in the Census list (e.g. PO-box-only ZIPs).
export async function findZip(zip) {
  const response = await fetch(`${ZIP_FOLDER}/${zip[0]}.json`);
  if (!response.ok) {
    throw new Error(`ZIP list request failed (HTTP ${response.status})`);
  }

  const points = await response.json();
  const point = points[zip];
  if (!point) return null;
  return { lat: point[0], lng: point[1] };
}

// Remember the user's choice on this phone: { source: "zip", zip: "27519" }
// or { source: "gps" } (GPS coordinates are never saved; the phone is asked again)
export function savePlaceChoice(choice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch (error) {
    // Storage blocked (e.g. some private modes): it just isn't remembered
    console.error("Couldn't save the location choice on this phone", error);
  }
}

// The saved choice, or null if there's none
export function savedPlaceChoice() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    return null;
  }
}

export function forgetPlaceChoice() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    // storage blocked: nothing was saved anyway
  }
}

// Distance between two { lat, lng } points in km, along the Earth's
// surface (the haversine formula)
export function distanceKm(a, b) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// The closest of a list of places (each with lat/lng) to a point.
// Returns { place, km }, or null if the list is empty.
export function nearest(places, point) {
  let best = null;
  for (const place of places) {
    const km = distanceKm(point, place);
    if (best === null || km < best.km) {
      best = { place, km };
    }
  }
  return best;
}
