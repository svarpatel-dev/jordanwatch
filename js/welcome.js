// The first-visit tips (decided Oct 21): three steps at the top of the
// Lake tab ("1 Search a ZIP or lake · 2 See its rating and why · 3 Scan the
// water"), shown until the user closes them. Each step is also a button
// that does that step.
//
// Closing is remembered on this phone (localStorage, like a small dict saved
// to disk). Some browsers block saving (private windows), so every read and
// write is in try/catch: then the tips simply show again next time.

const CLOSED_KEY = "jordanwatch-welcome-closed";

// actions = { search: fn, why: fn, scan: fn }, one for each step's button
export function setUpWelcome(actions) {
  const box = document.getElementById("welcome");
  box.hidden = wasClosed();

  document.getElementById("welcome-close").addEventListener("click", () => {
    box.hidden = true;
    rememberClosed();
  });
  for (const button of box.querySelectorAll("[data-step]")) {
    button.addEventListener("click", () => actions[button.dataset.step]());
  }
}

function wasClosed() {
  try {
    return localStorage.getItem(CLOSED_KEY) === "yes";
  } catch {
    return false;
  }
}

function rememberClosed() {
  try {
    localStorage.setItem(CLOSED_KEY, "yes");
  } catch {
    // Not saved: the tips come back next visit, which is harmless
  }
}
