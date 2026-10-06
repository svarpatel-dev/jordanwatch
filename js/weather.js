// Current wind at Jordan Lake from Open-Meteo (free, no key needed,
// and it allows browser requests).

const WIND_URL = "https://api.open-meteo.com/v1/forecast";

export async function fetchWind() {
  const query = new URLSearchParams({
    latitude: "35.73",
    longitude: "-79.02",
    current: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "America/New_York"
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
