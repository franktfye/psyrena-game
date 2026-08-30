/**
 * Virtual thumbstick — plain DOM, zero engine cost.
 *
 * Same reasoning as `actionBar.ts` and the perf HUD: a Babylon GUI stick would
 * cost a render target and draw calls to draw two circles, and would then have to
 * re-implement hit-testing that the DOM does for free. Two divs and pointer
 * events are strictly better here.
 *
 * WHY A DOM OVERLAY IS ALSO THE CAMERA FIX. The hub camera is an ArcRotateCamera
 * with `attachControl`, which listens on the CANVAS. Because this zone is a
 * sibling element stacked over the canvas, a thumb inside it never produces a
 * canvas pointer event at all — so dragging the stick cannot also orbit the
 * camera, with no cooperation needed from Babylon's input system. That is the
 * whole reason the stick is not drawn into the scene.
 *
 * The trade, which is the standard one for this genre: the left side of the
 * screen no longer orbits the camera. Left thumb moves, right thumb looks.
 */

/** Live analog state. Read once per frame by the hero controller. */
export interface StickAxes {
  /** -1 (left) .. +1 (right), after dead zone, magnitude-clamped to 1. */
  x: number;
  /** -1 (back) .. +1 (forward). Screen-up is forward. */
  y: number;
  /** True once the stick is pushed past `RUN_AT` — no separate run button. */
  run: boolean;
  /** 0 .. 1. Lets the controller scale speed analogically rather than on/off. */
  magnitude: number;
}

/** Visual radius of the ring, and the throw distance that means "full tilt". */
const BASE_R = 66;
const KNOB_R = 29;
/**
 * Below this the stick reads as centred. Capacitive screens jitter by a couple of
 * pixels while a thumb rests, and without a dead zone that jitter makes the hero
 * pivot on the spot.
 */
const DEAD_ZONE = 0.12;
/**
 * Push most of the way for a run. Matches how every mobile ARPG does sprint.
 *
 * Exported because the hero controller needs the same number to ramp walk speed
 * into run speed smoothly: if it guessed, tilt would cross the sprint threshold
 * at a different place than the speed curve expects and the hero would snap.
 * Compared against the DEAD-ZONE-RESCALED magnitude, so `run` and `magnitude`
 * are on one scale and a caller can reason about them together.
 */
export const STICK_RUN_AT = 0.85;

export class TouchStick {
  private readonly zone: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  /** Active pointer, or null. Tracking ONE id is what keeps the right thumb free. */
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private readonly state: StickAxes = { x: 0, y: 0, run: false, magnitude: 0 };
  /** Zone bounds, measured once per gesture — see `onDown`. */
  private rect: DOMRect;
  /** Scaled radii. A 66 px ring is right on a phone and small on an iPad. */
  private readonly baseR: number;
  private readonly knobR: number;

