/**
 * The pet roster and the follower that walks at the hero's heel.
 *
 * Extracted from villageHub.ts so every scene can spawn a pet without
 * importing the 7000-line hub module: the hub's Pet Park still renders the
 * roster as statues, the practice booth and the boss arena spawn followers,
 * and the Pet Park panel gates equipping on the same `heroId` field — one
 * roster, four consumers, no drifting mirrors.
 */

import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";

import { trackLoad } from "../core/loadProgress";

import { PALETTE, VILLAGE } from "../core/palette";
import { wardrobe } from "../state/wardrobe";

/** Tripo exports lying length-on-Z (robot, dino) — already face along ±Z. */
export const PET_ROBOT_MODEL_YAW = 0;
/** Tripo quadrupeds lying length-on-X need a quarter turn to face -Z. */
export const PET_CORGI_MODEL_YAW = -Math.PI / 2;
/**
 * The rigged re-exports (Tripo/Meshy animation pipeline) all rest nose-at-+Z —
 * the same convention as Druzhok's rigs — regardless of how their STATIC
 * ancestors lay. Measured in-probe per file (petprobe.html screenshots against
 * a reference arrow), not assumed: the one exception is the robot's walk
 * re-export, which rests nose-at--X and takes `PET_CORGI_MODEL_YAW` instead.
 */
export const PET_RIGGED_MODEL_YAW = Math.PI;

export interface PetSpec {
  file: string;
  key: string;
  height: number;
  modelYaw: number;
  x: number;
  z: number;
  fallback: Color3;
  /**
   * Rigged, animated variant for the FOLLOWER (`createPetFollower`).
   *
   * Separate from `file` on purpose: the park loads its statues through
   * `loadVillageProp`, which bakes the loader hierarchy into the vertices and
   * freezes the world matrix — that is what makes a 7-pet diorama cheap, and
   * it also destroys a skeleton. A pet that has to walk needs the untouched
   * rig, so the follower has its own load path.
   *
   * It does NOT always need its own asset: five of the six park pets ship as a
   * single rigged file serving both consumers, because the two load paths
   * already differ (`loadVillageProp` detaches the rig for the statue; the
   * follower keeps it). Set this only when the follower wants a DIFFERENT
   * model from the statue — Druzhok, whose rigged export is a different mesh
   * from his park copy.
   */
  followFile?: string;
  /**
   * Yaw for the FOLLOWER model, in radians. Separate from `modelYaw` because
   * it applies to a different asset in a different way: `modelYaw` is baked
   * into the park statue's vertices by `loadVillageProp`, whereas this is set
   * on the follower's node (baking would flatten the rig). The two exports do
   * not share a rest orientation — Druzhok's animated rig lies nose-to-tail
   * along Z with the NOSE at +Z, and every hero faces -Z, so he needs half a
   * turn where the park's static copy needs a quarter.
   */
  followYaw?: number;
  /**
   * Dedicated walk-cycle model, shown INSTEAD of `followFile` while the
   * follower is chasing. Druzhok's idle is the Meshy "Shadow Sentinel" rigged
   * Character export in bind pose — the walk model's exact mesh and 27-joint
   * rig, but clip-less (the export's only clip is a 0-length pose, stripped
   * in preprocessing), so the walk clip still cannot play on it; the follower
   * swaps whole models on the same moving/at-heel edge that starts and stops
   * the clips. Identical mesh at the identical baked armature scale, so the
   * swap cannot pop — which the earlier Tripo-rigged idle did (different
   * mesh, different bind proportions, visibly a different dog next to the
   * walking one). Both exports must share the `followYaw` rest orientation
   * (nose at +Z, verified in-probe).
   */
  walkFile?: string;
  /**
   * Rest yaw of the `walkFile` model, when it differs from the model the rest
   * of the follower shows. A split-duty pair shares ONE root node, and the
   * root's yaw is part of the facing math every frame — so a walk model whose
   * rest orientation disagrees with its idle partner gets the difference baked
   * onto its own wrapper at load instead. Robot is the case in point: its
   * static idle faces -Z (yaw 0) while its walk re-export rests nose-at--X.
   * Defaults to the follower model's yaw (Druzhok's two rigs agree).
   */
  walkYaw?: number;
  /** Hero this pet belongs to — petPanel.ts gates equipping on the same id. */
  heroId?: string;
}

