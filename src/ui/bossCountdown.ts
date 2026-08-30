/**
 * Pre-activation countdown — the big translucent 10→1 shown when the player
 * enters the arena, ticking in lockstep with the boss script's idle period
 * (`idleS` in shared/bosses/nightmare.ts) and fading out the exact moment the
 * boss engages.
 *
 * Timing comes from the scene render loop (engine.getDeltaTime() accumulated
 * per frame), NOT setInterval: the fight sim ticks on the same dt inside
 * scene.onBeforeRenderObservable, so the overlay can never drift from the
 * sim, and a stalled render stalls both. The observer and the DOM node are
 * both torn down on scene dispose, so repeated `go("arena")` entries leave
 * nothing behind.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Observer } from "@babylonjs/core/Misc/observable";

import { NIGHTMARE_STANDARD } from "../../shared/bosses/nightmare";
import { playSfx } from "../state/sfx";

/** Fade-out duration once the final second expires (the boss engages). */
const FADE_S = 0.4;

export function startBossCountdown(scene: Scene, engine: AbstractEngine): void {
  const totalS = NIGHTMARE_STANDARD.idleS;

  const root = document.createElement("div");
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    // Under the loot panel (z 45), above the player HUD (z 10).
    "z-index:30",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:1.5vmin",
    "pointer-events:none",
    "user-select:none",
  ].join(";");

  const num = document.createElement("div");
  num.textContent = String(totalS);
  num.style.cssText = [
    "font:600 30vmin Georgia, 'Palatino Linotype', Palatino, serif",
    "line-height:1",
    "color:rgba(255,240,200,.85)",
    "text-shadow:0 0 4vmin rgba(226,196,124,.55), 0 2px 6px rgba(0,0,0,.8)",
  ].join(";");

  // Announce capitalization follows bossFight.ts world announces
  // ("NIGHTMARE has engaged — Phase 1: Onslaught!").
  const caption = document.createElement("div");
  caption.textContent = `${NIGHTMARE_STANDARD.displayName} stirs…`;
  caption.style.cssText = [
    "font:14px/1.4 Georgia, 'Palatino Linotype', Palatino, serif",
    "letter-spacing:.35em",
    "color:rgba(255,255,255,.6)",
    "text-shadow:0 1px 3px rgba(0,0,0,.8)",
  ].join(";");

  root.append(num, caption);
  document.body.appendChild(root);

  let observer: Observer<Scene> | null = null;
  const finish = (): void => {
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    observer = null;
    root.remove();
  };

  let elapsed = 0;
  let shown = totalS;
  /** >= 0 once the count has expired: seconds into the fade-out. */
  let fadeT = -1;

  observer = scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;

    if (fadeT >= 0) {
      fadeT += dt;
      root.style.opacity = String(Math.max(0, 1 - fadeT / FADE_S));
      if (fadeT >= FADE_S) finish();
      return;
    }

    elapsed += dt;
    const remaining = totalS - elapsed;
    if (remaining <= 0) {
      // The sim engages on this same tick — hand the screen over to the fight.
      fadeT = 0;
      return;
    }
    const display = Math.ceil(remaining);
    if (display !== shown) {
      shown = display;
      num.textContent = String(display);
      playSfx("fight.countdown.tick");
      // Per-tick pulse: brief swell, then settle. WAAPI — no stylesheet needed.
      num.animate(
        [
          { transform: "scale(1.12)", opacity: 0.95 },
          { transform: "scale(1)", opacity: 0.8 },
        ],
        { duration: 650, easing: "ease-out" }
      );
    }
  });

  // Scene disposal drops the observer with the scene; the DOM node is ours.
  scene.onDisposeObservable.add(finish);
}
