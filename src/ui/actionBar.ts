/**
 * WoW-style action bar — plain DOM, zero engine cost.
 *
 * Like the perf HUD, this is deliberately NOT Babylon GUI: a GUI texture adds
 * draw calls and texture memory, and a hotbar is exactly the kind of flat,
 * text-heavy UI the DOM already does better (crisp text at any DPI, CSS
 * transitions, free hit-testing). The doc-01 UI direction is "flat,
 * holographic, high-contrast" — that is a stylesheet, not a render target.
 *
 * The bar knows nothing about combat: it renders slots, tracks cooldowns,
 * flashes presses, and reports casts to a callback. Whether a cast means
 * anything is the scene's (later: the server's) problem — same split as
 * `shared/` vs the sim.
 *
 * TWO LAYOUTS, ONE STATE MACHINE
 * ------------------------------
 * `layout: "bar"` is the desktop keybind row along the bottom. `layout: "touch"`
 * is the thumb cluster in the bottom-right corner. They are two arrangements of
 * the same slots, deliberately inside one class: cooldown state, the clock-wipe
 * sweep, the press flash and the single rAF loop are shared, so the two layouts
 * cannot drift. A separate TouchBar class would have had to mirror all of that,
 * and mirrored cooldown state is the kind of thing that ends up half a second out
 * of sync in a fight and nobody can say why.
 */

import { uiScale, isTypingInField, onAnyTap } from "./inputMode";
import { createSkillTooltip, type SkillTooltip } from "./skillTooltip";
import { showCastWarning } from "./castWarning";

export interface BarSlotDef {
  id: string;
  /** Keyboard key, as `KeyboardEvent.key` (lowercase). Shown on the button. */
  key: string;
  /** Short label on the button face, e.g. "Oral". Fallback when no icon. */
  label: string;
  /** Tooltip line. */
  tooltip: string;
  /**
   * Skill icon URL (square, pre-cropped to fill the button face). The text
   * label stays on top of it, shadowed for contrast.
   */
  icon?: string;
  cooldownMs: number;
  /**
   * `"stance"` is the odd one: a free on/off toggle, not a cast. It pays no
   * Focus, starts no cooldown and is exempt from the GCD, and instead of
   * flashing it HOLDS a lit border while active (`setToggle`). Pavlov's
   * Discrimination is the first — see `Hero.threatStance`.
   */
  kind: "basic" | "palette" | "defense" | "chain" | "ultimate" | "stance";
  /**
   * `basic` only: this attack pays FLAT damage, so its button is a plain
   * button — no stance name, no "×N", no payoff border. Mirrors
   * `Ability.ignoresBeats` in the kit. The beat still drives the hero's
   * SKILLS, so the bar shows the pill readout instead of the button face.
   */
  flat?: boolean;
  /**
   * `basic` only: on the DESKTOP row, render this slot with palette geometry —
   * the 44 px square icon face — instead of the wide flat plate. For a basic
   * that transforms into a palette entry (Pavlov's NS ⇄ CS): the two faces
   * share one shape, so the swap repaints a button instead of reshaping it.
   * The touch layout ignores this — the corner button stays the big circle.
   */
  paletteFace?: boolean;
  /**
   * Exempt from the GCD like a stance, while keeping its own kind (and so
   * its own cast machinery). Skinner's E/R quadrant toggles are the first:
   * free flips that must stay pressable mid-rotation — eating a GCD to
   * switch quadrant would price the toggle out of the play it exists for.
   */
  freeOfGcd?: boolean;
}

/**
 * The stance switch, touch layout only.
 *
 * The 3-beat cycle is player-driven (Freud's Id → Ego → Superego is a stance
 * the player SWITCHES, not a metronome — his cycle-manipulation identity from
 * doc 02). On touch the corner button is the BASIC ATTACK (same contract as
 * desktop's LMB — its face doubles as the beat readout, including the payoff
 * telegraph doc 02 asks for), and this switch rides a small satellite button
 * beside it. Desktop gets the same switch on Tab.
 */
export interface BasicDef {
  /** Called whenever the player taps the stance button to switch stance. */
  onTap(): void;
}

export interface ActionBarOptions {
  layout?: "bar" | "touch";
  basic?: BasicDef;
  /**
   * The touch layout's word for the collapsed palette cluster. "Stages" is
   * Freud's; Skinner's four schedules are "Schedules". Kits with one entry
   * ignore this — their button wears its own name.
   */
  paletteWord?: string;
  /**
   * Touch only: mount the palette entries as their own arc buttons instead of
   * one wheel opener. For a two-entry palette played as a rhythm (Erikson's
   * `1-2-1-2`), where a wheel would cost two taps per press.
   */
  paletteInline?: boolean;
  /**
   * Shared global cooldown (ms). When set, ANY successful cast starts it and
   * no slot casts while it runs — doc 02's 1.5 s GCD ("about 40 casts a
   * minute, total, per hero"). Per-slot cooldowns still apply on top. The
   * clock-wipe shows whichever of the two keeps a slot dark longer.
   */
  gcdMs?: number;
  /**
   * Resource gate, asked LAST (after cooldown + GCD): return false and the
   * cast is refused — no cooldown starts, no GCD, onCast never fires, and the
   * slot flashes red so "nothing happened" reads as "can't afford", not as a
   * dead button. The bar stays combat-agnostic: it doesn't know the answer is
   * about Focus, only that the scene said no.
   */
  canCast?: (slot: BarSlotDef) => boolean;
  /**
   * Fired when `canCast` refuses a press, alongside the red flash. The scene
   * knows WHY it said no (empty Focus pool, dead hero, …) and owns whatever
   * louder feedback that deserves — e.g. the "Not enough Focus" popup. Not
   * fired for cooldown/GCD refusals: those already read as a dark slot.
   */
  onRefused?: (slot: BarSlotDef) => void;
  /**
   * Is there anything to hit? Asked for the BASIC attack only: false refuses
   * the swing with a "No Target" popup (no cooldown starts). Skills are never
   * asked — they stay free to cast with nothing in range. Unset = always a
   * target (the practice pit's dummy never leaves).
   */
  hasTarget?: () => boolean;
}

/** A held basic re-asks every 100 ms; the "No Target" line re-pops at most this often. */
const NO_TARGET_REPOP_MS = 900;

interface SlotState {
  def: BarSlotDef;
  el: HTMLButtonElement;
  labelEl: HTMLDivElement;
  cdOverlay: HTMLDivElement;
  cdText: HTMLDivElement;
  readyAt: number;
}

const BASIC_ACCENT = "#d8f7ff";

const KIND_ACCENT: Record<BarSlotDef["kind"], string> = {
  basic: BASIC_ACCENT,
  palette: "#40e6ff",
  defense: "#9e59ff",
  chain: "#ffd166",
  ultimate: "#ff59b8",
  // Threat red — a stance that pulls the boss onto you should not read as
  // another damage button.
  stance: "#ff7a5c",
};

/**
 * Thumb-cluster geometry, in pixels from the bottom-right corner of the safe
 * area. Written as plain offsets rather than polar maths because these get
 * nudged by feel on a real phone, and `{right, bottom, size}` is the form a
 * person can nudge.
 *
 * `basic` sits in the corner where the thumb rests. The four skill buttons lie on
 * an arc around it, ordered so the most-used slot is the shortest reach: palette
 * lowest, ultimate at the top. Everything stays inside ~215 px of the corner,
 * which is within thumb reach on a 6"-class phone held two-handed.
 */
const TOUCH_BASIC = { right: 20, bottom: 20, size: 96 };
/**
 * Arc offsets are the button's CENTRE, so every one of them must stay at least
 * `size / 2` from the right edge or it hangs off screen. The first pass put the
 * ultimate at `right: 9` and half the button was outside the viewport.
 * Generated on a 122 px radius around the basic button's centre (68, 68) at
 * 4°/38°/72°/106°, measuring 0° as straight left and 90° as straight up.
 * The radius is as tight as the geometry allows: the 34° step keeps adjacent
 * 66 px buttons ~5 px apart (chord 2·122·sin17° ≈ 71), and the top slot's
 * centre lands at right 34, one pixel inside the size/2 = 33 edge margin.
 */