/**
 * Pet Park roster: robotic + corgi (V3) plus husky / black cat / dinosaur /
 * unicorn. One of each — no instancing. Names avoid the shadow denylist
 * (`paw` would silence them).
 *
 * Positions are inset ≥1.4 m from the fence (park is 15×12) and clear of the
 * plaza-side entrance corridor (|x| < 1.6 near the front) so nothing overlaps
 * the metal fence, gate posts, or the walk-in path.
 *
 * `modelYaw` bakes the export's rest pose into a canonical face-along-−Z; the
 * facing itself is computed at build time — every pet turns toward the plaza
 * centre (the park's audience side), so there is no per-pet `ry` to author.
 * The five rigged re-exports rest nose-at-+Z (`PET_RIGGED_MODEL_YAW`); the
 * robot's static model still faces -Z as exported (`PET_ROBOT_MODEL_YAW`),
 * and Druzhok's separate statue lies length-on-X (`PET_CORGI_MODEL_YAW`).
 */
export const PET_PARK_ROSTER: PetSpec[] = [
  {
    file: "pet_robot.glb",
    key: "robot",
    height: 0.55,
    modelYaw: PET_ROBOT_MODEL_YAW,
    x: -4.0,
    z: -1.2,
    fallback: PALETTE.cyan,
    // The only pet whose rigged re-export ships a gait and NOTHING else: its
    // one clip is the walk, so the original static model stays on as the idle
    // half of a split-duty pair. Every other pet's re-export carries its own
    // idle and simply replaced the statue asset in place.
    walkFile: "pet_robot_walk.glb",
    walkYaw: PET_CORGI_MODEL_YAW, // walk re-export rests nose-at--X
  },
  {
    file: "pet_corgi.glb",
    key: "corgi",
    height: 0.42,
    modelYaw: PET_RIGGED_MODEL_YAW,
    x: 3.8,
    z: 0.6,
    fallback: VILLAGE.warmLight,
  },
  {
    file: "pet_husky.glb",
    key: "husky",
    height: 0.5,
    modelYaw: PET_RIGGED_MODEL_YAW,
    x: -3.6,
    z: 2.6,
    fallback: PALETTE.cyan.scale(0.85),
  },
  {
    file: "pet_black_cat.glb",
    key: "blackcat",
    height: 0.36,
    modelYaw: PET_RIGGED_MODEL_YAW,
    x: 1.8,
    z: 3.2,
    fallback: PALETTE.violet,
  },
  {
    file: "pet_dinosaur.glb",
    key: "dino",
    height: 0.55,
    modelYaw: PET_RIGGED_MODEL_YAW,
    x: 4.2,
    z: -2.0,
    fallback: VILLAGE.turf.scale(2.2),
  },
  {
    file: "pet_unicorn.glb",
    key: "unicorn",
    height: 0.52,
    modelYaw: PET_RIGGED_MODEL_YAW,
    x: -1.4,
    z: 1.4,
    fallback: VILLAGE.magenta,
  },
  {
    // Druzhok — Pavlov's German Shepherd, and the only pet tied to a hero
    // (petPanel.ts gates equipping him on playing Pavlov). Tallest of the
    // roster on purpose: the breed reads wrong scaled down to husky size, and
    // the tank's dog should have presence beside him.
    file: "pet_druzhok.glb",
    key: "druzhok",
    height: 0.62,
    modelYaw: PET_CORGI_MODEL_YAW, // length-on-X, same as the other quadrupeds
    x: 0.8,
    z: -2.8,
    fallback: VILLAGE.warmLight,
    followFile: "pet_druzhok_idle.glb",
    walkFile: "pet_druzhok_walk.glb",
    followYaw: Math.PI, // both rigs' noses are +Z; heroes face -Z
    heroId: "pavlov",
  },
];

