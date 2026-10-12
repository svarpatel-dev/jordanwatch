// Camera scans the user confirmed as a possible bloom (decided Oct 11).
// Saved on this phone only (the browser's localStorage, like a tiny file
// the page can keep); never sent anywhere. Each one counts until midnight.

const STORAGE_KEY = "jordanwatch-scans";

// Used only if the browser blocks storage (e.g. some private modes)
let unsaved = [];

// Remember a confirmed scan, e.g. { areaId: "seaforth", percent: 86 }
export function saveScan(scan) {
  const now = new Date();
  const saved = { ...scan, date: localDate(now), time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) };
  const scans = [...todaysScans(), saved];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scans));
  } catch (error) {
    // Storage blocked: the scan still counts until the page is reloaded
    console.error("Couldn't save the scan on this phone", error);
    unsaved.push(saved);
  }
  return saved;
}

// Today's confirmed scans (older ones are dropped)
export function todaysScans() {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
  } catch (error) {
    // storage blocked or unreadable: just use what's in memory
  }
  const today = localDate(new Date());
  return [...stored, ...unsaved].filter(scan => scan.date === today);
}

// "YYYY-MM-DD" in the phone's own time zone, so a scan lasts until local midnight
function localDate(date) {
  return date.toLocaleDateString("en-CA");
}