const TOUCH_ARC: Array<{ right: number; bottom: number }> = [
  { right: 190, bottom: 77 }, // slot 1 — palette wheel, shortest reach
  { right: 164, bottom: 143 }, // slot 2
  { right: 106, bottom: 184 }, // slot 3
  { right: 34, bottom: 185 }, // slot 4 — ultimate, top of the arc
];
const TOUCH_SKILL_SIZE = 66;
/**
 * The extra anchor an inline palette's FIRST entry takes, left of the arc's
 * first slot (the second entry sits on TOUCH_ARC[0]) — so the pair reads 1 → 2
 * toward the thumb. 75 px from slot 1's centre and 138 px from slot 2's: clear
 * of both 66 px faces. Its left edge, 289 px from the corner, stays inside the
 * container's 340 px.
 */
const TOUCH_PALETTE_LEAD = { right: 256, bottom: 40 };
/**
 * The stance slot's centre — ABOVE the arc, crowning it (2026-08-05): a tank's
 * threat toggle is the button the kit pivots on, so it renders full size on
 * top of the other skills instead of as a satellite tucked beside the corner
 * button. Centred over the gap between the arc's top two buttons (106,184) and
 * (34,185): 36/72 px offsets put its centre ~80 px from each, a 14 px gap
 * between 66 px faces, and the top edge at 289 px stays inside the container's
 * 300 px height. Right 70 keeps the face 37 px clear of the screen edge.
 */
const TOUCH_STANCE = { right: 70, bottom: 256 };
/** Palette sub-skills fan out from the palette button on this arc. */
const WHEEL_R = 96;
const WHEEL_SIZE = 56;
const WHEEL_ANGLES = [20, 55, 90, 125, 160];

export class ActionBar {
  private readonly root: HTMLDivElement;
  /**
   * Hover copy for every slot. One bubble shared by the whole bar, built once
   * here so a scene never has to wire it up separately.
   */
  private readonly tip: SkillTooltip = createSkillTooltip();
  private readonly slots = new Map<string, SlotState>();
  private readonly byKey = new Map<string, string>();
  private readonly layout: "bar" | "touch";
  private readonly paletteWord: string | null;
  private readonly paletteInline: boolean;
  /** Slots `setAvailable` turned off: dimmed, and a press quietly does nothing. */
  private readonly unavailable = new Set<string>();
  /** Built on the first `setCaption`; kits that never call it never mount one. */
  private captionEl: HTMLDivElement | null = null;
  private readonly beatEl: HTMLDivElement;
  private rafId = 0;
  private readonly gcdMs: number;
  private readonly canCast: ((slot: BarSlotDef) => boolean) | null;
  private readonly onRefused: ((slot: BarSlotDef) => void) | null;
  private readonly hasTarget: (() => boolean) | null;
  private noTargetAt = -Infinity;
  private gcdReadyAt = 0;
  /** True when the mounted basic pays flat damage — see `BarSlotDef.flat`. */
  private readonly flatBasic: boolean;

  // Touch layout only.
  private basicEl: HTMLButtonElement | null = null;
  private wheelEl: HTMLDivElement | null = null;
  private wheelOpen = false;
  /** The finger holding the basic button down — the loop answers to it alone. */
  private basicHoldPointer: number | null = null;
  private basicHoldGrace: number | null = null;
  private basicHoldTimer: number | null = null;
  private basicHoldStopListeners: (() => void) | null = null;

