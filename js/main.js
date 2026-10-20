// Entry point: connects the other modules.
// Load the Jordan Lake data and work out each area's verdict → bring back the
// user's saved place ("See what's near you", plus the live stations near it)
// → fill the station picker → load the first station → reload whenever the
// pick changes.

import { STATIONS } from "./stations.js";
import { AREAS } from "./areas.js";
import { fetchStationData, extractAllReadings,
         fetchRainTotal, fetchFlowPercentiles } from "./usgs.js";
import { computeRisk } from "./risk.js";
import { fetchCyanData } from "./cyan.js";
import { fetchWind } from "./weather.js";
import { computeLakeVerdicts } from "./lake.js";
import { showMap, showYouAreHere, clearYouAreHere, openAreaCard, getMap } from "./map.js";
import { fetchLakes, nearestLakes, JORDAN_LAKE_ID } from "./lakes.js";
import { showLakePins } from "./lakemap.js";
import { showLakeCard, clearLakeCard, showNearbyLakes, clearNearbyLakes,
         showLakesUnavailable } from "./lakecard.js";
import { loadModel, startCamera, stopCamera, classifyFrame } from "./camera.js";
import { getLocation, nearest, findZip, locationAllowed,
         savePlaceChoice, savedPlaceChoice, forgetPlaceChoice } from "./location.js";
import { saveScan, todaysScans } from "./scans.js";
import { showNearYouStatus, showNearestArea, showFarFromLake } from "./nearyou.js";
import { findStationsNear, loadStandards, rulesFor, judgeStation } from "./nearby.js";
import { showStationsNearLoading, showStationsNear, showStationsNearError,
         clearStationsNear } from "./nearstations.js";
import { fillStationPicker, showLoading, showResult, showError,
         showLake, showLakeError, showScanStatus, showScanResult,
         askAboutBloom, showBloomSaved, showBloomNotNear, showBloomNoLocation,
         clearScanNote } from "./ui.js";

// The USGS station at Jordan Lake's dam (lake level and rain), and the
// Haw River, the lake's main inflow (for runoff after storms)
const DAM_STATION_ID = "02098197";
const HAW_RIVER_STATION_ID = "02096960";

// The state of the 13 stations in the picker (stations.js)
const PICKER_STATE = "North Carolina";

const picker = document.getElementById("station-picker");
const scanButton = document.getElementById("scan-start");
const scanVideo = document.getElementById("scan-video");
const nearGpsButton = document.getElementById("near-gps");
const zipForm = document.getElementById("near-zip-form");
const zipInput = document.getElementById("near-zip");
const nearClearButton = document.getElementById("near-clear");
const mapHeading = document.getElementById("map-heading");
// Jordan Lake's area list ("Best spots today"), shown only near Jordan Lake
// or with no place chosen (everything else is national, decided Oct 19)
const jordanList = document.getElementById("lake");
// The example station picker, hidden once a place is chosen
const pickerBox = document.getElementById("station-picker-box");

// The map's heading with no place or lake picked: Jordan Lake, the default
// example (decided Oct 19)
const DEFAULT_HEADING = "Jordan Lake";
// Opening a lake's card zooms the map in at least this far on it
const LAKE_ZOOM = 9;

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
// The latest verdicts, kept for the "See what's near you" line
let latestLake = null;

// "See what's near you": within this distance of a Jordan Lake area (about
// 15 miles), show that area's verdict; farther away, say how far the lake is
const NEAR_LAKE_KM = 25;

// The place the user chose: { lat, lng, source: "gps" or "zip", and
// accuracyM (GPS) or zip (ZIP) }. null until they choose one.
let chosenPlace = null;

// Every lake EPA CyAN covers, with its verdict (lakes.js); null until the
// lake files load. lakesFailed = true if they couldn't be loaded.
let nationwide = null;
let lakesFailed = false;
// How many lakes "See what's near you" lists
const NEARBY_LAKES = 5;

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
  latestLake = lake;

  // The map gets its own try/catch: if the map library fails to load,
  // the list of areas above still works.
  try {
    showMap(lake, AREAS);
  } catch (error) {
    console.error("Failed to show the map", error);
  }
  drawLakePins();

  // The nearest area's verdict may have changed (new data or a scan)
  if (chosenPlace) updateNearYou();
}

// Every covered US lake (decided Oct 16): a pin on the map for each, and
// the nearest ones in "See what's near you"
async function loadLakes() {
  try {
    nationwide = await fetchLakes();
  } catch (error) {
    console.error("Failed to load the lake verdicts", error);
    lakesFailed = true;
    if (chosenPlace) showLakesUnavailable();
    return;
  }
  drawLakePins();
  if (chosenPlace) updateNearYou();
}

// The lake pins need both the map and the lake files, which load separately,
// so this runs after each one (the pins are only drawn once)
function drawLakePins() {
  const map = getMap();
  if (map && nationwide) {
    showLakePins(map, nationwide.lakes, openLakeCard);
  }
}

