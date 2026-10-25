// Entry point: connects the other modules.
// Load the Jordan Lake data and work out each area's verdict, load every
// other lake's verdict → bring back the user's saved place → draw the Lake
// tab for whatever the user is looking at → redraw it whenever that changes
// (a new place, a tapped tile or pin, a search, new data, a camera scan).

import { STATIONS } from "./stations.js";
import { AREAS } from "./areas.js";
import { fetchStationData, extractAllReadings,
         fetchRainTotal, fetchFlowPercentiles } from "./usgs.js";
import { describeLimitedStation } from "./risk.js";
import { fetchCyanData } from "./cyan.js";
import { fetchWind } from "./weather.js";
import { computeLakeVerdicts } from "./lake.js";
import { showMap, showYouAreHere, clearYouAreHere, getMap, recenter, showOnMap,
         refreshMapSize, setSatelliteVisible } from "./map.js";
import { fetchLakes, nearestLakes, lakeVerdict, closestPointOfLake, betterLakeNearby,
         JORDAN_LAKE_ID } from "./lakes.js";
import { showLakePins, updateLakePin, showWaterSources } from "./lakemap.js";
import { showLakeDetails } from "./lakecard.js";
import { fetchLakeExtras, fetchReportRoutes, lakesWithBeaches } from "./lakeextras.js";
import { combineLakeSignals } from "./lakesignals.js";
import { loadModel, startCamera, stopCamera, freezeFrame, drawPhoto, scanLive, scanPicture } from "./camera.js";
import { getLocation, nearest, distanceKm, findZip, locationAllowed,
         savePlaceChoice, savedPlaceChoice, forgetPlaceChoice } from "./location.js";
import { saveScan, todaysScans } from "./scans.js";
import { showNearYouStatus, describePlace, describeDistance, placeName } from "./nearyou.js";
import { findStationsNear, loadStandards, rulesFor, judgeStation } from "./nearby.js";
import { showStationsNearLoading, showStationsNear, showStationsNearError,
         clearStationsNear, showStationsNearLake } from "./nearstations.js";
import { showAreaConditions, showLakeConditions, showConditionsMessage,
         showTiles, areaTileSub, lakeTileSub } from "./conditions.js";
import { searchLakes, isZip } from "./lakesearch.js";
import { showTab, onTab, setUpTabs, openSheet, closeSheet, setUpSheets } from "./screens.js";
import { setUpWelcome, openWelcome } from "./welcome.js";
import { startTour } from "./tour.js";
import { favorites, favoriteKey, parseFavorite, isFavorite, toggleFavorite } from "./favorites.js";
import { findWaterSystems } from "./tapwater.js";
import { showTapWater, showTapWaterStatus, clearTapWater } from "./tapcard.js";
import { reportHtml } from "./cardparts.js";
import { verdictLabel, escapeHtml, shortDateTime } from "./advice.js";
import { fillStationPicker, showLoading, showResult, showError,
         showAreaDetails, showLakeError, showScanStatus, showScanLooking, showScanResult,
         updateScanReport, clearScanResult, askAboutBloom, showBloomSaved, showBloomNotNear,
         showBloomNoLocation, clearScanNote } from "./ui.js";

// The USGS station at Jordan Lake's dam (lake level and rain), and the
// Haw River, the lake's main inflow (for runoff after storms)
const DAM_STATION_ID = "02098197";
const HAW_RIVER_STATION_ID = "02096960";

// The state of the 13 stations in the picker (stations.js)
const PICKER_STATE = "North Carolina";

const picker = document.getElementById("station-picker");
const pickerBox = document.getElementById("station-picker-box");
const scanButton = document.getElementById("scan-start");
const scanVideo = document.getElementById("scan-video");
const scanStill = document.getElementById("scan-still");
const scanView = document.querySelector(".scan-view");
const shutterButton = document.getElementById("scan-shutter");
const scanAgainButton = document.getElementById("scan-again");
const photoInput = document.getElementById("scan-photo");
const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const suggestionsBox = document.getElementById("suggestions");
const nearClearButton = document.getElementById("near-clear");
const satCard = document.getElementById("sat-card");
const fullMapButton = document.getElementById("full-map-button");

// What the search sheet says before anything is typed
const SEARCH_HINT = '<li class="small">Type a 5-digit ZIP or a lake name.</li>';

// Opening a lake zooms the map in at least this far on it
const LAKE_ZOOM = 9;

// The hint on the live camera view (tap to scan, decided Oct 24)
const SCAN_HINT = "Point at the water near the shore, then tap Scan";

// true while the camera is on
let cameraOn = false;
// true while a scan or a photo is being looked at (one at a time)
let scanBusy = false;

// A confirmed scan only counts within this distance of an area's shore
const NEAR_AREA_KM = 2;

let askingAboutBloom = false;
// Where the user was at their last bloom answer (GPS), for the report link
let lastScanPlace = null;

// The latest lake data, kept so the verdicts can be redone after a scan
let lakeData = null;
// The latest verdicts for Jordan Lake's 10 areas (null until they load)
let latestLake = null;

