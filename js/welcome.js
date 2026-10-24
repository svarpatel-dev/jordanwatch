// The first-open intro (decided Oct 24, after a neighbor's test): six
// cards, each with a real screenshot of the app and numbered arrows that
// point at the exact buttons. It replaces the small 3-step tips box.
//
// It opens by itself on the first visit only. Skip, Get started and Escape
// all close it and remember that on this phone (localStorage, like a small
// dict saved to disk). Some browsers block saving (private windows), so
// every read and write is in try/catch: then the intro simply shows again.
// It can be reopened any time from the (i) button in the header or the
// "How to use JordanWatch" row on the More tab.
//
// The intro is a <dialog>: the browser keeps the keyboard inside it, closes
// it on Escape and dims the page behind it.

const SEEN_KEY = "jordanwatch-intro-seen";

const dialog = document.getElementById("intro");
const cards = [...dialog.querySelectorAll(".intro-card")];
const dots = [...dialog.querySelectorAll(".intro-dots button")];
const backButton = document.getElementById("intro-back");
const nextButton = document.getElementById("intro-next");
const countText = document.getElementById("intro-count");

let current = 0;

export function setUpWelcome() {
  backButton.addEventListener("click", () => showCard(current - 1));
  nextButton.addEventListener("click", () => {
    if (current === cards.length - 1) {
      closeIntro();
    } else {
      showCard(current + 1);
    }
  });
  document.getElementById("intro-skip").addEventListener("click", closeIntro);
  dots.forEach((dot, index) => dot.addEventListener("click", () => showCard(index)));

  // Escape: the browser closes the dialog; remember it like Skip
  dialog.addEventListener("close", rememberSeen);

  // Left and right arrow keys move between cards (not while a button
  // inside needs them, which none do)
  dialog.addEventListener("keydown", event => {
    if (event.key === "ArrowRight" && current < cards.length - 1) showCard(current + 1);
    if (event.key === "ArrowLeft" && current > 0) showCard(current - 1);
  });

  // Swipe left or right on a phone (optional; the buttons always work)
  let startX = null;
  dialog.addEventListener("touchstart", event => {
    startX = event.touches[0].clientX;
  }, { passive: true });
  dialog.addEventListener("touchend", event => {
    if (startX === null) return;
    const moved = event.changedTouches[0].clientX - startX;
    startX = null;
    if (moved < -50 && current < cards.length - 1) showCard(current + 1);
    if (moved > 50 && current > 0) showCard(current - 1);
  });

  document.getElementById("intro-button").addEventListener("click", openWelcome);

  if (!wasSeen()) openWelcome();
}

// Open the intro at its first card
export function openWelcome() {
  showCard(0, false);
  if (!dialog.open) dialog.showModal();
  // Start on the title, so a screen reader reads the card from the top
  cards[0].querySelector("h2").focus();
}

function closeIntro() {
  if (dialog.open) dialog.close();   // the "close" event remembers it
}

// Show one card and hide the others. moveFocus: put the keyboard on the
// new card's title (not when the intro is just opening)
function showCard(index, moveFocus = true) {
  current = Math.max(0, Math.min(index, cards.length - 1));
  cards.forEach((card, i) => {
    card.hidden = i !== current;
  });
  dots.forEach((dot, i) => {
    if (i === current) {
      dot.setAttribute("aria-current", "step");
    } else {
      dot.removeAttribute("aria-current");
    }
  });
  backButton.disabled = current === 0;
  const last = current === cards.length - 1;
  nextButton.textContent = last ? "Get started" : "Next";
  countText.textContent = `${current + 1} of ${cards.length}`;
  if (moveFocus) cards[current].querySelector("h2").focus();
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
    // Not saved: the intro comes back next visit, which is harmless
  }
}
