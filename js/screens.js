// The app's three tabs (Lake, Scan, More) and its sheets (the location
// sheet, If exposed, the bloom question). One page: switching tabs only
// hides and shows sections, no page loads.
//
// Sheets are <dialog> elements: the browser already handles the hard parts
// (keeps the keyboard inside, closes on Escape, dims the page behind).

const TABS = ["lake", "scan", "more"];

// Functions to run when a tab is left or shown: { scan: { leave: fn } }
const tabHooks = {};
let currentTab = "lake";

// hooks = { show: fn, leave: fn }, both optional
export function onTab(name, hooks) {
  tabHooks[name] = hooks;
}

export function showTab(name) {
  if (name === currentTab) return;
  tabHooks[currentTab]?.leave?.();
  currentTab = name;

  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).hidden = tab !== name;
    // aria-current tells screen readers which tab is on
    const button = document.querySelector(`[data-tab="${tab}"]`);
    if (tab === name) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  window.scrollTo(0, 0);
  tabHooks[name]?.show?.();
}

// Every tab button (data-tab="lake" and so on) switches to its tab
export function setUpTabs() {
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }
}

export function openSheet(id) {
  const sheet = document.getElementById(id);
  if (!sheet.open) sheet.showModal();
}

export function closeSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet.open) sheet.close();
}

// Each sheet closes with its close button or a tap on the dimmed page
// around it (that tap lands on the <dialog> itself, not on its content)
export function setUpSheets() {
  for (const sheet of document.querySelectorAll("dialog.sheet")) {
    sheet.addEventListener("click", event => {
      if (event.target === sheet || event.target.closest("[data-close]")) sheet.close();
    });
  }
}
