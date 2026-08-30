/**
 * Click-and-hold wiring for the basic attack (desktop LMB).
 *
 * - A quick click fires exactly one swing, released on pointer-up.
 * - A press-and-HOLD keeps swinging: after a short grace the cast is polled
 *   on a short interval and simply returns false while the slot cooldown
 *   runs, so the swing rate stays governed by the action bar.
 * - IDLE fires nothing: the loop is scoped to the pointer that started it
 *   (`pointerId`), and release / pointercancel / blur tear it down — a second
 *   pointer's events can neither start nor stop it, which is how the old
 *   once-listener got consumed by the wrong thumb and looped forever.
 * - A drag past a few pixels means the player is orbiting the camera, not
 *   attacking, so the press is cancelled before it ever fires.
 *
 * Desktop only — touch uses the corner button's own hold wiring in
 * actionBar.ts (`startBasicHold`), which shares the same rules.
 */
import { PointerEventTypes } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";

/** Beyond this many px of movement the press is a camera orbit, not an attack. */
const DRAG_CANCEL_PX = 8;
/** Hold this long (without dragging) before the loop starts swinging. */
const HOLD_GRACE_MS = 150;
/** cast() no-ops while the slot is on cooldown, so poll faster than any CD. */
const POLL_MS = 100;

export function wireBasicAttack(scene: Scene, cast: () => boolean): () => void {
  let pointerId: number | null = null;
  let downAt: { x: number; y: number } | null = null;
  let grace: number | null = null;
  let timer: number | null = null;

  const stop = (): void => {
    if (grace !== null) {
      window.clearTimeout(grace);
      grace = null;
    }
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    pointerId = null;
    downAt = null;
  };

  const obs = scene.onPointerObservable.add((pi) => {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      if (pi.event.button !== 0) return;
      if (pointerId !== null) return; // one attack press at a time
      const e = pi.event as PointerEvent;
      pointerId = e.pointerId;
      downAt = { x: e.clientX, y: e.clientY };
      // The first loop swing waits out the grace: if the pointer is still down
      // and hasn't wandered into an orbit by then, the hold is an attack.
      grace = window.setTimeout(() => {
        grace = null;
        if (pointerId === null || !downAt) return;
        cast();
        timer = window.setInterval(() => {
          // Belt and braces: never swing without a live press behind it.
          if (pointerId === null) {
            stop();
            return;
          }
          cast();
        }, POLL_MS);
      }, HOLD_GRACE_MS);
    } else if (pi.type === PointerEventTypes.POINTERMOVE) {
      const e = pi.event as PointerEvent;
      if (pointerId === null || e.pointerId !== pointerId || !downAt) return;
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_CANCEL_PX) stop();
    } else if (pi.type === PointerEventTypes.POINTERUP) {
      if (pointerId === null || (pi.event as PointerEvent).pointerId !== pointerId) return;
      // A quick click never reached the loop — fire the single swing here.
      const wasClick = grace !== null;
      stop();
      if (wasClick) cast();
    }
  });

  // Babylon never emits a POINTERCANCEL observable event: capture loss and
  // window blur mid-hold are caught here, or the interval would swing forever.
  // The window pointerup matters too: Babylon only hears releases that reach
  // the canvas, so a hold released over a DOM overlay (dock, chat icon) or
  // outside the window would otherwise leave the loop swinging while idle.
  // On the normal click path the canvas handler runs first and nulls
  // pointerId, so this net no-ops there instead of double-stopping.
  //
  // visibilitychange/pagehide close the hole blur leaves on iOS: switching
  // apps or locking the screen mid-hold fires NEITHER pointerup NOR blur
  // there, the interval pauses with the page, and on return it resumed
  // swinging with no finger down — the "basic attack loops while idle" bug.
  const stopIfOurs = (e: PointerEvent): void => {
    if (pointerId !== null && e.pointerId === pointerId) stop();
  };
  const stopIfHidden = (): void => {
    if (document.visibilityState === "hidden") stop();
  };
  // Self-healing net: any mouse motion that reports the left button no longer
  // held kills the loop. If every release event above is somehow missed
  // (capture theft, an event order we didn't foresee), the loop still dies on
  // the first twitch of the mouse instead of swinging while idle.
  const stopIfReleased = (e: PointerEvent): void => {
    if (pointerId !== null && e.pointerId === pointerId && (e.buttons & 1) === 0) stop();
  };
  window.addEventListener("pointerup", stopIfOurs);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("pointermove", stopIfReleased);
  window.addEventListener("blur", stop);
  window.addEventListener("pagehide", stop);
  document.addEventListener("visibilitychange", stopIfHidden);

  const dispose = (): void => {
    stop();
    window.removeEventListener("pointerup", stopIfOurs);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("pointermove", stopIfReleased);
    window.removeEventListener("blur", stop);
    window.removeEventListener("pagehide", stop);
    document.removeEventListener("visibilitychange", stopIfHidden);
    scene.onPointerObservable.remove(obs);
  };
  scene.onDisposeObservable.add(dispose);
  return dispose;
}
