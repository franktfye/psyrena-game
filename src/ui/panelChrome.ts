/**
 * Panel chrome — keeps opened UI panels truly in the foreground on touch.
 *
 * Panels already outrank the HUD in z-index (40+ vs dock 30 / bar 10), but on
 * a phone the left dock and the right skill cluster stay *visible and
 * tappable* around a panel that doesn't fill the whole screen, which reads as
 * the panel sitting under the chrome. While any panel is open on the touch
 * scheme, the dock and the action bar hide entirely.
 *
 * Driven by a MutationObserver instead of wiring every open/close function:
 * panels mount their root straight onto <body>, so watching body children and
 * toggling `data-panel-open` covers every present and future panel with one
 * rule.
 */

import { playSfx } from "../state/sfx";

/** Root ids of every overlay panel that counts as "a UI is open". */
const PANEL_IDS = [
  "rooms", // boss queue / rooms
  "boss-guide", // Know Your Enemy, opened from the queue panel
  "gear",
  "shop",
  "style-lab",
  "pet-park",
  "hall-of-minds",
  "achievements-panel",
  "hero-codex",
  "loot",
  "practice-pit",
];

const CSS = `
body[data-controls="touch"][data-panel-open] #left-dock,
body[data-controls="touch"][data-panel-open] #action-bar,
body[data-controls="touch"][data-panel-open] #touch-stick,
body[data-controls="touch"][data-panel-open] #touch-jump {
  display: none !important;
}
`;

/**
 * Panels that get the open/close sound but not the touch-chrome hiding —
 * the coffee shop is a small popover, not a full-screen takeover.
 */
const SFX_ONLY_PANEL_IDS = ["coffee"];

export function initPanelChrome(): void {
  if (typeof document === "undefined") return;
  const style = document.createElement("style");
  style.id = "panel-chrome-css";
  style.textContent = CSS;
  document.head.appendChild(style);

  // The same body-children observation doubles as the one central place that
  // hears every panel open and close — no per-panel wiring, present and
  // future panels alike, exactly like the data-panel-open rule above.
  const audible = [...PANEL_IDS, ...SFX_ONLY_PANEL_IDS];
  let openCount = -1; // -1 = first sync, whatever is already up mounts silently

  const sync = (): void => {
    const open = PANEL_IDS.some((id) => document.getElementById(id));
    if (open) document.body.dataset.panelOpen = "1";
    else delete document.body.dataset.panelOpen;

    const count = audible.filter((id) => document.getElementById(id)).length;
    if (openCount >= 0 && count !== openCount) {
      playSfx(count > openCount ? "ui.panel.open" : "ui.panel.close");
    }
    openCount = count;
  };
  new MutationObserver(sync).observe(document.body, { childList: true });
  sync();
}
