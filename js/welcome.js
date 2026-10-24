// The welcome card (decided Oct 24, after a neighbor's test): what
// JordanWatch is, why it exists and who made it, with "Take the guided
// tour" as the main button. The tour (tour.js) then points at every
// feature on the real app, so nothing is explained twice.
//
// It opens by itself on the first visit only. Skip, the tour button and
// Escape all close it and remember that on this phone (localStorage, like
// a small dict saved to disk). Some browsers block saving (private
// windows), so every read and write is in try/catch: then the welcome
// simply shows again. It can be reopened any time from the (i) button in
// the header or the "Welcome" row on the More tab.
//
// The welcome is a <dialog>: the browser keeps the keyboard inside it,
// closes it on Escape and dims the page behind it.

import { startTour } from "./tour.js";

const SEEN_KEY = "jordanwatch-intro-seen";

const dialog = document.getElementById("intro");

export function setUpWelcome() {
  document.getElementById("intro-skip").addEventListener("click", closeIntro);
  document.getElementById("intro-close").addEventListener("click", closeIntro);
  // Close the welcome first, then walk through the real app
  document.getElementById("intro-tour").addEventListener("click", () => {
    closeIntro();
    startTour();
  });

  // Escape: the browser closes the dialog; remember it like Skip
  dialog.addEventListener("close", rememberSeen);

  document.getElementById("intro-button").addEventListener("click", openWelcome);

  if (!wasSeen()) openWelcome();
}

export function openWelcome() {
  if (!dialog.open) dialog.showModal();
  // Start on the title, so a screen reader reads the card from the top
  document.getElementById("intro-title").focus();
}

function closeIntro() {
  if (dialog.open) dialog.close();   // the "close" event remembers it
}

function wasSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === "yes";
  } catch {
    return false;
  }
}

function rememberSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "yes");
  } catch {
    // Not saved: the welcome comes back next visit, which is harmless
  }
}