/**
 * Which pet should be at this hero's heel.
 *
 * `wardrobe.pet === null` is ambiguous on its own — it means both "never
 * chose" and "unequipped on purpose" — so `petChosen` decides. Untouched
 * loadouts get the hero's OWN pet without being asked (Pavlov should not have
 * to go find the Pet Park to walk his own dog); once the player has used the
 * panel, their choice is absolute, including the choice of nothing.
 *
 * Hero-exclusive pets stay home when their hero is not the one playing: the
 * panel refuses to EQUIP Druzhok for anyone but Pavlov, and this is the same
 * rule at spawn time — without it, equip-as-Pavlov-then-switch had Freud
 * walking Pavlov's dog while the panel claimed it was locked.
 */
export function petForHero(heroId: string): string | null {
  const key = wardrobe.petChosen
    ? wardrobe.pet
    : (PET_PARK_ROSTER.find((p) => p.heroId === heroId)?.key ?? null);
  if (!key) return null;
  const spec = PET_PARK_ROSTER.find((p) => p.key === key);
  if (!spec) return null;
  if (spec.heroId !== undefined && spec.heroId !== heroId) return null;
  return key;
}

/** What the follower needs from a hero: a node with a position and a yaw. */
export interface PetAnchor {
  node: TransformNode;
}

export interface PetFollowerOpts {
  /**
   * Ground height at (x, z). The hub and booth are flat at y=0 so they omit
   * it; the boss arena has a raised spawn pad and bridge, and a pet that
   * ignores them wades through the deck up to its belly.
   */
  heightAt?: (x: number, z: number) => number;
}

export interface PetHandle {
  tick(): void;
  dispose(): void;
}

/**
 * The equipped pet, walking beside the hero.
 *
 * docs/01 promises "pets follow you in the hub and arena" and nothing
 * implemented it — `wardrobe.pet` was a string only the Pet Park panel ever
 * read, and the park's seven pets are frozen statues. This is the other half.
 *
 * HOW IT MOVES. The pet does NOT parent to the hero: a rigid child orbits like
 * the drone and reads as furniture. It keeps its own world position and chases
 * a target spot at the hero's shoulder, so it drifts, catches up, and settles
 * — the same exponential-chase-with-snap the remote-avatar interpolator uses
 * for other players, because "follow a thing that moves" is the same problem.
 *
 * WHY THE HEEL SPOT IS BEHIND-LEFT. Directly beside means the pet is in frame
 * for a third-person camera that sits behind the hero; directly behind means
 * it is hidden by him. Behind-and-left keeps him visible past the hero's
 * shoulder without walking through the shot.
 *
 * CLIPS. Three roles, matched by name (`tools/build-pet-anim.mjs` is what
 * guarantees a pet's clips are called `walk`, `run`, and `idle`/`idle_*`):
 *
 *   walk / run   locomotion. Whichever the pet has drives the chase; a pet
 *                with both walks a short gap and runs a long one, and a pet
 *                with only one uses it for both, leaning on the distance-driven
 *                `speedRatio` to tell a trot from a scramble.
 *   idle / idle_*  the at-heel loop. Starts the moment the chase ends — the
 *                sit delay this used to have held the pet frozen mid-stride
 *                instead of easing it into a stand, and flicker around the
 *                catch-up threshold is handled by the CATCH_UP_M / STOP_M
 *                dead zone now. More than one and they alternate; see `idles`.
 *
 * A pet with a `walkFile` carries the walk clip on a second model swapped in
 * on the same moving/at-heel edge; both models read as "standing" at the swap
 * moment, which is what keeps a hard mesh swap from reading as a pop. Druzhok
 * and the robot are the two split-duty pets — Druzhok because his rigged mesh
 * differs from his statue, the robot because its re-export ships a gait and no
 * idle, so the original statue stays on as the thing it does when standing.
 */
