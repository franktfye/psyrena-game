/**
 * Practice Pit intro — the confirmation modal between tapping the practice
 * booth's attendant and entering the practice scene. What the pit is for, a
 * little invented history, then Enter / Not now.
 *
 * Same plain-DOM discipline as roomsPanel.ts: markup and styles live in this
 * one module, nothing touches a scene. Deliberately needs NO profile and no
 * fetch — the practice booth works logged out (the headless soak test walks
 * this path too), so the modal must as well.
 */

import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER,
  WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

const CSS = `
#practice-pit {
  position: fixed; inset: 0; z-index: 44; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.6 ${WOW_FONT};
  display: grid; place-items: center;
  /* Safe-area terms keep the card clear of a landscape iPhone's camera housing. */
  padding: calc(18px + env(safe-area-inset-top, 0px)) calc(10px + env(safe-area-inset-right, 0px))
           calc(18px + env(safe-area-inset-bottom, 0px)) calc(10px + env(safe-area-inset-left, 0px));
  box-sizing: border-box;
}
#practice-pit .card {
  width: min(520px, 94vw); padding: 20px 20px 16px;
  ${WOW_CARD}
}
#practice-pit h1 {
  margin: 0 0 12px; font-size: 16px; letter-spacing: .3em; font-weight: 700;
  text-transform: uppercase;
  ${WOW_GOLD_TEXT}
}
#practice-pit p { margin: 0 0 10px; color: ${WOW_TEXT}; }
#practice-pit p.lore { color: ${WOW_TEXT_DIM}; font-style: italic; }
#practice-pit .btns { display: flex; gap: 10px; margin-top: 16px; }
#practice-pit button.cta {
  flex: 1; font: inherit; font-size: 13px;
  ${WOW_CTA}
}
#practice-pit button.cta:hover { ${WOW_CTA_HOVER} }
#practice-pit button.ghost {
  font: inherit; padding: 10px 14px;
  ${WOW_BTN}
}
#practice-pit button.ghost:hover { ${WOW_BTN_HOVER} }
`;

/**
 * Open the intro. Idempotent — a second tap while it is up does nothing.
 * Closes on "Not now", backdrop click, or Escape; "Enter the Pit" closes and
 * fires onEnter (the scene hand-off).
 */
export function openPracticePitIntro(onEnter: () => void): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("practice-pit")) return;
  if (!document.getElementById("practice-pit-css")) {
    const style = document.createElement("style");
    style.id = "practice-pit-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.id = "practice-pit";

  const card = document.createElement("div");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "The Practice Pit";

  const intro = document.createElement("p");
  intro.textContent =
    "A safe, warded space to drill your full kit on a tireless training " +
    "dummy, with a live damage and healing meter. No stakes, no rewards, no wounds.";

  const lore = document.createElement("p");
  lore.className = "lore";
  lore.textContent =
    "The first Analysts of the village sank this pit long ago, when the " +
    "Nightmare was still only a rumor at the edge of sleep — a place to " +
    "rehearse the defenses of the mind before facing the thing itself. Its " +
    "dummy, they say, is stitched from abandoned nightmares that never found " +
    "a dreamer: that is why it never fights back, and why it never tires.";

  const btns = document.createElement("div");
  btns.className = "btns";
  const enter = document.createElement("button");
  enter.className = "cta";
  enter.type = "button";
  enter.textContent = "Enter the Pit";
  const later = document.createElement("button");
  later.className = "ghost";
  later.type = "button";
  later.textContent = "Not now";
  btns.append(enter, later);

  card.append(h1, intro, lore, btns);
  overlay.appendChild(card);

  const shut = (): void => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") shut();
  };
  // Ghost-click guard, same as roomsPanel: the modal opens on the scene's
  // POINTERUP, and on touch the synthetic click at the release point lands on
  // the just-opened backdrop and would close it in the same gesture.
  const openedAt = performance.now();
  const GHOST_MS = 350;
  const ghostShut = (): void => {
    if (performance.now() - openedAt < GHOST_MS) return;
    shut();
  };

  enter.addEventListener("click", () => {
    shut();
    onEnter();
  });
  later.addEventListener("click", ghostShut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) ghostShut();
  });
  window.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}
