/**
 * Cast-refusal popup — the WoW UIErrorsFrame idea: one red line, upper-centre
 * of the screen, that pops in when a press is refused ("Not enough Focus")
 * and fades out on its own. The action bar's red slot flash says *that* the
 * press failed; this line says *why*, somewhere the player is actually
 * looking during a fight.
 *
 * One module-level element, reused: key-mashing an empty pool re-pops the
 * same line (text swap + animation restart) instead of stacking a column of
 * warnings. The element is lazily created, lives on document.body outside
 * any scene, and idles at display:none — surviving scene switches the same
 * way the shared tooltip does, with nothing to dispose.
 */

let el: HTMLDivElement | null = null;
let hideTimer = 0;

/** How long the line stays before fading (ms). */
const HOLD_MS = 1_100;
const FADE_MS = 350;

export function showCastWarning(text: string): void {
  if (typeof document === "undefined") return;
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      "top:20%",
      "left:50%",
      "transform:translateX(-50%)",
      // Above the player HUD (z 10) and the countdown (z 30), under panels.
      "z-index:40",
      "display:none",
      "font:600 clamp(16px, 2.6vmin, 22px)/1.3 Georgia, 'Palatino Linotype', Palatino, serif",
      "letter-spacing:.12em",
      "color:#ff5a66",
      "text-shadow:0 0 12px rgba(255,59,77,.5), 0 2px 4px rgba(0,0,0,.9)",
      "white-space:nowrap",
      "pointer-events:none",
      "user-select:none",
    ].join(";");
    document.body.appendChild(el);
  }

  el.textContent = text;
  el.style.display = "block";
  // Pop + settle, then fade. Restarting the animation on every call makes a
  // mash read as "still no" rather than one stale line sitting there.
  el.animate(
    [
      { transform: "translateX(-50%) scale(1.15)", opacity: 0 },
      { transform: "translateX(-50%) scale(1)", opacity: 1, offset: 0.18 },
      { transform: "translateX(-50%) scale(1)", opacity: 1, offset: HOLD_MS / (HOLD_MS + FADE_MS) },
      { transform: "translateX(-50%) scale(1)", opacity: 0 },
    ],
    { duration: HOLD_MS + FADE_MS, easing: "ease-out" }
  );
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (el) el.style.display = "none";
  }, HOLD_MS + FADE_MS);
}
