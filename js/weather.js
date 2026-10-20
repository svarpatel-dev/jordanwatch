// Current wind from Open-Meteo (free, no key needed, and it allows browser
// requests): at Jordan Lake, or at any lake's middle (decided Oct 13).

const WIND_URL = "https://api.open-meteo.com/v1/forecast";

// Without a place, Jordan Lake's middle (as before)
export async function fetchWind(lat = 35.73, lng = -79.02) {
  const query = new URLSearchParams({
    // 2 decimals (about 1 km) is plenty for wind
    latitude: lat.toFixed(2),
    longitude: lng.toFixed(2),
    current: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "auto"   // the place's own time zone (Jordan Lake: New York time, as before)
  });
  const response = await fetch(`${WIND_URL}?${query}`);

  if (!response.ok) {
    throw new Error(`Wind data request failed (HTTP ${response.status})`);
  }

  const data = await response.json();
  return {
    speedMs: data.current.wind_speed_10m,    // meters per second
    fromDeg: data.current.wind_direction_10m, // direction the wind blows FROM
    time: data.current.time                   // local time, e.g. "2026-10-05T21:15"
  };
}
