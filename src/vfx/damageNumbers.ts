/**
 * Floating damage numbers — the classic MMO hit feedback.
 *
 * Plain DOM like the action bar, boss frame and speech bubble: crisp text at
 * any DPI, free alpha, zero draw calls. Each number is projected from its
 * world anchor every frame while it lives (the camera orbits — a spawn-time
 * projection would slide off the boss), floats up, and fades out. Crits get
 * a bigger font and a golden shine so they read at a glance.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Live anchor: called every frame while the number floats, so a number over a
 * walking monster walks with it. Return null once the target is gone — the
 * number then finishes where it last was.
 */
export type Follow = () => Vector3 | null;

export interface DamageNumbers {
  /**
   * Pop a number at a world position. `crit` renders larger + golden;
   * `kind: "heal"` renders green with a leading `+`.
   *
   * Healing is the same pipeline with the sign flipped (doc 08 §1), and it
   * still has to be told apart at a glance — a white 86 over your own head
   * reads as damage taken, which is the opposite of what happened.
   */
  spawn(world: Vector3, amount: number, crit?: boolean, kind?: "damage" | "heal" | "taken", follow?: Follow): void;
  /**
   * Pop a word instead of a number — Defense Mechanism procs ("Projection!").
   * Same pipeline and anchor as the damage ticks, but it lives ~3× longer, so
   * it drifts and fades slowly enough to be read as a name, not a hit.
   */
  spawnText(world: Vector3, text: string): void;
  /**
   * A DoT tick: the number plus the skill that opened the bleed. Same life as
   * a hit number — it IS a hit, it just needs its source named because the
   * cast that caused it happened a phase ago.
   */
  spawnDot(world: Vector3, amount: number, label: string, follow?: Follow): void;
  /**
   * A pickup's yield over the hero: "+120 HP" (green) or "+25 Focus" (blue).
   * Text, not a bare number, because two pools fill from the same orbs.
   */
  spawnGain(world: Vector3, text: string, kind: "heal" | "focus"): void;
  dispose(): void;
}

/** Seconds a number floats before it's removed. */
const LIFE = 0.95;
/** Seconds a proc name floats — slow enough to read. */
const TEXT_LIFE = 2.6;
/** Upward screen drift over the life, px. */
const RISE = 64;
/** Default cap on concurrent numbers — a spammy GCD rotation must not flood the DOM. */
const MAX_LIVE = 24;

interface LiveNumber {
  el: HTMLDivElement;
  anchor: Vector3;
  jitterX: number;
  age: number;
  /** Seconds this element lives — LIFE for numbers, TEXT_LIFE for proc names. */
  life: number;
  follow?: Follow;
  /** Extra screen-space lift, px (pickup gains stack instead of overlapping). */
  yOff?: number;
}