export async function createPetFollower(
  scene: Scene,
  hero: PetAnchor,
  petId: string,
  opts: PetFollowerOpts = {}
): Promise<PetHandle | null> {
  const spec = PET_PARK_ROSTER.find((p) => p.key === petId);
  if (!spec) return null;

  const root = new TransformNode(`pet_${petId}`, scene);
  /** Every animation group imported for this pet — see loadModel's note. */
  const imported: AnimationGroup[] = [];
  let walk: AnimationGroup | null = null;
  let run: AnimationGroup | null = null;
  /**
   * The at-heel loop, or several of them cycled in order.
   *
   * A pet that ships more than one idle has them ALTERNATED rather than picked
   * once, because these clips are short and self-similar — the husky's rest is
   * 0.33 s and the dinosaur's is 2.4 s, so a single looped choice reads as a
   * stutter within a few seconds of standing still. Cycling rest→sit and
   * idle→roar gives the pause somewhere to go.
   */
  const idles: AnimationGroup[] = [];
  /** The `followFile` model — the only model, unless `walkFile` splits duty. */
  let idleNode: AbstractMesh | null = null;
  let idleSkeleton: Skeleton | null = null;
  /** The `walkFile` model, shown only while chasing. Null = single-model pet. */
  let walkNode: AbstractMesh | null = null;
  /** Per-clip standing frame, filled by loadModel's sampler; see standDown. */
  const neutralFrame = new Map<AnimationGroup, number>();
  // The static asset's yaw canonicalizes it to face -Z, same contract the
  // park bakes — here it stays on the node so a later rigged export slots in.
  const modelYaw = spec.followFile ? (spec.followYaw ?? 0) : spec.modelYaw;

  /**
   * Load one model under `root`, scaled to the roster height with the paws
   * dropped onto y=0 — the same contract loadVillageProp bakes, but done on
   * the NODE so the skeleton is left alone (baking it into the vertices is
   * what would break the rig). Measured per model, not via `root`, because a
   * split-duty pet has two models under one root and each grounds itself.
   *
   * `yawOffset` is this model's rest yaw MINUS the root's `modelYaw` — the
   * per-model correction a split-duty pair needs when its two exports do not
   * rest the same way. It lives on a wrapper node because the loader root
   * carries a rotationQuaternion (handedness conversion), which silently wins
   * over any Euler written to it.
   *
   * `fitClips` scales against the tallest pose SAMPLED FROM THE CLIPS instead
   * of the bind pose — for a model whose clips are its whole repertoire (no
   * idle role), so the bind pose is never on screen once `standDown` exists.
   * The corgi is why: its export's rest pose is a uniform ~33% bigger than
   * every frame of its walk (a retarget scale artifact, measured in-probe),
   * so bind-pose scaling shipped a walking corgi at 0.32 m against its
   * authored 0.42. Split-duty walk models must NOT opt in: their size is
   * paired with a separately-loaded idle model that scales by bind, and the
   * robot/Druzhok walk poses differ from bind by honest posture, not scale.
   */
  const loadModel = async (file: string, yawOffset = 0, fitClips = false) => {
    const result = await trackLoad(ImportMeshAsync(`/assets/village/${file}`, scene));
    const loaded = result.meshes[0];
    if (!loaded) throw new Error("empty pet glb");
    if (yawOffset !== 0) {
      const wrap = new TransformNode(`${file}_yaw`, scene);
      wrap.parent = root;
      wrap.rotation.y = yawOffset;
      loaded.parent = wrap;
    } else {
      loaded.parent = root;
    }
    const b = loaded.getHierarchyBoundingVectors();
    const bindHeight = Math.max(1e-3, b.max.y - b.min.y);
    // Stopped only for now — blending is configured AFTER the sampling below.
    // With blending on, every load-time goToFrame evaluates as a partial blend
    // FROM THE BIND POSE, so the samples answer for poses the clips never
    // hold: the corgi's "tallest clip pose" measured within 3% of its bind
    // height and the fitClips rescale silently degenerated to bind scaling.
    for (const g of result.animationGroups) g.stop();

    const skeleton = result.skeletons[0] ?? null;
    const parts = [loaded, ...loaded.getChildMeshes(false)].filter((m) => m.getTotalVertices() > 0);

    /**
     * Bounding box of the model right now, WITH the skeleton applied —
     * `getHierarchyBoundingVectors` reads cached bounds computed from the
     * bind-pose vertices, so on a skinned mesh it answers for a pose the pet
     * may never actually hold. Measured BEFORE the scale below is applied;
     * everything derived from it is multiplied out, which is safe because the
     * scale is uniform and the node is still at the origin.
     */
    const measureNow = (): { minY: number; height: number; footprint: number } => {
      // Bone matrices are only recomputed as part of a render, and this all
      // runs at load before the pet has ever been drawn — without forcing it,
      // `applySkeleton` measures against whatever pose the matrices were left
      // in and every sample below returns the same (bind-pose) answer.
      skeleton?.computeAbsoluteMatrices(true);
      skeleton?.prepare(true);
      let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
      for (const m of parts) {
        m.refreshBoundingInfo({ applySkeleton: true });
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        minX = Math.min(minX, bb.minimumWorld.x);
        minY = Math.min(minY, bb.minimumWorld.y);
        minZ = Math.min(minZ, bb.minimumWorld.z);
        maxX = Math.max(maxX, bb.maximumWorld.x);
        maxY = Math.max(maxY, bb.maximumWorld.y);
        maxZ = Math.max(maxZ, bb.maximumWorld.z);
      }
      return { minY, height: maxY - minY, footprint: maxX - minX + (maxZ - minZ) };
    };

    /**
     * Sample every clip for three answers at once:
     *
     *  - `lowest`, to drop the paws onto y=0 across the POSES THE PET WILL
     *    HOLD. Grounding on the bind pose alone is what buried the black cat:
     *    its rest and run clips both sit lower than the pose it was exported
     *    in. Conservative by construction — the bind pose is a candidate and
     *    the result is a MINIMUM.
     *  - `tallestPose`, the fitClips scale target (see above).
     *  - `neutralFrame` per clip: the sampled frame with the smallest
     *    horizontal footprint — legs gathered under the body, the closest
     *    thing a gait has to a standing pose. `standDown` freezes a gait-only
     *    model on this frame instead of snapping it to bind.
     */
    const SAMPLES = 8;
    const bind = measureNow();
    let lowest = bind.minY;
    let tallestPose = 0;
    for (const g of result.animationGroups) {
      g.start(false);
      g.pause();
      let bestFootprint = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const frame = g.from + ((g.to - g.from) * i) / SAMPLES;
        g.goToFrame(frame);
        const m = measureNow();
        lowest = Math.min(lowest, m.minY);
        tallestPose = Math.max(tallestPose, m.height);
        if (m.footprint < bestFootprint) {
          bestFootprint = m.footprint;
          neutralFrame.set(g, frame);
        }
      }
      g.stop();
    }
    skeleton?.returnToRest();
    for (const g of result.animationGroups) {
      // Blend on start: walk↔sit are far apart in pose (folded vs standing
      // hind legs), and the group that starts inherits whatever pose the
      // other left behind.
      g.enableBlending = true;
      g.blendingSpeed = 0.08;
    }

    const hasIdle = result.animationGroups.some((g) => /idle|sit|rest/.test(g.name.toLowerCase()));
    const scale = spec.height / (fitClips && !hasIdle && tallestPose > 0 ? tallestPose : bindHeight);
    loaded.scaling.scaleInPlace(scale);
    loaded.computeWorldMatrix(true);
    loaded.position.y -= lowest * scale;

    // Every group this pet imported, kept for dispose(): animation groups are
    // scene-level objects that root.dispose() does NOT take, and a leaked
    // group keeps animating freed nodes. It only used to matter at scene
    // teardown (which sweeps them anyway); now that pets come and go with
    // remote players walking through the plaza, each one has to clean up
    // after itself.
    imported.push(...result.animationGroups);
    return { node: loaded, groups: result.animationGroups, skeleton };
  };

  /**
   * Sort a model's clips into the three roles the follower drives.
   *
   * Matching is on NAME, and `tools/build-pet-anim.mjs` is what guarantees the
   * names: every shipped pet clip is `walk`, `run`, or `idle`/`idle_*`. The
   * substring test is kept (rather than an equality test) so a hand-exported
   * model with `Walk_Loop` still lands in the right slot, and `idle` is checked
   * FIRST so `idle_run_ready`-style names cannot be stolen by the gait tests.
   */
  const classify = (groups: AnimationGroup[]): void => {
    for (const g of groups) {
      const n = g.name.toLowerCase();
      if (n.includes("idle") || n.includes("sit") || n.includes("rest")) idles.push(g);
      else if (n.includes("walk")) walk = g;
      else if (n.includes("run")) run = g;
    }
  };

  try {
    const idle = await loadModel(spec.followFile ?? spec.file, 0, true);
    idleNode = idle.node;
    idleSkeleton = idle.skeleton;
    classify(idle.groups);
    if (spec.walkFile) {
      try {
        const walker = await loadModel(spec.walkFile, (spec.walkYaw ?? modelYaw) - modelYaw);
        walkNode = walker.node;
        walkNode.setEnabled(false);
        walk = walker.groups.find((g) => g.name.toLowerCase().includes("walk")) ?? walker.groups[0] ?? walk;
      } catch {
        // Walk model missing: fall back to single-model duty rather than no pet.
        walkNode = null;
      }
    }
  } catch {
    // No model, no pet — the scene is not worth breaking over a cosmetic.
    root.dispose();
    return null;
  }

  /** Heel position in the hero's own frame: behind and to his left. */
  const HEEL_BACK = 0.95;
  const HEEL_SIDE = 0.75;
  /** Past this the pet is lagging and breaks into a walk. */
  const CATCH_UP_M = 0.28;
  /**
   * Below this a moving pet considers itself arrived and stands down. Kept
   * apart from CATCH_UP_M so a gap hovering on one shared threshold cannot
   * flick the gait on and off every frame — the dead zone IS the debounce.
   * It used to be a 1.1 s sit delay instead, and that read as a bug: a pet
   * arriving at heel held its last mid-stride frame, frozen, for the full
   * delay before the idle started. The idle now starts on the stop edge.
   */
  const STOP_M = 0.18;
  /**
   * The gap at which the walk gives way to the run, and the gap at which it
   * comes back — measured, not guessed.
   *
   * The chase settles where the gain closes exactly as much ground as the hero
   * gains in a frame, so each hero speed has one steady trailing distance. At
   * 60 fps on hardware those are **0.76 m** at WALK_SPEED and **1.11 m** at
   * RUN_SPEED, and they are steady to the millimetre once reached. The band
   * sits between them, so the pet's gait tracks the hero's.
   *
   * TWO THRESHOLDS, not one. The keyboard only ever asks for 3.4 or 6.2, but
   * the analog stick asks for everything in between (see STICK_RUN_AT in the
   * hub controller) — and a player holding the stick at the speed whose
   * steady gap lands exactly on a single threshold would flip the gait every
   * frame. Entering at 1.00 and leaving at 0.85 puts ~0.1 m of clearance on
   * both measured gaps and 0.15 m of dead zone between them.
   *
   * The first value tried here was a single 1.6 m, above BOTH gaps: the run
   * clip was unreachable and a sprinting pet just played its walk at the 2.2
   * speed cap. Re-measure these if the chase gain or the hero speeds change.
   */
  const RUN_ENTER_M = 1.0;
  const RUN_EXIT_M = 0.85;
  /** Past this it teleports — the hero used a portal, not his legs. */
  const SNAP_M = 6;

  /** Seconds to hold one idle clip before cycling to the next. */
  const IDLE_HOLD_S = 5;

  /**
   * Clip length in seconds, or null for a group that has no timeline to read.
   * Used to end an idle on a loop boundary instead of mid-stride.
   */
  const clipSeconds = (g: AnimationGroup): number | null => {
    const fps = g.targetedAnimations[0]?.animation?.framePerSecond;
    if (!fps) return null;
    const frames = g.to - g.from;
    return frames > 0 ? frames / fps : null;
  };

  /**
   * How long to hold `g` before moving to the next idle: at least IDLE_HOLD_S,
   * rounded UP to a whole number of loops. Cutting a 6 s roar off at 5 s is
   * visibly a cut; letting it finish costs a second and reads as intent.
   */
  const idleHold = (g: AnimationGroup): number => {
    const len = clipSeconds(g);
    if (!len || len <= 0) return IDLE_HOLD_S;
    return Math.ceil(IDLE_HOLD_S / len) * len;
  };

  const target = new Vector3();
  let started = false;
  let moving = false;
  /** An idle clip is looping. */
  let sitting = false;
  /** Which idle is playing, and for how long it has been. */
  let idleIndex = 0;
  let idleFor = 0;
  /** The locomotion clip currently running — walk or run, never both. */
  let gait: AnimationGroup | null = null;
  /** A gait frozen on its neutral frame as a stand-in stand; see standDown. */
  let pausedStand: AnimationGroup | null = null;
  /** Which side of the run band we are on; see RUN_ENTER_M / RUN_EXIT_M. */
  let running = false;

  /**
   * Adopt the at-heel look NOW — on the stop edge and at spawn.
   *
   * Idle clips start immediately: the blend (see loadModel) carries the pet
   * from its last stride frame into the loop, and the first idle is a stand
   * everywhere in the roster, so there is no instant-sit glitch to debounce.
   *
   * A gait-only single model (the corgi — one walk cycle, nothing else) has
   * no idle to start and must NOT fall back to the bind pose: its export's
   * rest is visibly bigger than its clip poses (the fitClips story), so the
   * old returnToRest stand popped a size change on every stop. Freezing the
   * gait on its most-gathered sampled frame keeps pose AND scale on the same
   * timeline the pet just walked.
   */
  const standDown = (): void => {
    if (idles.length > 0) {
      sitting = true;
      idleIndex = 0;
      idleFor = 0;
      idles[0]!.start(true);
      return;
    }
    const stand = walkNode ? null : (walk ?? run);
    if (stand) {
      // Blending OFF for the freeze: goToFrame with blending on evaluates as a
      // partial blend FROM the pose the bones currently hold (the same trap the
      // load-time sampler documents) — and a paused group never advances the
      // blend, so the stand froze at ~92% of the previous pose. At spawn that
      // pose is the corgi's rest — the ~33%-bigger export artifact — which is
      // exactly the "idle is bigger than the walk" report. Frame-exact freeze
      // here; the moving edge restores blending before the gait starts, so the
      // walk still eases out of the stand.
      stand.enableBlending = false;
      stand.start(false);
      stand.pause();
      stand.goToFrame(neutralFrame.get(stand) ?? stand.from);
      pausedStand = stand;
    } else {
      // Split-duty pets show their idle MODEL instead; its skeleton (if any)
      // rests, which is that model's authored stand.
      idleSkeleton?.returnToRest();
    }
  };

  // Spawn is at heel by construction — the first tick sets the pet ON its
  // target — so adopt the stand now, not after a first imaginary chase.
  standDown();

  const tick = (): void => {
    const dt = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
    // The hero faces -Z at yaw 0 (every shipped rig does), so his forward is
    // -(sin ry, cos ry) and his left is the perpendicular of that.
    const ry = hero.node.rotation.y;
    const fx = -Math.sin(ry);
    const fz = -Math.cos(ry);
    target.set(
      hero.node.position.x - fx * HEEL_BACK - fz * HEEL_SIDE,
      0,
      hero.node.position.z - fz * HEEL_BACK + fx * HEEL_SIDE
    );

    if (!started) {
      started = true;
      root.position.copyFrom(target);
      root.rotation.y = ry;
    }

    const dx = target.x - root.position.x;
    const dz = target.z - root.position.z;
    const dist = Math.hypot(dx, dz);
    // Hysteresis: break into a walk past CATCH_UP_M, keep walking down to
    // STOP_M — see STOP_M for why the two thresholds differ.
    const wantMove = dist > (moving ? STOP_M : CATCH_UP_M);

    if (dist > SNAP_M) {
      root.position.copyFrom(target);
    } else if (wantMove) {
      // Chase gain rises with the gap so a sprinting hero is not slowly lost,
      // and the step is distance-capped so the pet never outruns its own gait.
      const k = Math.min(1, dt * (2.2 + dist * 2.4));
      root.position.x += dx * k;
      root.position.z += dz * k;
      // Face the way it is travelling, not the way the hero is: a dog that
      // strafes sideways to keep the hero's facing reads as a hovering prop.
      root.rotation.y = lerpAngle(root.rotation.y, Math.atan2(dx, dz) + Math.PI + modelYaw, Math.min(1, dt * 8));
    } else {
      // At heel: settle onto the hero's facing so they stand as a pair.
      root.rotation.y = lerpAngle(root.rotation.y, ry + modelYaw, Math.min(1, dt * 4));
    }

    // Stand on the ground that is actually there — the paws sit at local y=0,
    // so the node's y IS the ground height under the pet's own feet.
    root.position.y = opts.heightAt?.(root.position.x, root.position.z) ?? 0;

    if (wantMove !== moving) {
      moving = wantMove;
      if (moving) {
        // A paused stand-in is the same group the gait logic below is about
        // to start — stop() resets it so start() takes, and the blending that
        // standDown switched off comes back so the stride blends in.
        if (pausedStand) {
          pausedStand.stop();
          pausedStand.enableBlending = true;
          pausedStand = null;
        }
        if (sitting) {
          sitting = false;
          idles[idleIndex]?.stop();
        }
        if (walkNode && idleNode) {
          // Reset the hidden idle model to its bind pose while nobody can see
          // it — otherwise it reappears frozen wherever the sit loop left it.
          idleSkeleton?.returnToRest();
          idleNode.setEnabled(false);
          walkNode.setEnabled(true);
        }
      } else {
        gait?.stop();
        gait = null;
        if (walkNode && idleNode) {
          walkNode.setEnabled(false);
          idleNode.setEnabled(true);
        }
        standDown();
      }
    }

    if (moving) {
      // Walk closes a small gap; run closes a large one. A pet with only one
      // locomotion clip uses it for both — the husky and cat ship `run` alone,
      // and the speed ratio below is what makes it read as a trot up close.
      // Which side of the band we are on only changes on a crossing, so a gap
      // resting inside it keeps whatever gait it arrived with.
      if (dist > RUN_ENTER_M) running = true;
      else if (dist < RUN_EXIT_M) running = false;
      const want = (running ? (run ?? walk) : (walk ?? run)) ?? null;
      if (want !== gait) {
        gait?.stop();
        gait = want;
        gait?.start(true);
      }
      // Gait speed tracks how hard it is chasing, so a trot and a scramble are
      // not the same animation played at one rate.
      if (gait) gait.speedRatio = Math.min(2.2, Math.max(0.9, dist * 2.6));
    } else if (sitting && idles.length > 1) {
      // The idle itself started on the stop edge (standDown); all that is
      // left per-frame is the alternation between idles.
      idleFor += dt;
      if (idleFor >= idleHold(idles[idleIndex]!)) {
        idles[idleIndex]!.stop();
        idleIndex = (idleIndex + 1) % idles.length;
        idleFor = 0;
        idles[idleIndex]!.start(true);
      }
    }
  };

  return {
    tick,
    dispose: () => {
      for (const g of imported) g.dispose(); // stops them too
      root.dispose(false, true);
    },
  };
}

