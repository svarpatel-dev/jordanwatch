// Entry point: connects the other modules.
// Fetch → extract readings → compute risk → show it.

import { STATION_ID } from "./stations.js";
import { fetchStationData, extractAllReadings } from "./usgs.js";
import { computeRisk } from "./risk.js";
import { showResult } from "./ui.js";

async function run() {
  const data = await fetchStationData(STATION_ID);
  const readings = extractAllReadings(data);
  const risk = computeRisk(readings);

  console.log("All readings:", readings);
  console.log("Risk result:", risk);

  showResult(risk, readings);
}

run();