// Within this distance of a Jordan Lake area (about 15 miles), the Lake tab
// opens on that area; farther away, on the nearest covered lake
const NEAR_LAKE_KM = 25;

// The place the user chose: { lat, lng, source: "gps" or "zip", and
// accuracyM (GPS) or zip (ZIP) }. null until they choose one.
let chosenPlace = null;

// Every lake EPA CyAN covers, with its verdict (lakes.js); null until the
// lake files load. lakesFailed = true if they couldn't be loaded.
let nationwide = null;
let lakesFailed = false;
// How many lakes a row of lake tiles shows
const LAKE_TILES = 8;

// What the Lake tab shows: { kind: "area" or "lake", id }, or null to pick
// on its own (the nearest area or lake, or Jordan Lake's best spot)
let selected = null;
// The lake the row of lake tiles is centered on when there's no place (the
// last lake opened from the map or the search)
let rowCenter = null;
// A lake's other signals once they load: lake id → { full } or { extrasFailed }
const lakeExtras = new Map();
// The lakes whose other signals are loading right now (so each loads once)
const extrasLoading = new Set();
// Each state's way to report a bloom (data/report_routes.json), once loaded
let reportRoutes = null;

// Where the chosen place's tap water likely comes from (tapwater.js), or
// null until it's looked up (decided Oct 13, built Oct 22)
let tapWater = null;

// Which lakes have OpenStreetMap beaches, by state: "NC" → a Set of lake
// ids, for "Go here instead" (decided Oct 21: lakes with beaches first)
const beachLakes = new Map();
const beachesLoading = new Set();

// --- Loading the data ---

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
    showConditionsMessage(`Couldn't load Jordan Lake data: ${error.message} Try again soon.`);
    showLakeError(error.message);
  }
}

// Work out every area's verdict (including today's confirmed camera
// scans), then draw the map and the Lake tab. Runs again after a scan.
function showLakeVerdicts() {
  const { cyan, lakeLevel, wind, runoff } = lakeData;
  latestLake = computeLakeVerdicts(AREAS, cyan, lakeLevel, wind, runoff, todaysScans());

  // The map gets its own try/catch: if the map library fails to load,
  // the rest of the Lake tab still works.
  try {
    showMap(latestLake, AREAS, id => pickArea(id, true));
  } catch (error) {
    console.error("Failed to show the map", error);
  }
  drawLakePins();
  document.getElementById("lake-footer").textContent =
    `EPA CyAN satellite estimates · Not an official advisory · Checked ${shortDateTime(latestLake.checkedAt)}`;
  render();
}

// Every covered US lake (decided Oct 16): a pin on the map for each, the
// lake tiles, and the lake search
async function loadLakes() {
  try {
    nationwide = await fetchLakes();
  } catch (error) {
    console.error("Failed to load the lake verdicts", error);
    lakesFailed = true;
  }
  drawLakePins();
  render();
}

// The lake pins need both the map and the lake files, which load separately,
// so this runs after each one (the pins are only drawn once)
function drawLakePins() {
  const map = getMap();
  if (map && nationwide) {
    showLakePins(map, nationwide.lakes, id => openLake(id, { scroll: true }));
  }
}

// The report routes file, loaded once (lakeextras.js keeps the download)
async function loadReportRoutes() {
  reportRoutes = await fetchReportRoutes();
  return reportRoutes;
}

// --- Drawing the Lake tab ---

// Draws the conditions block, the tiles and the Why and What to do cards
// for whatever the user is looking at
function render() {
  const focus = selected ?? autoFocus();
  if (focus === null) {
    if (lakesFailed && chosenPlace) {
      showConditionsMessage("Couldn't load the lake ratings. Try again soon.");
    } else {
      showConditionsMessage(chosenPlace
        ? "Finding the lakes near you…"
        : "Loading today's ratings…");
    }
    return;
  }
  if (focus.kind === "area") {
    renderArea(focus);
  } else {
    renderLake(focus);
  }
  renderNearLakes(focus);
  renderMapSheet(focus);
  renderFavorites();
  // The source lakes' ratings may have changed (or just loaded)
  if (tapWater) drawTapWater();
}

// What to show when the user hasn't picked anything: near Jordan Lake its
// nearest area; farther away the nearest covered lake; with no place,
// Jordan Lake's best spot today (the default example, decided Oct 19).
// null while the data it needs is still loading.
function autoFocus() {
  if (chosenPlace && !nearJordan(chosenPlace)) {
    if (!nationwide) return null;
    const closest = nearestLakes(nationwide.lakes, chosenPlace, 1)[0];
    return closest ? { kind: "lake", id: closest.lake.id, why: "nearest" } : null;
  }
  if (!latestLake) return null;
  if (chosenPlace) {
    return { kind: "area", id: nearest(AREAS, chosenPlace).place.id, why: "nearest" };
  }
  return { kind: "area", id: latestLake.ranked[0].id, why: "best" };
}

