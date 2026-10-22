// Favorites (decided Oct 13, built Oct 22): a star on a lake or a Jordan
// Lake area saves it on this phone, and saved ones show first in a "Your
// lakes" row at the top of the Lake tab. No login: the list lives in this
// browser only (localStorage, like a small dict saved to disk).
//
// Each favorite is one short text key: "area:seaforth" or "lake:2300042"
// (a Jordan Lake area by its id, any other lake by its EPA id).
//
// Some browsers block saving (private windows), so every read and write is
// in try/catch: then the star still works until the page is closed.

const STORAGE_KEY = "jordanwatch-favorites";

// The list while the page is open, read from storage once (like a Python
// list kept in a module-level variable)
let saved = null;

// "area" + "seaforth" → "area:seaforth"
export function favoriteKey(kind, id) {
  return `${kind}:${id}`;
}

// "lake:2300042" → { kind: "lake", id: 2300042 } (lake ids are numbers)
export function parseFavorite(key) {
  const [kind, id] = key.split(":");
  return { kind, id: kind === "lake" ? Number(id) : id };
}

// Every saved key, in the order they were saved
export function favorites() {
  if (saved === null) saved = readSaved();
  return [...saved];
}

export function isFavorite(key) {
  return favorites().includes(key);
}

// Star → saved; star again → removed. Returns true if it's now saved.
export function toggleFavorite(key) {
  const list = favorites();
  saved = list.includes(key) ? list.filter(k => k !== key) : [...list, key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Saving is blocked: the star still works for this visit
  }
  return saved.includes(key);
}

function readSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    // Only keep text keys that look right, in case the saved value is broken
    return Array.isArray(list) ? list.filter(k => typeof k === "string" && /^(area|lake):/.test(k)) : [];
  } catch {
    return [];
  }
}
