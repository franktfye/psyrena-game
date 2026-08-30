/**
 * The player's hero in the boss arena — rigged hero glb, WASD, cast gestures.
 *
 * A lean sibling of the hub's hero stack (villageHub.ts): same glb, same clip
 * vocabulary, same normalisation (1.8 m, soles on y 0, facing -Z), but only
 * what a boss fight needs — locomotion blend, full-body cast one-shots, a hit
 * reaction — without the hub's drone/pipe/auto-rig dressing. Casts are
 * full-body takeovers here (no upper/lower bone split): in the arena you are
 * planted and casting, not sprinting between village errands.
 *
 * Heroes resolve by id to /assets/heroes/<id>.glb; every shipped hero rig
 * faces -Z at rest and carries the shared clip vocabulary, so a new hero is
 * an asset drop, not a code change.
 */

import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";

import "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import "@babylonjs/loaders/glTF/2.0";

import { heroHeightM } from "@shared/combat";
import { trackLoad } from "../core/loadProgress";
import { detectControlScheme, isTypingInField, uiScale } from "../ui/inputMode";
import { TouchStick, STICK_RUN_AT } from "../ui/touchStick";

export type ArenaCastKind = "basic" | "palette" | "defense" | "chain" | "ultimate";

/** Walkable ground shape, supplied by the scene (disc + spawn bridge + pad). */
export interface ArenaTerrain {
  /** Clamp a proposed position back onto walkable ground, in place. */
  clamp(pos: Vector3): void;
  /** Ground height under (x, z) — the spawn pad and bridge sit above the disc. */
  heightAt(x: number, z: number): number;
}

export interface ArenaHero {
  /** Unit-scale wrapper: position + facing yaw live here. */
  node: TransformNode;
  /** Per-frame: movement input, locomotion blend. */
  update(dt: number): void;
  /** Snap facing onto the boss (auto-aim is the design — players never aim). */
  faceTarget(point: Vector3): void;
  cast(kind: ArenaCastKind): void;
  hit(): void;
  /**
   * External locomotion hint for network-driven instances (remote teammates):
   * the caller moves `node` itself and reports how fast, so the walk/run
   * blend matches the glide. Ignored while player input is enabled; practice
   * bots never call it and keep settling on idle.
   */
  driveSpeed(speed: number): void;
  /**
   * Play the death clip and lie where you fell — input, locomotion and cast
   * gestures all stop. There is no rez; the body stays down until the scene
   * ends (defeat routes back to the village, victory leaves it as set
   * dressing beside the loot).
   */
  die(): void;
}

const WALK_SPEED = 3.4;
const RUN_SPEED = 6.2;
/** How fast the body yaws toward where it's going / where it casts. */
const TURN_RATE = 14;
/**
 * Jump: same ~0.75 m arcade hop as the village and the practice pit
 * (villageHub.ts JUMP_SPEED/JUMP_GRAVITY) — the arena was the one scene
 * missing it, and a hero who can hop in the pit must hop in the fight.
 */
const JUMP_SPEED = 4.6;
const JUMP_GRAVITY = 14;

/** Hero ids with a shipped /assets/heroes/<id>.glb; anyone else borrows Freud's rig. */
export const MODELED_HEROES = new Set(["freud", "pavlov", "skinner"]);

export interface ArenaHeroOptions {
  /**
   * false = an NPC instance (practice bot): no keyboard/touch wiring, so it
   * never moves with the player's WASD and never mounts a second TouchStick.
   * The update loop needs no branching — with nothing feeding the key set the
   * locomotion blend settles on idle by itself; faceTarget/cast/hit/die stay
   * fully driveable from the sim.
   */
  input?: boolean;
  /** Node-name prefix — lets several instances coexist ("bot_0_pavlov"…). */
  name?: string;
}

