/**
 * In-browser fullscreen for touch play.
 *
 * The Fullscreen API only resolves inside a user gesture, and the auth flow
 * conveniently ends in one: the Enter Psyrena tap. main.ts calls
 * `enterFullscreen()` there, and `keepFullscreen()` re-enters on the next tap
 * after the browser kicks us out — on mobile that is almost always an
 * accidental edge swipe mid-fight, not a decision to leave.
 *
 * Fullscreen goes on `document.documentElement`, NOT the canvas. The HUD, the
 * boot overlay and the touch controls are DOM siblings of the canvas;
 * fullscreening the canvas alone would leave the player with a picture and no
 * buttons.
 *
 * Support map, which is why the PWA manifest exists alongside this:
 *  - Android Chrome: works, and `screen.orientation.lock()` works inside it.
 *  - iPad / desktop Safari: works, standard unprefixed API.
 *  - iPhone Safari: element fullscreen is OFF BY DEFAULT — it exists only
 *    behind Settings → Apps → Safari → Advanced → Feature Flags → "Fullscreen
 *    API" (verified on a real device 2026-08: with the flag off, neither the
 *    standard nor the webkit-prefixed entry points exist at all, so there is
 *    nothing to call). Add-to-Home-Screen is the route to recommend to iPhone
 *    players; orientation lock always rejects on iOS either way (the CSS
 *    rotate gate in index.html stays the real enforcement there).
 *  - Installed from the home screen: the page launches fullscreen already,
 *    `fullscreenEnabled` is irrelevant, and both helpers no-op via the
 *    display-mode check.
 */

// iPhone Safari ships the Fullscreen API exclusively under webkit prefixes:
// `requestFullscreen`, `document.fullscreenElement`, `exitFullscreen` and the
// `fullscreenchange` event are all simply absent there, while iPad and desktop
// Safari expose the standard names. With optional chaining the unprefixed call
// doesn't even throw — the button just silently does nothing, which is exactly
// how this shipped broken on iPhone. Every fullscreen touch in the codebase
// must go through these helpers, never the document/element API directly.
type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/**
 * Whether ANY element-fullscreen entry point exists. False on a default-config
 * iPhone (see the support map above) — callers use this to not render UI for
 * a feature that cannot work, rather than showing a button that eats a tap
 * and does nothing.
 */
export function fullscreenSupported(): boolean {
  const root = document.documentElement as WebkitElement;
  return typeof root.requestFullscreen === "function" ||
    typeof root.webkitRequestFullscreen === "function";
}

/** Prefix-blind `document.fullscreenElement`. */
export function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null;
}

/** Prefix-blind `fullscreenchange` subscription. */
export function onFullscreenChange(handler: () => void): void {
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
}

/** Launched from the home screen (PWA/standalone) — already chromeless. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: fullscreen), (display-mode: standalone)").matches ||
    // iOS Safari's pre-standard flag for home-screen launches.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export async function enterFullscreen(): Promise<void> {
  if (isStandalone() || fullscreenElement()) return;
  const root = document.documentElement as WebkitElement;
  try {
    if (root.requestFullscreen) {
      // `navigationUI: "hide"` asks Android to drop the system bars too.
      await root.requestFullscreen({ navigationUI: "hide" });
    } else {
      // iPhone Safari. Returns undefined rather than a promise — await copes.
      await root.webkitRequestFullscreen?.();
    }
    // Landscape lock is a bonus, not a requirement: it resolves on Android in
    // fullscreen and rejects everywhere else. The rotate gate covers the rest.
    type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await (screen.orientation as LockableOrientation)?.lock?.("landscape");
  } catch {
    // Rejected (old iOS, iframe without allowfullscreen, lock unsupported).
    // Not an error state — the game is fully playable un-fullscreened.
  }
}

/** Re-enter on the first tap after fullscreen is lost. Touch scheme only. */
export function keepFullscreen(): void {
  if (isStandalone()) return;
  onFullscreenChange(() => {
    if (fullscreenElement()) return;
    // A deliberate exit via the dock's toggle is a decision, not an accident —
    // don't arm the re-enter trap for it.
    if (manualExit) return;
    window.addEventListener("pointerdown", () => void enterFullscreen(), { once: true });
  });
}

/**
 * Set when the player leaves fullscreen through the dock toggle, so
 * keepFullscreen can tell a deliberate exit apart from an accidental edge
 * swipe (which it re-arms against). Cleared on any enter.
 */
let manualExit = false;

/** The dock's fullscreen switch: enter when windowed, leave when fullscreen. */
export async function toggleFullscreen(): Promise<void> {
  if (fullscreenElement()) {
    manualExit = true;
    try {
      const doc = document as WebkitDocument;
      if (document.exitFullscreen) await document.exitFullscreen();
      else await doc.webkitExitFullscreen?.();
    } catch {
      manualExit = false; // never actually left — treat as still fullscreen
    }
    return;
  }
  manualExit = false;
  await enterFullscreen();
}
