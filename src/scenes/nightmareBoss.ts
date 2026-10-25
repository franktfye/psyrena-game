import { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
// Tree-shaken shape builder for the foot-vortex discs (blackHolePortal rule:
// never rely on another module having pulled the builder in).
import "@babylonjs/core/Meshes/Builders/discBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";

import { PALETTE } from "../core/palette";
import { trackLoad } from "../core/loadProgress";
import { isMusicMuted, onMusicSettingsChange } from "../state/musicSettings";
import { fbm, sstep } from "../vfx/softSprites";
import { audioUrl } from "../core/audio";

/**
 * NIGHTMARE — Boss 5, the first implemented boss (docs/04-bosses.md).
 *
 * Asset canon (assets/work/nightmare/README.md, 2026-07-30):
 *  - `nightmare_idle.glb` — STATIC default-form model (no clips on purpose):
 *    the not-yet-activated boss, wrapped in the smoke particle shell.
 *  - `nightmare.glb` — the Mixamo-rigged fight body carrying ten packed clips
 *    (Angry, Death01, Dizzy, Melee_Hook, NinjaJump_Start, Sleeping,
 *    Swim_Idle_Loop, Sword_Regular_B, Two-hand, Zombie_Idle_Loop). Used by
 *    every fight phase except P2.
 *  - `doll_1.glb` … `doll_5.glb` — the P2 Shapeshift age-stage dolls
 *    (infant/toddler/child/teen/adult = Oral/Anal/Phallic/Latency/Genital
 *    answer key). Blender NLA exports: clips are named NlaTrack[.NNN]. A
 *    doll's clip set is chained in export order (doll_4's pair reversed —
 *    art direction) and plays at normal speed, looping inside its stage.
 *
 * Phase script is design canon (fixed order, fixed durations):
 *   P1 Onslaught 60 s → P2 Shapeshift 50 s (5 stages × 10 s) →
 *   P3 Fortress 60 s → P4 Terror 60 s → back to P1 (loop pending confirm).
 *
 * Clip↔phase mapping (the packed set vs the runbook's wishlist):
 *   P1: Zombie_Idle_Loop base; the sim's REAL single-target hits (FightHooks
 *       → strike(false)) each play one of the two melee swings
 *       [Melee_Hook, Sword_Regular_B], alternating — no decorative attack
 *       loop. While a swing runs the boss squares onto its victim (the hate
 *       target, via setCombatAnchors). The old 2 s internal timer survives
 *       only for uncontrolled lookdev runs.
 *   P3: Dizzy TWICE on entry (the P2 debuffs landing is what staggers it into
 *       turtling), then Swim_Idle_Loop — floating inside the pink heal bubble
 *       with rising motes: armored, not attacking, visibly self-healing.
 *   P4: Zombie_Idle_Loop base; each raid-wide AOE tick (strike(true)) is a
 *       Two-hand Blast with the expanding ring plus lightning bolts from the
 *       boss's chest to every living hero — it's an AOE, the bolts say so.
 *       The boss tracks the highest-hate hero continuously all phase.
 *   Death01 on kill (lookdev auto-defeats after LOOKDEV_KILL_AFTER_CYCLES full
 *   scripts; server HP will replace that later). Angry, Sleeping and
 *   NinjaJump_Start are spare (phase-transition candidates).
 *
 * Voice: `public/assets/bosses/voice/*.mp3` (assets/work/nightmare/voice).
 * Activate, phase entries, P2 age-stage lines, P3 defense-mechanism fun barks,
 * and the defeat line. A translucent DOM speech bubble tracks the boss while a
 * line plays. Skills / debuff economy still TBD (doc: "skills later").
 *
 * OST: `public/assets/bosses/ost/*.mp3` (assets/work/nightmare/ost). The fight
 * rotates through the siege tracks (Heartbeat Siege 1/2, Siege to Sunrise 1/2)
 * for the whole encounter; on defeat the fight track fades out and Siege To
 * Triumph plays once.
 *
 * P2 Shapeshift: Babylon ParticleSystem ground cloud (embedded particles +
 * runtime soft-dot texture) rises from the floor and blankets the dolls, and
 * the doll grows continuously from DOLL_GROW_START× to DOLL_GROW_END× across
 * the phase — "Watch me grow" made literal.
 *
 * Ground dressing: dark floor puffs + a glowing ember fog pool under the boss
 * in EVERY state (idle shell included) except defeat, where both stop and
 * fade — the glow dies with the boss.
 *
 * Lookdev-paced: idles IDLE_SECS, engages, runs the phase script. Damage
 * numbers, HP and the debuff economy are server concerns and deliberately absent.
 */

const IDLE_SECS = 8;
const P1_SECS = 60;
const P2_SECS = 50; // 5 age stages × 10 s
const P3_SECS = 60;
const P4_SECS = 60;
const P2_STAGE_SECS = 10;

const P1_ATTACK_PERIOD = 2; // uncontrolled-lookdev drumbeat only (design table)
const P4_PULSE_PERIOD = 5; // uncontrolled-lookdev AOE fallback (design table)
/**
 * Fight-rig forward at yaw 0 is +Z — NOT Freud's -Z convention (calibrated by
 * screenshotting from both sides, 2026-08-01: with a +π offset the boss showed
 * the tank its back). atan2(dx, dz) with no offset squares the face onto the
 * aim point. Same trap class as FREUD_MODEL_YAW / QUEUE_BOARD_MODEL_YAW.
 */
const BOSS_MODEL_YAW = 0;
/** How fast the boss turns onto its aim point, rad/s (exponential ease). */
const BOSS_TURN_RATE = 6;
/** Full P1→P4 loops before lookdev auto-kill. Server HP will own this. */
const LOOKDEV_KILL_AFTER_CYCLES = 1;
/** P3 fortress: spacing between defense-mechanism fun barks. */
const DEFENSE_BARK_PERIOD = 12;
/** First P3 bark after the phase-entry line has room to finish. */
const DEFENSE_BARK_FIRST_AT = 10;

/** Fight body / idle shell target height, metres. Boss reads ~2.5× hero. */
const BOSS_HEIGHT = 4.5;
/** Doll stage height — big toy, not full boss bulk: the tonal whiplash IS the design. */
const DOLL_HEIGHT = 3.6;
/** Stage 2 (toddler) reads larger than the infant — still under boss bulk. */
const DOLL2_HEIGHT = 4.2;
/**
 * P2 growth arc — the shapeshift IS "Watch me grow": the doll starts small at
 * the top of the phase and swells to 3× by its end, riding phase progress
 * continuously (not stepped per stage). The smoke shell and cover cloud track
 * the same factor so the FX keep wrapping the body at every size.
 * (Was 5× — that read as bigger than the fight body and crowded the camera.)
 */
const DOLL_GROW_START = 1;
const DOLL_GROW_END = 3;

export type NightmarePhase = "idle" | "p1" | "p2" | "p3" | "p4" | "dead";

export interface NightmareBoss {
  tick(t: number, dt: number): void;
  /** Fires on every phase entry — lookdev uses it to tint the arena ring. */
  onPhase?: (phase: NightmarePhase, detail?: string) => void;
  /** HP-zero path. Lookdev also calls this after LOOKDEV_KILL_AFTER_CYCLES. */
  defeat(): void;
  /**
   * Hand the phase script to the fight sim (src/fight/bossFight.ts): the
   * internal clock stops advancing phases (and the lookdev auto-kill is
   * disabled); the sim drives transitions through `setPhase`. Per-phase
   * animation/VFX upkeep in `tick` keeps running either way.
   */
  setControlled(controlled: boolean, p2Timing?: { totalS: number; stageS: number }): void;
  /** Drive a phase transition from the fight sim. No-op once dead. */
  setPhase(phase: NightmarePhase): void;
  /**
   * Which P2 form to wear, 0-based; -1 hands the stage clock back to the
   * model's own phase timer.
   *
   * The offline fight has no stage clock — the model counts the dolls off and
   * the sim is TOLD which one is up (`notifyP2Stage`). A server-run fight
   * owns the phase, so the arrow reverses: the arena feeds `snap.p2Stage`
   * in here and the dolls follow the authority instead of racing it.
   */
  setP2Stage(stage: number): void;
  /**
   * World-space combat anchors from the arena glue. `aim` is the point the
   * boss squares onto — the highest-hate hero's chest (used while a P1 swing
   * runs, and continuously through P4). `heroes` are the chest points of
   * every living hero — the P4 lightning endpoints.
   */
  setCombatAnchors(anchors: { aim(): Vector3 | null; heroes(): Vector3[] }): void;
  /**
   * A REAL outgoing hit from the sim landed: false = single-target swing
   * (P1 hate-target hit), true = raid-wide AOE (P4 terror blast).
   */
  strike(all: boolean): void;
  /**
   * A ground fan (FightHooks.bossFan): `aim` = square onto that floor point
   * for the windup; null = it lands now — swing (or, wide, the two-hand blast)
   * and let go of the aim when the clip ends.
   */
  sweep(aim: Vector3 | null, wide?: boolean): void;
  /** Speak one pack line by stem (public/assets/bosses/voice/<stem>), cutting whatever plays. */
  speak(stem: string): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Voice — void/desire pack (assets/work/nightmare/voice, LINES.md)
// ---------------------------------------------------------------------------

const VOICE_BASE = "/assets/bosses/voice";

/** P2 doll index → age-stage line (Oral…Genital answer key). */
const STAGE_VOICE = [
  "stage_infant_oral",
  "stage_toddler_anal",
  "stage_child_phallic",
  "stage_teen_latency",
  "stage_adult_genital",
] as const;

/**
 * P2 doll index → "worst memory" pair — the laugh and the age line ("who you
 * were when you were N years old"). Each stage speaks ONE line drawn at
 * random from these two plus STAGE_VOICE, so any single playthrough hears a
 * different mix and the full set surfaces across runs.
 */
const STAGE_MEMORY_VOICE = [
  { laugh: "stage_infant_laugh", age: "stage_infant_age" },
  { laugh: "stage_toddler_laugh", age: "stage_toddler_age" },
  { laugh: "stage_child_laugh", age: "stage_child_age" },
  { laugh: "stage_teen_laugh", age: "stage_teen_age" },
  { laugh: "stage_adult_laugh", age: "stage_adult_age" },
] as const;

const PHASE_VOICE: Partial<Record<NightmarePhase, string>> = {
  p1: "phase_p1_onslaught",
  p2: "phase_p2_shapeshift",
  p3: "phase_p3_fortress",
  p4: "phase_p4_terror",
};

/** Fun barks — Freud's six defenses, rotated during P3 Fortress. */
const DEFENSE_VOICE = [
  "defense_repression",
  "defense_denial",
  "defense_projection",
  "defense_displacement",
  "defense_sublimation",
  "defense_regression",
] as const;

/** Caption text shown in the speech bubble while each line plays. */
const VOICE_CAPTION: Record<string, string> = {
  start_activate: "Ah… you opened the door. Good. I was starving.",
  end_defeated: "So this is waking… how rude. Sleep well without me.",
  phase_p1_onslaught: "One by one. Desire does not wait its turn.",
  phase_p2_shapeshift: "Watch me grow. Every age wants something different.",
  phase_p3_fortress: "I refuse. Denial wears better armor than steel.",
  phase_p4_terror: "Feel it. The pulse of every buried want.",
  stage_infant_oral: "Feed me. The void has a mouth.",
  stage_toddler_anal: "Mine. Not yours. Mine.",
  stage_child_phallic: "Look at me! I dare you to look away.",
  stage_teen_latency: "Quiet now… I'm studying how you break.",
  stage_adult_genital: "Whole at last. Now pay me what desire is owed.",
  stage_infant_laugh: "Hahahaha! Let me show you your worst memory.",
  stage_toddler_laugh: "Hahahaha! Let me show you your worst memory.",
  stage_child_laugh: "Hahahaha! Let me show you your worst memory.",
  stage_teen_laugh: "Hahahaha! Let me show you your worst memory.",
  stage_adult_laugh: "Hahahaha! Let me show you your worst memory.",
  stage_infant_age: "Let me show you who you were when you were one year old.",
  stage_toddler_age: "Let me show you who you were when you were three years old.",
  stage_child_age: "Let me show you who you were when you were six years old.",
  stage_teen_age: "Let me show you who you were when you were ten years old.",
  stage_adult_age: "Let me show you who you were when you were sixteen years old.",
  defense_repression: "What hit? I felt nothing. Nothing at all.",
  defense_denial: "That didn't happen. Your eyes are lying.",
  defense_projection: "You're the monster here. I merely reflect.",
  defense_displacement: "Not you. Them. Anger needs a smaller target.",
  defense_sublimation: "I turned my hunger into art. Admire the blast.",
  defense_regression: "Fine! Back to the crib. The void was happier small.",
};

interface BossVoice {
  /**
   * Play a line by file stem (no extension).
   * `interrupt` (default true) cuts whatever is mid-line and clears the queue;
   * false appends so activate can chain into the P1 phase line.
   */
  say(name: string, opts?: { interrupt?: boolean }): void;
  dispose(): void;
}

/** VO sits on top of the OST; 1.0 = full browser bus level. */
const VOICE_VOLUME = 1.0;

/**
 * One HTMLAudio element (same pattern as Freud's hub VO): no spatialisation,
 * cast/phase lines replace each other, autoplay rejection is swallowed until
 * the first user gesture unlocks audio.
 *
 * `onLine` / `onSilence` drive the speech bubble — shown for the active
 * caption, hidden when the queue drains.
 */
function createBossVoice(
  onLine: (id: string, caption: string) => void,
  onSilence: () => void
): BossVoice {
  const player = typeof Audio !== "undefined" ? new Audio() : null;
  if (player) player.volume = VOICE_VOLUME;
  const queue: string[] = [];
  let playing = false;
  let disposed = false;

  const playNext = (): void => {
    if (!player || disposed) return;
    const name = queue.shift();
    if (!name) {
      playing = false;
      onSilence();
      return;
    }
    playing = true;
    player.volume = VOICE_VOLUME;
    player.src = audioUrl(`${VOICE_BASE}/${name}`);
    const caption = VOICE_CAPTION[name] ?? name;
    onLine(name, caption);
    player.onended = () => playNext();
    void player.play().catch(() => {
      // Autoplay block or missing file — drop this line, try the next.
      if (!disposed) playNext();
    });
  };

  return {
    say(name: string, opts?: { interrupt?: boolean }): void {
      if (!player || disposed) return;
      const interrupt = opts?.interrupt !== false;
      if (interrupt) {
        queue.length = 0;
        player.onended = null;
        player.pause();
        playing = false;
      }
      queue.push(name);
      if (!playing) playNext();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (!player) {
        onSilence();
        return;
      }
      player.onended = null;
      try {
        player.volume = 0;
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch {
        /* ignore */
      }
      queue.length = 0;
      playing = false;
      onSilence();
    },
  };
}

// ---------------------------------------------------------------------------
// Speech bubble — translucent DOM caption over the boss (not Babylon GUI)
// ---------------------------------------------------------------------------

interface SpeechBubble {
  show(caption: string): void;
  hide(): void;
  /** Project the bubble onto the boss head each frame. */
  tick(): void;
  dispose(): void;
}

/**
 * Plain DOM bubble, same reasoning as the action bar / perf HUD: crisp text,
 * free alpha, zero render-target cost. World position is projected through the
 * active camera so it rides the boss (and the camera orbit) without a mesh.
 *
 * `getHeadWorld` must return a world-space point just above the current form's
 * head (fight body vs shorter dolls). Projection maps the engine framebuffer
 * into the canvas's CSS box — raw `getRenderWidth()` pixels are NOT CSS pixels
 * under hardware scaling, which is what pinned the bubble to screen-centre.
 */
function createSpeechBubble(scene: Scene, getHeadWorld: () => Vector3): SpeechBubble {
  const el = document.createElement("div");
  el.id = "nightmare-speech";
  el.setAttribute("aria-live", "polite");
  el.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    // Bottom-center of the bubble sits on the projected head point.
    "transform:translate(-50%,-100%)",
    "max-width:min(320px,72vw)",
    "padding:10px 14px 12px",
    "border-radius:14px",
    // Void panel: dark magenta-tinted glass
    "background:rgba(12,6,20,0.58)",
    "border:1px solid rgba(255,89,184,0.35)",
    "box-shadow:0 0 18px rgba(158,89,255,0.22), inset 0 0 12px rgba(64,230,255,0.06)",
    "color:rgba(232,244,255,0.92)",
    "font:600 13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif",
    "letter-spacing:0.02em",
    "text-align:center",
    "text-shadow:0 1px 2px rgba(0,0,0,0.55)",
    "pointer-events:none",
    "z-index:40",
    "opacity:0",
    "visibility:hidden",
    "transition:opacity 180ms ease",
    "backdrop-filter:blur(6px)",
    "-webkit-backdrop-filter:blur(6px)",
    "will-change:left,top,opacity",
  ].join(";");

  // Soft tail pointing at the boss
  const tail = document.createElement("div");
  tail.style.cssText = [
    "position:absolute",
    "left:50%",
    "bottom:-7px",
    "width:12px",
    "height:12px",
    "transform:translateX(-50%) rotate(45deg)",
    "background:rgba(12,6,20,0.58)",
    "border-right:1px solid rgba(255,89,184,0.35)",
    "border-bottom:1px solid rgba(255,89,184,0.35)",
  ].join(";");
  el.appendChild(tail);

  const text = document.createElement("div");
  text.style.cssText = "position:relative;z-index:1";
  el.appendChild(text);
  document.body.appendChild(el);

  let visible = false;
  const identity = Matrix.Identity();

  const project = (): boolean => {
    const cam = scene.activeCamera;
    const engine = scene.getEngine();
    const canvas = engine.getRenderingCanvas();
    if (!cam || !canvas) return false;

    // Keep view/projection current — otherwise Project can lag a frame or
    // read a stale matrix and pin the caption to the wrong place.
    scene.updateTransformMatrix();

    const engineW = engine.getRenderWidth();
    const engineH = engine.getRenderHeight();
    if (engineW <= 0 || engineH <= 0) return false;

    const world = getHeadWorld();
    const p = Vector3.Project(
      world,
      identity,
      scene.getTransformMatrix(),
      cam.viewport.toGlobal(engineW, engineH)
    );
    // Behind camera / outside clip — hide.
    if (p.z < 0 || p.z > 1) return false;

    // Framebuffer px → canvas CSS box (handles hardware scaling + letterbox).
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + (p.x / engineW) * rect.width;
    const y = rect.top + (p.y / engineH) * rect.height;

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    return true;
  };

  return {
    show(caption: string): void {
      text.textContent = caption;
      visible = true;
      el.style.visibility = "visible";
      // Force layout so the opacity transition always runs.
      void el.offsetWidth;
      if (project()) el.style.opacity = "1";
      else el.style.opacity = "0";
    },
    hide(): void {
      visible = false;
      el.style.opacity = "0";
      window.setTimeout(() => {
        if (!visible) el.style.visibility = "hidden";
      }, 200);
    },
    tick(): void {
      if (!visible) return;
      if (project()) el.style.opacity = "1";
      else el.style.opacity = "0";
    },
    dispose(): void {
      visible = false;
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// OST — fight music (assets/work/nightmare/ost)
// ---------------------------------------------------------------------------

const OST_BASE = "/assets/bosses/ost";
/** Siege tracks — every fight starts on the first and rotates in order. */
const OST_TRACKS = ["siege_loop_1", "siege_loop_2", "siege_sunrise_1", "siege_sunrise_2"] as const;
/** Played once on boss death, after the fight track fades out. */
const VICTORY_TRACK = "siege_triumph";
const VICTORY_FADE_S = 1.5;
/** Music sits under the VO lines (VO = 1.0). 0.35 = 35% of full bus. */
const OST_VOLUME = 0.35;

interface BossMusic {
  /** Fade the fight track out, then play the victory track once. */
  victory(): void;
  dispose(): void;
}

/**
 * Second HTMLAudio element, looping. Unlike the voice queue, a blocked
 * autoplay here would mean a silent fight forever — so a one-shot gesture
 * listener retries once the browser unlocks audio.
 *
 * Dispose is deliberately aggressive: mute → pause → drop src → load(). A
 * plain pause leaves the decoder hot; removeAttribute("src") alone can blip
 * on some browsers; and the unlock listeners must not outlive the scene or
 * a V/B scene-switch keydown restarts the fight OST for a frame after leave.
 */
function createBossMusic(): BossMusic {
  const player = typeof Audio !== "undefined" ? new Audio() : null;
  if (!player) return { victory: () => {}, dispose: () => {} };

  let disposed = false;
  // The fight OST is FIXED: the siege tracks in order, wrapping around, always
  // starting from the first — a System-tab track pick never follows the player
  // into the arena (the village player re-applies it on return). Only the mute
  // switch reaches in here.
  let trackIdx = 0;
  // Set once the boss dies: the rotation stands down and the ended listener
  // must not chain another siege loop after the victory track finishes.
  let victoryStarted = false;
  let fadeTimer: number | null = null;
  player.src = audioUrl(`${OST_BASE}/${OST_TRACKS[trackIdx]}`);
  player.loop = false;
  player.volume = OST_VOLUME;
  player.preload = "auto";

  const advance = (): void => {
    if (disposed || victoryStarted) return;
    trackIdx = (trackIdx + 1) % OST_TRACKS.length;
    player.src = audioUrl(`${OST_BASE}/${OST_TRACKS[trackIdx]}`);
    void player.play().catch(() => {});
  };
  player.addEventListener("ended", advance);

  player.muted = isMusicMuted();
  const unbindSettings = onMusicSettingsChange(() => {
    player.muted = isMusicMuted();
  });

  const unlock = (): void => {
    if (disposed) return;
    void player.play().catch(() => {});
  };
  void player.play().catch(() => {
    if (disposed) return;
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  });

  return {
    victory(): void {
      if (disposed || victoryStarted) return;
      victoryStarted = true;
      // Ramp the fight track down, then swap to the triumph sting at full OST
      // volume. Volume (not muted) so the mute switch stays independent.
      const startVol = player.volume;
      const stepMs = 50;
      const steps = Math.max(1, Math.round((VICTORY_FADE_S * 1000) / stepMs));
      let step = 0;
      fadeTimer = window.setInterval(() => {
        step++;
        player.volume = startVol * Math.max(0, 1 - step / steps);
        if (step < steps) return;
        if (fadeTimer !== null) window.clearInterval(fadeTimer);
        fadeTimer = null;
        if (disposed) return;
        player.src = audioUrl(`${OST_BASE}/${VICTORY_TRACK}`);
        player.loop = false;
        player.volume = OST_VOLUME;
        void player.play().catch(() => {});
      }, stepMs);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unbindSettings();
      if (fadeTimer !== null) {
        window.clearInterval(fadeTimer);
        fadeTimer = null;
      }
      player.removeEventListener("ended", advance);
      // Drop unlock first so the same key that switches scenes cannot re-play.
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      try {
        player.volume = 0;
        player.pause();
        player.removeAttribute("src");
        // Abort any in-flight decode / network; prevents a late canplay→sound.
        player.load();
      } catch {
        // Some browsers throw if load() races a dead element — ignore.
      }
    },
  };
}

interface LoadedModel {
  root: TransformNode;
  groups: AnimationGroup[];
}

/**
 * Load one boss glb, normalise its height and park it hidden at the origin.
 *
 * Scaling lives on the loader root (NOT baked into vertices as the village
 * props do): these meshes are skinned, and re-baking vertices under a skeleton
 * breaks the bind pose. Nothing here is instanced, so root scaling is safe.
 */
async function loadBossModel(
  scene: Scene,
  url: string,
  name: string,
  targetHeight: number,
  /**
   * Ember-lit self-illumination: the bake's own albedo re-emitted at this
   * tint. The arena is a void with two dim lights — a near-black smoke body
   * that only reflects is a silhouette at best (measured on the first
   * integration pass). Lighting the texture from within both fixes the read
   * and IS the concept: the thing is lit by its own ember, not by the room.
   */
  emissiveTint: Color3
): Promise<LoadedModel | null> {
  try {
    const result = await trackLoad(ImportMeshAsync(url, scene));
    const root = result.meshes[0] as TransformNode;
    root.name = name;

    for (const g of result.animationGroups) g.stop();

    for (const m of result.meshes) {
      const mat = m.material;
      if (mat instanceof PBRMaterial && mat.albedoTexture) {
        mat.emissiveTexture = mat.albedoTexture;
        mat.emissiveColor = emissiveTint.clone();
      }
    }

    const { min, max } = (root as AbstractMesh).getHierarchyBoundingVectors(true);
    const h = max.y - min.y || 1;
    const s = targetHeight / h;
    root.scaling.scaleInPlace(s);
    // Sole on the floor regardless of where the export put its origin.
    root.position.y = -min.y * s;

    root.setEnabled(false);
    return { root, groups: result.animationGroups };
  } catch (err) {
    console.warn(`[nightmare] failed to load ${url}:`, err);
    return null;
  }
}

/** Fisher-Yates on a copy — the caller's array is never reordered in place. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Case-insensitive clip lookup — merged Mixamo names are stable but be safe. */
function findClip(groups: AnimationGroup[], key: string): AnimationGroup | null {
  const k = key.toLowerCase();
  return groups.find((g) => g.name.toLowerCase().includes(k)) ?? null;
}

/**
 * Play a doll's clip set at NORMAL speed. A pass longer than the stage window
 * is simply cut by the next stage swap; a shorter pass loops (one clip loops
 * directly, a chained set wraps back to its first clip). The stage clock owns
 * the pacing, not the clips. Returns a stop().
 */
function playDollClips(groups: AnimationGroup[]): () => void {
  if (groups.length === 0) return () => {};
  if (groups.length === 1) {
    const g = groups[0];
    g.reset();
    g.play(true);
    g.speedRatio = 1;
    return () => g.stop();
  }
  let alive = true;
  let i = 0;
  const playNext = (): void => {
    if (!alive) return;
    const g = groups[i % groups.length];
    i++;
    g.reset();
    g.play(false);
    g.speedRatio = 1;
    g.onAnimationGroupEndObservable.addOnce(playNext);
  };
  playNext();
  return () => {
    alive = false;
    for (const g of groups) g.stop();
  };
}

/**
 * The living-smoke shell that wraps EVERY form (idle, fight body, dolls).
 * Ember-lit violet/magenta rather than literal black: additive particles on
 * the arena's void background are what actually read as "alive".
 */
function buildSmokeShell(scene: Scene, emitter: TransformNode): ParticleSystem {
  const anchor = MeshBuilder.CreateBox("nightmare_smokeAnchor", { size: 0.02 }, scene);
  anchor.parent = emitter;
  anchor.position.y = 1.4;
  anchor.isVisible = false;

  const ps = new ParticleSystem("nightmare_smoke", 220, scene);
  ps.particleTexture = createSoftDot(scene);
  ps.emitter = anchor;
  ps.minEmitBox = new Vector3(-1.3, -1.2, -1.3);
  ps.maxEmitBox = new Vector3(1.3, 1.6, 1.3);
  ps.color1 = new Color4(0.3, 0.06, 0.45, 0.55);
  ps.color2 = new Color4(0.8, 0.1, 0.55, 0.4);
  ps.colorDead = new Color4(0.08, 0.02, 0.14, 0);
  ps.minSize = 0.5;
  ps.maxSize = 1.6;
  ps.minLifeTime = 1.1;
  ps.maxLifeTime = 2.4;
  ps.emitRate = 70;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.gravity = new Vector3(0, 0.5, 0);
  ps.direction1 = new Vector3(-0.25, 0.15, -0.25);
  ps.direction2 = new Vector3(0.25, 0.6, 0.25);
  ps.minAngularSpeed = -0.8;
  ps.maxAngularSpeed = 0.8;
  ps.start();
  return ps;
}

/**
 * Persistent ground smoke — slow dark puffs that keep popping up from the
 * floor around the boss's feet, every phase. Much thinner than the P2 cover
 * cloud (this is set dressing, not an occluder): low emit rate, STANDARD
 * blend so it reads as smoke rather than glow.
 */
function buildGroundSmoke(scene: Scene, emitter: TransformNode): ParticleSystem {
  const anchor = MeshBuilder.CreateBox("nightmare_groundSmokeAnchor", { size: 0.02 }, scene);
  anchor.parent = emitter;
  anchor.position.y = 0.05;
  anchor.isVisible = false;

  // Steady state ≈ emitRate × avgLife ≈ 55 × 3.5 ≈ 190 particles.
  const ps = new ParticleSystem("nightmare_groundSmoke", 320, scene);
  ps.particleTexture = createSoftDot(scene);
  ps.emitter = anchor;
  // Tight collar around the ankles (2026-08-06): the old ±1.8 m ring read as
  // a room-wide fog bank. The column is narrow at source and stays narrow —
  // spread comes from the small lateral drift below, not the emit box.
  ps.minEmitBox = new Vector3(-0.9, 0.0, -0.9);
  ps.maxEmitBox = new Vector3(0.9, 0.2, 0.9);
  ps.color1 = new Color4(0.16, 0.05, 0.22, 0.65);
  ps.color2 = new Color4(0.34, 0.08, 0.28, 0.55);
  ps.colorDead = new Color4(0.05, 0.02, 0.09, 0);
  ps.minSize = 0.9;
  ps.maxSize = 2.0;
  ps.minLifeTime = 2.6;
  ps.maxLifeTime = 4.4;
  ps.emitRate = 55;
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  // Rising smoke, not drifting fog: accelerate upward the whole life, keep
  // the sideways component near zero so the column climbs the legs.
  ps.gravity = new Vector3(0, 0.7, 0);
  ps.direction1 = new Vector3(-0.08, 0.9, -0.08);
  ps.direction2 = new Vector3(0.08, 2.0, 0.08);
  ps.minEmitPower = 0.25;
  ps.maxEmitPower = 0.7;
  ps.minAngularSpeed = -0.6;
  ps.maxAngularSpeed = 0.6;
  ps.start();
  return ps;
}

/**
 * Glowing ground fog — ember-lit additive haze pooling at the boss's feet,
 * paired with the darker groundSmoke: the smoke gives body, this gives light.
 * Runs in every state (idle shell, all fight phases) EXCEPT defeat — the glow
 * dying with the boss is the point, so enter("dead") stops both ground systems
 * and the residue fades out on its own lifetimes.
 */
function buildGroundGlowFog(scene: Scene, emitter: TransformNode): ParticleSystem {
  const anchor = MeshBuilder.CreateBox("nightmare_groundGlowAnchor", { size: 0.02 }, scene);
  anchor.parent = emitter;
  anchor.position.y = 0.05;
  anchor.isVisible = false;

  // Steady state ≈ emitRate × avgLife ≈ 95 × 3 ≈ 285 particles.
  const ps = new ParticleSystem("nightmare_groundGlowFog", 480, scene);
  ps.particleTexture = createSoftDot(scene);
  ps.emitter = anchor;
  // Tight ember column (2026-08-06): the ±3.2 m pool covered a third of the
  // fight disc and read as arena weather, not the boss's own aura. The
  // footprint now hugs the body — brightness lost to the smaller area comes
  // back from the higher per-particle alpha, so it still beats the lit
  // mandala at gameplay distance without owning the floor.
  // Ring shell, not a filled pool: the embers rise from a collar around the
  // body and the dead centre stays clear — that centre belongs to the black
  // foot vortex, and a filled additive emit box was whiting it out.
  ps.createDirectedCylinderEmitter(
    1.15,
    0.25,
    0,
    new Vector3(-0.08, 0.6, -0.08),
    new Vector3(0.08, 1.4, 0.08)
  );
  // Ember magenta → violet, ADD blend: reads as light on the void floor.
  // Alphas stay at the wide-pool values — the tighter footprint already
  // doubles the overlap per pixel, and higher clipped the base to white.
  ps.color1 = new Color4(0.85, 0.18, 0.72, 0.6);
  ps.color2 = new Color4(0.48, 0.16, 0.9, 0.45);
  ps.colorDead = new Color4(0.05, 0.02, 0.1, 0);
  ps.minSize = 1.1;
  ps.maxSize = 2.2;
  ps.minLifeTime = 2.2;
  ps.maxLifeTime = 3.8;
  ps.emitRate = 95;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  // Rising smoke: the embers climb straight up the body and keep coming —
  // upward acceleration all life, near-zero lateral drift.
  ps.gravity = new Vector3(0, 0.55, 0);
  ps.minEmitPower = 0.2;
  ps.maxEmitPower = 0.5;
  ps.minAngularSpeed = -0.5;
  ps.maxAngularSpeed = 0.5;
  ps.start();
  return ps;
}

/**
 * 256² spiral-arm sprite for the foot vortex — white arms on transparent, so
 * the material tints it. Arms curl by `twist` radians over the radius, carry a
 * little fbm break-up, and both the eye (centre) and the rim fade to nothing —
 * same "no radius at which it ends" rule as the soft ring bakes.
 */
function createSpiralTexture(
  scene: Scene,
  name: string,
  arms: number,
  twist: number
): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 centre → 1 edge
      const ang = Math.atan2(dy, dx);
      // Arm wave, sharpened so the streaks read as ribbons, not a moiré.
      const wave = 0.5 + 0.5 * Math.sin(arms * ang + twist * r);
      let a = Math.pow(wave, 3);
      a *= 0.75 + 0.25 * fbm(dx * 6 + 3.1, dy * 6 - 7.7);
      a *= sstep(0.08, 0.3, r); // dark eye — the hole stays a hole
      a *= 1 - sstep(0.7, 0.98, r); // rim feather
      const v = Math.round(255 * Math.min(1, a));
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.hasAlpha = true;
  tex.update(true);
  return tex;
}

interface FootVortex {
  /** Per-frame spin/pulse. Call with scene time; cheap (rotations only). */
  tick(t: number, dt: number): void;
  /** Death: fade the vortex out over ~1.5 s, then disable it. */
  die(): void;
  dispose(): void;
}

/**
 * The moving black vortex under the boss's feet — the standing spot itself is
 * void. Three flat discs on the floor: an opaque-black soft blob (the hole),
 * and two counter-rotating spiral-arm layers tinted void-violet, all sized to
 * the body's footprint so they sit inside the tightened ground fog. Each
 * layer hangs off its own Y-spinner node so the spin is about the disc
 * normal; depth write stays off (the floor already wrote depth) and the
 * alphaIndex ladder keeps hole → arms ordering stable over the mandala.
 */
function buildFootVortex(scene: Scene, emitter: TransformNode): FootVortex {
  const root = new TransformNode("nightmare_vortex", scene);
  root.parent = emitter;

  const layers: { spin: TransformNode; mat: StandardMaterial; speed: number; baseAlpha: number }[] =
    [];
  const layer = (
    name: string,
    radius: number,
    y: number,
    tex: DynamicTexture,
    emissive: Color3,
    alpha: number,
    speed: number,
    alphaIndex: number
  ): void => {
    const spin = new TransformNode(`${name}Spin`, scene);
    spin.parent = root;
    spin.position.y = y;
    const mesh = MeshBuilder.CreateDisc(
      name,
      { radius, tessellation: 48, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    mesh.parent = spin;
    mesh.rotation.x = Math.PI / 2;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    const mat = new StandardMaterial(`${name}Mat`, scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    // Colour comes from emissiveColor ALONE; the bake drives only opacity.
    // (StandardMaterial ADDS the emissive texture to the emissive colour, so
    // a white-on-transparent bake as emissiveTexture turned the black hole
    // into a white-hot disc — the softSprites discs get away with it because
    // they WANT to glow.)
    mat.emissiveColor = emissive.clone();
    mat.opacityTexture = tex;
    mat.alpha = alpha;
    mat.disableDepthWrite = true;
    mesh.material = mat;
    mesh.alphaIndex = alphaIndex;
    layers.push({ spin, mat, speed, baseAlpha: alpha });
  };

  // The hole: a soft black blob. Emissive black + STANDARD blend actually
  // DARKENS the lit mandala under the boss, which is what sells "pit".
  layer("nightmare_vortexHole", 1.7, 0.02, createSoftDot(scene), Color3.Black(), 0.92, 0.15, 1);
  // Spiral arms: BLACK, like the hole — the vortex is swirling darkness, and
  // the motion reads as the rotating alpha pattern eating the floor light.
  // (First pass used violet emissive ribbons; over the lit mandala + arena
  // grading they rendered as white-hot swirls — the opposite of a black
  // vortex.) Counter-rotating at unequal speeds so the pattern never settles
  // into a static mandala of its own.
  layer(
    "nightmare_vortexArms",
    1.9,
    0.05,
    createSpiralTexture(scene, "nightmare_vortexArmsTex", 3, 7),
    Color3.Black(),
    0.85,
    -0.9,
    2
  );
  // The one lit accent: a faint violet shimmer riding the inner arms, dim
  // enough to read as sheen on the darkness rather than a light source.
  layer(
    "nightmare_vortexArms2",
    1.45,
    0.08,
    createSpiralTexture(scene, "nightmare_vortexArms2Tex", 4, -9),
    new Color3(0.3, 0.1, 0.42),
    0.55,
    1.4,
    3
  );

  let dying = false;
  return {
    tick(t: number, dt: number): void {
      for (const l of layers) l.spin.rotation.y += l.speed * dt;
      // Slow breath on the footprint — "moving", not just rotating.
      const k = 1 + Math.sin(t * 0.8) * 0.05;
      root.scaling.set(k, 1, k);
      if (dying) {
        let live = false;
        for (const l of layers) {
          l.mat.alpha = Math.max(0, l.mat.alpha - dt * (l.baseAlpha / 1.5));
          if (l.mat.alpha > 0) live = true;
        }
        if (!live) root.setEnabled(false);
      }
    },
    die(): void {
      dying = true;
    },
    dispose(): void {
      for (const l of layers) l.mat.dispose();
      root.dispose();
    },
  };
}

/**
 * P2 Shapeshift cover — heavy void cloud rising from the floor, built with
 * Babylon's embedded ParticleSystem (no external VFX assets). STANDARD blend
 * + large soft particles actually *occlude* the doll swaps; the ambient shell
 * stays additive and thin so it doesn't do that job on its own.
 *
 * Tuned as a *continuous column* for the full P2 window (50 s / 5 stages), not
 * a one-shot burst: long lifetimes, gentle rise, capacity ≥ emitRate × life.
 * Starts stopped; `enter("p2")` turns it on and keeps it emitting until leave.
 */
function buildShapeshiftCloud(scene: Scene, emitter: TransformNode): ParticleSystem {
  const anchor = MeshBuilder.CreateBox("nightmare_shiftCloudAnchor", { size: 0.02 }, scene);
  anchor.parent = emitter;
  // Floor-level source: smoke rises up the body instead of spawning mid-torso.
  anchor.position.y = 0.05;
  anchor.isVisible = false;

  // Steady-state headcount ≈ emitRate × avgLife ≈ 200 × 5.5 ≈ 1100 at base;
  // the growth arc raises emitRate up to ~1.8× (see growFx), so capacity must
  // clear ≈ 360 × 5.5 ≈ 1980 or the system starves and the cloud thins late-P2.
  const ps = new ParticleSystem("nightmare_shiftCloud", 2100, scene);
  // Reuse the same soft-dot generator — one small DynamicTexture is fine.
  ps.particleTexture = createSoftDot(scene);
  ps.emitter = anchor;
  // Wide ground disc under the boss — continuous feed for the whole stage.
  ps.minEmitBox = new Vector3(-2.5, 0.0, -2.5);
  ps.maxEmitBox = new Vector3(2.5, 0.45, 2.5);
  // Dark void plum with a magenta rim so it still reads on the arena void.
  ps.color1 = new Color4(0.12, 0.03, 0.18, 0.82);
  ps.color2 = new Color4(0.45, 0.06, 0.32, 0.62);
  ps.colorDead = new Color4(0.04, 0.01, 0.08, 0);
  ps.minSize = 1.6;
  ps.maxSize = 3.8;
  // Long enough to hang around the body the full stage, not pop out after 2 s.
  ps.minLifeTime = 4.0;
  ps.maxLifeTime = 7.0;
  // Continuous emit for the entire P2 — not burst-only.
  ps.emitRate = 200;
  // STANDARD = real cover; ADD would glow through the dolls.
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  // Gentle rise: fills a column around the boss instead of rocketing off-screen.
  ps.gravity = new Vector3(0, 0.45, 0);
  ps.direction1 = new Vector3(-0.4, 0.7, -0.4);
  ps.direction2 = new Vector3(0.4, 2.0, 0.4);
  ps.minEmitPower = 0.25;
  ps.maxEmitPower = 0.85;
  ps.minAngularSpeed = -0.9;
  ps.maxAngularSpeed = 0.9;
  // Default sim rate — 0.02 was double-speed aging and thinned the cloud early.
  ps.updateSpeed = 0.01;
  // Don't dispose particles on stop — just halt emission so leave-P2 can fade.
  ps.disposeOnStop = false;
  // Off until Shapeshift — don't pay the cost (or fill the frame) in P1/P3/P4.
  ps.stop();
  return ps;
}

/**
 * P3 self-heal motes — soft pink sparks drifting up inside the heal bubble.
 * The bubble alone read as armor (its old P3 job); the rising motes are what
 * say "recovering". ADD blend, tiny, cheap (~50 live particles). Started only
 * in P3.
 */
function buildHealMotes(scene: Scene, emitter: TransformNode): ParticleSystem {
  const anchor = MeshBuilder.CreateBox("nightmare_healAnchor", { size: 0.02 }, scene);
  anchor.parent = emitter;
  anchor.position.y = 0.5;
  anchor.isVisible = false;

  const ps = new ParticleSystem("nightmare_healMotes", 90, scene);
  ps.particleTexture = createSoftDot(scene);
  ps.emitter = anchor;
  // Inside the bubble's footprint, floor-ish, rising through the body.
  ps.minEmitBox = new Vector3(-1.9, 0, -1.9);
  ps.maxEmitBox = new Vector3(1.9, 0.6, 1.9);
  ps.color1 = new Color4(1.0, 0.55, 0.85, 0.85);
  ps.color2 = new Color4(1.0, 0.35, 0.7, 0.65);
  ps.colorDead = new Color4(0.4, 0.1, 0.3, 0);
  ps.minSize = 0.09;
  ps.maxSize = 0.24;
  ps.minLifeTime = 1.2;
  ps.maxLifeTime = 2.2;
  ps.emitRate = 30;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.gravity = new Vector3(0, 1.0, 0);
  ps.direction1 = new Vector3(-0.15, 0.6, -0.15);
  ps.direction2 = new Vector3(0.15, 1.4, 0.15);
  ps.minEmitPower = 0.2;
  ps.maxEmitPower = 0.6;
  ps.disposeOnStop = false;
  ps.stop();
  return ps;
}

// ---------------------------------------------------------------------------
// P4 Terror lightning — boss→hero AOE bolts
// ---------------------------------------------------------------------------

interface Lightning {
  /** Snap a volley of bolts from the boss's chest to these world points. */
  fire(targets: Vector3[]): void;
  tick(dt: number): void;
  /** Drop the live volley immediately (phase change, death). */
  clear(): void;
  dispose(): void;
}

/** Seconds a volley stays up — doubled with the slowed Two-hand Blast. */
const BOLT_LIFE = 1.2;
/** Points per bolt path; jitter at every interior point is the lightning. */
const BOLT_SEGS = 11;

/**
 * One jagged emissive tube per living hero on each P4 AOE tick. The expanding
 * ring says "map-wide"; the bolts say "each of YOU, specifically" — the raid
 * blast is the only attack that hits heroes the boss isn't even facing, so it
 * gets an explicit boss→hero connection. Paths re-jitter every frame while
 * live (that flicker IS the lightning read) and the volley fades over
 * BOLT_LIFE. Tube update goes through CreateTube's `instance` path, so no
 * per-frame mesh allocation — only the once-per-5 s volley rebuild allocates.
 */
function buildLightning(scene: Scene, source: () => Vector3): Lightning {
  const mat = new StandardMaterial("nightmare_boltMat", scene);
  mat.disableLighting = true;
  // Void-pink discharge — reads against both the warn ring and the violet fog.
  mat.emissiveColor = new Color3(1.0, 0.5, 0.95);
  mat.alpha = 0.85;

  let bolts: { mesh: Mesh; to: Vector3 }[] = [];
  let age = -1; // <0 = no live volley

  const jitteredPath = (from: Vector3, to: Vector3): Vector3[] => {
    const pts: Vector3[] = [];
    const span = from.subtract(to).length();
    for (let i = 0; i < BOLT_SEGS; i++) {
      const t = i / (BOLT_SEGS - 1);
      const p = Vector3.Lerp(from, to, t);
      // Zero jitter at both anchors, max mid-span, scaled by span length.
      const j = Math.sin(Math.PI * t) * span * 0.05;
      p.x += (Math.random() * 2 - 1) * j;
      p.y += (Math.random() * 2 - 1) * j;
      p.z += (Math.random() * 2 - 1) * j;
      pts.push(p);
    }
    return pts;
  };

  const clear = (): void => {
    for (const b of bolts) b.mesh.dispose();
    bolts = [];
    age = -1;
  };

  return {
    fire(targets: Vector3[]): void {
      clear();
      if (targets.length === 0) return;
      const from = source();
      bolts = targets.map((to, i) => {
        const mesh = MeshBuilder.CreateTube(
          `nightmare_bolt${i}`,
          { path: jitteredPath(from, to), radius: 0.07, tessellation: 5, updatable: true },
          scene
        );
        mesh.material = mat;
        return { mesh, to: to.clone() };
      });
      mat.alpha = 0.85;
      age = 0;
    },
    tick(dt: number): void {
      if (age < 0) return;
      age += dt;
      const k = age / BOLT_LIFE;
      if (k >= 1) {
        clear();
        return;
      }
      const from = source();
      for (const b of bolts) {
        MeshBuilder.CreateTube(
          b.mesh.name,
          { path: jitteredPath(from, b.to), radius: 0.07, instance: b.mesh },
          scene
        );
      }
      mat.alpha = 0.85 * (1 - k);
    },
    clear,
    dispose(): void {
      clear();
      mat.dispose();
    },
  };
}

/** 64² radial soft dot, generated at runtime — same rationale as Freud's. */
function createSoftDot(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("nightmareDot", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * Build the boss. Returns null when the asset set is absent so the arena can
 * keep its sphere stand-in — same degrade contract as every other loader.
 */
export async function buildNightmare(
  scene: Scene,
  arenaExtent: number
): Promise<NightmareBoss | null> {
  // One HEAD probe gates the whole set (brick-set precedent in villageHub).
  if (typeof fetch === "function") {
    try {
      const res = await fetch("/assets/bosses/nightmare.glb", { method: "HEAD" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.info("[nightmare] boss set unavailable, keeping stand-in:", err);
      return null;
    }
  }

  // Smoke forms glow ember-violet from within; dolls get a soft neutral lift
  // so their toy-line colours survive the void instead of turning purple.
  const emberGlow = new Color3(0.4, 0.12, 0.34);
  // Keep the dolls BELOW the bloom threshold: at 0.3 the pale infant clipped
  // to a featureless white blob; 0.15 lifts it out of the void and no more.
  const dollGlow = new Color3(0.15, 0.14, 0.16);
  const [fight, idle, ...dolls] = await Promise.all([
    loadBossModel(scene, "/assets/bosses/nightmare.glb", "nightmare_fight", BOSS_HEIGHT, emberGlow),
    loadBossModel(scene, "/assets/bosses/nightmare_idle.glb", "nightmare_idle", BOSS_HEIGHT, emberGlow),
    loadBossModel(scene, "/assets/bosses/doll_1.glb", "nightmare_doll1", DOLL_HEIGHT, dollGlow),
    loadBossModel(scene, "/assets/bosses/doll_2.glb", "nightmare_doll2", DOLL2_HEIGHT, dollGlow),
    loadBossModel(scene, "/assets/bosses/doll_3.glb", "nightmare_doll3", DOLL_HEIGHT, dollGlow),
    loadBossModel(scene, "/assets/bosses/doll_4.glb", "nightmare_doll4", DOLL_HEIGHT, dollGlow),
    loadBossModel(scene, "/assets/bosses/doll_5.glb", "nightmare_doll5", DOLL_HEIGHT, dollGlow),
  ]);
  if (!fight) return null;

  // doll_4 (Latency): its two NLA clips export in the wrong order — play the
  // sequence reversed (art direction, 2026-08-01).
  dolls[3]?.groups.reverse();

  // Facing rig: the fight body hangs off a yaw node so P1 swings and the whole
  // of P4 can square the boss onto its hate target. The loader root keeps its
  // own scale/soling transform; only this wrapper ever turns.
  const fightYaw = new TransformNode("nightmare_fightYaw", scene);
  fight.root.parent = fightYaw;

  // ---- Shared dressing ---------------------------------------------------
  // Root the smoke/ember on their own node so they survive model swaps.
  const centre = new TransformNode("nightmare_root", scene);
  const smoke = buildSmokeShell(scene, centre);
  // Always-on floor puffs at the boss's feet.
  const groundSmoke = buildGroundSmoke(scene, centre);
  // Glowing floor haze under the boss — every state except defeat.
  const glowFog = buildGroundGlowFog(scene, centre);
  // The black vortex the boss stands on — every state; fades out on defeat.
  const vortex = buildFootVortex(scene, centre);
  // P2-only heavy floor cloud — Babylon ParticleSystem, not a mesh effect.
  const shiftCloud = buildShapeshiftCloud(scene, centre);

  // ---- P2 growth bookkeeping --------------------------------------------
  // Doll roots carry their height-normalising scale from loadBossModel; the
  // growth factor multiplies ON TOP of that base, so record it (plus the
  // floor-soling y offset, which scales linearly with uniform root scale).
  const dollBases = dolls.map((d) =>
    d ? { scale: d.root.scaling.clone(), y: d.root.position.y } : null
  );
  // Smoke shell / cover cloud base tuning, so growFx can scale and restore.
  const smokeBase = {
    anchorY: (smoke.emitter as AbstractMesh).position.y,
    min: smoke.minEmitBox.clone(),
    max: smoke.maxEmitBox.clone(),
    minSize: smoke.minSize,
    maxSize: smoke.maxSize,
  };
  const cloudBase = {
    min: shiftCloud.minEmitBox.clone(),
    max: shiftCloud.maxEmitBox.clone(),
    minSize: shiftCloud.minSize,
    maxSize: shiftCloud.maxSize,
    emitRate: shiftCloud.emitRate,
  };
  /**
   * Scale the wrap FX with the doll's growth factor. Emit boxes track k fully
   * (the smoke must still WRAP the body); particle sizes and the cloud's
   * emitRate track it at half/fifth slope — full-k sizes ate the frame in
   * overdraw, and emitRate is capacity-bound (see buildShapeshiftCloud).
   */
  const growFx = (k: number): void => {
    const sizeK = 1 + (k - 1) * 0.5;
    (smoke.emitter as AbstractMesh).position.y = smokeBase.anchorY * k;
    smoke.minEmitBox.copyFrom(smokeBase.min).scaleInPlace(k);
    smoke.maxEmitBox.copyFrom(smokeBase.max).scaleInPlace(k);
    smoke.minSize = smokeBase.minSize * sizeK;
    smoke.maxSize = smokeBase.maxSize * sizeK;
    shiftCloud.minEmitBox.copyFrom(cloudBase.min).scaleInPlace(k);
    shiftCloud.maxEmitBox.copyFrom(cloudBase.max).scaleInPlace(k);
    shiftCloud.minSize = cloudBase.minSize * sizeK;
    shiftCloud.maxSize = cloudBase.maxSize * sizeK;
    shiftCloud.emitRate = cloudBase.emitRate * (1 + (k - 1) * 0.2);
  };

  // Chest anchor — invisible node at the current form's core. (Was a glowing
  // magenta ember sphere, but on the fight body it read as a stray pink ball
  // hovering over the boss spot; only its position bookkeeping earned its keep —
  // the speech bubble and per-form chest heights hang off it.)
  const ember = new TransformNode("nightmare_ember", scene);
  ember.parent = centre;
  ember.position.y = 2.6;

  // P4 AOE bolts launch from the chest core to every hero.
  const lightning = buildLightning(scene, () => ember.getAbsolutePosition());

  // P3 Fortress heal bubble — translucent PINK, pulsing; enabled only in P3.
  // Pink, not violet armor-glass: with Swim_Idle_Loop floating inside it and
  // the motes rising, the read is "self-healing cocoon", which is what the
  // Fortress regen actually does.
  const shell = MeshBuilder.CreateSphere(
    "nightmare_armor",
    { diameter: BOSS_HEIGHT * 1.5, segments: 20 },
    scene
  );
  shell.parent = centre;
  // Low enough that the Swim_Idle pose (the P3 clip) stays inside the bubble.
  shell.position.y = BOSS_HEIGHT * 0.42;
  const shellMat = new StandardMaterial("nightmare_armorMat", scene);
  shellMat.disableLighting = true;
  shellMat.emissiveColor = new Color3(1.0, 0.42, 0.78);
  shellMat.alpha = 0.16;
  shellMat.backFaceCulling = false;
  shell.material = shellMat;
  shell.setEnabled(false);
  // The rising sparks inside the bubble — started/stopped with P3.
  const healMotes = buildHealMotes(scene, centre);

  // P4 Terror pulse — a ring that expands from the boss to the arena edge on
  // every AOE tick. Additive emissive; scale + fade driven from tick().
  const pulse = MeshBuilder.CreateTorus(
    "nightmare_pulse",
    { diameter: 2, thickness: 0.18, tessellation: 64 },
    scene
  );
  pulse.position.y = 0.05;
  const pulseMat = new StandardMaterial("nightmare_pulseMat", scene);
  pulseMat.disableLighting = true;
  pulseMat.emissiveColor = PALETTE.warn;
  pulseMat.alpha = 0;
  pulse.material = pulseMat;
  pulse.setEnabled(false);

  // ---- Fight-body clips --------------------------------------------------
  const clips = {
    idleLoop: findClip(fight.groups, "Zombie_Idle"),
    // P1 swing pair — mapped 1:1 onto the sim's real single-target hits.
    attacks: [
      findClip(fight.groups, "Melee_Hook"),
      findClip(fight.groups, "Sword_Regular"),
    ].filter((g): g is AnimationGroup => g !== null),
    // P4: the Two-hand Blast IS the AOE attack (Angry retired to spare).
    blast: findClip(fight.groups, "Two-hand"),
    dizzy: findClip(fight.groups, "Dizzy"),
    swimIdle: findClip(fight.groups, "Swim_Idle"),
    death: findClip(fight.groups, "Death"),
  };

  const stopFightClips = (): void => {
    for (const g of fight.groups) g.stop();
  };
  // P4 Terror: the Two-hand Blast plays at half speed — double duration — so
  // the raid-wide wind-up reads as a telegraph, not a twitch. Damage and tick
  // pacing are the sim's, untouched.
  if (clips.blast) clips.blast.speedRatio = 0.5;
  const loopClip = (g: AnimationGroup | null): void => {
    if (!g) return;
    g.reset();
    g.play(true);
  };
  /**
   * Play one-shot clips in order, then fall into `loop` — unless the phase
   * moved on (actionToken). Repeating the same group in `seq` replays it.
   * `onDone` fires when the sequence hands over to the loop (NOT when a
   * phase change cancels it — enter() resets the dependent state itself).
   */
  let actionToken = 0;
  const sequenceThen = (
    seq: (AnimationGroup | null)[],
    loop: AnimationGroup | null,
    onDone?: () => void
  ): void => {
    const gs = seq.filter((g): g is AnimationGroup => g !== null);
    const token = ++actionToken;
    stopFightClips();
    let i = 0;
    const step = (): void => {
      if (token !== actionToken) return;
      const g = gs[i++];
      if (!g) {
        loopClip(loop);
        onDone?.();
        return;
      }
      g.reset();
      g.play(false);
      g.onAnimationGroupEndObservable.addOnce(step);
    };
    step();
  };

  // ---- Model swap helpers ------------------------------------------------
  const allModels: LoadedModel[] = [fight, idle, ...dolls].filter(
    (m): m is LoadedModel => m !== null
  );
  let stopDoll: () => void = () => {};
  const showOnly = (model: LoadedModel | null): void => {
    stopDoll();
    stopDoll = () => {};
    stopFightClips();
    for (const m of allModels) m.root.setEnabled(m === model);
    // Swap-cover: a burst thick enough that the pop-in hides inside it.
    smoke.manualEmitCount = 70;
  };

  // ---- Voice + speech bubble + music + phase machine --------------------
  // Caption anchors just above the current form's head. Ember is the shared
  // chest core (drops for dolls); add a form-aware lift so the bubble sits
  // over the skull, not the torso / screen centre.
  let headLift = 2.15; // fight body / idle shell (~4.5 m)
  const headWorld = new Vector3();
  const bubble = createSpeechBubble(scene, () => {
    const p = ember.getAbsolutePosition();
    headWorld.set(p.x, p.y + headLift, p.z);
    return headWorld;
  });
  const voice = createBossVoice(
    (_id, caption) => bubble.show(caption),
    () => bubble.hide()
  );
  const music = createBossMusic();
  const disposeAll = (): void => {
    voice.dispose();
    music.dispose();
    bubble.dispose();
    lightning.dispose();
    shiftCloud.stop();
    shiftCloud.dispose();
    smoke.stop();
    smoke.dispose();
    groundSmoke.stop();
    groundSmoke.dispose();
    glowFog.stop();
    glowFog.dispose();
    vortex.dispose();
    healMotes.stop();
    healMotes.dispose();
  };
  scene.onDisposeObservable.addOnce(disposeAll);

  const boss: NightmareBoss = {
    tick: () => {},
    onPhase: undefined,
    defeat: () => {},
    setControlled: () => {},
    setPhase: () => {},
    setP2Stage: () => {},
    setCombatAnchors: () => {},
    strike: () => {},
    sweep: () => {},
    speak: () => {},
    dispose: disposeAll,
  };

  let phase: NightmarePhase = "idle";
  let phaseT = 0; // seconds inside the current phase
  let nextAttackAt = 0;
  let attackIx = 0;
  let nextPulseAt = 0;
  let pulseT = -1; // <0 = no pulse running
  let dollIx = -1;
  /** >= 0 while an outside authority owns the stage — see `setP2Stage`. */
  let forcedStage = -1;
  /**
   * Which doll each P2 slot shows. The FIRST shapeshift walks the ages in
   * order (1→5) so the Oral→Genital progression reads as the deliberate
   * sequence it is; every later P2 entry shuffles, so a fight that goes long
   * stops being a memorised script. Always a permutation — five slots, five
   * dolls, no repeats inside a cycle — and `dollIx` resets to -1 on entry, so
   * a shuffle that opens on the doll the previous cycle closed on still swaps.
   */
  let p2Order: number[] = [0, 1, 2, 3, 4];
  let p2Cycles = 0;
  let activated = false; // first idle→p1 plays start_activate
  let cyclesCompleted = 0;
  let nextDefenseBarkAt = DEFENSE_BARK_FIRST_AT;
  let defenseBarkIx = 0;
  // Fight-sim control: when `external` is set the sim owns phase transitions
  // and P2 rides the sheet's 30 s / 6 s-stage timing instead of lookdev's;
  // real outgoing hits arrive through strike() and the internal P1/P4 attack
  // timers stand down.
  let external = false;
  let p2TotalS = P2_SECS;
  let p2StageS = P2_STAGE_SECS;
  // World anchors from the arena glue (hate target + hero chest points).
  let anchors: { aim(): Vector3 | null; heroes(): Vector3[] } | null = null;
  // True while a P1 swing runs — the window where the boss squares onto its victim.
  let attackFacing = false;
  // A fan's aim point, held from its telegraph to the end of its swing.
  let sweepAt: Vector3 | null = null;

  const enter = (p: NightmarePhase): void => {
    if (phase === "dead" && p !== "dead") return; // terminal
    phase = p;
    phaseT = 0;
    shell.setEnabled(p === "p3");
    pulse.setEnabled(p === "p4");
    pulseT = -1;
    attackFacing = false;
    sweepAt = null;
    lightning.clear();
    // Heal motes belong to the P3 bubble only.
    if (p === "p3") healMotes.start();
    else if (healMotes.isStarted()) healMotes.stop();
    // Chest height differs per form: the dolls are shorter and mostly crouch
    // through their clips — at fight-body height the ember floats over their
    // heads instead of reading as the shared core. (In P2 the tick re-derives
    // both every frame from the growth factor.)
    ember.position.y = p === "p2" ? 1.5 : 2.6;
    // Speech bubble lift above the chest ember: tall fight body vs short dolls.
    headLift = p === "p2" ? 1.7 : 2.15;
    // Wrap FX back to base scale on any phase change; the P2 tick re-grows them.
    growFx(1);
    // Shapeshift cover cloud: continuous emit for the full P2 window only.
    if (p === "p2") {
      // Reset any prior fade so a second cycle starts full-strength.
      shiftCloud.reset();
      shiftCloud.start();
      // Instant fill so the first doll is already blanketed; emitRate then
      // sustains the column for all 5 × 10 s stages until we leave P2.
      shiftCloud.manualEmitCount = 180;
    } else if (shiftCloud.isStarted()) {
      // Stop emission only — residual particles fade out on their own life.
      shiftCloud.stop();
    }
    switch (p) {
      case "idle":
        showOnly(idle);
        break;
      case "p1":
        showOnly(fight);
        loopClip(clips.idleLoop);
        nextAttackAt = P1_ATTACK_PERIOD;
        attackIx = 0;
        if (!activated) {
          // First engage: activation line, then the P1 phase bark queues after.
          activated = true;
          voice.say("start_activate");
          voice.say(PHASE_VOICE.p1!, { interrupt: false });
        } else {
          voice.say(PHASE_VOICE.p1!);
        }
        break;
      case "p2":
        dollIx = -1; // first tick swaps the opening doll in
        p2Order = p2Cycles === 0 ? [0, 1, 2, 3, 4] : shuffled([0, 1, 2, 3, 4]);
        p2Cycles += 1;
        voice.say(PHASE_VOICE.p2!);
        break;
      case "p3":
        showOnly(fight);
        // Dizzy TWICE on entry (the P2 debuffs are what stagger it into
        // turtling), then float in the pink bubble — the self-heal loop.
        sequenceThen([clips.dizzy, clips.dizzy], clips.swimIdle);
        nextDefenseBarkAt = DEFENSE_BARK_FIRST_AT;
        voice.say(PHASE_VOICE.p3!);
        break;
      case "p4":
        showOnly(fight);
        loopClip(clips.idleLoop);
        nextPulseAt = P4_PULSE_PERIOD;
        voice.say(PHASE_VOICE.p4!);
        break;
      case "dead":
        showOnly(fight);
        shell.setEnabled(false);
        pulse.setEnabled(false);
        // Death is a one-shot with no recovery loop — hold the last frame.
        actionToken++; // cancel any pending oneShotThen
        stopFightClips();
        if (clips.death) {
          clips.death.reset();
          clips.death.play(false);
        }
        // The glow dies with the boss: halt both ground systems (emission only
        // — the residue fades out on its own lifetimes). The body smoke shell
        // stays; it's the corpse's shroud, not a vital sign.
        groundSmoke.stop();
        glowFog.stop();
        vortex.die();
        voice.say("end_defeated");
        // Fight music yields to the boss's death: fade it out and let the
        // triumph sting play once over the corpse.
        music.victory();
        break;
    }
    boss.onPhase?.(p);
  };

  /**
   * A real hit lands (sim-driven; also the uncontrolled lookdev drumbeat).
   * Single-target: alternate the two melee swings, squaring onto the victim
   * while the swing runs. AOE: Two-hand Blast + expanding ring + boss→hero
   * lightning.
   */
  const strikeVisual = (all: boolean): void => {
    if (all) {
      if (phase !== "p4") return;
      sequenceThen([clips.blast], clips.idleLoop);
      pulseT = 0;
      lightning.fire(anchors?.heroes() ?? []);
    } else {
      if (phase !== "p1" || clips.attacks.length === 0) return;
      const atk = clips.attacks[attackIx % clips.attacks.length];
      attackIx++;
      attackFacing = true;
      sequenceThen([atk], clips.idleLoop, () => {
        attackFacing = false;
      });
    }
  };

  boss.strike = strikeVisual;

  boss.speak = (stem) => {
    if (phase !== "dead") voice.say(stem);
  };

  boss.sweep = (aim, wide = false) => {
    if (phase === "dead" || phase === "idle") return;
    if (aim) {
      sweepAt = aim.clone();
      return;
    }
    const clip = wide ? clips.blast : clips.attacks[attackIx++ % Math.max(1, clips.attacks.length)];
    if (!clip) {
      sweepAt = null;
      return;
    }
    // Back to whatever this phase loops on (P3's Fortress floats in Swim_Idle).
    sequenceThen([clip], phase === "p3" ? clips.swimIdle : clips.idleLoop, () => {
      sweepAt = null;
    });
  };

  boss.setCombatAnchors = (a) => {
    anchors = a;
  };

  boss.defeat = () => {
    if (phase !== "dead") enter("dead");
  };

  boss.setControlled = (controlled, p2Timing) => {
    external = controlled;
    if (p2Timing) {
      p2TotalS = p2Timing.totalS;
      p2StageS = p2Timing.stageS;
    }
  };

  boss.setPhase = (p) => {
    enter(p);
  };

  boss.setP2Stage = (stage) => {
    forcedStage = stage >= 0 ? Math.min(4, stage) : -1;
  };

  enter("idle");

  boss.tick = (t: number, dt: number) => {
    // Caption rides the boss every frame while a line is up (including death).
    bubble.tick();
    // Bolt flicker/fade — runs past phase changes so a volley can't freeze.
    lightning.tick(dt);
    // Vortex spins in every phase and keeps ticking through death — that is
    // where its fade-out runs.
    vortex.tick(t, dt);

    if (phase === "dead") return;

    phaseT += dt;

    // Square onto the hate target: continuously through P4 (the terror never
    // takes its eyes off whoever holds it), and during P1 swings (the boss
    // faces WHO it hits, exactly while hitting them).
    const aimAt =
      sweepAt ?? (phase === "p4" || (phase === "p1" && attackFacing) ? (anchors?.aim() ?? null) : null);
    if (aimAt) {
      const targetYaw = Math.atan2(aimAt.x, aimAt.z) + BOSS_MODEL_YAW;
      let d = targetYaw - fightYaw.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      fightYaw.rotation.y += d * Math.min(1, dt * BOSS_TURN_RATE);
    }

    // Idle bob — the not-yet-activated mass breathing inside its smoke.
    if (phase === "idle" && idle) {
      idle.root.rotation.y = t * 0.15;
      if (!external && phaseT >= IDLE_SECS) enter("p1");
      return;
    }

    switch (phase) {
      case "p1": {
        // Real hits arrive via strike(); this drumbeat only paces an
        // uncontrolled lookdev run (no sim attached).
        if (!external && phaseT >= nextAttackAt) {
          nextAttackAt += P1_ATTACK_PERIOD;
          strikeVisual(false);
        }
        if (!external && phaseT >= P1_SECS) enter("p2");
        break;
      }
      case "p2": {
        // Keep the cloud emitting for the whole shapeshift — never let it
        // stall mid-phase (e.g. if something else called stop()).
        if (!shiftCloud.isStarted()) shiftCloud.start();
        // Growth factor rides raw phase progress: small at the top of P2,
        // DOLL_GROW_END× by its last second — continuous across stage swaps.
        const grow =
          DOLL_GROW_START +
          (DOLL_GROW_END - DOLL_GROW_START) * Math.min(1, phaseT / p2TotalS);
        const slot = Math.min(4, Math.floor(phaseT / p2StageS));
        const stage = forcedStage >= 0 ? forcedStage : (p2Order[slot] ?? 0);
        if (stage !== dollIx) {
          const prev = dollIx;
          dollIx = stage;
          const doll = dolls[stage] ?? null;
          showOnly(doll);
          if (doll) {
            // Doll clips run at normal speed and loop inside the stage window.
            stopDoll = playDollClips(doll.groups);
            // Spike density on each doll swap; base emitRate covers the rest.
            // Scaled with growth so late swaps stay covered at 3× bulk.
            shiftCloud.manualEmitCount = Math.round(100 * grow);
            // ONE line per stage — queueing several overflowed the stage
            // window (measured 12–20 s of audio against 10 s), so tail lines
            // were structurally unhearable. The newly generated worst-memory
            // pair (laugh / age reveal) takes priority: pick one of those two
            // at random, and fall back to the older doll line only when a
            // stage has no memory lines. First doll's line queues after the
            // P2 phase line; later stages cut in over whatever is playing.
            const mem = STAGE_MEMORY_VOICE[stage];
            const memory: string[] = [mem?.laugh, mem?.age].filter((n) => Boolean(n)) as string[];
            const line = memory.length
              ? memory[Math.floor(Math.random() * memory.length)]
              : STAGE_VOICE[stage];
            if (line) voice.say(line, { interrupt: prev >= 0 });
            boss.onPhase?.("p2", `stage ${stage + 1}`);
          }
        }
        // Apply growth every frame: doll root scale + floor soling, the chest
        // ember / bubble anchors, and the wrap FX. Always derived from the
        // recorded base, so re-entry on a second cycle restarts small.
        const doll = dolls[dollIx] ?? null;
        const base = dollBases[dollIx] ?? null;
        if (doll && base) {
          doll.root.scaling.copyFrom(base.scale).scaleInPlace(grow);
          doll.root.position.y = base.y * grow;
        }
        // Doll 2 is taller (DOLL2_HEIGHT); keep the chest ember on its core.
        const dollH = (dollIx === 1 ? DOLL2_HEIGHT : DOLL_HEIGHT) * grow;
        ember.position.y = dollH * (1.5 / DOLL_HEIGHT);
        headLift = dollH * (1.7 / DOLL_HEIGHT);
        growFx(grow);
        if (!external && phaseT >= p2TotalS) enter("p3");
        break;
      }
      case "p3": {
        // Armor breath — visibly *recovering*, per the design table.
        const breathe = 1 + Math.sin(t * 1.6) * 0.04;
        shell.scaling.setAll(breathe);
        shellMat.alpha = 0.13 + (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.08;
        // Defense-mechanism fun barks while the fortress holds (skills TBD).
        if (phaseT >= nextDefenseBarkAt) {
          nextDefenseBarkAt += DEFENSE_BARK_PERIOD;
          const bark = DEFENSE_VOICE[defenseBarkIx % DEFENSE_VOICE.length];
          defenseBarkIx++;
          if (bark) voice.say(bark);
        }
        if (!external && phaseT >= P3_SECS) enter("p4");
        break;
      }
      case "p4": {
        // Real AOE ticks arrive via strike(true); the timer is lookdev-only.
        if (!external && phaseT >= nextPulseAt) {
          nextPulseAt += P4_PULSE_PERIOD;
          strikeVisual(true);
        }
        if (pulseT >= 0) {
          pulseT += dt;
          const life = 1.2; // seconds from boss to arena edge
          const k = Math.min(1, pulseT / life);
          const radius = 1 + k * (arenaExtent * 0.45);
          pulse.scaling.setAll(radius);
          pulseMat.alpha = 0.5 * (1 - k);
          if (k >= 1) pulseT = -1;
        }
        if (!external && phaseT >= P4_SECS) {
          cyclesCompleted++;
          // Lookdev kill so the defeat line is reachable without a HP sim.
          // Server will call boss.defeat() from the real death pipeline.
          if (cyclesCompleted >= LOOKDEV_KILL_AFTER_CYCLES) enter("dead");
          else enter("p1");
        }
        break;
      }
    }
  };

  return boss;
}
