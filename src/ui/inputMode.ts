/**
 * Which control scheme this session gets.
 *
 * Deliberately NOT a user-agent sniff. What matters is the input device, not the
 * brand of the device: a Windows tablet and an iPad both want thumbs, a phone
 * paired with a bluetooth keyboard does not, and UA strings answer neither
 * question. `pointer: coarse` is the CSS media query that asks exactly this.
 *
 * `?controls=touch` / `?controls=keyboard` overrides it. That is not a debug
 * afterthought: the touch layout is the shipping layout now, and it has to be
 * testable at a desk, in the same browser that runs the perf HUD, without
 * emulation mode changing anything else about the page.
 */
export type ControlScheme = "touch" | "keyboard";

export function detectControlScheme(): ControlScheme {
  if (typeof window === "undefined") return "keyboard"; // headless soak test

  const forced = new URLSearchParams(window.location.search).get("controls");
  if (forced === "touch" || forced === "keyboard") return forced;

  // `pointer: coarse` asks about the PRIMARY pointer, which is the question that
  // matters. `maxTouchPoints > 0` is the tempting shortcut and it is wrong for one
  // of our three target form factors: a touchscreen laptop reports touch points
  // while its primary pointer is a trackpad, so it would get the thumb cluster and
  // lose left-side camera drag to the stick zone. It is only consulted when
  // matchMedia is unavailable.
  if (typeof window.matchMedia !== "function") {
    return navigator.maxTouchPoints > 0 ? "touch" : "keyboard";
  }
  return window.matchMedia("(pointer: coarse)").matches ? "touch" : "keyboard";
}

/**
 * True while the keyboard belongs to a text field (chat box, rooms panel, any
 * future input).
 *
 * Every gameplay key handler in this codebase listens on `window` with no
 * focus check — typing "verb" into a naive chat input would switch scenes
 * twice and cast two skills, and a "name your room" field would make "w" walk
 * and space jump mid-typing. Rather than teach every handler about every
 * panel, they all ask this one question first. Checking `document.activeElement`
 * beats a hand-maintained flag: it cannot desync from reality (blur on tap,
 * alt-tab, an <input> added by any future feature all just work).
 */
export function isTypingInField(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

/**
 * Multiplier for on-screen control sizes.
 *
 * A 66 px button is right under a thumb on a phone and looks like a toy on an
 * iPad, where the screen is twice as tall but the thumb is the same size — so the
 * controls scale with the SHORT side of the viewport, which in landscape is the
 * one that constrains reach.
 *
 * Clamped at both ends: never smaller than 0.85 (a small phone still needs a
 * tappable target — 44 px is the usual floor and 66 x 0.85 clears it), never
 * larger than 1.5 (past that the cluster starts eating the play area on a tablet).
 */
export function uiScale(): number {
  if (typeof window === "undefined") return 1;
  const short = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(0.85, Math.min(1.5, short / 430));
}

/**
 * Activate a button on tap for EVERY pointer, not just the primary one.
 *
 * Chrome only synthesizes `click` for the primary pointer. With the move
 * stick held (first thumb down), the second thumb's taps on a skill button
 * produce pointerdown/pointerup but never a click — so skills stayed dark
 * while running. Listening on pointerup and skipping the primary pointer
 * gives the second thumb the same activation without double-firing the first
 * (its pointerup is always followed by a real click).
 */
export function onAnyTap(el: HTMLElement, fn: () => void): void {
  let downId: number | null = null;
  el.addEventListener("click", () => fn()); // primary pointer: mouse, first thumb
  el.addEventListener("pointerdown", (e) => (downId = e.pointerId));
  el.addEventListener("pointercancel", () => (downId = null));
  el.addEventListener("pointerup", (e) => {
    if (e.pointerId !== downId) return;
    downId = null;
    if (!e.isPrimary) fn();
  });
}
