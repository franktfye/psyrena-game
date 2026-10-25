/**
 * Left-edge dock — one button per village facility function, plus a Boss
 * Queue button and a small fullscreen switch.
 *
 * Every panel a shop NPC opens in the village hub is also reachable here, from
 * any scene (the dock is plain DOM, mounted once after login, and survives
 * scene switches like the player HUD). Gear keeps its G hotkey; the rest are
 * pointer-only for now. Buttons toggle: a second click closes the panel. The
 * utility button toggles browser fullscreen — mostly for mobile, where the
 * browser chrome costs real screen space.
 *
 * LAYOUT IS MEASURED, NOT GUESSED
 * ------------------------------
 * The dock used to sit at a fixed `top: 22%` on touch, which on a landscape
 * phone landed on top of the player frame's party row — the frame's height
 * depends on the UI scale and on how many buffs are running, so no percentage
 * can be right on every device. `relayout()` instead reads the real bottom of
 * `#player-hud` and parks the dock below it, and re-runs whenever either the
 * viewport or the frame changes size.
 *
 * The buttons size themselves from the same measurement: a target size derived
 * from the viewport (thumb-sized on a phone, comfortable on a desktop), then
 * as many rows as actually fit between the frame and the bottom controls, with
 * the overflow wrapping into further columns. Nothing is allowed to run off
 * the bottom of a short screen or onto the move stick's resting ring.
 */

import type { Profile } from "./authFlow";
import { detectControlScheme, isTypingInField, onAnyTap, uiScale } from "./inputMode";
import { toggleFullscreen, fullscreenElement, onFullscreenChange, fullscreenSupported } from "./fullscreen";
import { openGearPanel, closeGearPanel } from "./gearPanel";
import { openSkinPanel, closeSkinPanel } from "./skinPanel";
import { openPetPanel, closePetPanel } from "./petPanel";
import { openHallPanel, closeHallPanel } from "./hallPanel";
import { openRoomsPanel, closeRoomsPanel } from "./roomsPanel";
import { gameConfirm } from "./confirmDialog";
import { closeLootPanel } from "./lootPanel";
import { playSfx } from "../state/sfx";

/* --dock-btn / --dock-gap / --dock-util / --dock-rows are all written by
   relayout(); the values here are only what the dock looks like for the one
   frame before the first measurement lands. Buttons flow down a column and
   wrap into the next one, so shrinking the row count widens the cluster
   instead of pushing its tail off the screen. */
const CSS = `
#left-dock {
  /* Safe-area inset: keep the dock out from under a landscape iPhone's
     camera housing; env() is 0 on hardware without one. */
  position: fixed; left: calc(12px + env(safe-area-inset-left, 0px)); top: 38%; z-index: 30;
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(var(--dock-rows, 4), var(--dock-btn, 52px));
  gap: var(--dock-gap, 10px);
}
#left-dock .dock-btn {
  width: var(--dock-btn, 52px); height: var(--dock-btn, 52px);
  border-radius: 50%; padding: 0; cursor: pointer;
  border: 1px solid rgba(120,220,255,.28);
  background-color: rgba(4,10,18,.72);
  /* Icons are rounded tiles on square canvases — overscan past the light
     corner padding so the circular button never shows white gaps. */
  background-size: 132%; background-position: center; background-repeat: no-repeat;
  transition: transform .08s ease, border-color .12s ease;
}
#left-dock .dock-btn:hover { border-color: #40e6ff; }
/* Glyph-carried dock button — a facility button whose icon asset doesn't exist
   yet, so a text glyph stands in at icon weight (unlike .util-btn, which is
   deliberately smaller and dimmer). Drop the class when real art lands. */
#left-dock .dock-btn.glyph {
  font-size: calc(var(--dock-btn, 52px) * .5); line-height: 1; color: #d8f7ff;
}
/* Fullscreen — deliberately smaller and dimmer than the in-game function
   buttons: it's a device chrome switch, not a game verb. It flows as the last
   cell and centres inside its (button-sized) row. */
#left-dock .util-btn {
  width: var(--dock-util, 32px); height: var(--dock-util, 32px);
  border-radius: 50%; padding: 0; cursor: pointer;
  place-self: center;
  font-size: calc(var(--dock-util, 32px) * .47); line-height: 1; color: #d8f7ff;
  border: 1px solid rgba(120,220,255,.28);
  background: rgba(4,10,18,.72);
  opacity: .6;
  transition: transform .08s ease, border-color .12s ease, opacity .12s ease;
}
#left-dock .util-btn:hover { border-color: #40e6ff; opacity: .9; }
#left-dock .util-btn.on { opacity: 1; border-color: #40e6ff; box-shadow: 0 0 10px rgba(64,230,255,.3); }
/* Scene scoping (body[data-scene] is stamped by main.ts go()): the facility
   buttons are village/practice furniture — in the arena battlefield they all
   hide and only Exit Battlefield (plus the fullscreen util) remains. The
   default hides Exit everywhere else, so the village keeps its usual dock. */
body[data-scene="arena"] #left-dock .dock-fn, body[data-scene="kowloon"] #left-dock .dock-fn { display: none; }
#left-dock .dock-exit { display: none; }
body[data-scene="arena"] #left-dock .dock-exit, body[data-scene="kowloon"] #left-dock .dock-exit { display: block; }
`;