  /**
   * Holding the touch basic button keeps swinging: after a short grace (so a
   * plain tap stays a single cast via onAnyTap) cast() is polled on a short
   * interval and no-ops while the slot cooldown runs, so the swing rate stays
   * governed by the bar — the same rule the desktop LMB hold follows in
   * fight/basicAttack.ts.
   *
   * The loop is scoped to the pointer that started it. The old `{once: true}`
   * window listener was consumed by ANY pointerup — the move-stick thumb
   * lifting ate it, the attack finger's own release then had no listener left,
   * and the interval swung forever while the player stood idle.
   *
   * `getId` is a getter, not a frozen id: replaceSlot renames the corner
   * slot mid-hold (Pavlov's NS ⇄ CS), and a hold pinned to the mount id
   * would poll a slot that no longer exists — a dead button until release.
   */
  private startBasicHold(el: HTMLElement, getId: () => string, pointerId: number): void {
    this.stopBasicHold();
    this.basicHoldPointer = pointerId;
    const stopIfOurs = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) this.stopBasicHold();
    };
    // Same teardown net as the desktop LMB hold (fight/basicAttack.ts), so the
    // two schemes cannot drift. visibilitychange/pagehide matter most here:
    // switching apps or locking the phone mid-hold fires neither pointerup nor
    // blur on iOS, and the interval resumed swinging on return with no finger
    // down — the "basic attack loops while idle" bug.
    const stopHold = (): void => this.stopBasicHold();
    const stopIfHidden = (): void => {
      if (document.visibilityState === "hidden") this.stopBasicHold();
    };
    // Self-healing net: any motion from this pointer that reports the press
    // no longer held (mouse: primary button up; touch: contact gone) kills the
    // loop. If every release event above is somehow missed, the loop still
    // dies on the first twitch of the pointer instead of swinging forever.
    const stopIfReleased = (e: PointerEvent): void => {
      if (e.pointerId === pointerId && (e.buttons & 1) === 0) this.stopBasicHold();
    };
    // Explicit capture: a guaranteed lostpointercapture bookends the press
    // even when the pointer vanishes without a pointerup (capture theft,
    // OS gestures). Touch pointers capture implicitly; this adds mouse parity.
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* pointer already gone — the listeners below still tear down */
    }
    el.addEventListener("lostpointercapture", stopIfOurs);
    window.addEventListener("pointerup", stopIfOurs);
    window.addEventListener("pointercancel", stopIfOurs);
    window.addEventListener("pointermove", stopIfReleased);
    window.addEventListener("blur", stopHold);
    window.addEventListener("pagehide", stopHold);
    document.addEventListener("visibilitychange", stopIfHidden);
    this.basicHoldStopListeners = () => {
      el.removeEventListener("lostpointercapture", stopIfOurs);
      window.removeEventListener("pointerup", stopIfOurs);
      window.removeEventListener("pointercancel", stopIfOurs);
      window.removeEventListener("pointermove", stopIfReleased);
      window.removeEventListener("blur", stopHold);
      window.removeEventListener("pagehide", stopHold);
      document.removeEventListener("visibilitychange", stopIfHidden);
    };
    this.basicHoldGrace = window.setTimeout(() => {
      this.basicHoldGrace = null;
      if (this.basicHoldPointer !== pointerId) return;
      this.cast(getId());
      this.basicHoldTimer = window.setInterval(() => {
        // Belt and braces: never swing without a live press behind it.
        if (this.basicHoldPointer !== pointerId) {
          this.stopBasicHold();
          return;
        }
        this.cast(getId());
      }, 100);
    }, 150);
  }

  private stopBasicHold(): void {
    if (this.basicHoldGrace !== null) {
      window.clearTimeout(this.basicHoldGrace);
      this.basicHoldGrace = null;
    }
    if (this.basicHoldTimer !== null) {
      window.clearInterval(this.basicHoldTimer);
      this.basicHoldTimer = null;
    }
    this.basicHoldStopListeners?.();
    this.basicHoldStopListeners = null;
    this.basicHoldPointer = null;
  }

  private readonly keyHandler = (e: KeyboardEvent) => {
    if (isTypingInField()) return; // "free" typed into chat must not cast R/E/F
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    const id = this.byKey.get(e.key.toLowerCase());
    if (id) this.cast(id);
  };
  /** Tap-away closes the palette wheel, the way every radial menu behaves. */
  private readonly outsideHandler = (e: PointerEvent) => {
    if (!this.wheelOpen) return;
    const target = e.target as Node;
    if (this.wheelEl?.contains(target)) return;
    // `contains`, not `===`: the tap usually lands on the button's label div, so
    // an identity check would close the wheel here and let the button's own click
    // immediately reopen it — the palette button would stop being able to close.
    if (this.paletteEl?.contains(target)) return;
    this.closeWheel();
  };

  private paletteEl: HTMLButtonElement | null = null;

  constructor(
    slots: BarSlotDef[],
    private readonly onCast: (slot: BarSlotDef) => void,
    opts: ActionBarOptions = {}
  ) {
    this.layout = opts.layout ?? "bar";
    this.paletteWord = opts.paletteWord ?? null;
    this.paletteInline = opts.paletteInline === true;
    this.gcdMs = opts.gcdMs ?? 0;
    this.canCast = opts.canCast ?? null;
    this.onRefused = opts.onRefused ?? null;
    this.hasTarget = opts.hasTarget ?? null;
    this.root = document.createElement("div");
    // Named so the panel chrome (ui/panelChrome.ts) can hide the whole bar —
    // desktop row or touch cluster — while a full-screen panel is open.
    this.root.id = "action-bar";
    this.beatEl = document.createElement("div");
    this.flatBasic = slots.some((d) => d.kind === "basic" && d.flat === true);

    if (this.layout === "touch") this.buildTouch(slots, opts.basic);
    else this.buildBar(slots);

    document.body.appendChild(this.root);
    // Keyboard stays live in BOTH layouts. A tablet with a keyboard, or a phone
    // on a desk mirror, should not lose its keybinds because a finger exists.
    window.addEventListener("keydown", this.keyHandler);
    if (this.layout === "touch") window.addEventListener("pointerdown", this.outsideHandler, true);
  }

  // -------------------------------------------------------------------------
  // Desktop: one row, centred along the bottom.
  // -------------------------------------------------------------------------

  private buildBar(slots: BarSlotDef[]): void {
    this.root.style.cssText = [
      "position:fixed",
      "bottom:calc(14px + env(safe-area-inset-bottom, 0px))",
      "left:50%",
      "transform:translateX(-50%)",
      "display:flex",
      "align-items:flex-end",
      "gap:6px",
      "z-index:10",
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
      "user-select:none",
    ].join(";");

    let basic: HTMLButtonElement | null = null;
    for (const def of slots) {
      // The basic attack is pulled out and mounted at the END of the row: LMB
      // is the mouse's own button, and its face already carries the stance
      // readout (setBeat rewrites the label) — which is also why the old beat
      // pill is gone: the button on the right says everything it said.
      if (def.kind === "basic") {
        // A transforming basic (Pavlov's NS ⇄ CS) wears palette geometry —
        // the same 44 px square icon face the palette row uses — so when
        // replaceSlot swaps CS in, the change is a repaint, not a reshape.
        // buildSlot's generic face (icon, bottom label, key badge) is exactly
        // what replaceSlot knows how to repaint, so nothing custom mounts.
        if (def.paletteFace) {
          basic = this.buildSlot(def, { size: 44, radius: 8, showKey: true });
          continue;
        }
        // A FLAT basic (Skinner's Response Rate) is just a button. No stance
        // name, no "×N" sub-line, no payoff border — flat damage means the
        // same thing every time, and a face that animated between three
        // values would be teaching the opposite. It keeps the square 52 px
        // slot the rest of the row uses — there is no long stance name to fit.
        basic = this.buildSlot(def, { size: 52, radius: 8, showKey: true });
        if (def.flat) {
          // A flat basic has no stance readout to wear, and the generic 9 px
          // slot label left "NS Bell" barely legible on the one button the
          // player presses most. It gets the same two-tier face the stance
          // readout uses — a big name over a small qualifier — just static.
          basic.style.width = "84px";
          const flatLabel = this.slots.get(def.id)!.labelEl;
          const [head, ...rest] = def.label.split("\n");
          flatLabel.textContent = "";
          flatLabel.style.cssText =
            "position:absolute;inset:0;display:grid;place-content:center;gap:1px;padding:0 4px;text-align:center;color:#eaf7ff;text-shadow:0 1px 2px rgba(0,0,0,.95)";
          const headEl = document.createElement("div");
          headEl.textContent = head ?? "";
          headEl.style.cssText =
            `font-size:${fitFontPx(head ?? "", 76, 22)}px;font-weight:800;letter-spacing:.04em;line-height:1.05;white-space:nowrap`;
          flatLabel.appendChild(headEl);
          if (rest.length) {
            const subEl = document.createElement("div");
            subEl.textContent = rest.join(" ");
            subEl.style.cssText = "font-size:11px;opacity:.85;line-height:1.15;white-space:nowrap";
            flatLabel.appendChild(subEl);
          }
          continue;
        }
        // Otherwise the face IS the stance readout: a big stance name over a
        // small "Attack ×N" sub-line, which setBeat rewrites. The face is
        // widened (square would clip "Superego" at a readable size); the
        // cooldown overlay is inset:0, so it follows the new width for free.
        basic.style.width = "84px";
        const label = this.slots.get(def.id)!.labelEl;
        const [initName] = def.label.split("\n");
        label.textContent = "";
        const nameEl = document.createElement("div");
        nameEl.textContent = initName;
        nameEl.style.cssText =
          "font-size:15px;font-weight:800;letter-spacing:.04em;line-height:1.1;white-space:nowrap;transform-origin:center";
        const subEl = document.createElement("div");
        subEl.textContent = "Attack ×1";
        subEl.style.cssText = "font-size:9px;opacity:.8;line-height:1.2;white-space:nowrap";
        label.append(nameEl, subEl);
        continue;
      }
      if (def.kind === "defense") this.root.appendChild(divider());
      const big = def.kind !== "palette";
      this.root.appendChild(this.buildSlot(def, { size: big ? 52 : 44, radius: 8, showKey: true }));
    }
    if (basic) {
      this.root.appendChild(divider());
      this.root.appendChild(basic);
    }

    // Beat readout: normally unattached on desktop (same trick as the touch
    // layout) so `setBeat` stays a single code path — the basic slot's label
    // and border carry the stance and the payoff telegraph instead.
    //
    // A hero with a FLAT basic has no such face, but the beat still multiplies
    // their SKILLS, so the pill comes back rather than leaving the cycle
    // invisible. It rides above the row, left of centre, out of the way of the
    // cooldown numbers.
    if (this.flatBasic) {
      this.beatEl.style.cssText = [
        "position:fixed",
        "bottom:calc(78px + env(safe-area-inset-bottom, 0px))",
        "left:50%",
        "transform:translateX(-50%)",
        "padding:2px 10px",
        "border-radius:999px",
        "background:rgba(8,10,16,.72)",
        `border:1px solid ${BASIC_ACCENT}44`,
        "color:#dfe6f5",
        "font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
        "letter-spacing:.04em",
        "white-space:nowrap",
        "pointer-events:none",
        "z-index:10",
      ].join(";");
      if (!this.beatEl.isConnected) document.body.appendChild(this.beatEl);
    } else {
      this.beatEl.style.cssText = "display:none";
    }
  }

  // -------------------------------------------------------------------------
  // Touch: thumb cluster, bottom-right.
  // -------------------------------------------------------------------------

  private buildTouch(slots: BarSlotDef[], basic?: BasicDef): void {
    // The container spans a large corner region but is pointer-transparent: only
    // the buttons themselves take input, so a drag that starts on empty space
    // between them still reaches the canvas and orbits the camera. Getting this
    // wrong turns the whole lower-right quadrant into a dead zone for the look
    // control, which is the single most common mobile-HUD bug.
    this.root.style.cssText = [
      "position:fixed",
      // The whole cluster's edge clearance lives HERE, on the container's own
      // offsets — not in padding: the buttons are absolutely positioned, and
      // absolute children anchor to the containing block's PADDING box, so
      // container padding never moves them (the old env() padding was a
      // silent no-op). The 14px base keeps a real right margin even where the
      // safe-area inset is 0 (most Androids): without it the arc's top button
      // sat 1px from the screen edge.
      "right:calc(14px + env(safe-area-inset-right, 0px))",
      "bottom:env(safe-area-inset-bottom, 0px)",
      "width:min(340px,72vw)",
      "height:min(300px,58vh)",
      "z-index:10",
      "pointer-events:none",
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
      "user-select:none",
      "-webkit-user-select:none",
      // One transform scales the whole cluster for tablets, which keeps the arc
      // geometry above in a single coordinate system — scaling each button's
      // offsets individually would mean re-deriving the arc for every device.
      // Anchored bottom-right so the thumb corner stays put as it grows.
      // The extra ×0.8 shrinks the whole cluster on phones: full-size buttons
      // ate too much of the play area next to the boss frame.
      `transform:scale(${uiScale() * 0.8})`,
      "transform-origin:100% 100%",
    ].join(";");

    // Palette collapses to ONE button that opens a wheel — doc 02's own model:
    // "4-8 sub-skills on one button-wheel". Five separate 44 px targets is a
    // desktop keybind row, not a thumb layout. A "basic" slot never mounts on
    // the arc — it becomes the corner button (see buildBasic).
    const palette = slots.filter((s) => s.kind === "palette");
    // A stance is pulled off the arc too. TOUCH_ARC has exactly four anchors
    // and E/R/F already fill three of them beside the palette wheel; a fourth
    // discrete slot would clamp onto the ultimate's anchor and render on top
    // of it. The stance instead crowns the cluster at TOUCH_STANCE, full size
    // above the arc's top buttons (see buildStanceSlot).
    const stanceDef = slots.find((s) => s.kind === "stance");
    const discrete = slots.filter(
      (s) => s.kind !== "palette" && s.kind !== "basic" && s.kind !== "stance"
    );
    const basicDef = slots.find((s) => s.kind === "basic");

    let paletteEl: HTMLButtonElement | null = null;
    if (this.paletteInline && palette.length > 0) {
      // Each entry is its own button, cast on tap — no wheel. The last entry
      // takes the arc's palette anchor; the one before it the lead anchor.
      const anchors = [TOUCH_PALETTE_LEAD, TOUCH_ARC[0]!].slice(-palette.length);
      palette.slice(-anchors.length).forEach((def, i) => {
        const el = this.buildSlot(def, { size: TOUCH_SKILL_SIZE, radius: 999, showKey: false });
        place(el, anchors[i]!, TOUCH_SKILL_SIZE);
        this.root.appendChild(el);
      });
    } else if (palette.length > 0) {
      // A kit with ONE palette entry has no wheel to open and no stages to
      // name — Pavlov's button is just UCS — so the button IS the skill: it
      // wears its own face and casts directly. No wheel means no second
      // registration of the same slot id, which is what once let a
      // `replaceSlot` transform repaint THIS visible button — the wheel
      // copy used to steal the `slots` entry, so on touch the flip landed on
      // a hidden button and the face the player saw never changed. (The
      // NS ⇄ CS transform now rides the corner basic, but the single-entry
      // rule stands on its own.)
      const single = palette.length === 1;
      paletteEl = this.buildSlot(palette[0], {
        size: TOUCH_SKILL_SIZE,
        radius: 999,
        showKey: false,
        // "Stages" is Freud's word for his five-entry palette wheel; other
        // kits pass their own (`paletteWord` — Skinner's "Schedules").
        labelOverride: single ? undefined : (this.paletteWord ?? "Stages"),
        // Tapping a multi-entry palette button opens the wheel, never casts;
        // a single-entry one takes buildSlot's default live-def cast.
        onTap: single ? undefined : () => this.toggleWheel(),
      });
      place(paletteEl, TOUCH_ARC[0], TOUCH_SKILL_SIZE);
      this.root.appendChild(paletteEl);
      this.paletteEl = paletteEl;
    }

    discrete.forEach((def, i) => {
      const anchor = TOUCH_ARC[Math.min(TOUCH_ARC.length - 1, i + 1)];
      const el = this.buildSlot(def, { size: TOUCH_SKILL_SIZE, radius: 999, showKey: false });
      place(el, anchor, TOUCH_SKILL_SIZE);
      this.root.appendChild(el);
    });

    // Corner button: the basic attack when the scene supplies a basic slot
    // (the shipping wiring — same cast path as desktop's LMB), else the legacy
    // stance-only button. The stance switch gets its own satellite button.
    if (basicDef || basic) this.root.appendChild(this.buildBasic(basicDef, basic));
    if (stanceDef) this.root.appendChild(this.buildStanceSlot(stanceDef));
    else if (basicDef && basic) this.root.appendChild(this.buildStanceToggle(basic));

    // Wheel goes on LAST so it paints above the arc it opens across. Appended
    // before the other buttons, an equal z-index meant DOM order won and the
    // Defense/Chain/Ultimate buttons sat on top of the open wheel — swallowing
    // taps meant for a palette stage. Only multi-entry palettes get one — a
    // single entry casts straight off its arc button (see above).
    if (palette.length > 1 && !this.paletteInline) this.root.appendChild(this.buildWheel(palette));

    // Beat normally lives on the basic button in this layout; keep the element
    // around (unattached) so `setBeat` stays a single code path. A flat basic
    // has no face to carry it, so the pill mounts above the thumb cluster —
    // the beat still multiplies that hero's skills.
    if (this.flatBasic) {
      this.beatEl.style.cssText = [
        "position:fixed",
        `bottom:calc(${TOUCH_BASIC.bottom + TOUCH_BASIC.size + 8}px + env(safe-area-inset-bottom, 0px))`,
        `right:${TOUCH_BASIC.right}px`,
        "padding:3px 10px",
        "border-radius:999px",
        "background:rgba(8,10,16,.72)",
        `border:1px solid ${BASIC_ACCENT}44`,
        "color:#dfe6f5",
        "font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
        "white-space:nowrap",
        "pointer-events:none",
        "z-index:10",
      ].join(";");
      if (!this.beatEl.isConnected) document.body.appendChild(this.beatEl);
    } else {
      this.beatEl.style.cssText = "display:none";
    }
  }

  private buildBasic(def?: BarSlotDef, stance?: BasicDef): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.title = !def
      ? "Stance. Tap to switch the 3 beat cycle."
      : def.flat
        ? "Basic attack. Flat damage — it does not ride the beat."
        : "Basic attack. Damage rides the current stance.";
    el.style.cssText = [
      "position:absolute",
      `width:${TOUCH_BASIC.size}px`,
      `height:${TOUCH_BASIC.size}px`,
      `right:${TOUCH_BASIC.right}px`,
      `bottom:${TOUCH_BASIC.bottom}px`,
      "border-radius:50%",
      `border:2px solid ${BASIC_ACCENT}66`,
      "background:radial-gradient(circle at 42% 34%,rgba(24,42,60,.95),rgba(6,10,18,.95))",
      "color:#eaf9ff",
      "pointer-events:auto",
      "touch-action:manipulation",
      "-webkit-tap-highlight-color:transparent",
      "display:grid",
      "place-content:center",
      "gap:1px",
      "padding:0",
      // Clips the rectangular cooldown overlay to the round face.
      "overflow:hidden",
      "transition:box-shadow .18s ease, transform .05s ease, border-color .18s ease",
    ].join(";");

    const name = document.createElement("div");
    // The stance name dominates the face; the multiplier and the state tag
    // stay small secondaries. Nowrap + a shrink-to-fit transform in setBeat
    // keep "Superego" inside the 96 px circle without dropping the base size.
    name.style.cssText =
      "font-size:24px;font-weight:800;letter-spacing:.02em;line-height:1.05;white-space:nowrap;transform-origin:center";
    const mult = document.createElement("div");
    mult.style.cssText = "font-size:11px;opacity:.7";
    const state = document.createElement("div");
    state.style.cssText = "font-size:8px;letter-spacing:.14em;opacity:.6";
    el.append(name, mult, state);

    this.basicEl = el;
    if (def?.flat) {
      // Flat basic: the circle just says what it is. setBeat leaves it alone,
      // so this text is written once, here — at the biggest size the 96 px
      // face allows. 28 px fits Pavlov's "NS", but a long head like Skinner's
      // "Response" runs half again the diameter at that size, so the face
      // shrinks to what its own word needs.
      const [head, ...rest] = def.label.split("\n");
      name.textContent = head ?? "";
      name.style.fontSize = `${fitFontPx(head ?? "", TOUCH_BASIC.size - 14, 28)}px`;
      mult.textContent = rest.join(" ");
      mult.style.fontSize = "13px";
      mult.style.opacity = ".85";
    }
    state.textContent = def ? "ATTACK" : "TAP TO SWITCH";
    el.style.borderColor = `${BASIC_ACCENT}bb`;
    el.style.boxShadow = `0 0 16px ${BASIC_ACCENT}33`;

    if (def) {
      // Register as a REAL slot so `cast(def.id)` runs the shared machinery —
      // cooldown, GCD, the onCast callback — identically to the desktop LMB
      // slot. Before this, the corner button only switched stance and touch
      // players had no basic attack at all.
      const cdOverlay = document.createElement("div");
      cdOverlay.style.cssText =
        "position:absolute;inset:0;background:rgba(2,4,8,.78);display:none;pointer-events:none";
      const cdText = document.createElement("div");
      cdText.style.cssText =
        "position:absolute;inset:0;display:none;place-content:center;font-size:14px;color:#fff;pointer-events:none;text-shadow:0 0 6px #000";
      el.append(cdOverlay, cdText);
      const state: SlotState = { def, el, labelEl: name, cdOverlay, cdText, readyAt: 0 };
      this.slots.set(def.id, state);
      this.byKey.set(def.key.toLowerCase(), def.id);
      // Cast the LIVE def, exactly as buildSlot does: replaceSlot renames the
      // corner slot in place (Pavlov's NS ⇄ CS), and a tap or hold frozen on
      // the mount id would look up a slot that no longer exists.
      onAnyTap(el, () => this.cast(state.def.id));
      // Hold-to-loop: a press-and-hold keeps swinging until THAT finger lifts.
      el.addEventListener("pointerdown", (e) =>
        this.startBasicHold(el, () => state.def.id, e.pointerId)
      );
    } else if (stance) {
      onAnyTap(el, () => stance.onTap());
    }
    pressFeedback(el);
    return el;
  }

  /**
   * The stance as a REAL slot on the touch layout, worn full size ON TOP of
   * the arc (`TOUCH_STANCE` — 2026-08-05, replacing the 38 px satellite beside
   * the corner button): a big icon face like every other skill, crowning the
   * cluster, because Discrimination is the button a tank plays the fight
   * around and a 38 px pill read as a settings toggle.
   *
   * It registers through `buildSlot` so the keyboard binding, the hover
   * bubble and `setToggle` all work exactly as they do on desktop; showKey
   * stays off like the rest of the touch cluster.
   */
  private buildStanceSlot(def: BarSlotDef): HTMLButtonElement {
    const el = this.buildSlot(def, { size: TOUCH_SKILL_SIZE, radius: 999, showKey: false });
    place(el, TOUCH_STANCE, TOUCH_SKILL_SIZE);
    return el;
  }

  private buildStanceToggle(stance: BasicDef): HTMLButtonElement {
    const SIZE = 34;
    const el = document.createElement("button");
    el.type = "button";
    el.title = "Switch stance: Id, then Ego, then Superego.";
    el.textContent = "⟳";
    el.style.cssText = [
      "position:absolute",
      `width:${SIZE}px`,
      `height:${SIZE}px`,
      `right:${TOUCH_BASIC.right + TOUCH_BASIC.size + 14}px`,
      `bottom:${TOUCH_BASIC.bottom - 12}px`,
      "border-radius:50%",
      `border:1px solid ${BASIC_ACCENT}66`,
      "background:radial-gradient(circle at 42% 34%,rgba(24,42,60,.92),rgba(6,10,18,.92))",
      "color:#d8f7ff",
      "font-size:16px",
      "line-height:1",
      "padding:0",
      "pointer-events:auto",
      "touch-action:manipulation",
      "-webkit-tap-highlight-color:transparent",
      "transition:box-shadow .18s ease, transform .05s ease",
    ].join(";");
    onAnyTap(el, () => stance.onTap());
    pressFeedback(el);
    return el;
  }

  private buildWheel(palette: BarSlotDef[]): HTMLDivElement {
    const wheel = document.createElement("div");
    wheel.style.cssText = [
      "position:absolute",
      "inset:0",
      "pointer-events:none",
      "opacity:0",
      "visibility:hidden",
      "transition:opacity .14s ease",
    ].join(";");

    palette.forEach((def, i) => {
      const angle = ((WHEEL_ANGLES[i % WHEEL_ANGLES.length] ?? 90) * Math.PI) / 180;
      // Resolved after buildSlot registers the state; the tap must cast the
      // LIVE def (replaceSlot renames entries in place — Skinner's E/R faces),
      // not the id this button happened to mount with.
      let state: { def: BarSlotDef } | undefined;
      const el = this.buildSlot(def, {
        size: WHEEL_SIZE,
        radius: 999,
        showKey: false,
        // Casting from the wheel closes it: a radial that stays open after a
        // selection covers the screen during the cast you just committed to.
        onTap: () => {
          this.cast(state?.def.id ?? def.id);
          this.closeWheel();
        },
      });
      state = this.slots.get(def.id);
      place(
        el,
        {
          right: TOUCH_ARC[0].right + WHEEL_R * Math.cos(angle),
          bottom: TOUCH_ARC[0].bottom + WHEEL_R * Math.sin(angle),
        },
        WHEEL_SIZE
      );
      wheel.appendChild(el);
    });

    this.wheelEl = wheel;
    return wheel;
  }

  private toggleWheel(): void {
    if (this.wheelOpen) this.closeWheel();
    else this.openWheel();
  }

  private openWheel(): void {
    if (!this.wheelEl) return;
    this.wheelOpen = true;
    this.wheelEl.style.visibility = "visible";
    this.wheelEl.style.pointerEvents = "none"; // container stays transparent
    this.wheelEl.style.opacity = "1";
    for (const child of Array.from(this.wheelEl.children)) {
      (child as HTMLElement).style.pointerEvents = "auto";
    }
    // The wheel necessarily fans across the arc it springs from, so five stage
    // buttons land on top of Defense/Chain/Ultimate. Dimming those reads the
    // overlap as "a menu is open" instead of as two rows of buttons colliding.
    // A full-screen scrim would be the usual trick and is wrong here: it would
    // swallow the drags that orbit the camera.
    this.setUnderlayDim(true);
  }

  private closeWheel(): void {
    if (!this.wheelEl) return;
    this.wheelOpen = false;
    this.wheelEl.style.opacity = "0";
    this.wheelEl.style.visibility = "hidden";
    for (const child of Array.from(this.wheelEl.children)) {
      (child as HTMLElement).style.pointerEvents = "none";
    }
    this.setUnderlayDim(false);
  }

  /** Fade everything the open wheel is drawn over, wheel and palette excluded. */
  private setUnderlayDim(dim: boolean): void {
    for (const child of Array.from(this.root.children)) {
      const el = child as HTMLElement;
      if (el === this.wheelEl || el === this.paletteEl) continue;
      el.style.opacity = dim ? "0.3" : "1";
      el.style.transition = "opacity .14s ease";
    }
  }

  // -------------------------------------------------------------------------
  // Shared slot rendering
  // -------------------------------------------------------------------------

  private buildSlot(
    def: BarSlotDef,
    opts: {
      size: number;
      radius: number;
      showKey: boolean;
      labelOverride?: string;
      onTap?: () => void;
    }
  ): HTMLButtonElement {
    const accent = KIND_ACCENT[def.kind];
    const round = opts.radius > 100;

    const el = document.createElement("button");
    el.type = "button";
    // The native tooltip stays as the accessible fallback; `attach` strips it
    // and takes over on a mouse pointer (attached at the bottom, over the
    // slot state, so a transformed slot describes its current face).
    el.title = `${def.label.replace("\n", " ")}: ${def.tooltip}`;
    el.style.cssText = [
      `width:${opts.size}px`,
      `height:${opts.size}px`,
      round ? "position:absolute" : "position:relative",
      round ? "border-radius:50%" : `border-radius:${opts.radius}px`,
      `border:1px solid ${accent}55`,
      "background:linear-gradient(180deg,rgba(14,22,34,.92),rgba(6,10,18,.92))",
      `box-shadow:0 0 10px ${accent}22, inset 0 1px 0 rgba(255,255,255,.06)`,
      "color:#d8f7ff",
      "cursor:pointer",
      "padding:0",
      "overflow:hidden",
      round ? "pointer-events:auto" : "",
      // Suppress the 300 ms tap delay and double-tap zoom on the buttons.
      "touch-action:manipulation",
      "-webkit-tap-highlight-color:transparent",
      "transition:box-shadow .15s ease, transform .05s ease",
    ]
      .filter(Boolean)
      .join(";");

    // Icon face goes on FIRST so the key badge, label and cooldown overlays
    // stack above it in DOM order. The art is pre-cropped to the tile face
    // (tools note in assets/work/freud/README.md), so `cover` fills the
    // button and the button's own border-radius does the framing. The wheel
    // opener (labelOverride) stays text-only — it stands for all five stages,
    // and wearing one stage's icon would misread as that stage.
    const hasIcon = Boolean(def.icon) && !opts.labelOverride;
    if (hasIcon) {
      const icon = document.createElement("div");
      icon.dataset.slotIcon = "1"; // replaceSlot finds and repaints this face
      icon.style.cssText = `position:absolute;inset:0;background:url(${def.icon}) center/cover no-repeat`;
      el.appendChild(icon);
    }

    if (opts.showKey) {
      const key = document.createElement("div");
      key.textContent = def.key.toUpperCase();
      key.style.cssText = hasIcon
        ? // On an icon face the badge needs its own contrast plate.
          `position:absolute;top:2px;left:2px;padding:0 3px;font-size:9px;line-height:1.4;color:${accent};background:rgba(2,6,12,.75);border-radius:4px`
        : `position:absolute;top:2px;left:4px;font-size:9px;color:${accent};opacity:.9`;
      el.appendChild(key);
    }

    // The label always renders — over an icon it anchors to the bottom edge
    // (centred it would sit right on the glyph) and gets a hard shadow plus a
    // low scrim so neon art behind it never washes the words out.
    const label = document.createElement("div");
    const labelText = opts.labelOverride ?? def.label;
    label.textContent = labelText;
    const baseSize = round ? (opts.size >= 60 ? 10 : 9) : def.kind !== "palette" ? 9 : 8;
    // replaceSlot refits the swapped-in label against this same base.
    label.dataset.baseFs = String(baseSize);
    const labelSize = fitFontPx(labelText, opts.size - 8, baseSize);
    if (hasIcon) {
      label.style.cssText = [
        "position:absolute",
        "bottom:0",
        "left:0",
        "right:0",
        `padding:6px 2px 2px`,
        `font-size:${labelSize}px`,
        "line-height:1.1",
        "color:#eaf7ff",
        "white-space:pre-line",
        "text-align:center",
        "text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 5px rgba(0,0,0,.8)",
        "background:linear-gradient(180deg,transparent,rgba(2,6,12,.72))",
      ].join(";");
    } else {
      label.style.cssText = round
        ? `position:absolute;inset:0;display:grid;place-content:center;padding:0 4px;font-size:${labelSize}px;line-height:1.15;color:#dff2fb;white-space:pre-line;text-align:center`
        : `position:absolute;bottom:3px;left:0;right:0;font-size:${labelSize}px;line-height:1.1;color:#cfe8f5;opacity:.85;white-space:pre-line`;
    }
    el.appendChild(label);

    // Cooldown: a conic sweep + countdown text, driven by one rAF loop for
    // the whole bar that only runs while something is actually cooling down.
    const cdOverlay = document.createElement("div");
    cdOverlay.style.cssText =
      "position:absolute;inset:0;background:rgba(2,4,8,.78);display:none;pointer-events:none";
    el.appendChild(cdOverlay);

    const cdText = document.createElement("div");
    cdText.style.cssText =
      "position:absolute;inset:0;display:none;place-content:center;font-size:14px;color:#fff;pointer-events:none;text-shadow:0 0 6px #000";
    el.appendChild(cdText);

    const state: SlotState = { def, el, labelEl: label, cdOverlay, cdText, readyAt: 0 };
    // Cast the LIVE def, not the mount-time one: replaceSlot renames the slot
    // id in place (Skinner's E/R faces, Pavlov's NS⇄CS), and a tap closure
    // frozen on the mount id would look up a slot that no longer exists —
    // a dead button for every pointer press, while the key kept working
    // through the byKey map. That was the whole mobile E/R bug.
    const tap = opts.onTap ?? (() => this.cast(state.def.id));
    // onAnyTap, not click: the second thumb (skill while the move stick is
    // held) is a non-primary pointer and never gets a click event.
    onAnyTap(el, tap);
    pressFeedback(el);

    this.slots.set(def.id, state);
    this.byKey.set(def.key.toLowerCase(), def.id);
    // One attach per BUTTON, over the live state — replaceSlot swaps the def
    // and the bubble follows without stacking a second listener set.
    this.tip.attach(el, () => state.def.id);
    return el;
  }

  /**
   * Transform a slot in place — the same button, key and element wearing a
   * new ability (`PaletteEntry.transformsFrom`: Pavlov's NS ⇄ CS share the
   * LMB slot). Label, icon, tooltip and the `slots`/`byKey` maps all move to the new
   * id; a running cooldown carries over, so a transform is never a cooldown
   * reset. Returns false if `oldId` isn't mounted (or the new id already is).
   */
  replaceSlot(oldId: string, def: BarSlotDef): boolean {
    if (oldId === def.id) return false;
    const slot = this.slots.get(oldId);
    if (!slot || this.slots.has(def.id)) return false;
    this.slots.delete(oldId);
    slot.def = def;
    this.slots.set(def.id, slot);
    this.byKey.set(def.key.toLowerCase(), def.id);
    this.paintLabel(slot);
    if (slot.el !== this.basicEl) {
      const icon = slot.el.querySelector<HTMLElement>("[data-slot-icon]");
      if (icon && def.icon) icon.style.background = `url(${def.icon}) center/cover no-repeat`;
    }
    // The face may change KIND (basic ⇄ palette on the NS ⇄ CS swap), so the
    // resting border follows the new accent; flash() below already restores
    // the matching box-shadow when the blink settles.
    const accent = KIND_ACCENT[def.kind];
    slot.el.style.borderColor = slot.el === this.basicEl ? `${accent}bb` : `${accent}55`;
    flash(slot.el, KIND_ACCENT[def.kind]);
    return true;
  }

  /**
   * Repaint a slot's words from its def. Three faces exist: the touch corner
   * button (a big head over a small sub-line, from buildBasic), the desktop
   * flat basic (the same two tiers, from buildBar), and every other slot (one
   * label, refit to the button). The shape never changes; only the words do.
   */
  private paintLabel(slot: SlotState): void {
    const [head, ...rest] = slot.def.label.split("\n");
    if (slot.el === this.basicEl) {
      slot.labelEl.textContent = head ?? "";
      slot.labelEl.style.fontSize = `${fitFontPx(head ?? "", TOUCH_BASIC.size - 14, 28)}px`;
      const sub = slot.labelEl.nextElementSibling as HTMLElement | null;
      if (sub) sub.textContent = rest.join(" ");
    } else if (slot.def.kind === "basic" && slot.def.flat && slot.labelEl.children.length > 0) {
      const [headEl, subEl] = slot.labelEl.children as unknown as HTMLElement[];
      if (headEl) {
        headEl.textContent = head ?? "";
        headEl.style.fontSize = `${fitFontPx(head ?? "", 76, 22)}px`;
      }
      if (subEl) subEl.textContent = rest.join(" ");
    } else {
      slot.labelEl.textContent = slot.def.label;
      const base = Number(slot.labelEl.dataset.baseFs ?? 9);
      slot.labelEl.style.fontSize = `${fitFontPx(slot.def.label, slot.el.offsetWidth - 8, base)}px`;
    }
  }

  /**
   * Relabel a slot in place: same id, key and running cooldown, new words
   * (and, optionally, a new icon face). Erikson's keys 1, 2 and LMB name the stage, virtue and relations
   * they cast next, and those move on every press — a `replaceSlot` per press
   * would be a new id each time for what is only a caption.
   */
  setLabel(id: string, label: string, icon?: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const iconChanged = icon !== undefined && icon !== slot.def.icon;
    if (slot.def.label === label && !iconChanged) return;
    slot.def = { ...slot.def, label, ...(icon !== undefined ? { icon } : {}) };
    this.paintLabel(slot);
    // Icon faces only: a slot mounted without art has no face to repaint.
    const face = iconChanged ? slot.el.querySelector<HTMLElement>("[data-slot-icon]") : null;
    if (face) face.style.background = `url(${icon}) center/cover no-repeat`;
  }

  /**
   * Turn a slot off or on without a cooldown: off dims it, and a press does
   * nothing — no flash, no popup, so holding a gated basic (the touch corner
   * repeats every 100 ms) is not a strobe. Erikson's add-on basic is the
   * first user: it is available only once after each key 1 or key 2.
   */
  setAvailable(id: string, available: boolean): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (available) this.unavailable.delete(id);
    else this.unavailable.add(id);
    slot.el.style.opacity = available ? "" : "0.4";
  }

  /**
   * A readout for the whole kit, up to two lines (`\n`) — Erikson's
   * "Stage 5 · Identity vs Role Confusion · age 12 to 18" over
   * "press 2 → Fidelity · Virtues 3/8". Desktop: centred above the row, where
   * the beat pill sits (which it replaces). Touch: right-aligned just above the
   * thumb cluster — the band between the boss frame and the skill arc, clear
   * of the chat button and the move stick that share the bottom edge.
   */
  setCaption(text: string): void {
    if (!this.captionEl) {
      const el = document.createElement("div");
      el.id = "action-caption";
      // Top of the arc's highest button, in the cluster's scaled frame.
      const arcTop = Math.max(...TOUCH_ARC.map((a) => a.bottom)) + TOUCH_SKILL_SIZE / 2;
      el.style.cssText = [
        "position:fixed",
        ...(this.layout === "touch"
          ? [
              `bottom:calc(${Math.round(arcTop * uiScale() * 0.8) + 10}px + env(safe-area-inset-bottom, 0px))`,
              "right:calc(14px + env(safe-area-inset-right, 0px))",
              "max-width:min(380px,46vw)",
              "text-align:right",
              "border-radius:10px",
            ]
          : [
              "bottom:calc(78px + env(safe-area-inset-bottom, 0px))",
              "left:50%",
              "transform:translateX(-50%)",
              "max-width:min(620px,60vw)",
              "text-align:center",
              "border-radius:12px",
            ]),
        "padding:3px 12px",
        "background:rgba(8,10,16,.78)",
        `border:1px solid ${KIND_ACCENT.palette}55`,
        "color:#eaf7ff",
        "font:600 12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
        "white-space:pre-line",
        "pointer-events:none",
        "z-index:10",
      ].join(";");
      document.body.appendChild(el);
      this.captionEl = el;
      // One readout, not two: the flat-basic beat pill shares the spot.
      this.beatEl.style.display = "none";
    }
    this.captionEl.textContent = text;
  }

  /** Attempt a cast. Returns false while the slot is on cooldown or the GCD runs. */
  cast(id: string): boolean {
    const now = performance.now();
    const slot = this.slots.get(id);
    if (!slot || now < slot.readyAt) return false;
    if (this.unavailable.has(id)) return false;
    if (slot.def.kind === "basic" && this.hasTarget && !this.hasTarget()) {
      // Throttled: holding LMB or the touch corner would otherwise strobe.
      if (now - this.noTargetAt > NO_TARGET_REPOP_MS) {
        this.noTargetAt = now;
        denyFlash(slot.el);
        showCastWarning("No Target");
      }
      return false;
    }
    // The basic attack lives outside the GCD: it answers only to its own
    // cooldown, so it can weave freely between skill casts (and vice versa).
    // Free presses: the basic (doc 02 exempts it) and a stance toggle, which
    // costs nothing and must stay pressable mid-rotation — eating a GCD to
    // drop aggro would make the stance unusable exactly when it matters.
    const isBasic =
      slot.def.kind === "basic" || slot.def.kind === "stance" || slot.def.freeOfGcd === true;
    if (!isBasic && now < this.gcdReadyAt) return false;
    if (this.canCast && !this.canCast(slot.def)) {
      denyFlash(slot.el);
      this.onRefused?.(slot.def);
      return false;
    }

    slot.readyAt = now + slot.def.cooldownMs;
    if (!isBasic && this.gcdMs > 0) this.gcdReadyAt = now + this.gcdMs;
    // A stance never flashes: `flash` restores the RESTING box-shadow on a
    // 180 ms timer, which would wipe the held glow `setToggle` paints inside
    // this same call. The state change is better feedback than a blink anyway
    // — the button either stays lit or goes dark, and that IS the answer.
    if (slot.def.kind !== "stance") flash(slot.el, KIND_ACCENT[slot.def.kind]);
    slot.cdOverlay.style.display = "block";
    slot.cdText.style.display = "grid";
    this.ensureTicking();

    this.onCast(slot.def);
    return true;
  }

  /**
   * Force a slot onto a cooldown from outside — e.g. doc 02's Fixation: a
   * wrong palette answer locks that sub-skill for 10 s. Refuses to shorten an
   * existing longer cooldown.
   */
  lockSlot(id: string, ms: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const until = performance.now() + ms;
    if (until <= slot.readyAt) return;
    slot.readyAt = until;
    slot.cdOverlay.style.display = "block";
    slot.cdText.style.display = "grid";
    this.ensureTicking();
  }

  /**
   * Paint a stance slot's on/off state.
   *
   * A cooldown slot has exactly one persistent state — dark or ready — and the
   * bar infers it from `readyAt`. A stance has a second one that no cooldown
   * implies, so the scene tells us: `on` lights the border and adds a steady
   * glow, `off` returns it to the resting outline. Deliberately NOT `flash()`,
   * which is a 180 ms press blink and would say nothing about what is held.
   */
  setToggle(id: string, on: boolean): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const accent = KIND_ACCENT[slot.def.kind];
    slot.el.style.borderColor = on ? `${accent}ff` : `${accent}55`;
    // Held reads as LIT, not merely outlined: an outer bloom, an inner wash,
    // and a brightened face. A stance has no cooldown sweep to show its state,
    // so this glow is the only thing on the button that says "on".
    slot.el.style.boxShadow = on
      ? `0 0 26px ${accent}aa, 0 0 10px ${accent}ff, inset 0 0 16px ${accent}55`
      : "none";
    slot.el.style.filter = on ? "brightness(1.35) saturate(1.2)" : "";
  }

  /**
   * Update the beat readout, e.g. ("Superego", 1.5).
   *
   * `payoffNext` drives doc 02's telegraph: beat 3 is announced one beat early so
   * the player can line a skill up with it (+25%). On the bar that is a text
   * cue; on the touch layout the basic button itself lights up, because a phone
   * player is looking at their thumb, not at a readout across the screen.
   */
  setBeat(name: string, multiplier: number, payoffNext = false): void {
    this.beatEl.textContent = `${name} ×${multiplier}${payoffNext ? " · payoff next" : ""}`;

    // The desktop basic-attack slot wears the stance name ("Id Attack", "Ego
    // Attack", ...) so the LMB button always says what a click will hit with.
    // With the beat pill gone, the slot also carries doc 02's payoff telegraph
    // on this layout: a gold border while the next beat is the payoff — the
    // same cue the touch corner button gets as a glow. (flash() only touches
    // box-shadow, so the border survives casts.)
    for (const s of this.slots.values()) {
      if (s.def.kind !== "basic") continue;
      // A flat basic owns none of this: no stance name to write, and no payoff
      // border, because the beat it would be telegraphing does not apply to it.
      // The pill mounted in buildBar carries the cue for the skills instead.
      if (s.def.flat) continue;
      // Desktop only: the touch basic slot's labelEl is the corner button's
      // name div, handled by the basicEl block below (as before).
      if (this.layout !== "touch" && s.labelEl.children.length === 2) {
        const [nameEl, subEl] = s.labelEl.children as unknown as HTMLDivElement[];
        nameEl.textContent = name;
        subEl.textContent = `Attack ×${multiplier}`;
        fitLabel(nameEl, s.labelEl.clientWidth - 8);
      }
      s.el.style.borderColor = payoffNext ? `${KIND_ACCENT.chain}cc` : `${BASIC_ACCENT}55`;
    }

    const el = this.basicEl;
    if (!el || this.flatBasic) return;
    const [nameEl, multEl] = el.children as unknown as HTMLDivElement[];
    nameEl.textContent = name;
    fitLabel(nameEl, el.clientWidth - 14);
    multEl.textContent = `×${multiplier}`;
    const accent = payoffNext ? KIND_ACCENT.chain : BASIC_ACCENT;
    el.style.borderColor = `${accent}bb`;
    el.style.boxShadow = `0 0 ${payoffNext ? 26 : 16}px ${accent}${payoffNext ? "88" : "33"}`;
  }

  private ensureTicking(): void {
    if (this.rafId) return;
    const tick = () => {
      const now = performance.now();
      let active = false;
      const gcdRemaining = Math.max(0, this.gcdReadyAt - now);
      if (gcdRemaining > 0) active = true;
      for (const s of this.slots.values()) {
        const slotRemaining = s.readyAt - now;
        // The overlay tracks whichever holds the slot dark longer: its own
        // cooldown, or the shared GCD sweeping every button at once. The basic
        // attack is exempt from the GCD, so it only ever shows its own CD.
        const gcdApplies = s.def.kind !== "basic" && s.def.kind !== "stance";
        const onGcd = gcdApplies && gcdRemaining > slotRemaining;
        const remaining = Math.max(slotRemaining, gcdApplies ? gcdRemaining : 0);
        if (remaining <= 0) {
          s.cdOverlay.style.display = "none";
          s.cdText.style.display = "none";
          continue;
        }
        active = true;
        const denom = onGcd ? this.gcdMs : s.def.cooldownMs;
        const frac = remaining / denom;
        // Conic "clock wipe", WoW-style: covered part darkens, sweeps clear.
        s.cdOverlay.style.display = "block";
        s.cdText.style.display = "grid";
        s.cdOverlay.style.background = `conic-gradient(transparent ${(1 - frac) * 360}deg, rgba(2,4,8,.78) 0deg)`;
        s.cdText.textContent = remaining > 9_800 ? `${Math.ceil(remaining / 1000)}` : (remaining / 1000).toFixed(1);
      }
      this.rafId = active ? requestAnimationFrame(tick) : 0;
    };
    this.rafId = requestAnimationFrame(tick);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("pointerdown", this.outsideHandler, true);
    this.stopBasicHold();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    // The bubble lives on <body>, not inside the bar, so it has to be taken
    // down by hand or it survives the scene that opened it. Same for the beat
    // pill when a flat basic put it there — leaving it behind strands a
    // readout for a hero the next scene may not even be running.
    this.tip.dispose();
    this.captionEl?.remove();
    this.beatEl.remove();
    this.root.remove();
  }
}