export function createDamageNumbers(scene: Scene, opts: { maxLive?: number } = {}): DamageNumbers {
  const maxLive = opts.maxLive ?? MAX_LIVE;
  const style = document.createElement("style");
  style.textContent = `
.psy-dmg {
  position: fixed; left: 0; top: 0; z-index: 30; pointer-events: none;
  transform: translate(-50%, -100%);
  font: 700 16px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #eaf7ff; text-shadow: 0 1px 2px #000, 0 0 6px rgba(64,230,255,.45);
  will-change: left, top, opacity;
}
.psy-dmg.crit {
  font-size: 27px; font-weight: 800; color: #ffd94a;
  text-shadow: 0 1px 2px #000, 0 0 10px rgba(255,217,74,.9), 0 0 26px rgba(255,160,40,.65);
  animation: psyDmgPop .22s ease-out;
}
.psy-dmg.heal {
  color: #7dfaa8; text-shadow: 0 1px 2px #000, 0 0 6px rgba(80,255,150,.5);
}
.psy-dmg.proc {
  font-size: 22px; font-weight: 800; letter-spacing: .06em; color: #d9b3ff;
  text-shadow: 0 1px 2px #000, 0 0 10px rgba(190,120,255,.85), 0 0 24px rgba(140,70,255,.55);
  animation: psyDmgPop .3s ease-out;
}
.psy-dmg.taken {
  color: #ff8f8f; text-shadow: 0 1px 2px #000, 0 0 8px rgba(255,90,90,.6);
}
.psy-dmg.dot {
  font-size: 14px; color: #d9b3ff;
  text-shadow: 0 1px 2px #000, 0 0 8px rgba(190,120,255,.7);
}
.psy-dmg.gain {
  font-size: 20px; font-weight: 800; color: #7dfaa8;
  text-shadow: 0 1px 2px #000, 0 0 8px rgba(80,255,150,.65);
  animation: psyDmgPop .25s ease-out;
}
.psy-dmg.gain.focus {
  color: #8fd8ff; text-shadow: 0 1px 2px #000, 0 0 8px rgba(70,170,255,.75);
}
@keyframes psyDmgPop {
  0% { scale: 1.6; }
  100% { scale: 1; }
}
`;
  document.head.appendChild(style);

  const live: LiveNumber[] = [];
  let lastGainAt = -1e9;
  let gainStack = 0;
  let rafId = 0;
  let lastT = 0;
  const identity = Matrix.Identity();

  const tick = (now: number): void => {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    const cam = scene.activeCamera;
    const engine = scene.getEngine();
    const canvas = engine.getRenderingCanvas();
    const rect = canvas?.getBoundingClientRect();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    if (cam && canvas && rect && w > 0 && h > 0) {
      scene.updateTransformMatrix();
      const transform = scene.getTransformMatrix();
      const viewport = cam.viewport.toGlobal(w, h);
      for (const n of live) {
        n.age += dt;
        const k = n.age / n.life;
        if (k >= 1) continue;
        if (n.follow) {
          const at = n.follow();
          if (at) n.anchor.copyFrom(at);
          else n.follow = undefined;
        }
        const p = Vector3.Project(n.anchor, identity, transform, viewport);
        if (p.z < 0 || p.z > 1) {
          n.el.style.opacity = "0";
          continue;
        }
        const x = rect.left + (p.x / w) * rect.width + n.jitterX;
        const y = rect.top + (p.y / h) * rect.height - k * RISE - (n.yOff ?? 0);
        n.el.style.left = `${x}px`;
        n.el.style.top = `${y}px`;
        n.el.style.opacity = k < 0.6 ? "1" : `${(1 - k) / 0.4}`;
      }
    }
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i]!.age >= live[i]!.life) {
        live[i]!.el.remove();
        live.splice(i, 1);
      }
    }
    rafId = live.length > 0 ? requestAnimationFrame(tick) : 0;
  };

  return {
    spawn(world, amount, crit = false, kind = "damage", follow) {
      if (amount <= 0) return;
      // Drop the oldest when saturated — newest feedback matters most.
      if (live.length >= maxLive) live.shift()?.el.remove();
      const el = document.createElement("div");
      el.className = `psy-dmg${crit ? " crit" : ""}${kind === "heal" ? " heal" : kind === "taken" ? " taken" : ""}`;
      const n = Math.round(amount);
      el.textContent = kind === "heal" ? `+${n}` : crit ? `${n}!` : `${n}`;
      el.style.opacity = "0";
      document.body.appendChild(el);
      live.push({
        el,
        anchor: world.clone(),
        jitterX: (Math.random() * 2 - 1) * 26,
        age: 0,
        life: LIFE,
        follow,
      });
      if (!rafId) {
        lastT = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    },
    spawnDot(world, amount, label, follow) {
      if (amount <= 0) return;
      if (live.length >= maxLive) live.shift()?.el.remove();
      const el = document.createElement("div");
      el.className = "psy-dmg dot";
      el.textContent = label ? `${Math.round(amount)} ${label}` : `${Math.round(amount)}`;
      el.style.opacity = "0";
      document.body.appendChild(el);
      live.push({
        el,
        anchor: world.clone(),
        jitterX: (Math.random() * 2 - 1) * 26,
        age: 0,
        life: LIFE,
        follow,
      });
      if (!rafId) {
        lastT = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    },
    spawnGain(world, text, kind) {
      if (live.length >= maxLive) live.shift()?.el.remove();
      const el = document.createElement("div");
      el.className = `psy-dmg gain${kind === "focus" ? " focus" : ""}`;
      el.textContent = text;
      el.style.opacity = "0";
      document.body.appendChild(el);
      // Two orbs collected together (HP + Focus) stack one line apart.
      const now = performance.now();
      gainStack = now - lastGainAt < 600 ? gainStack + 1 : 0;
      lastGainAt = now;
      live.push({ el, anchor: world.clone(), jitterX: 0, age: 0, life: LIFE * 1.6, yOff: gainStack * 24 });
      if (!rafId) {
        lastT = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    },
    spawnText(world, text) {
      if (!text) return;
      if (live.length >= maxLive) live.shift()?.el.remove();
      const el = document.createElement("div");
      el.className = "psy-dmg proc";
      el.textContent = text;
      el.style.opacity = "0";
      document.body.appendChild(el);
      // No jitter — a name that spawns off-center reads as someone else's.
      live.push({ el, anchor: world.clone(), jitterX: 0, age: 0, life: TEXT_LIFE });
      if (!rafId) {
        lastT = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    },
    dispose() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      for (const n of live) n.el.remove();
      live.length = 0;
      style.remove();
    },
  };
}
