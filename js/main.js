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
import { showMap } from "./map.js";
import { loadModel, startCamera, stopCamera, classifyFrame } from "./camera.js";
import { getLocation, nearest } from "./location.js";
import { saveScan, todaysScans } from "./scans.js";
import { fillStationPicker, showLoading, showResult, showError,
         showLake, showLakeError, showScanStatus, showScanResult,
         askAboutBloom, showBloomSaved, showBloomNotNear, showBloomNoLocation,
         clearScanNote } from "./ui.js";

// The USGS station at Jordan Lake's dam (lake level and rain), and the
// Haw River, the lake's main inflow (for runoff after storms)
const DAM_STATION_ID = "02098197";
const HAW_RIVER_STATION_ID = "02096960";

const picker = document.getElementById("station-picker");
const scanButton = document.getElementById("scan-start");
const scanVideo = document.getElementById("scan-video");

// How often the camera scan looks at the view (milliseconds)
const SCAN_EVERY_MS = 500;

// The repeating scan while the camera is on; null while it's off
let scanTimer = null;

// A bloom has to be steady before the app asks about it (decided Oct 11):
// "bloom" in at least 5 of the last 6 frames (about 3 seconds)
const STEADY_FRAMES = 6;
const STEADY_BLOOMS = 5;
// A confirmed scan only counts within this distance of an area's shore
const NEAR_AREA_KM = 2;
// After an answer, wait this long before asking again
const ASK_AGAIN_AFTER_MS = 30000;

let recentLabels = [];
let askingAboutBloom = false;
let dontAskBefore = 0;

// The latest lake data, kept so the verdicts can be redone after a scan
let lakeData = null;

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

    lakeData = { cyan, lakeLevel, wind, runoff };
    showLakeVerdicts();
  } catch (error) {
    console.error("Failed to load Jordan Lake data", error);
    showLakeError(error.message);
  }
}

// Work out every area's verdict (including today's confirmed camera
// scans) and show the list and the map. Runs again after a scan.
function showLakeVerdicts() {
  const { cyan, lakeLevel, wind, runoff } = lakeData;
  const lake = computeLakeVerdicts(AREAS, cyan, lakeLevel, wind, runoff, todaysScans());
  console.log("Lake verdicts:", lake);
  console.table(lake.ranked.map(a => ({ area: a.name, verdict: a.level, cellsPerMl: a.cellsPerMl })));

  showLake(lake);

  // The map gets its own try/catch: if the map library fails to load,
  // the list of areas above still works.
  try {
    showMap(lake, AREAS);
  } catch (error) {
    console.error("Failed to show the map", error);
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

// Camera scan: start the camera and load the model at the same time, then
// classify the view twice a second.
async function startScan() {
  scanButton.disabled = true;
  scanVideo.hidden = false;
  showScanStatus("Starting the camera and loading the model…");

  try {
    const [model] = await Promise.all([loadModel(), startCamera(scanVideo)]);

    scanTimer = setInterval(() => {
      // readyState 2+ means the video has a frame to look at
      if (scanVideo.readyState >= 2) {
        const result = classifyFrame(model, scanVideo);
        showScanResult(result);
        checkForSteadyBloom(result);
      }
    }, SCAN_EVERY_MS);
    scanButton.textContent = "Stop camera";
  } catch (error) {
    console.error("Camera scan failed", error);
    stopCamera(scanVideo);
    scanVideo.hidden = true;
    showScanStatus(`Couldn't start the scan: ${error.message}. Allow camera access and try again.`);
  }
  scanButton.disabled = false;
}

// Turn the camera off and stop scanning
function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  stopCamera(scanVideo);
  scanVideo.hidden = true;
  scanButton.textContent = "Start camera";
  showScanStatus("Camera off.");
  recentLabels = [];
  if (askingAboutBloom) {
    askingAboutBloom = false;
    clearScanNote();
  }
}

// Ask the user only when the bloom result is steady, not a one-frame flicker
function checkForSteadyBloom(result) {
  recentLabels = [...recentLabels, result.label].slice(-STEADY_FRAMES);
  const blooms = recentLabels.filter(label => label === "bloom").length;

  if (blooms >= STEADY_BLOOMS && !askingAboutBloom && Date.now() >= dontAskBefore) {
    askingAboutBloom = true;
    recentLabels = [];
    const percent = Math.round(result.confidence * 100);
    askAboutBloom(percent, answeredYes => answerBloomQuestion(answeredYes, percent));
  }
}

// Yes → find the nearest Jordan Lake area and raise its verdict one level
// (saved on this phone only). No → nothing changes.
async function answerBloomQuestion(answeredYes, percent) {
  dontAskBefore = Date.now() + ASK_AGAIN_AFTER_MS;
  if (!answeredYes) {
    askingAboutBloom = false;
    return;
  }

  try {
    const here = await getLocation();
    const closest = nearest(AREAS, here);
    if (closest && closest.km <= NEAR_AREA_KM) {
      saveScan({ areaId: closest.place.id, percent });
      showBloomSaved(closest.place.name);
      if (lakeData) showLakeVerdicts();
    } else {
      showBloomNotNear();
    }
  } catch (error) {
    console.error("Couldn't get the location for the scan", error);
    showBloomNoLocation(error.message);
  }
  askingAboutBloom = false;
}

loadLake();

// One button: starts the camera when it's off, stops it when it's on
scanButton.addEventListener("click", () => {
  if (scanTimer === null) {
    startScan();
  } else {
    stopScan();
  }
});

// Leaving the page (another app or tab, phone locked) turns the camera off
document.addEventListener("visibilitychange", () => {
  if (document.hidden && scanTimer !== null) {
    stopScan();
  }
});

fillStationPicker(STATIONS);

picker.addEventListener("change", () => {
  const station = STATIONS.find(s => s.id === picker.value);
  run(station);
});

run(STATIONS[0]);