// Show a lake's card, name it in the heading and move the map to it
function openLakeCard(id) {
  const lake = nationwide.lakes.find(l => l.id === id);
  if (!lake) return;
  showLakeCard(lake, nationwide.updatedAt);
  mapHeading.textContent = `${lake.name} (${lake.state})`;
  const map = getMap();
  if (map) map.setView([lake.lat, lake.lng], Math.max(map.getZoom(), LAKE_ZOOM));
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
    // Full and partial stations are judged by their state's standards, like
    // the stations near you (decided Oct 18). All 13 are North Carolina streams.
    const risk = station.tier === "limited"
      ? computeRisk(readings, station.tier, flowNormal)
      : judgeStation(readings, station.tier, rulesFor(await loadStandards(), PICKER_STATE, "ST"));

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

// "Use my location": the phone's GPS, asked for only after a tap
async function useMyLocation() {
  showNearYouStatus("Finding your location…");
  try {
    const point = await getLocation();
    choosePlace({ ...point, source: "gps" });
  } catch (error) {
    console.error("Couldn't get the location", error);
    showNearYouStatus(`Couldn't get your location (${error.message}). Try a ZIP code instead.`);
  }
}

// "Enter a ZIP code": the middle of that ZIP's area, from the Census list
async function useZip(zip) {
  // Exactly 5 digits (like Python's re.fullmatch(r"\d{5}", zip))
  if (!/^\d{5}$/.test(zip)) {
    showNearYouStatus("A ZIP code has 5 digits.");
    return;
  }

  showNearYouStatus(`Looking up ZIP ${zip}…`);
  try {
    const point = await findZip(zip);
    if (!point) {
      showNearYouStatus(`Couldn't find ZIP ${zip}. Try a nearby ZIP or use your location.`);
      return;
    }
    choosePlace({ ...point, source: "zip", zip });
  } catch (error) {
    console.error("Couldn't look up the ZIP", error);
    showNearYouStatus(`Couldn't look up ZIP ${zip} right now (${error.message}). Try again in a minute.`);
  }
}

// A place was chosen: remember the choice, put the dot on the map and show
// what's near it
function choosePlace(place) {
  chosenPlace = place;
  savePlaceChoice(place.source === "zip" ? { source: "zip", zip: place.zip } : { source: "gps" });
  nearClearButton.hidden = false;
  const nearJordan = nearest(AREAS, place).km <= NEAR_LAKE_KM;
  showYouAreHere(place, nearJordan);

  // A new place: a lake card from before no longer fits, and the heading
  // names where the map is now
  clearLakeCard();
  jordanList.hidden = !nearJordan;
  pickerBox.hidden = true;
  if (nearJordan) {
    mapHeading.textContent = DEFAULT_HEADING;
  } else {
    mapHeading.textContent = place.source === "zip" ? `Lakes near ZIP ${place.zip}` : "Lakes near you";
  }
  updateNearYou();
  loadStationsNear(place);
}

// The nearest Jordan Lake area and its verdict, or how far away the lake is,
// plus the nearest other lakes
function updateNearYou() {
  const closest = nearest(AREAS, chosenPlace);
  if (closest.km <= NEAR_LAKE_KM) {
    const verdict = latestLake?.areas.find(a => a.id === closest.place.id) ?? null;
    showNearestArea(chosenPlace, closest.place, closest.km, verdict, openAreaCard);
  } else {
    showFarFromLake(chosenPlace, closest.km);
  }

  // The nearest other lakes and their satellite verdicts (decided Oct 16).
  // Near Jordan Lake, its areas are already shown, so it's left out.
  if (nationwide) {
    const nearJordan = closest.km <= NEAR_LAKE_KM;
    const nearby = nearestLakes(nationwide.lakes, chosenPlace, NEARBY_LAKES, nearJordan ? JORDAN_LAKE_ID : null);
    showNearbyLakes(nearby, nearJordan, openLakeCard);
  } else if (lakesFailed) {
    showLakesUnavailable();
  }
}

// Every live USGS station near the place, each compared with its own
// state's standards (2 USGS requests; nearby.js remembers the answer)
async function loadStationsNear(place) {
  showStationsNearLoading();
  try {
    const result = await findStationsNear(place);
    // The user chose another place (or Clear) while this one was loading
    if (chosenPlace !== place) return;
    showStationsNear(result, place);
  } catch (error) {
    if (chosenPlace !== place) return;
    console.error("Failed to load the stations near", place, error);
    showStationsNearError(error.message);
  }
}

// "Clear": forget the choice and go back to the Jordan Lake view
function clearPlace() {
  chosenPlace = null;
  forgetPlaceChoice();
  zipInput.value = "";
  nearClearButton.hidden = true;
  showNearYouStatus("");
  clearNearbyLakes();
  clearLakeCard();
  clearStationsNear();
  jordanList.hidden = false;
  pickerBox.hidden = false;
  mapHeading.textContent = DEFAULT_HEADING;
  clearYouAreHere();
}

// When the page opens, bring back the last choice. A ZIP comes back right
// away; GPS only if the phone already allows it, so there's no surprise
// pop-up (otherwise it waits for a tap).
async function restorePlace() {
  const saved = savedPlaceChoice();
  if (saved?.source === "zip") {
    zipInput.value = saved.zip;
    useZip(saved.zip);
  } else if (saved?.source === "gps" && await locationAllowed()) {
    useMyLocation();
  }
}

loadLake();
loadLakes();

nearGpsButton.addEventListener("click", useMyLocation);
nearClearButton.addEventListener("click", clearPlace);
zipForm.addEventListener("submit", event => {
  event.preventDefault();   // stay on this page instead of sending the form
  useZip(zipInput.value.trim());
});
restorePlace();

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
