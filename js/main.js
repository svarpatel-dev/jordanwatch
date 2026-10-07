// Entry point: connects the other modules.
// Load the Jordan Lake data and work out each area's verdict → fill the
// station picker → load the first station → reload whenever the pick changes.

import { STATIONS } from "./stations.js";
import { AREAS } from "./areas.js";
import { fetchStationData, extractAllReadings,
         fetchRainTotal, fetchFlowPercentiles } from "./usgs.js";
import { computeRisk } from "./risk.js";
import { fetchCyanData } from "./cyan.js";
import { fetchWind } from "./weather.js";
import { computeLakeVerdicts } from "./lake.js";
import { fillStationPicker, showLoading, showResult, showError,
         showLake, showLakeError } from "./ui.js";

// The USGS station at Jordan Lake's dam (lake level and rain), and the
// Haw River, the lake's main inflow (for runoff after storms)
const DAM_STATION_ID = "02098197";
const HAW_RIVER_STATION_ID = "02096960";

const picker = document.getElementById("station-picker");

// Jordan Lake: satellite data, runoff, lake level and wind, combined into
// a verdict for each area.
async function loadLake() {
  try {
    // Fetch everything at the same time. Only the satellite data is
    // required: if an extra fails, the verdict still works without it.
    const [cyan, runoff, lakeLevel, wind] = await Promise.all([
      fetchCyanData(),
      fetchRunoff(),
      fetchLakeLevel().catch(error => {
        console.error("Failed to load lake level", error);
        return null;
      }),
      fetchWind().catch(error => {
        console.error("Failed to load wind", error);
        return null;
      })
    ]);

    const lake = computeLakeVerdicts(AREAS, cyan, lakeLevel, wind, runoff);
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

// Rain at the dam (last 48 hours) plus the Haw River's flow and its
// normal range for today. Each piece is null if it fails to load.
async function fetchRunoff() {
  const [rainIn48h, hawReadings, flowPercentiles] = await Promise.all([
    fetchRainTotal(DAM_STATION_ID, 48).catch(error => {
      console.error("Failed to load rain", error);
      return null;
    }),
    fetchStationData(HAW_RIVER_STATION_ID).then(extractAllReadings).catch(error => {
      console.error("Failed to load Haw River flow", error);
      return null;
    }),
    fetchFlowPercentiles(HAW_RIVER_STATION_ID).catch(error => {
      console.error("Failed to load Haw River normals", error);
      return null;
    })
  ]);

  return {
    rainIn48h,
    flowCfs: hawReadings?.flowCfs?.value ?? null,
    flowPercentiles
  };
}

async function run(station) {
  showLoading(station);

  // Bug 4 fix: if anything below fails (no internet, a USGS error,
  // unexpected data), show a message instead of freezing on "Loading…".
  try {
    // Limited stations also get today's normal flow range, to say whether
    // the river is running high or low. If that fails, skip it (null).
    const [data, flowNormal] = await Promise.all([
      fetchStationData(station.id),
      station.tier === "limited"
        ? fetchFlowPercentiles(station.id).catch(error => {
            console.error("Failed to load normal flow for", station.name, error);
            return null;
          })
        : null
    ]);

    // If the user picked a different station while this one was loading,
    // throw this result away so an old answer never overwrites the new one.
    if (picker.value !== station.id) return;

    const readings = extractAllReadings(data);
    const risk = computeRisk(readings, station.tier, flowNormal);

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