/** Gap between the player frame's bottom edge and the first dock button. */
const HUD_CLEARANCE = 10;
/**
 * Desktop keeps its long-standing resting height — the frame is nowhere near
 * it there, and the dock reading as "middle of the left edge" is the look.
 * Used as a floor only: a taller frame still pushes the dock down.
 */
const DESKTOP_TOP_FRACTION = 0.38;
/** Never fewer than two rows: three columns of buttons is as wide as the
 *  cluster may get before it starts eating the play area. */
const MIN_ROWS = 2;
/** Never more than four: past that the column just looks unmoored on a big
 *  screen, and the extra height buys nothing. */
const MAX_ROWS = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * How much bottom edge the dock must stay out of.
 *
 * Touch: the move stick parks its ring 26 px from the bottom-left corner at
 * `uiScale()`-scaled radius (ui/touchStick.ts) — the dock's tail sitting on
 * that ring is the exact bug the old fixed percentages kept re-creating.
 * Desktop: just enough for the action bar along the bottom.
 */
function bottomReserve(touch: boolean): number {
  return touch ? Math.round(2 * 66 * uiScale() + 34) : 80;
}

/**
 * Target button size for this device, before the vertical fit is applied.
 *
 * Touch scales with the short side (same thumb-reach argument as the action
 * bar's `uiScale`), desktop with viewport height so a 4K panel gets a dock
 * that matches everything else that grew — both clamped so the dock never
 * turns into either a toy or a wall.
 */
function targetSize(touch: boolean): number {
  if (touch) return clamp(Math.round(44 * uiScale()), 36, 62);
  return clamp(Math.round(52 * clamp(window.innerHeight / 900, 0.85, 1.3)), 40, 62);
}

/**
 * Measure the player frame and re-fit the dock underneath it. Cheap (two
 * rects and a handful of custom properties) and idempotent, so it is safe to
 * call from resize, orientationchange and a ResizeObserver alike.
 */
