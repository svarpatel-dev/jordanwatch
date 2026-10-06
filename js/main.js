// Entry point: connects the other modules.
// Load the Jordan Lake data and work out each area's verdict → fill the
// station picker → load the first station → reload whenever the pick changes.

import { STATIONS } from "./stations.js";
import { AREAS } from "./areas.js";
import { fetchStationData, extractAllReadings } from "./usgs.js";
import { computeRisk } from "./risk.js";
import { fetchCyanData } from "./cyan.js";
import { fetchWind } from "./weather.js";
import { computeLakeVerdicts } from "./lake.js";
import { fillStationPicker, showLoading, showResult, showError,
         showLake, showLakeError } from "./ui.js";

// The USGS station at Jordan Lake's dam, which measures the lake level
const DAM_STATION_ID = "02098197";

const picker = document.getElementById("station-picker");

// Jordan Lake: satellite data, lake level and wind, combined into a
// verdict for each area.
async function loadLake() {
  try {
    // Fetch all three at the same time. Lake level and wind are extras:
    // if one of them fails, the verdict still works without it.
    const [cyan, lakeLevel, wind] = await Promise.all([
      fetchCyanData(),
      fetchLakeLevel().catch(error => {
        console.error("Failed to load lake level", error);
        return null;
      }),
      fetchWind().catch(error => {
        console.error("Failed to load wind", error);
        return null;
      })
    ]);

    const lake = computeLakeVerdicts(AREAS, cyan, lakeLevel, wind);
    console.log("Lake verdicts:", lake);
    console.table(lake.ranked.map(a => ({ area: a.name, verdict: a.level, cellsPerMl: a.cellsPerMl })));

    showLake(lake);
  } catch (error) {
    console.error("Failed to load Jordan Lake data", error);
    showLakeError(error.message);
  }
}

// The latest lake level reading at the dam
async function fetchLakeLevel() {
  const data = await fetchStationData(DAM_STATION_ID);
  return extractAllReadings(data).lakeLevelFt;
}

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

loadLake();

fillStationPicker(STATIONS);

picker.addEventListener("change", () => {
  const station = STATIONS.find(s => s.id === picker.value);
  run(station);
});

run(STATIONS[0]);
