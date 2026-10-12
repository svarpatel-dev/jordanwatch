// The user's location: the phone's GPS (only asked for when it's needed)
// and distances between places. The location never leaves the phone.
//
// Testing aid: add ?at=LAT,LNG to the page address to pretend to be there,
// e.g. localhost:8000/?at=35.727,-79.027 (Seaforth).

const EARTH_RADIUS_KM = 6371;

// Ask the phone where it is. Returns { lat, lng }.
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
      position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      error => reject(new Error(error.message || "location is unavailable")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
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