function relayout(dock: HTMLElement, cellCount: number): void {
  const touch = detectControlScheme() === "touch";
  const vh = window.innerHeight;

  // The frame mounts before the dock in main.ts, but fall back to a sane
  // estimate rather than stacking on top of it if that order ever changes.
  const hud = document.getElementById("player-hud");
  const hudBottom = hud ? hud.getBoundingClientRect().bottom : (touch ? 110 : 190);
  const top = touch
    ? hudBottom + HUD_CLEARANCE
    : Math.max(hudBottom + HUD_CLEARANCE, vh * DESKTOP_TOP_FRACTION);
  dock.style.top = `${Math.round(top)}px`;

  const size = targetSize(touch);
  const gap = Math.max(5, Math.round(size * 0.19));
  // Row budget between the frame and the bottom controls. The fullscreen
  // button is smaller than a facility button but is counted as a full cell —
  // over-reserving a few pixels is the safe direction to be wrong in.
  const avail = vh - top - bottomReserve(touch);
  const fits = Math.floor((avail + gap) / (size + gap));
  const rows = clamp(fits, MIN_ROWS, Math.min(MAX_ROWS, cellCount));

  dock.style.setProperty("--dock-btn", `${size}px`);
  dock.style.setProperty("--dock-gap", `${gap}px`);
  dock.style.setProperty("--dock-util", `${Math.round(size * 0.62)}px`);
  dock.style.setProperty("--dock-rows", String(rows));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** The achievements panel module, once its button has loaded it. */
let achievements: typeof import("./achievementsPanel") | null = null;

/** Idempotent — a second mount does nothing. */
export function mountLeftDock(profile: Profile): void {
  if (document.getElementById("left-dock")) return;
  if (!document.getElementById("left-dock-css")) {
    document.head.append(el("style", { id: "left-dock-css" }, CSS));
  }

  // One entry per facility panel. Gear is dock/G-key only — the outfitter NPC
  // in scenes/villageHub.ts opens the store catalogue (shopPanel.ts) instead;
  // the other shop-NPC taps mirror these buttons (style-lab / pet-park /
  // hall-of-minds).
  const items = [
    { title: "Gear (G)", icon: "/assets/ui/gear/gear.webp", open: () => openGearPanel(profile), close: closeGearPanel },
    { title: "Skins — Style Lab", icon: "/assets/ui/gear/skin.webp", open: () => openSkinPanel(profile), close: closeSkinPanel },
    { title: "Pets — Pet Park", icon: "/assets/ui/gear/slot-pet.webp", open: () => openPetPanel(profile), close: closePetPanel },
    { title: "Hall of Minds", icon: "/assets/ui/gear/hall.webp", open: () => openHallPanel(profile), close: closeHallPanel },
    // Lazy (CLAUDE.md rule 3): only this button ever opens it.
    { title: "Achievements", icon: "/assets/ui/achievements/achievements.webp", open: () => void import("./achievementsPanel").then((m) => (achievements = m).openAchievementsPanel()), close: () => achievements?.closeAchievementsPanel() ?? false },
  ];

  const dock = el("div", { id: "left-dock" });
  // One delegated press sound for every dock button, present and future —
  // pointerdown so the click lands with the finger, not after the tap-vs-drag
  // gates settle.
  dock.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement | null)?.closest("button")) playSfx("ui.click");
  });

  // Exit Battlefield — the only game verb the dock offers in the arena
  // (CSS above shows it there and nowhere else). Confirmed because a stray
  // tap mid-pull would abandon the attempt. In-game confirm, never
  // window.confirm: the native dialog drops the browser out of fullscreen.
  const exitBtn = el("button", {
    class: "dock-btn dock-exit",
    type: "button",
    title: "Exit Battlefield",
    "aria-label": "Exit Battlefield",
    style: `background-image:url("/assets/ui/gear/exit.webp")`,
  });
  onAnyTap(exitBtn, () => {
    void gameConfirm("Leave the battlefield and return to the village?", { okLabel: "Leave" }).then((ok) => {
      if (!ok) return;
      // A result card left open would survive the scene switch as a stale
      // popup in the village — the hub's unclaimed-cache prop covers the loot.
      closeLootPanel();
      const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
      void psy?.go?.("village");
    });
  });
  exitBtn.addEventListener("pointerdown", () => (exitBtn.style.transform = "scale(.94)"));
  exitBtn.addEventListener("pointerup", () => (exitBtn.style.transform = "scale(1)"));
  exitBtn.addEventListener("pointerleave", () => (exitBtn.style.transform = "scale(1)"));
  exitBtn.addEventListener("pointercancel", () => (exitBtn.style.transform = "scale(1)"));
  dock.append(exitBtn);

  for (const it of items) {
    const btn = el("button", {
      class: "dock-btn dock-fn",
      type: "button",
      title: it.title,
      "aria-label": it.title,
      style: `background-image:url("${it.icon}")`,
    });
    onAnyTap(btn, () => {
      if (!it.close()) it.open();
    });
    // Shrink on press — same feedback as the action bar buttons.
    btn.addEventListener("pointerdown", () => (btn.style.transform = "scale(.94)"));
    btn.addEventListener("pointerup", () => (btn.style.transform = "scale(1)"));
    btn.addEventListener("pointerleave", () => (btn.style.transform = "scale(1)"));
    btn.addEventListener("pointercancel", () => (btn.style.transform = "scale(1)"));
    dock.append(btn);
  }

  // Boss Queue — flows after the facility buttons, so on the usual four-row
  // layout it lands at the top of column 2. Toggles the rooms panel with the
  // options villageHub configured on the module (configureRoomsPanel), so this
  // and the plaza portal tap open the same panel. The icon asset may not exist
  // yet; the tooltip carries it until then.
  const queueBtn = el("button", {
    class: "dock-btn dock-fn",
    type: "button",
    title: "Boss Queue",
    "aria-label": "Boss Queue",
    style: `background-image:url("/assets/ui/gear/queue.webp")`,
  });
  onAnyTap(queueBtn, () => {
    if (!closeRoomsPanel()) openRoomsPanel();
  });
  queueBtn.addEventListener("pointerdown", () => (queueBtn.style.transform = "scale(.94)"));
  queueBtn.addEventListener("pointerup", () => (queueBtn.style.transform = "scale(1)"));
  queueBtn.addEventListener("pointerleave", () => (queueBtn.style.transform = "scale(1)"));
  queueBtn.addEventListener("pointercancel", () => (queueBtn.style.transform = "scale(1)"));
  dock.append(queueBtn);

  // Dream Siege — survival mode (docs/survival-design.md). Same verb as the
  // village's pailou portal: the difficulty picker, then Old Kowloon.
  const survivalBtn = el("button", {
    class: "dock-btn dock-fn",
    type: "button",
    title: "Dream Siege",
    "aria-label": "Dream Siege",
    style: `background-image:url("/assets/ui/gear/survival.webp")`,
  });
  // Lazy: the picker and run state are survival code, not boot (CLAUDE.md rule 3).
  onAnyTap(survivalBtn, () => {
    void Promise.all([import("../survival/hud"), import("../survival/pending")]).then(([hud, pending]) => {
      hud.openSurvivalPicker((d) => {
        pending.setPendingRun(d);
        const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
        void psy?.go?.("kowloon");
      });
    });
  });
  survivalBtn.addEventListener("pointerdown", () => (survivalBtn.style.transform = "scale(.94)"));
  survivalBtn.addEventListener("pointerup", () => (survivalBtn.style.transform = "scale(1)"));
  survivalBtn.addEventListener("pointerleave", () => (survivalBtn.style.transform = "scale(1)"));
  survivalBtn.addEventListener("pointercancel", () => (survivalBtn.style.transform = "scale(1)"));
  dock.append(survivalBtn);

  // Switch Character — back to the hero picker via a plain reload: the session
  // is an HttpOnly cookie, so the reload lands on GET /api/me, skips the login
  // form and opens straight onto character select (authFlow.ts). A reload is
  // also the only honest route — sessionProfile is closed over by the scene
  // factories, the player frame and the chat identity (main.ts), so swapping
  // heroes under a live session would leave half the chrome showing the old
  // one. Confirmed because a reload drops any open panel state; dock-fn scoping
  // hides it on the battlefield, same as every other village verb.
  const switchBtn = el("button", {
    class: "dock-btn dock-fn glyph",
    type: "button",
    title: "Switch Character",
    "aria-label": "Switch Character",
  }, "⇄");
  onAnyTap(switchBtn, () => {
    void gameConfirm("Return to character selection?", { okLabel: "Switch" }).then((ok) => {
      if (!ok) return;
      // Hand the GPU back BEFORE the navigation, not during it.
      //
      // This reload is the one flow guaranteed to ask a device for a second
      // WebGL context while the first is still live, and on an iPhone the
      // second request is the one that comes back dead. `pagehide` also
      // releases (main.ts), but its timing is the browser's to choose and iOS
      // has been unreliable about which flavour of it fires — doing it here
      // is deterministic, and a double release is harmless.
      const release = (
        window as unknown as { psyrena?: { releaseGraphics?: (then?: () => void) => void } }
      ).psyrena?.releaseGraphics;
      if (release) release(() => location.reload());
      else location.reload();
    });
  });
  switchBtn.addEventListener("pointerdown", () => (switchBtn.style.transform = "scale(.94)"));
  switchBtn.addEventListener("pointerup", () => (switchBtn.style.transform = "scale(1)"));
  switchBtn.addEventListener("pointerleave", () => (switchBtn.style.transform = "scale(1)"));
  switchBtn.addEventListener("pointercancel", () => (switchBtn.style.transform = "scale(1)"));
  dock.append(switchBtn);

  // Fullscreen switch — mainly for mobile, where the browser chrome eats a
  // slice of an already small screen. Smaller than the function buttons; the
  // "on" state follows the real fullscreenchange event, not the click, so it
  // stays truthful when the browser kicks us out on its own.
  //
  // Not rendered at all where element fullscreen doesn't exist — which is
  // every default-config iPhone (feature-flagged off in Safari there, see
  // ui/fullscreen.ts). A button that eats a tap and does nothing reads as
  // the game being broken; Add-to-Home-Screen is the iPhone route instead.
  if (fullscreenSupported()) {
    const fsBtn = el("button", {
      class: "util-btn",
      type: "button",
      title: "Fullscreen",
      "aria-label": "Toggle fullscreen",
    }, "⛶");
    // fullscreenElement()/onFullscreenChange, not the document API: Safari
    // exposes webkit-prefixed forms in places (see ui/fullscreen.ts).
    const syncFs = (): void => {
      fsBtn.classList.toggle("on", Boolean(fullscreenElement()));
    };
    onAnyTap(fsBtn, () => void toggleFullscreen());
    fsBtn.addEventListener("pointerdown", () => (fsBtn.style.transform = "scale(.94)"));
    fsBtn.addEventListener("pointerup", () => (fsBtn.style.transform = "scale(1)"));
    fsBtn.addEventListener("pointerleave", () => (fsBtn.style.transform = "scale(1)"));
    fsBtn.addEventListener("pointercancel", () => (fsBtn.style.transform = "scale(1)"));
    onFullscreenChange(syncFs);
    syncFs();
    dock.append(fsBtn);
  }

  document.body.append(dock);

  // Fit it under the player frame, and keep it fitted: rotate the phone, resize
  // the window, or gain a buff row and the frame's bottom edge moves.
  const cells = items.length + 4; // facility buttons + queue + survival + switch + fullscreen
  const fit = (): void => relayout(dock, cells);
  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);
  const hud = document.getElementById("player-hud");
  if (hud && typeof ResizeObserver === "function") {
    // Fires once immediately, which also covers the case where the frame's
    // portrait image had not decoded when `fit()` first measured it.
    new ResizeObserver(fit).observe(hud);
  }

  window.addEventListener("keydown", (e) => {
    // A text field owns the keyboard — same gate as every gameplay key handler.
    if (isTypingInField()) return;
    // Same scoping as the dock buttons: facility panels are village/practice
    // furniture, so the hotkey goes quiet on the battlefield too.
    if (document.body.dataset.scene === "arena") return;
    if (e.key.toLowerCase() === "g" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (!closeGearPanel()) openGearPanel(profile);
    }
  });
}