/**
 * The pet SLOT: whatever the wardrobe says should be at this hero's heel,
 * kept live for the life of the scene.
 *
 * The old call sites read `petForHero` once at scene build, so equipping or
 * unequipping in the Pet Park did nothing until the next scene rebuild — the
 * panel showed "Equipped" while the dog stood there anyway. This subscribes
 * to the wardrobe and swaps the follower the moment the loadout changes:
 * unequip disposes it immediately, equip spawns the new pet in place.
 *
 * Synchronous on purpose (the async model load happens behind the ticker), so
 * scene factories can call it without awaiting. Generation counting guards
 * the load races: a swap mid-load orphans the old request's result, which is
 * disposed on arrival instead of leaking into the scene.
 */
export function createPetSlot(
  scene: Scene,
  hero: PetAnchor,
  heroId: string,
  opts: PetFollowerOpts = {}
): PetHandle {
  let current: PetHandle | null = null;
  let currentId: string | null = null;
  let generation = 0;
  let disposed = false;

  const apply = (): void => {
    const petId = disposed ? null : petForHero(heroId);
    if (petId === currentId) return;
    currentId = petId;
    const gen = ++generation;
    current?.dispose();
    current = null;
    if (!petId) return;
    void createPetFollower(scene, hero, petId, opts).then((pet) => {
      if (!pet) return;
      // The slot moved on (another swap, or the scene died) while the glb
      // was in flight — this result belongs to nobody.
      if (disposed || gen !== generation) {
        pet.dispose();
        return;
      }
      current = pet;
    });
  };

  const offWardrobe = wardrobe.onChange(apply);
  apply();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    offWardrobe();
    generation++;
    current?.dispose();
    current = null;
  };
  scene.onDisposeObservable.add(dispose);

  return { tick: () => current?.tick(), dispose };
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