function renderArea(focus) {
  if (!latestLake) return;
  const area = latestLake.areas.find(a => a.id === focus.id);
  let where = "Jordan Lake";
  if (focus.why === "nearest") {
    where = `nearest area, ${describeDistance(nearest(AREAS, chosenPlace).km)}, Jordan Lake`;
  } else if (focus.why === "best") {
    // On an all-Avoid day, "best spot" would sound like a recommendation
    const allAvoid = latestLake.areas.every(a => a.level === "avoid");
    where = allAvoid ? "lowest reading today, Jordan Lake" : "best spot today, Jordan Lake";
  }
  // With no place, a line under the block opens the place search
  const onHint = chosenPlace ? null : openPlaceSheet;
  showAreaConditions(area, latestLake, where, id => pickArea(id, false), onHint, starFor("area", area.id));
  showAreaDetails(area, latestLake, reportRoutes);

  // The row: every area, best first
  const counts = { avoid: 0, caution: 0, low: 0 };
  for (const a of latestLake.areas) counts[a.level] += 1;
  showRowHeading("Jordan Lake areas",
    `${counts.avoid} Avoid · ${counts.caution} Caution · ${counts.low} Low Risk · best first`);
  const tiles = latestLake.ranked.map(a => ({
    key: a.id, name: a.name, level: a.level, sub: areaTileSub(a), fav: favoriteKey("area", a.id)
  }));
  showTiles(document.getElementById("tiles"), tiles, area.id, id => pickArea(id, false), TILE_STARS);
}

function renderLake(focus) {
  const lake = nationwide.lakes.find(l => l.id === focus.id);
  const satellite = lakeVerdict(lake);
  const extras = lakeExtras.get(lake.id) ?? {};
  const verdict = extras.full ?? satellite;

  const km = chosenPlace ? distanceToLake(lake, chosenPlace) : null;
  const distance = km === null ? "" : `, ${describeDistance(km)}`;
  const where = focus.why === "nearest"
    ? `nearest covered lake${distance}, ${lake.state}`
    : `${lake.state}${distance}`;
  // Another lake nearby with a better rating (decided Oct 21)
  const better = betterLake(lake, verdict);
  showLakeConditions(lake, verdict, where, {
    star: starFor("lake", lake.id),
    better,
    onOpenLake: id => openLake(id, { scroll: true })
  });
  // Not awaited: the card shows the satellite verdict now, the rest when ready
  loadLakeExtras(lake);
  showLakeDetails(lake, {
    satellite,
    full: extras.full ?? null,
    extrasFailed: extras.extrasFailed === true,
    updatedAt: nationwide.updatedAt,
    reportRoutes,
    onShowStations: showStationsForLake,
    onScan: () => showTab("scan"),
    better,
    onOpenLake: id => openLake(id, { scroll: true })
  });

  // The row: the lakes nearest the place (or nearest the lake opened last)
  const center = chosenPlace ?? rowCenter ?? lake;
  let label = (rowCenter ?? lake).name;
  if (chosenPlace) label = chosenPlace.source === "zip" ? `ZIP ${chosenPlace.zip}` : "you";
  showRowHeading(`Lakes near ${label}`, "Nearest first · tap one to see it");
  showTiles(document.getElementById("tiles"), lakeTiles(center, null), lake.id,
            id => openLake(Number(id), { fromRow: true }), TILE_STARS);
}

// "Lakes near you": the other lakes around the place, under the Jordan Lake
// cards (a lake's own row already lists the lakes around it)
function renderNearLakes(focus) {
  const card = document.getElementById("near-lakes-card");
  card.hidden = focus.kind !== "area";
  if (card.hidden) return;

  const box = document.getElementById("near-lakes");
  if (lakesFailed) {
    box.innerHTML = "<p>Couldn't load the lake ratings. Try again soon.</p>";
    return;
  }
  if (!nationwide) {
    box.innerHTML = "<p class=\"small\">Loading nearby lakes…</p>";
    return;
  }
  document.getElementById("near-lakes-title").textContent =
    chosenPlace ? "Other lakes near you" : "Lakes near Jordan Lake";
  const center = chosenPlace ?? nationwide.lakes.find(l => l.id === JORDAN_LAKE_ID);
  showTiles(box, lakeTiles(center, JORDAN_LAKE_ID), null, id => openLake(Number(id), { scroll: true }), TILE_STARS);
}

// The heading and one-line description above the row of tiles
function showRowHeading(title, description) {
  document.getElementById("row-title").textContent = title;
  document.getElementById("row-caption").textContent = description;
}

// The lake tiles around a point, nearest first
function lakeTiles(center, skipId) {
  return nearestLakes(nationwide.lakes, center, LAKE_TILES, skipId).map(({ lake, km }) => ({
    key: lake.id, name: lake.name, level: lake.verdict.level,
    status: lake.verdict.status, sub: lakeTileSub(lake, chosenPlace ? km : null),
    fav: favoriteKey("lake", lake.id)
  }));
}

// --- Favorites (decided Oct 22) ---

// Every tile's star: saved or not, and what a tap does
const TILE_STARS = { isSaved: isFavorite, onToggle: key => starTapped(key) };