/** Absolute placement from the cluster's bottom-right origin. */
function place(el: HTMLElement, at: { right: number; bottom: number }, size: number): void {
  el.style.right = `${at.right - size / 2}px`;
  el.style.bottom = `${at.bottom - size / 2}px`;
}

function divider(): HTMLDivElement {
  const d = document.createElement("div");
  d.style.cssText = "width:1px;height:40px;background:rgba(120,220,255,.25);margin:0 4px;align-self:center";
  return d;
}

/**
 * Largest font (≤ base) whose longest word still fits `width`, for the bar's
 * ui-monospace faces (glyphs ≈ 0.62em wide). Slot labels wrap at spaces
 * (white-space:pre-line), so the longest WORD is the widest unbreakable run —
 * shrinking to fit it lets multi-word names take extra rows instead of
 * clipping against the button edge. Char-count maths rather than scrollWidth
 * because the label isn't in the DOM yet when the slot is built.
 */
function fitFontPx(text: string, width: number, base: number): number {
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => w.length));
  return Math.max(6, Math.min(base, Math.floor(width / (0.62 * longest))));
}

/**
 * Scale a stance-name line down when it would overflow its button ("Superego"
 * at full size), so every stance renders as large as the face allows. The
 * transform is visual only — scrollWidth keeps reporting the layout width, so
 * repeated calls stay stable.
 */