export async function loadArenaHero(
  scene: Scene,
  spawn: Vector3,
  faceToward: Vector3,
  camera: ArcRotateCamera,
  /** Walkable ground — clamps movement and supplies the floor height. */
  terrain: ArenaTerrain,
  heroId = "freud",
  opts: ArenaHeroOptions = {}
): Promise<ArenaHero> {
  const modelId = MODELED_HEROES.has(heroId) ? heroId : "freud";
  const nodeName = opts.name ?? "arenaHero";
  const wrapper = new TransformNode(nodeName, scene);
  wrapper.position.copyFrom(spawn);
  wrapper.position.y = terrain.heightAt(spawn.x, spawn.z);
  wrapper.rotation.y = Math.atan2(faceToward.x - spawn.x, faceToward.z - spawn.z) + Math.PI;

  let clips: AnimationGroup[] = [];
  try {
    const result = await trackLoad(ImportMeshAsync(`/assets/heroes/${modelId}.glb`, scene));
    const root = result.meshes[0];
    for (const m of result.meshes) {
      m.name = `${nodeName}_${m.name}`;
      m.isPickable = false;
      if (m.getTotalVertices() > 0) m.alwaysSelectAsActiveMesh = true;
    }
    // Canon scale on the loader root (it carries the RH→LH flip), soles to y 0.
    const bounds = root.getHierarchyBoundingVectors();
    const s = heroHeightM(modelId) / (bounds.max.y - bounds.min.y);
    root.scaling.scaleInPlace(s);
    root.rotationQuaternion = null;
    root.rotation.y = 0; // every shipped hero rig already faces -Z at rest
    root.position.set(0, -bounds.min.y * s, 0);
    root.parent = wrapper;
    clips = result.animationGroups;
  } catch (err) {
    console.info(`[arena] ${modelId}.glb unavailable, using capsule stand-in:`, err);
    const body = MeshBuilder.CreateCapsule(`${nodeName}_body`, { height: 1.8, radius: 0.32 }, scene);
    body.position.y = 0.9;
    body.isPickable = false;
    const mat = new StandardMaterial(`${nodeName}_mat`, scene);
    mat.diffuseColor = new Color3(0.2, 0.24, 0.35);
    mat.emissiveColor = new Color3(0.05, 0.12, 0.16);
    body.material = mat;
    body.parent = wrapper;
  }

  // ---- clips ---------------------------------------------------------------
  const find = (...keys: string[]): AnimationGroup | null => {
    for (const k of keys) {
      const g = clips.find((g) => g.name.toLowerCase() === k);
      if (g) return g;
    }
    for (const k of keys) {
      const g = clips.find((g) => g.name.toLowerCase().includes(k));
      if (g) return g;
    }
    return null;
  };
  const idle = find("idle");
  const walk = find("walk");
  const run = find("run", "sprint");
  const throwClip = find("overhandthrow", "overhand", "cast", "shoot");
  const castE = find("cast_e", "throw"); // defense, and the ultimate when no cast_f
  const castR = find("cast_r", "meditate");
  // A DEDICATED ultimate clip, when the rig ships one. Looked up as "cast_f"
  // only — deliberately not "ult", which would silently repoint Freud's F (his
  // glb carries a clip literally named `ult`) off the cast_e it is tuned for.
  const castF = find("cast_f");
  const hitClip = find("hit", "knockback");
  const deathClip = find("death", "die");
  // Jump pair — same lookup as the hub animator. Some rigs ship only the
  // launch half (Pavlov's is a backflip with no `jump_land`); triggerLand
  // below handles that the same way the village does.
  const jumpStart = find("jump_start", "jump");
  const jumpLand = find("jump_land");
  // jump_land is the one takeover that starts off a HELD pose (the launch
  // clip's last airborne frame). Without per-animation blending the weight-1
  // swap snaps into the clip's opening crouch in a single frame, and at the
  // compressed recovery speed the hips-back absorb reads as the hero
  // flashing backwards on touchdown. Blending eases both the swap and the
  // opening plunge from wherever the bones actually are.
  if (jumpLand) {
    for (const ta of jumpLand.targetedAnimations) {
      ta.animation.enableBlending = true;
      ta.animation.blendingSpeed = 0.12;
    }
  }

  for (const g of clips) g.stop();
  const loop = (g: AnimationGroup | null, w: number): void => {
    if (!g) return;
    g.start(true);
    g.setWeightForAllAnimatables(w);
  };
  loop(idle, 1);
  loop(walk, 0);
  loop(run, 0);

  /** Seconds a group runs at speedRatio 1 — Babylon's glTF importer is 60 fps. */
  const clipSeconds = (g: AnimationGroup): number => (g.to - g.from) / 60;
  /**
   * Cap a fixed speed ratio so a SHORT clip still reads.
   *
   * The ratios above were picked against Freud's rig, whose cast clips run
   * 1.3-5.4 s; Pavlov's second rig answers E and R with the same 0.46 s hook,
   * and 0.46 s played at 1.6x is a 0.29 s twitch that reads as a glitch rather
   * than a cast. This only ever SLOWS a clip that would finish under
   * MIN_CAST_S, so every clip long enough to read keeps its authored ratio and
   * Freud's playback is untouched.
   */
  const MIN_CAST_S = 0.5;
  const readable = (g: AnimationGroup | null, ratio: number): number =>
    g ? Math.min(ratio, Math.max(0.5, clipSeconds(g) / MIN_CAST_S)) : ratio;

  let wIdle = 1;
  let wWalk = 0;
  let wRun = 0;
  let takenOver = false;
  const fullBody = (g: AnimationGroup | null, speedRatio: number): void => {
    if (!g) return;
    for (const other of [throwClip, castE, castR, castF, hitClip, jumpStart, jumpLand]) {
      if (other && other !== g) {
        other.stop();
        other.setWeightForAllAnimatables(0);
      }
    }
    g.stop();
    g.start(false, speedRatio);
    g.setWeightForAllAnimatables(1);
    // AFTER the stops — see the note in villageHub's copy: stop() fires the end
    // observable, which clears this flag, so raising it first left an
    // interrupting cast un-flagged and blended against full-weight idle.
    takenOver = true;
  };
  for (const g of [throwClip, castE, castR, castF, hitClip, jumpStart, jumpLand]) {
    g?.onAnimationGroupEndObservable.add(() => {
      takenOver = false;
      g.setWeightForAllAnimatables(0);
    });
  }

  // Jump halves, straight off the hub animator (villageHub triggerJump/-Land).
  // A jump taken (or landed) on the move skips the landing recovery so the
  // gait resumes at touchdown; a standing jump plays the whole pair.
  let jumpedMoving = false;
  const triggerJump = (moving: boolean): void => {
    if (!jumpStart) return;
    jumpedMoving = moving;
    // Launch carries crouch-anticipation + rise, but the ballistic arc is only
    // ~0.66 s (2·JUMP_SPEED/JUMP_GRAVITY) — play it brisk so the crouch
    // doesn't eat the whole airtime.
    fullBody(jumpStart, Math.min(2.2, Math.max(1, clipSeconds(jumpStart) / 0.9)));
  };
  const triggerLand = (moving: boolean): void => {
    // Stop the launch clip FIRST, unconditionally — Pavlov's rig ships a
    // `jump_start` (a backflip) with no `jump_land`, and leaving it running
    // full-body on the ground holds a mid-backflip pose after touchdown.
    if (jumpStart) {
      jumpStart.stop();
      jumpStart.setWeightForAllAnimatables(0);
      takenOver = false;
    }
    // On the move the launch stop above already released the takeover —
    // walk/run blend straight back in. Playing the recovery here froze the
    // legs into a crouch while the body kept gliding across the arena.
    if (jumpedMoving || moving) return;
    if (!jumpLand) return;
    // Landing recovery, compressed to a beat so control doesn't feel sluggish.
    fullBody(jumpLand, Math.min(2.2, Math.max(1, clipSeconds(jumpLand) / 0.8)));
  };

  // ---- input ---------------------------------------------------------------
  const wantInput = opts.input !== false;
  const keys = new Set<string>();
  /** Edge-triggered so holding space does not bunny-hop every landing. */
  let jumpQueued = false;
  if (wantInput) {
    const down = (e: KeyboardEvent): void => {
      if (isTypingInField()) return;
      if (e.key === " " && !e.repeat) {
        // Space scrolls the page and activates focused buttons — neither is
        // wanted while it is the jump key. Same guard as the hub controller.
        e.preventDefault();
        jumpQueued = true;
        return;
      }
      keys.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent): void => {
      keys.delete(e.key.toLowerCase());
    };
    const blur = (): void => {
      keys.clear();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    scene.onDisposeObservable.add(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    });
  }

  // Left-thumb stick — the hub's stick dies with the hub scene, so the arena
  // must mount its own or touch players cannot move in the boss fight. Same
  // control grammar as villageHub.ts: the stick substitutes for the WASD axes
  // only; camera-relative movement, facing and the terrain clamp are shared
  // with the keyboard path below.
  const stick =
    wantInput && typeof document !== "undefined" && detectControlScheme() === "touch"
      ? new TouchStick(uiScale())
      : null;
  if (stick) scene.onDisposeObservable.add(() => stick.dispose());

  // Touch jump button — same placement and look as the hub's (right of the
  // stick's resting ring), so the grammar the village teaches carries into
  // the fight unchanged.
  if (stick) {
    const scale = uiScale();
    const d = Math.round(46 * scale);
    const jump = document.createElement("button");
    jump.textContent = "JUMP";
    jump.style.cssText = [
      "position:fixed",
      `left:${Math.round(178 * scale)}px`,
      `bottom:${Math.round(44 * scale)}px`,
      `width:${d}px`,
      `height:${d}px`,
      "border-radius:50%",
      "border:1px solid rgba(120,220,255,.4)",
      "background:radial-gradient(circle at 40% 35%,rgba(24,52,74,.85),rgba(6,14,24,.85))",
      "color:#a8f0ff",
      `font:600 ${Math.max(9, Math.round(10 * scale))}px ui-monospace,monospace`,
      "letter-spacing:.06em",
      "z-index:9",
      "touch-action:none",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");
    jump.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      jumpQueued = true;
    });
    document.body.appendChild(jump);
    scene.onDisposeObservable.add(() => jump.remove());
  }

  let targetYaw: number | null = null;
  let dead = false;
  /** Locomotion speed fed by driveSpeed() for network-driven instances. */
  let drivenSpeed = 0;
  // Ballistic hop state — height above the LOCAL ground (the pad/bridge/disc
  // steps mean the arena's ground is terrain.heightAt, not y=0).
  let jumpY = 0;
  let jumpVel = 0;
  const moveVec = Vector3.Zero();
  const camFwd = Vector3.Zero();

  return {
    node: wrapper,

    update(dt) {
      if (dead) return; // the body lies where it fell — no input, no blend
      // Camera-relative WASD: forward is where the camera looks, flattened.
      moveVec.setAll(0);
      if (keys.has("w") || keys.has("arrowup")) moveVec.z += 1;
      if (keys.has("s") || keys.has("arrowdown")) moveVec.z -= 1;
      if (keys.has("a") || keys.has("arrowleft")) moveVec.x -= 1;
      if (keys.has("d") || keys.has("arrowright")) moveVec.x += 1;
      let sprint = keys.has("shift");
      // Digital keys are full tilt; the stick reports how far it is pushed.
      let tilt = 1;
      // The stick wins while actually held, falling back to the keyboard axes
      // on release — same arbitration as the hub controller.
      const axes = stick?.axes;
      if (axes && axes.magnitude > 0) {
        moveVec.set(axes.x, 0, axes.y);
        sprint = axes.run;
        tilt = axes.magnitude;
      }
      const moving = moveVec.lengthSquared() > 0;
      // Analog speed curve, same shape as the hub: tilt scales across the walk
      // range below the sprint threshold, then ramps walk → run over the
      // remaining travel. Keyboard input (tilt 1) lands exactly on WALK / RUN.
      const speed = !moving
        ? 0
        : sprint
          ? WALK_SPEED +
            (RUN_SPEED - WALK_SPEED) *
              Math.min(1, Math.max(0, tilt - STICK_RUN_AT) / (1 - STICK_RUN_AT))
          : WALK_SPEED * Math.min(1, tilt / STICK_RUN_AT);

      if (moving) {
        moveVec.normalize();
        camera.target.subtractToRef(camera.position, camFwd);
        camFwd.y = 0;
        camFwd.normalize();
        // Left-handed, y-up: screen-right is up × forward.
        const rx = camFwd.z;
        const rz = -camFwd.x;
        const wx = camFwd.x * moveVec.z + rx * moveVec.x;
        const wz = camFwd.z * moveVec.z + rz * moveVec.x;
        wrapper.position.x += wx * speed * dt;
        wrapper.position.z += wz * speed * dt;
        // Stay on walkable ground (disc, spawn bridge, pad).
        terrain.clamp(wrapper.position);
        targetYaw = Math.atan2(wx, wz) + Math.PI;
      }
      // ---- Jump — same fixed-gravity hop as the hub controller, stacked on
      // the local floor height instead of the village's flat y=0.
      if (jumpQueued) {
        jumpQueued = false;
        if (jumpY === 0) {
          jumpVel = JUMP_SPEED;
          triggerJump(moving);
        }
      }
      if (jumpVel !== 0 || jumpY > 0) {
        jumpVel -= JUMP_GRAVITY * dt;
        jumpY += jumpVel * dt;
        if (jumpY <= 0) {
          jumpY = 0;
          jumpVel = 0;
          // Touchdown — this branch only runs while an arc is in flight.
          triggerLand(moving);
        }
      }

      // Ease onto the local floor height — the pad/bridge/disc steps are small,
      // and a hard snap reads as a pop when crossing them. The jump arc stacks
      // on top; while airborne, snap to floor + arc so the hop is crisp.
      const floorY = terrain.heightAt(wrapper.position.x, wrapper.position.z);
      if (jumpY > 0) wrapper.position.y = floorY + jumpY;
      else wrapper.position.y += (floorY - wrapper.position.y) * Math.min(1, dt * 12);

      // Facing: movement direction, or the cast target while casting.
      if (targetYaw !== null) {
        let d = targetYaw - wrapper.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        wrapper.rotation.y += d * Math.min(1, dt * TURN_RATE);
        if (!moving && Math.abs(d) < 0.02) targetYaw = null;
      }

      // Locomotion blend (suppressed during full-body cast takeovers). A
      // network-driven rig has no input; its externally reported speed feeds
      // the same blend so remote teammates walk instead of skating.
      const blendSpeed = moving ? speed : wantInput ? 0 : drivenSpeed;
      let tIdle = 1;
      let tWalk = 0;
      let tRun = 0;
      if (blendSpeed > 0.05) {
        if (blendSpeed <= WALK_SPEED) {
          tWalk = 1;
          tIdle = 0;
        } else {
          tRun = Math.min(1, (blendSpeed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED));
          tWalk = 1 - tRun;
          tIdle = 0;
        }
      }
      if (takenOver) {
        tIdle = 0;
        tWalk = 0;
        tRun = 0;
      }
      const k = Math.min(1, dt * 9);
      wIdle += (tIdle - wIdle) * k;
      wWalk += (tWalk - wWalk) * k;
      wRun += (tRun - wRun) * k;
      idle?.setWeightForAllAnimatables(wIdle);
      walk?.setWeightForAllAnimatables(wWalk);
      run?.setWeightForAllAnimatables(wRun);
      if (walk) walk.speedRatio = Math.min(1.9, Math.max(0.8, blendSpeed / 1.4));
      if (run) run.speedRatio = Math.min(1.5, Math.max(0.8, blendSpeed / 4.5));
    },

    faceTarget(point) {
      if (dead) return;
      targetYaw = Math.atan2(point.x - wrapper.position.x, point.z - wrapper.position.z) + Math.PI;
    },

    cast(kind) {
      if (dead) return;
      if (kind === "ultimate" && castF) return fullBody(castF, readable(castF, 1.0));
      if (kind === "ultimate" && castE) return fullBody(castE, readable(castE, 0.9));
      if (kind === "chain" && castR) return fullBody(castR, readable(castR, 0.6));
      if (kind === "defense" && castE) return fullBody(castE, readable(castE, 1.6));
      fullBody(throwClip, readable(throwClip, 1.0)); // basic + palette
    },

    hit() {
      if (dead) return;
      fullBody(hitClip, 1);
    },

    driveSpeed(speed) {
      drivenSpeed = speed;
    },

    die() {
      if (dead) return;
      dead = true;
      // Killed mid-hop: ground the body first or the corpse floats at the
      // frozen arc height (update() stops running the arc once dead).
      if (jumpY > 0) {
        jumpY = 0;
        jumpVel = 0;
        wrapper.position.y = terrain.heightAt(wrapper.position.x, wrapper.position.z);
      }
      stick?.dispose();
      if (deathClip) {
        // Stop EVERY group (idle/walk/run keep animating bones at weight > 0
        // otherwise), then play death once. When it ends nothing else drives
        // the skeleton, so the rig holds the clip's final lying pose.
        for (const g of clips) g.stop();
        deathClip.start(false, 1.0);
        deathClip.setWeightForAllAnimatables(1);
      } else {
        // Capsule stand-in (or a glb with no death clip): tip it over.
        wrapper.rotation.x = -Math.PI / 2;
        wrapper.position.y += 0.35;
      }
    },
  };
}