  constructor(scale = 1) {
    this.baseR = Math.round(BASE_R * scale);
    this.knobR = Math.round(KNOB_R * scale);
    // Activation zone: the lower-left of the screen, not just the visible ring.
    // A thumb that lands 40 px from the ring still means "move", and a stick that
    // only responds inside its own circle feels broken on a phone.
    this.zone = document.createElement("div");
    // Id so panelChrome can hide the stick with the rest of the touch HUD
    // while a modal panel is open.
    this.zone.id = "touch-stick";
    this.zone.style.cssText = [
      "position:fixed",
      // Safe-area insets shift the whole zone (and with it the resting ring):
      // the strip under a landscape iPhone's camera housing can't register
      // touches anyway, so ceding it costs nothing and keeps the ring visible.
      "left:env(safe-area-inset-left, 0px)",
      "bottom:env(safe-area-inset-bottom, 0px)",
      "width:46%",
      "height:62%",
      "z-index:9",
      "touch-action:none",
      "user-select:none",
      "-webkit-user-select:none",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");

    this.base = document.createElement("div");
    this.base.style.cssText = [
      "position:absolute",
      `width:${this.baseR * 2}px`,
      `height:${this.baseR * 2}px`,
      "border-radius:50%",
      "border:1px solid rgba(120,220,255,.30)",
      "background:radial-gradient(circle,rgba(10,20,32,.42),rgba(4,10,18,.62))",
      "box-shadow:0 0 18px rgba(64,230,255,.10) inset",
      "opacity:.55",
      "transition:opacity .18s ease",
      "pointer-events:none",
    ].join(";");

    this.knob = document.createElement("div");
    this.knob.style.cssText = [
      "position:absolute",
      `width:${this.knobR * 2}px`,
      `height:${this.knobR * 2}px`,
      "border-radius:50%",
      "border:1px solid rgba(160,240,255,.55)",
      "background:radial-gradient(circle at 40% 35%,rgba(120,235,255,.55),rgba(20,60,90,.75))",
      "box-shadow:0 0 14px rgba(64,230,255,.35)",
      "pointer-events:none",
    ].join(";");

    this.zone.appendChild(this.base);
    this.zone.appendChild(this.knob);
    document.body.appendChild(this.zone);

    // Park the ring at its resting home so there is something to aim at, and
    // take the first measurement so a gesture never starts from a stale rect.
    this.rect = this.zone.getBoundingClientRect();
    this.moveBaseTo(this.baseR + 26, this.rect.height - this.baseR - 26);

    this.zone.addEventListener("pointerdown", this.onDown);
    this.zone.addEventListener("pointermove", this.onMove);
    this.zone.addEventListener("pointerup", this.onUp);
    this.zone.addEventListener("pointercancel", this.onUp);
    // A thumb that slides off the zone must not leave the hero running forever.
    this.zone.addEventListener("lostpointercapture", this.onUp);
    // Window-level backstop: if a panel overlay (or anything else) mounts over
    // the zone mid-drag and the zone's own release events never arrive, the
    // release still lands here and the stick cannot stay stranded at full tilt.
    window.addEventListener("pointerup", this.onWindowUp);
    window.addEventListener("pointercancel", this.onWindowUp);
  }

  /** Current analog state. The same object every call — do not retain it. */
  get axes(): StickAxes {
    return this.state;
  }

  private moveBaseTo(x: number, y: number): void {
    this.originX = x;
    this.originY = y;
    this.base.style.left = `${x - this.baseR}px`;
    this.base.style.top = `${y - this.baseR}px`;
    this.knob.style.left = `${x - this.knobR}px`;
    this.knob.style.top = `${y - this.knobR}px`;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return; // already owned by the other thumb
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    // preventDefault stops the browser turning this into a scroll / text
    // selection / double-tap-zoom gesture mid-drag.
    e.preventDefault();

    // Measure ONCE per gesture and cache it. `getBoundingClientRect` forces a
    // synchronous layout, and a phone delivers pointermove at up to 120 Hz — so
    // reading it per move meant a forced layout per move, on top of a render loop
    // that is already the frame budget. The zone is `position: fixed` and only
    // moves when the viewport does, so a per-gesture measurement is exact.
    this.rect = this.zone.getBoundingClientRect();

    // Floating origin: the ring jumps to wherever the thumb landed, clamped so it
    // stays fully on screen. This is what makes a blind thumb-down work.
    const r = this.rect;
    const x = clamp(e.clientX - r.left, this.baseR, Math.max(this.baseR, r.width - this.baseR));
    const y = clamp(e.clientY - r.top, this.baseR, Math.max(this.baseR, r.height - this.baseR));
    this.moveBaseTo(x, y);
    this.base.style.opacity = "0.9";
    this.update(e);
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    this.update(e);
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.release();
  };

  private onWindowUp = (e: PointerEvent): void => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.release();
  };

  /**
   * Centre the stick and drop the active pointer. Public because the hero
   * controller calls it while a modal panel is open — the belt to the
   * window-backstop braces above.
   */
  release(): void {
    this.pointerId = null;
    this.state.x = 0;
    this.state.y = 0;
    this.state.run = false;
    this.state.magnitude = 0;
    this.knob.style.left = `${this.originX - this.knobR}px`;
    this.knob.style.top = `${this.originY - this.knobR}px`;
    this.base.style.opacity = "0.55";
  }

  private update(e: PointerEvent): void {
    const r = this.rect;
    const dx = e.clientX - r.left - this.originX;
    const dy = e.clientY - r.top - this.originY;

    const dist = Math.hypot(dx, dy);
    // Clamp the KNOB to the ring, but derive the axes from the same clamped
    // vector, so "full tilt" and "knob against the edge" are the same instant.
    const k = dist > this.baseR ? this.baseR / dist : 1;
    const kx = dx * k;
    const ky = dy * k;
    this.knob.style.left = `${this.originX + kx - this.knobR}px`;
    this.knob.style.top = `${this.originY + ky - this.knobR}px`;

    const mag = Math.min(1, dist / this.baseR);
    if (mag < DEAD_ZONE) {
      this.state.x = 0;
      this.state.y = 0;
      this.state.run = false;
      this.state.magnitude = 0;
      return;
    }
    // Rescale past the dead zone so the first responsive millimetre is a crawl
    // rather than an instant 12% of walk speed.
    const scaled = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
    const ux = kx / (dist * k || 1);
    const uy = ky / (dist * k || 1);
    this.state.x = ux * scaled;
    this.state.y = -uy * scaled; // screen-down is +y; forward is up
    this.state.magnitude = scaled;
    this.state.run = scaled >= STICK_RUN_AT;
  }

  dispose(): void {
    this.zone.removeEventListener("pointerdown", this.onDown);
    this.zone.removeEventListener("pointermove", this.onMove);
    this.zone.removeEventListener("pointerup", this.onUp);
    this.zone.removeEventListener("pointercancel", this.onUp);
    this.zone.removeEventListener("lostpointercapture", this.onUp);
    window.removeEventListener("pointerup", this.onWindowUp);
    window.removeEventListener("pointercancel", this.onWindowUp);
    this.zone.remove();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