function fitLabel(el: HTMLElement, maxWidth: number): void {
  const scale = Math.min(1, maxWidth / el.scrollWidth);
  el.style.transform = scale < 1 ? `scale(${scale.toFixed(3)})` : "";
}

/** Shrink on press. On touch this is the only "I registered that" signal. */function pressFeedback(el: HTMLElement): void {
  el.addEventListener("pointerdown", () => (el.style.transform = "scale(.94)"));
  el.addEventListener("pointerup", () => (el.style.transform = "scale(1)"));
  el.addEventListener("pointerleave", () => (el.style.transform = "scale(1)"));
  el.addEventListener("pointercancel", () => (el.style.transform = "scale(1)"));
}

/** Refused-cast feedback: a short red pulse, same shape as the cast flash. */
function denyFlash(el: HTMLElement): void {
  el.style.boxShadow = "0 0 18px #ff3b4dcc, inset 0 0 12px #ff3b4d66";
  setTimeout(() => {
    el.style.boxShadow = "0 0 10px #ff3b4d22, inset 0 1px 0 rgba(255,255,255,.06)";
  }, 180);
}

function flash(el: HTMLElement, accent: string): void {
  el.style.boxShadow = `0 0 18px ${accent}cc, inset 0 0 12px ${accent}66`;
  setTimeout(() => {
    el.style.boxShadow = `0 0 10px ${accent}22, inset 0 1px 0 rgba(255,255,255,.06)`;
  }, 180);
}