// The star on the conditions block, for an area or a lake
function starFor(kind, id) {
  const key = favoriteKey(kind, id);
  return { key, saved: isFavorite(key), onToggle: () => starTapped(key) };
}

// A star was tapped: save or remove it, redraw "Your lakes", and set every
// other star for the same lake on the page to match. Returns true if saved.
function starTapped(key) {
  const saved = toggleFavorite(key);
  renderFavorites();
  for (const button of document.querySelectorAll(`.star-button[data-fav="${key}"]`)) {
    button.setAttribute("aria-pressed", String(saved));
  }
  return saved;
}

// "Your lakes": the saved areas and lakes at the top of the Lake tab, in
// the order they were saved. Hidden until something is saved. An area waits
// for Jordan Lake's data, a lake for the lake files.
function renderFavorites() {
  const tiles = [];
  for (const key of favorites()) {
    const { kind, id } = parseFavorite(key);
    if (kind === "area") {
      const area = latestLake?.areas.find(a => a.id === id);
      if (area) tiles.push({ key, fav: key, name: area.name, level: area.level, sub: "Jordan Lake area" });
    } else {
      const lake = nationwide?.lakes.find(l => l.id === id);
      if (lake) {
        const km = chosenPlace ? distanceToLake(lake, chosenPlace) : null;
        tiles.push({ key, fav: key, name: lake.name, level: lake.verdict.level, status: lake.verdict.status,
                     sub: lakeTileSub(lake, km) });
      }
    }
  }
  document.getElementById("favorites").hidden = tiles.length === 0;
  const current = selected ?? autoFocus();
  const selectedKey = current ? favoriteKey(current.kind, current.id) : null;
  showTiles(document.getElementById("favorite-tiles"), tiles, selectedKey, openFavorite, TILE_STARS);
}

function openFavorite(key) {
  const { kind, id } = parseFavorite(key);
  if (kind === "area") {
    pickArea(id, true);
  } else {
    openLake(id, { scroll: true });
  }
}

// --- "Go here instead" for any lake (decided Oct 21) ---

// The nearest lake within about 30 miles with a better rating (lakes.js),
// preferring lakes with beaches. The beach lists come from each state's
// extras file: the first time, the states around the lake are loaded and
// the tab is drawn again.
function betterLake(lake, verdict) {
  // A big lake: measured from the part closest to the user
  const from = chosenPlace && lake.shore ? closestPointOfLake(lake, chosenPlace) : lake;
  const withBeaches = new Set();
  for (const ids of beachLakes.values()) {
    for (const id of ids) withBeaches.add(id);
  }
  const better = betterLakeNearby(lake, verdict, nationwide.lakes, withBeaches, from);
  if (better) loadBeachLakes(better.states);
  return better;
}

async function loadBeachLakes(states) {
  const missing = states.filter(state => !beachLakes.has(state) && !beachesLoading.has(state));
  if (missing.length === 0) return;
  for (const state of missing) beachesLoading.add(state);
  await Promise.all(missing.map(async state => {
    try {
      beachLakes.set(state, await lakesWithBeaches(state));
    } catch (error) {
      // Without the beach list, lakes there just aren't preferred
      console.error("Failed to load the beach list for", state, error);
      beachLakes.set(state, new Set());
    }
    beachesLoading.delete(state);
  }));
  render();
}

// --- Your tap water (decided Oct 13; card Oct 22) ---

// Looked up once per place; drawn again whenever the lake ratings change
async function loadTapWater(place) {
  tapWater = null;
  // Tap water is about where you live, not the lake on screen, so the card
  // says which place it's for (a lake picked in the search doesn't change it)
  const where = place.source === "zip" ? `ZIP ${place.zip}` : "your location";
  document.getElementById("tap-desc").textContent =
    `For ${where}, not the lake on screen. Change it with the place button at the top. Context only.`;
  showTapWaterStatus("Looking up your water system…");
  try {
    const result = await findWaterSystems(place);
    // The user may have chosen another place while this one loaded
    if (place !== chosenPlace) return;
    tapWater = result;
    drawTapWater();
  } catch (error) {
    console.error("Couldn't look up the water system", error);
    if (place === chosenPlace) {
      showTapWaterStatus(`Couldn't look up your water system right now (${error.message}). Try again soon.`);
    }
  }
}

function drawTapWater() {
  showTapWater(tapWater, nationwide ? nationwide.lakes : null, id => openLake(id, { scroll: true }));
  drawWaterSources();
}

// A droplet badge on the map for each lake the first (most likely) water
// system draws from (decided Oct 22), the same lakes the card lists
function drawWaterSources() {
  const covered = tapWater?.systems[0]?.sources?.lakes ?? [];
  const sources = nationwide
    ? covered.map(([id]) => nationwide.lakes.find(l => l.id === id))
             .filter(lake => lake)
             // The app's name for the lake (e.g. "Jordan Lake", not EPA's "B Everett Jordan Lake")
             .map(lake => ({ lake, name: lake.name }))
    : [];
  showWaterSources(getMap(), sources);
}

