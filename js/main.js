// Entry point: connects the other modules.
// Fill the station picker → load the first station → reload whenever the pick changes.

import { STATIONS } from "./stations.js";
import { fetchStationData, extractAllReadings } from "./usgs.js";
import { computeRisk } from "./risk.js";
import { fillStationPicker, showLoading, showResult, showError } from "./ui.js";

const picker = document.getElementById("station-picker");

async function run(station) {
  showLoading(station);

  // Bug 4 fix: if anything below fails (no internet, a USGS error,
  // unexpected data), show a message instead of freezing on "Loading…".
  try {
    const data = await fetchStationData(station.id);

    // If the user picked a different station while this one was loading,
    // throw this result away so an old answer never overwrites the new one.
    if (picker.value !== station.id) return;

    const readings = extractAllReadings(data);
    const risk = computeRisk(readings, station.tier);

    console.log("Station:", station.name, "| Readings:", readings);
    console.log("Risk result:", risk);

    showResult(station, risk, readings);
  } catch (error) {
    if (picker.value !== station.id) return;
    console.error("Failed to load", station.name, error);
    showError(station, error.message);
  }
}

fillStationPicker(STATIONS);

picker.addEventListener("change", () => {
  const station = STATIONS.find(s => s.id === picker.value);
  run(station);
});

run(STATIONS[0]);