// The full map's small sheet: the area or lake being looked at
function renderMapSheet(focus) {
  const sheet = document.getElementById("map-sheet");
  let name;
  let label;
  if (focus.kind === "area") {
    const area = latestLake.areas.find(a => a.id === focus.id);
    name = area.name;
    label = verdictLabel(area);
  } else {
    const lake = nationwide.lakes.find(l => l.id === focus.id);
    name = escapeHtml(lake.name);
    label = verdictLabel(lakeExtras.get(lake.id)?.full ?? lake.verdict);
  }
  sheet.innerHTML = `
    <p><strong>${name}</strong> ${label}</p>
    <button type="button" class="button-line" id="map-sheet-why">See why and what to do</button>
  `;
  document.getElementById("map-sheet-why").addEventListener("click", () => {
    setFullMap(false);
    document.getElementById("why").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// --- Picking what to look at ---

// A Jordan Lake area (a tile, a pin, or "Go to X instead")
function pickArea(id, scroll) {
  selected = { kind: "area", id, why: "picked" };
  render();
  if (scroll) scrollToTop();
}

// Any lake (a pin, a tile, or a search suggestion). Its satellite verdict
// shows right away; then (decided Oct 13) its wind, rain, river flow, lake
// level and beaches once they load. Jordan Lake opens its 10 areas instead.
async function openLake(id, { scroll = false, fromRow = false } = {}) {
  if (id === JORDAN_LAKE_ID) {
    selected = latestLake ? { kind: "area", id: latestLake.ranked[0].id, why: "best" } : null;
    render();
    const jordan = nationwide.lakes.find(l => l.id === JORDAN_LAKE_ID);
    showOnMap(jordan.lat, jordan.lng, LAKE_ZOOM + 1);
    if (scroll) scrollToTop();
    return;
  }
  const lake = nationwide.lakes.find(l => l.id === id);
  if (!lake) return;
  selected = { kind: "lake", id, why: "picked" };
  if (!fromRow) rowCenter = lake;
  render();
  // A big lake: the part closest to the user (Lake Michigan's middle is 150
  // miles from Chicago)
  const spot = chosenPlace ? closestPointOfLake(lake, chosenPlace) : lake;
  showOnMap(spot.lat, spot.lng, LAKE_ZOOM);
  if (scroll) scrollToTop();
}

// A lake's wind, rain, river flow, lake level and beaches (decided Oct 13),
// fetched once per lake and place: when a lake is opened, and when the Lake
// tab shows the nearest lake on its own. Then the card, pin and tiles redraw.
async function loadLakeExtras(lake) {
  if (lakeExtras.has(lake.id) || extrasLoading.has(lake.id)) return;
  extrasLoading.add(lake.id);
  const place = chosenPlace;
  const [extras] = await Promise.all([fetchLakeExtras(lake, place), loadReportRoutes()]);
  extrasLoading.delete(lake.id);
  // The user chose another place while this was loading: its beaches and
  // wind spot were for the old place, so throw it away and draw again
  // (which loads it for the new place if this lake is still shown)
  if (chosenPlace !== place) {
    render();
    return;
  }
  // Each piece already fails soft; this catch is for anything unexpected,
  // so the card never stays on "Checking…"
  try {
    const full = combineLakeSignals(lakeVerdict(lake), extras);
    lakeExtras.set(lake.id, { full });
    // The pin and the tiles show the same verdict as the card
    lake.verdict = full;
    updateLakePin(lake);
  } catch (error) {
    console.error("Failed to combine the lake's signals", error);
    lakeExtras.set(lake.id, { extrasFailed: true });
  }
  render();
}

// "Live water stations near this lake": the same list as for the user's
// place (nearby.js), around the lake's middle, or for a big lake its
// shore closest to the user
async function showStationsForLake(lake, element) {
  element.innerHTML = "<p>Finding live USGS stations near this lake…</p>";
  try {
    const point = chosenPlace ? closestPointOfLake(lake, chosenPlace) : lake;
    const result = await findStationsNear(point);
    showStationsNearLake(element, result, escapeHtml(lake.name));
  } catch (error) {
    console.error("Failed to load the stations near", lake.name, error);
    element.innerHTML = `<p>Couldn't load stations: ${error.message} Try again soon.</p>`;
  }
}

function scrollToTop() {
  document.getElementById("now").scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- Jordan Lake's extra data ---

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

// --- The example station picker (no place chosen) ---

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
      ? describeLimitedStation(readings, flowNormal)
      : judgeStation(readings, station.tier, rulesFor(await loadStandards(), PICKER_STATE, "ST"));

    showResult(station, risk, readings);
  } catch (error) {
    if (picker.value !== station.id) return;
    console.error("Failed to load", station.name, error);
    showError(station, error.message);
  }
}

// --- The camera scan ---
// Tap to scan or use a photo (decided Oct 24, after the live result jumped
// around in testing): the live view shows only the camera. Tapping Scan
// freezes the picture, looks at 8 frames over about 1.5 seconds and shows
// one averaged result. A photo gets the same single result. The old "bloom
// in 5 of the last 6 frames" rule is replaced by the averaging.

// Start the camera and load the model at the same time, then show the
// live view with the Scan button
async function startScan() {
  scanButton.disabled = true;
  showScanStatus("Starting the camera and loading the model…");
  scanVideo.hidden = false;

  try {
    await Promise.all([loadModel(), startCamera(scanVideo)]);
    cameraOn = true;
    scanButton.textContent = "Stop camera";
    scanButton.className = "button-line";   // quieter, so Scan stays the main button
    showLiveView();
  } catch (error) {
    console.error("Camera scan failed", error);
    stopCamera(scanVideo);
    scanVideo.hidden = true;
    showScanStatus(`Couldn't start the camera: ${error.message}. Allow camera access, or use a photo.`);
  }
  scanButton.disabled = false;
}

// The live picture with the Scan button, no result
function showLiveView() {
  scanStill.hidden = true;
  scanView.classList.remove("has-result");
  clearScanResult();
  clearScanNote();
  scanAgainButton.hidden = true;
  showStartButton();
  shutterButton.hidden = false;
  showScanStatus(SCAN_HINT);
}

// Turn the camera off. A result already on screen stays.
function stopScan() {
  cameraOn = false;
  stopCamera(scanVideo);
  scanVideo.hidden = true;
  shutterButton.hidden = true;
  scanButton.textContent = "Start camera";
  scanButton.className = "button-solid";
  showScanStatus(scanStill.hidden ? "Camera off" : "");
  if (askingAboutBloom) closeSheet("sheet-bloom");   // closing counts as No
  showStartButton();
}

// "Start camera" / "Stop camera" hides while a result's "Scan again" can
// start the camera instead (two buttons doing the same thing)
function showStartButton() {
  scanButton.hidden = !cameraOn && !scanAgainButton.hidden;
}

// The Scan button: freeze the picture, look at several frames, average them
async function takeScan() {
  if (!cameraOn || scanBusy) return;
  scanBusy = true;
  freezeFrame(scanVideo, scanStill);
  scanStill.classList.remove("is-photo");
  scanStill.hidden = false;
  shutterButton.hidden = true;
  showScanStatus("");
  showScanLooking(0, 1);

  try {
    const model = await loadModel();
    const result = await scanLive(model, scanVideo, showScanLooking);
    await showScanOutcome(result);
  } catch (error) {
    console.error("Scan failed", error);
    scanStill.hidden = true;
    scanView.classList.remove("has-result");
    if (cameraOn) {
      shutterButton.hidden = false;
      showScanStatus(`Couldn't scan: ${error.message}. Try again.`);
    } else {
      showScanStatus("Camera off");
    }
  }
  showScanLooking(null);
  scanBusy = false;
}

// "Use a photo instead": works with the camera off, and on laptops
async function scanPhoto(file) {
  if (!file || scanBusy) return;
  if (cameraOn) stopScan();
  scanBusy = true;
  clearScanResult();
  clearScanNote();
  scanAgainButton.hidden = true;
  showStartButton();
  showScanStatus("");
  showScanLooking(0, 1);
  scanStill.classList.add("is-photo");

  try {
    const [model] = await Promise.all([loadModel(), drawPhoto(file, scanStill)]);
    scanStill.hidden = false;
    const result = scanPicture(model, scanStill);
    showScanLooking(1, 1);
    await showScanOutcome(result);
  } catch (error) {
    console.error("Photo scan failed", error);
    scanStill.hidden = true;
    scanView.classList.remove("has-result");
    showScanStatus(`Couldn't read that photo (${error.message}). Try another one.`);
  }
  showScanLooking(null);
  scanBusy = false;
  photoInput.value = "";   // so choosing the same photo again still works
}

// Show the one result under the picture; a bloom at 70% or more asks the
// bloom question (decided Oct 11)
async function showScanOutcome(result) {
  if (!reportRoutes) await loadReportRoutes();
  scanView.classList.add("has-result");
  showScanResult(result, reportHtml(stateAt(lastScanPlace ?? chosenPlace), reportRoutes));
  scanAgainButton.hidden = false;
  showStartButton();
  document.getElementById("scan-result").scrollIntoView({ behavior: "smooth", block: "nearest" });

  if (result.label === "bloom" && !askingAboutBloom) {
    askingAboutBloom = true;
    const percent = Math.round(result.confidence * 100);
    askAboutBloom(percent, answeredYes => answerBloomQuestion(answeredYes, percent));
  }
}

// "Scan again": back to the live picture (the camera starts if it's off)
function scanAgain() {
  if (cameraOn) {
    showLiveView();
  } else {
    scanStill.hidden = true;
    scanView.classList.remove("has-result");
    clearScanResult();
    clearScanNote();
    scanAgainButton.hidden = true;
    showStartButton();
    startScan();
  }
}

// Yes → find the nearest Jordan Lake area and raise its verdict one level
// (saved on this phone only). No → nothing changes. Either way after a Yes,
// the report link in the result switches to the user's state.
async function answerBloomQuestion(answeredYes, percent) {
  if (!answeredYes) {
    askingAboutBloom = false;
    return;
  }

  await loadReportRoutes();
  try {
    const here = await getLocation();
    lastScanPlace = here;
    updateScanReport(reportHtml(stateAt(here), reportRoutes));
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

// The state a point is in, for reporting a bloom: the state of the nearest
// covered lake (null if the lake list isn't loaded, then EPA's list of
// every state's program is shown). No point (no place chosen yet) → null too.
function stateAt(point) {
  if (!nationwide || !point) return null;
  return nearestLakes(nationwide.lakes, point, 1)[0]?.lake.state ?? null;
}

// --- The user's place (the location sheet) ---

// The header's place button and the hint under the conditions block
function openPlaceSheet() {
  openSheet("sheet-place");
  searchInput.focus();
}

// "Use my location": the phone's GPS, asked for only after a tap
async function useMyLocation() {
  showNearYouStatus("Finding your location…");
  try {
    const point = await getLocation();
    choosePlace({ ...point, source: "gps" });
  } catch (error) {
    console.error("Couldn't get the location", error);
    openSheet("sheet-place");
    showNearYouStatus(`Couldn't get your location (${error.message}). Try a ZIP code instead.`);
  }
}

// A ZIP code: the middle of that ZIP's area, from the Census list
async function useZip(zip) {
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
    showNearYouStatus(`Couldn't look up ZIP ${zip} (${error.message}). Try again soon.`);
  }
}

// A place was chosen: remember the choice, put the dot on the map and show
// what's near it
function choosePlace(place) {
  chosenPlace = place;
  savePlaceChoice(place.source === "zip" ? { source: "zip", zip: place.zip } : { source: "gps" });
  showPlaceName(place);
  showNearYouStatus(describePlace(place));
  nearClearButton.hidden = false;
  closeSheet("sheet-place");
  showYouAreHere(place, nearJordan(place));

  // A new place: the Lake tab picks again on its own, and lakes' other
  // signals are fetched again (beaches and the wind spot depend on the place)
  selected = null;
  rowCenter = null;
  lakeExtras.clear();
  pickerBox.hidden = true;
  render();
  loadStationsNear(place);
  loadTapWater(place);
}

function nearJordan(place) {
  return nearest(AREAS, place).km <= NEAR_LAKE_KM;
}

// To a lake's middle, or a big lake's nearest shore point
function distanceToLake(lake, place) {
  return distanceKm(place, closestPointOfLake(lake, place));
}

// Every live USGS station near the place, each compared with its own
// state's standards (2 USGS requests; nearby.js remembers the answer)
async function loadStationsNear(place) {
  document.getElementById("stations-title").textContent = "Live stations near you";
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

// The header's place button: a short name on the button, and the whole
// thing ("Place: ZIP 27519") for screen readers
function showPlaceName(place) {
  document.getElementById("place-name").textContent = placeName(place);
  const button = document.getElementById("place-button");
  if (!place) {
    button.setAttribute("aria-label", "Set your place");
  } else {
    button.setAttribute("aria-label", place.source === "zip" ? `Place: ZIP ${place.zip}` : "Place: my location");
  }
}

// "Clear": forget the choice and go back to the Jordan Lake view
function clearPlace() {
  chosenPlace = null;
  forgetPlaceChoice();
  searchInput.value = "";
  suggestionsBox.innerHTML = SEARCH_HINT;
  nearClearButton.hidden = true;
  showNearYouStatus("");
  showPlaceName(null);
  selected = null;
  rowCenter = null;
  lakeExtras.clear();
  clearStationsNear();
  tapWater = null;
  clearTapWater();
  showWaterSources(getMap(), []);
  document.getElementById("stations-title").textContent = "Live stations: examples in North Carolina";
  pickerBox.hidden = false;
  clearYouAreHere();
  closeSheet("sheet-place");
  render();
}

// When the page opens, bring back the last choice. A ZIP comes back right
// away; GPS only if the phone already allows it, so there's no surprise
// pop-up (otherwise it waits for a tap).
async function restorePlace() {
  const saved = savedPlaceChoice();
  if (saved?.source === "zip") {
    useZip(saved.zip);
  } else if (saved?.source === "gps" && await locationAllowed()) {
    useMyLocation();
  }
}

// The search box (decided Oct 20): digits → a ZIP code; letters → lakes
// whose name matches, from the list already loaded (no request)
function showSuggestions() {
  const text = searchInput.value.trim();
  if (text === "") {
    suggestionsBox.innerHTML = SEARCH_HINT;
    return;
  }
  if (/^\d+$/.test(text)) {
    suggestionsBox.innerHTML = isZip(text)
      ? `<li><button type="submit" class="suggestion">Use ZIP ${text}</button></li>`
      : '<li class="small">A ZIP code has 5 digits.</li>';
    return;
  }
  if (!nationwide) {
    suggestionsBox.innerHTML = '<li class="small">Lake list still loading. Try again, or type a ZIP.</li>';
    return;
  }
  const found = searchLakes(nationwide.lakes, text, chosenPlace);
  if (found.length === 0) {
    suggestionsBox.innerHTML = `<li class="small">No covered lake matches "${escapeHtml(text)}". Check spelling or try a ZIP.</li>`;
    return;
  }
  suggestionsBox.innerHTML = found.map(({ lake, km }) => `
    <li><button type="button" class="suggestion" data-lake="${lake.id}">
      <span><strong>${escapeHtml(lake.name)}</strong> <small>${lake.state}${km === null ? "" : `, ${describeDistance(km)}`}</small></span>
      <small>${verdictLabel(lake.verdict)}</small>
    </button></li>
  `).join("");
  for (const button of suggestionsBox.querySelectorAll("[data-lake]")) {
    button.addEventListener("click", () => pickSuggestion(Number(button.dataset.lake)));
  }
}

function pickSuggestion(id) {
  closeSheet("sheet-place");
  showTab("lake");
  openLake(id, { scroll: true });
}

// Enter in the search box: a ZIP code, or the first lake suggestion
function submitSearch(event) {
  event.preventDefault();   // stay on this page instead of sending the form
  const text = searchInput.value.trim();
  if (isZip(text)) {
    useZip(text);
    return;
  }
  const first = suggestionsBox.querySelector("[data-lake]");
  if (first) {
    pickSuggestion(Number(first.dataset.lake));
  } else {
    showNearYouStatus("Type a 5-digit ZIP code or part of a lake's name.");
  }
}

// --- The full map (the Satellite card full screen) ---

function setFullMap(on) {
  satCard.classList.toggle("is-full", on);
  document.body.classList.toggle("map-open", on);
  document.getElementById("map-sheet").hidden = !on;
  fullMapButton.textContent = on ? "Close map" : "Full map";
  refreshMapSize();
}

// --- Starting up ---

setUpTabs();
setUpSheets();
// Leaving the Scan tab turns the camera off; coming back to the Lake tab,
// Leaflet measures the map again (it can't while the tab is hidden)
onTab("scan", { leave: () => { if (cameraOn) stopScan(); } });
onTab("lake", { show: refreshMapSize });

loadLake();
loadLakes();
loadReportRoutes().then(() => render());

document.getElementById("place-button").addEventListener("click", openPlaceSheet);
document.getElementById("exposed-button").addEventListener("click", () => openSheet("sheet-exposed"));
document.getElementById("near-gps").addEventListener("click", useMyLocation);
nearClearButton.addEventListener("click", clearPlace);
searchInput.addEventListener("input", showSuggestions);
searchForm.addEventListener("submit", submitSearch);
restorePlace();

// The map's own buttons
document.getElementById("locate-button").addEventListener("click", () => {
  if (chosenPlace) {
    recenter();
  } else {
    useMyLocation();
  }
});
document.getElementById("satellite-switch").addEventListener("change", event => {
  setSatelliteVisible(event.target.checked);
});
fullMapButton.addEventListener("click", () => setFullMap(!satCard.classList.contains("is-full")));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && satCard.classList.contains("is-full")) setFullMap(false);
});

// The More tab's directory (decided Oct 21): each row goes to where that
// feature lives. Rows for the Lake tab switch tabs first.
const DIRECTORY = {
  intro: openWelcome,
  tour: startTour,
  stations: () => showSection("lake", "stations-card"),
  // With no place yet, the place search first (the card needs a place)
  tap: () => (chosenPlace ? showSection("lake", "tap-card") : openPlaceSheet()),
  how: () => showSection("more", "about-how"),
  exposed: () => openSheet("sheet-exposed"),
  report: () => showSection("lake", "todo"),
  sources: () => showSection("more", "about-sources"),
  about: () => showSection("more", "about-app")
};
for (const row of document.querySelectorAll("[data-go]")) {
  row.addEventListener("click", () => DIRECTORY[row.dataset.go]());
}

// Switch to a tab and scroll to one part of it
function showSection(tab, id) {
  showTab(tab);
  document.getElementById(id).scrollIntoView({ block: "start" });
}

// The first-open intro (decided Oct 24): opens by itself on the first
// visit; the (i) button in the header and the More tab reopen it
setUpWelcome();

// One button: starts the camera when it's off, stops it when it's on
scanButton.addEventListener("click", () => {
  if (!cameraOn) {
    startScan();
  } else {
    stopScan();
  }
});

// The Scan button over the live picture, "Scan again", and the photo picker
shutterButton.addEventListener("click", takeScan);
scanAgainButton.addEventListener("click", scanAgain);
photoInput.addEventListener("change", () => scanPhoto(photoInput.files[0]));

// Leaving the page (another app or tab, phone locked) turns the camera off
document.addEventListener("visibilitychange", () => {
  if (document.hidden && cameraOn) {
    stopScan();
  }
});

fillStationPicker(STATIONS);

picker.addEventListener("change", () => {
  const station = STATIONS.find(s => s.id === picker.value);
  run(station);
});

run(STATIONS[0]);
