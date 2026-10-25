import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { TrailMesh } from "@babylonjs/core/Meshes/trailMesh";

import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";

import { createSoftRingTexture } from "./softSprites";
import type { ProjectileDressingKind } from "./projectileDressings";

/**
 * Cast projectiles — the travel layer between a cast and its target.
 *
 * Two fire modes:
 *
 *  - UNTARGETED (hub): no `target` in the spec — the projectile takes a random
 *    heading inside a front cone off the hero's facing and fades at `lifeSec`.
 *  - HOMING (arena): `target` set — the player never aims; the projectile
 *    steers itself onto the target every frame and lands with an impact flash
 *    plus the spec's `onHit` callback (the fight sim applies damage there, so
 *    the HP bar moves exactly when the hit reads).
 *
 *  - Basic attack: small and fast — a blue bolt by default; Pavlov flies his
 *    NS bell and Freud a smoke ring instead (see `dressing`).
 *  - Palette 1-5: a larger, slower orb tinted per psychosexual stage, with a
 *    gentle wobble and a colour-matched trail.
 *  - E / R / F are self effects and launch nothing.
 *
 * A fixed pool of orbs + trails is created once and re-armed per cast; one
 * onBeforeRenderObservable moves the live ones, so an idle hero costs nothing.
 * A second tiny pool of billboard ring sprites plays the impact flashes.
 */

export interface ProjectileSpec {
  /** Emissive colour of orb and trail. */
  color: Color3;
  /** Orb diameter in metres. */
  size: number;
  /** Flight speed in m/s. */
  speed: number;
  /** Seconds before the projectile fades out (caps a homing flight too). */
  lifeSec: number;
  /** Sideways wobble amplitude in metres (0 = dead straight). */
  wobble?: number;
  /** Random yaw spread (radians, ±) around the hero's facing. Untargeted only. */
  spread?: number;
  /**
   * Homing destination — a fixed point or a live accessor for a moving boss.
   * When set, `spread` is ignored: casts auto-aim, the player never does.
   */
  target?: Vector3 | (() => Vector3);
  /** Distance at which the projectile counts as landed (default 1.2 m). */
  hitRadius?: number;
  /** Fired once on landing, with the impact point. No hit, no call. */
  onHit?: (pos: Vector3) => void;
  /**
   * Fly a procedural prop instead of the emissive orb. The orb still carries
   * the flight (and the trail); the prop rides it.
   *
   *  - "steak": Pavlov's UCS — the food itself, tumbling end over end.
   *  - "bell":  Pavlov's basic attack — the little NS bell, spinning as it
   *             flies, the same spin language as the CS ring fan.
   *  - "smoke": Freud's basic attack — a grey smoke ring blown at the target,
   *             expanding and thinning like cigar smoke as it drifts.
   *  - Erikson's set, the life cycle in four props:
   *    "hourglass" the add-on basic — a small cyan glass hourglass (his
   *                charm), tumbling end over end;
   *    "lifering"  key 1, Life Stage — an amber clock face, one stage on its axis;
   *    "gem"       key 2, Virtue — a spinning gold bipyramid, the virtue the
   *                stage yields;
   *    "spiral"    F, Life Review — three nested rings (amber, gold, cyan)
   *                spinning on three axes around a white-gold core, a whole
   *                life cycle turning at once.
   *  - "schema" / "balance": Piaget's geometric seed and formal balance.
   *  - "echo" / "reproduction": Bandura's mirrored model and copied forms.
   *  - "thread" / "heart" / "locket": Ainsworth's sensitivity and security.
   */
  dressing?: DressingKind;
}

export type DressingKind =
  | "steak"
  | "bell"
  | "smoke"
  | "hourglass"
  | "lifering"
  | "gem"
  | "spiral"
  | "heart"
  | "locket"
  | ProjectileDressingKind;

const isLazyDressing = (kind: DressingKind | undefined): kind is ProjectileDressingKind =>
  kind === "schema" || kind === "balance" || kind === "echo" || kind === "reproduction" || kind === "thread";

export interface CastProjectiles {
  fire(spec: ProjectileSpec): void;
}

const POOL = 12;
const IMPACT_POOL = 8;
/** Seconds an impact flash lives: fast swell, fast fade. */
const IMPACT_LIFE = 0.32;

interface Pooled {
  orb: Mesh;
  mat: StandardMaterial;
  trail: TrailMesh;
  trailMat: StandardMaterial;
  dir: Vector3;
  side: Vector3;
  origin: Vector3;
  speed: number;
  life: number;
  age: number;
  wobble: number;
  active: boolean;
  target: Vector3 | (() => Vector3) | null;
  hitRadius: number;
  onHit: ((pos: Vector3) => void) | null;
  /** Dressing rigs, built lazily the first time this slot flies each kind. */
  rigs: Partial<Record<DressingKind, DressingRig>>;
  dressing: DressingKind | null;
  /** Trail alpha at full strength — dressings tone it down (smoke barely trails). */
  trailBase: number;
}

interface DressingRig {
  root: TransformNode;
  spin: TransformNode;
  mats: StandardMaterial[];
}

interface PooledImpact {
  quad: Mesh;
  mat: StandardMaterial;
  age: number;
  active: boolean;
}

export function createCastProjectiles(scene: Scene, hero: TransformNode): CastProjectiles {
  const pool: Pooled[] = [];
  for (let i = 0; i < POOL; i++) {
    // `freud` in the name lands on the hub's shadow-caster denylist, like the
    // rest of the cast VFX.
    const orb = MeshBuilder.CreateSphere(`freudProj_orb_${i}`, { diameter: 1, segments: 8 }, scene);
    orb.isPickable = false;
    const mat = new StandardMaterial(`freudProj_orbMat_${i}`, scene);
    mat.disableLighting = true;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableDepthWrite = true;
    orb.material = mat;

    const trail = new TrailMesh(
      `freudProj_trail_${i}`,
      orb,
      scene,
      { diameter: 0.1, length: 10, segments: 10, doNotTaper: false, autoStart: false }
    );
    trail.isPickable = false;
    const trailMat = new StandardMaterial(`freudProj_trailMat_${i}`, scene);
    trailMat.disableLighting = true;
    trailMat.diffuseColor = Color3.Black();
    trailMat.specularColor = Color3.Black();
    trailMat.disableDepthWrite = true;
    trail.material = trailMat;

    orb.setEnabled(false);
    trail.setEnabled(false);
    pool.push({
      orb,
      mat,
      trail,
      trailMat,
      dir: Vector3.Zero(),
      side: Vector3.Zero(),
      origin: Vector3.Zero(),
      speed: 0,
      life: 0,
      age: 0,
      wobble: 0,
      active: false,
      target: null,
      hitRadius: 1.2,
      onHit: null,
      rigs: {},
      dressing: null,
      trailBase: 0.55,
    });
  }

  // Dressing props: primitives only, same unlit-emissive recipe as everything
  // else in vfx/. Built in orb-local units (the orb is scaled to spec.size)
  // and parented to the orb: the flight/trail/impact machinery never notices.
  const dressMat = (name: string, tint: Color3): StandardMaterial => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor = tint;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    return m;
  };
  const finishRig = (
    p: Pooled,
    root: TransformNode,
    spin: TransformNode,
    meshes: Mesh[],
    mats: StandardMaterial[]
  ): DressingRig => {
    root.parent = p.orb;
    for (const mesh of meshes) {
      mesh.parent = spin;
      mesh.isPickable = false;
      mesh.applyFog = false;
      (mesh.material as StandardMaterial).forceCompilation(mesh);
    }
    return { root, spin, mats };
  };

  // The UCS beef steak: meat slab with a fat cap, boneless (the bone read as
  // a dog toy, not dinner). Oversized, but only mildly — at 1.1 the cut still
  // carries past the arena camera without dwarfing the hero.
  const buildSteak = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`freudProj_steakRoot_${i}`, scene);
    const spin = new TransformNode(`freudProj_steakSpin_${i}`, scene);
    spin.parent = root;
    spin.scaling.setAll(1.1);

    // Kept well under 1.0 — the arena's bloom blows brighter emissives out
    // into a white blob and the cut reads as a light, not a steak.
    const meatMat = dressMat(`freudProj_steakMeat_${i}`, new Color3(0.42, 0.09, 0.06));
    const fatMat = dressMat(`freudProj_steakFat_${i}`, new Color3(0.46, 0.36, 0.22));

    const meat = MeshBuilder.CreateSphere(`freudProj_steakMeatM_${i}`, { diameter: 1, segments: 12 }, scene);
    meat.scaling.set(1.5, 0.45, 2.2); // oval slab, long side down the flight path
    meat.material = meatMat;
    // Fat cap hugging the slab's equator.
    const fat = MeshBuilder.CreateTorus(
      `freudProj_steakFatM_${i}`,
      { diameter: 1.28, thickness: 0.34, tessellation: 24 },
      scene
    );
    fat.scaling.set(1.18, 0.55, 1.72);
    fat.material = fatMat;

    return finishRig(p, root, spin, [meat, fat], [meatMat, fatMat]);
  };

  // The NS bell: crown knob, domed shoulder, flared skirt, mouth rim and a
  // clapper peeking out below. Hangs upright and spins on its own axis in the
  // driver — the same spin the CS ring fan sweeps.
  const buildBell = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`freudProj_bellRoot_${i}`, scene);
    const spin = new TransformNode(`freudProj_bellSpin_${i}`, scene);
    spin.parent = root;
    spin.scaling.setAll(2.0);
    // A touch of lean so the silhouette never degenerates to pure profile.
    root.rotation.z = 0.22;

    // Brass under bloom: brighter than the steak but still shy of 1.0.
    const brassMat = dressMat(`freudProj_bellBrass_${i}`, new Color3(0.92, 0.74, 0.2));
    const rimMat = dressMat(`freudProj_bellRim_${i}`, new Color3(0.68, 0.5, 0.12));
    const clapperMat = dressMat(`freudProj_bellClapper_${i}`, new Color3(0.45, 0.38, 0.28));

    const skirt = MeshBuilder.CreateCylinder(
      `freudProj_bellSkirtM_${i}`,
      { height: 0.9, diameterTop: 0.42, diameterBottom: 1.0, tessellation: 20 },
      scene
    );
    skirt.position.y = 0.05;
    skirt.material = brassMat;
    const dome = MeshBuilder.CreateSphere(`freudProj_bellDomeM_${i}`, { diameter: 0.46, segments: 10 }, scene);
    dome.scaling.set(1, 0.7, 1);
    dome.position.y = 0.52;
    dome.material = brassMat;
    const knob = MeshBuilder.CreateSphere(`freudProj_bellKnobM_${i}`, { diameter: 0.2, segments: 8 }, scene);
    knob.position.y = 0.72;
    knob.material = rimMat;
    const rim = MeshBuilder.CreateTorus(
      `freudProj_bellRimM_${i}`,
      { diameter: 0.98, thickness: 0.13, tessellation: 20 },
      scene
    );
    rim.position.y = -0.4;
    rim.material = rimMat;
    const clapper = MeshBuilder.CreateSphere(`freudProj_bellClapM_${i}`, { diameter: 0.28, segments: 8 }, scene);
    clapper.position.y = -0.5;
    clapper.material = clapperMat;

    return finishRig(p, root, spin, [skirt, dome, knob, rim, clapper], [brassMat, rimMat, clapperMat]);
  };

  // The smoke ring: a fat grey torus facing down the flight path, with a
  // thinner wisp trailing just behind. The driver grows and thins it over the
  // flight — a ring blown from the lips, not a bolt.
  const buildSmoke = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`freudProj_smokeRoot_${i}`, scene);
    const spin = new TransformNode(`freudProj_smokeSpin_${i}`, scene);
    spin.parent = root;

    // Grey, not glowing: low emissive keeps it under the bloom threshold so
    // it reads as smoke among the emissive orbs.
    const puffMat = dressMat(`freudProj_smokePuff_${i}`, new Color3(0.58, 0.6, 0.64));
    const wispMat = dressMat(`freudProj_smokeWisp_${i}`, new Color3(0.42, 0.44, 0.48));

    const ring = MeshBuilder.CreateTorus(
      `freudProj_smokeRingM_${i}`,
      { diameter: 1.5, thickness: 0.42, tessellation: 32 },
      scene
    );
    ring.rotation.x = Math.PI / 2; // torus axis along +Z = the flight path
    ring.material = puffMat;
    const wisp = MeshBuilder.CreateTorus(
      `freudProj_smokeWispM_${i}`,
      { diameter: 1.0, thickness: 0.2, tessellation: 24 },
      scene
    );
    wisp.rotation.x = Math.PI / 2;
    wisp.position.z = -0.4; // lags behind the main ring
    wisp.material = wispMat;

    return finishRig(p, root, spin, [ring, wisp], [puffMat, wispMat]);
  };

  // ---- Erikson's temporal props --------------------------------------------
  const cone = (name: string, top: number, bottom: number, height: number, tess: number): Mesh =>
    MeshBuilder.CreateCylinder(name, { height, diameterTop: top, diameterBottom: bottom, tessellation: tess }, scene);
  const block = (
    name: string,
    options: { size?: number; width?: number; height?: number; depth?: number },
    host: Scene
  ): Mesh => {
    const side = options.size ?? 1;
    const mesh = MeshBuilder.CreateCylinder(
      name,
      { height: options.height ?? side, diameterTop: Math.SQRT2, diameterBottom: Math.SQRT2, tessellation: 4 },
      host
    );
    mesh.scaling.set(options.width ?? side, 1, options.depth ?? side);
    mesh.rotation.y = Math.PI / 4;
    return mesh;
  };

  // The hourglass: two glass cones tip to tip between two caps, a grain of
  // gold sand at the waist. His hourglass charm, thrown.
  const buildHourglass = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`eriksonProj_hgRoot_${i}`, scene);
    const spin = new TransformNode(`eriksonProj_hgSpin_${i}`, scene);
    spin.parent = root;
    spin.scaling.setAll(0.75);
    const glassMat = dressMat(`eriksonProj_hgGlass_${i}`, new Color3(0.35, 0.85, 0.92));
    const capMat = dressMat(`eriksonProj_hgCap_${i}`, new Color3(0.6, 0.95, 1.0));
    const sandMat = dressMat(`eriksonProj_hgSand_${i}`, new Color3(0.95, 0.78, 0.35));
    const upper = cone(`eriksonProj_hgUpM_${i}`, 0.62, 0.05, 0.5, 14);
    upper.position.y = 0.25;
    upper.material = glassMat;
    const lower = cone(`eriksonProj_hgLoM_${i}`, 0.05, 0.62, 0.5, 14);
    lower.position.y = -0.25;
    lower.material = glassMat;
    const capT = cone(`eriksonProj_hgCapT_${i}`, 0.74, 0.74, 0.06, 18);
    capT.position.y = 0.52;
    capT.material = capMat;
    const capB = cone(`eriksonProj_hgCapB_${i}`, 0.74, 0.74, 0.06, 18);
    capB.position.y = -0.52;
    capB.material = capMat;
    const sand = MeshBuilder.CreateSphere(`eriksonProj_hgSandM_${i}`, { diameter: 0.16, segments: 6 }, scene);
    sand.position.y = -0.38;
    sand.material = sandMat;
    const rails = [-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) => {
        const rail = block(
          `eriksonProj_hgRailM_${i}_${sx}_${sz}`,
          { width: 0.035, height: 1.0, depth: 0.035 },
          scene
        );
        rail.position.set(sx * 0.25, 0, sz * 0.25);
        rail.material = capMat;
        return rail;
      })
    );
    return finishRig(p, root, spin, [upper, lower, capT, capB, sand, ...rails], [glassMat, capMat, sandMat]);
  };

  // Life Stage: a clock face with an angular centre, one hand and four ticks.
  const buildLifeRing = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`eriksonProj_lrRoot_${i}`, scene);
    const spin = new TransformNode(`eriksonProj_lrSpin_${i}`, scene);
    spin.parent = root;
    root.rotation.z = 0.5; // a tilted orbit reads at every camera angle
    const coreMat = dressMat(`eriksonProj_lrCore_${i}`, new Color3(1.0, 0.6, 0.3));
    const ringMat = dressMat(`eriksonProj_lrRing_${i}`, new Color3(1.0, 0.75, 0.45));
    const core = block(`eriksonProj_lrCoreM_${i}`, { size: 0.24 }, scene);
    core.rotation.z = Math.PI / 4;
    core.material = coreMat;
    const hand = block(`eriksonProj_lrHandM_${i}`, { width: 0.04, height: 0.38, depth: 0.04 }, scene);
    hand.position.y = 0.15;
    hand.rotation.z = -0.45;
    hand.material = coreMat;
    const ring = MeshBuilder.CreateTorus(`eriksonProj_lrRingM_${i}`, { diameter: 1.0, thickness: 0.055, tessellation: 28 }, scene);
    ring.material = ringMat;
    const ticks = [0, 1, 2, 3].map((k) => {
      const angle = k * Math.PI / 2;
      const tick = block(`eriksonProj_lrTickM_${i}_${k}`, { width: 0.045, height: 0.14, depth: 0.045 }, scene);
      tick.position.set(Math.sin(angle) * 0.5, Math.cos(angle) * 0.5, 0);
      tick.rotation.z = -angle;
      tick.material = ringMat;
      return tick;
    });
    return finishRig(p, root, spin, [core, hand, ring, ...ticks], [coreMat, ringMat]);
  };

  // Virtue: a gold bipyramid gem.
  const buildGem = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`eriksonProj_gemRoot_${i}`, scene);
    const spin = new TransformNode(`eriksonProj_gemSpin_${i}`, scene);
    spin.parent = root;
    spin.scaling.setAll(0.8);
    const gemMat = dressMat(`eriksonProj_gemMat_${i}`, new Color3(1.0, 0.82, 0.32));
    const girdleMat = dressMat(`eriksonProj_gemGirdle_${i}`, new Color3(1.0, 0.95, 0.7));
    const crown = cone(`eriksonProj_gemCrownM_${i}`, 0.0, 0.8, 0.42, 6);
    crown.position.y = 0.21;
    crown.material = gemMat;
    const pavilion = cone(`eriksonProj_gemPavM_${i}`, 0.8, 0.0, 0.62, 6);
    pavilion.position.y = -0.31;
    pavilion.material = gemMat;
    const girdle = MeshBuilder.CreateTorus(`eriksonProj_gemGirdleM_${i}`, { diameter: 0.8, thickness: 0.05, tessellation: 6 }, scene);
    girdle.material = girdleMat;
    return finishRig(p, root, spin, [crown, pavilion, girdle], [gemMat, girdleMat]);
  };

  // Life Review: three nested rings on three axes around a bright core.
  const buildSpiral = (p: Pooled, i: number): DressingRig => {
    const root = new TransformNode(`eriksonProj_spRoot_${i}`, scene);
    const spin = new TransformNode(`eriksonProj_spSpin_${i}`, scene);
    spin.parent = root;
    spin.scaling.setAll(1.5);
    const coreMat = dressMat(`eriksonProj_spCore_${i}`, new Color3(1.0, 0.92, 0.65));
    const mats = [
      dressMat(`eriksonProj_spA_${i}`, new Color3(1.0, 0.6, 0.3)),
      dressMat(`eriksonProj_spB_${i}`, new Color3(1.0, 0.82, 0.35)),
      dressMat(`eriksonProj_spC_${i}`, new Color3(0.4, 0.9, 0.95)),
    ];
    const core = block(`eriksonProj_spCoreM_${i}`, { size: 0.3 }, scene);
    core.rotation.set(Math.PI / 4, Math.PI / 4, 0);
    core.material = coreMat;
    const rings = [1.3, 1.0, 0.72].map((d, k) => {
      const r = MeshBuilder.CreateTorus(`eriksonProj_spRingM_${i}_${k}`, { diameter: d, thickness: 0.06, tessellation: 32 }, scene);
      r.material = mats[k]!;
      r.rotation.set(k * 1.05, k * 0.6, k * 0.35);
      return r;
    });
    return finishRig(p, root, spin, [core, ...rings], [coreMat, ...mats]);
  };

  // Ainsworth's heart-in-shield (her brooch; gold for the Earned Security
  // locket): two spheres and a cone make the heart, a thin disc the shield.
  const buildHeart = (gold: boolean) => (p: Pooled, i: number): DressingRig => {
    const tag = gold ? "lk" : "ht";
    const root = new TransformNode(`ainsworthProj_${tag}Root_${i}`, scene);
    const spin = new TransformNode(`ainsworthProj_${tag}Spin_${i}`, scene);
    spin.parent = root;
    spin.scaling.setAll(gold ? 1.25 : 0.8);
    const heartMat = dressMat(`ainsworthProj_${tag}Heart_${i}`, gold ? new Color3(1.0, 0.82, 0.35) : new Color3(0.35, 0.95, 1.0));
    const shieldMat = dressMat(`ainsworthProj_${tag}Shield_${i}`, gold ? new Color3(1.0, 0.92, 0.6) : new Color3(0.12, 0.55, 0.62));
    const lobes = [-1, 1].map((sx) => {
      const m = MeshBuilder.CreateSphere(`ainsworthProj_${tag}LobeM_${i}_${sx}`, { diameter: 0.34, segments: 10 }, scene);
      m.position.set(sx * 0.12, 0.08, 0);
      m.material = heartMat;
      return m;
    });
    const tip = cone(`ainsworthProj_${tag}TipM_${i}`, 0.5, 0.0, 0.36, 16);
    tip.position.y = -0.14;
    tip.scaling.z = 0.6;
    tip.material = heartMat;
    const shield = cone(`ainsworthProj_${tag}ShieldM_${i}`, 0.78, 0.78, 0.04, 6);
    shield.rotation.x = Math.PI / 2; // face along the flight path
    shield.position.z = -0.08;
    shield.material = shieldMat;
    return finishRig(p, root, spin, [...lobes, tip, shield], [heartMat, shieldMat]);
  };

  const RIG_BUILDERS: Partial<Record<DressingKind, (p: Pooled, i: number) => DressingRig>> = {
    heart: buildHeart(false),
    locket: buildHeart(true),
    steak: buildSteak,
    bell: buildBell,
    smoke: buildSmoke,
    hourglass: buildHourglass,
    lifering: buildLifeRing,
    gem: buildGem,
    spiral: buildSpiral,
  };

  const pendingDressingCasts: ProjectileSpec[] = [];
  let lazyDressingFailed = false;
  import("./projectileDressings")
    .then((m) => {
      const builders = m.createProjectileDressingBuilders(scene);
      for (const kind of Object.keys(builders) as ProjectileDressingKind[]) {
        const build = builders[kind];
        RIG_BUILDERS[kind] = (p, i) => build(p.orb, i);
      }
      for (const spec of pendingDressingCasts.splice(0)) fire(spec);
    })
    .catch((err: unknown) => {
      lazyDressingFailed = true;
      console.warn("[vfx] projectile dressings failed to load:", err);
      for (const spec of pendingDressingCasts.splice(0)) fire({ ...spec, dressing: undefined });
    });

  // Impact flashes: billboarded soft rings that swell and fade on the boss.
  const impacts: PooledImpact[] = [];
  const impactTex = createSoftRingTexture(scene, "freudProj_impactTex", 128, 0.18, 0.1, 0.28, 0.42);
  for (let i = 0; i < IMPACT_POOL; i++) {
    const quad = MeshBuilder.CreatePlane(`freudProj_impact_${i}`, { size: 1 }, scene);
    quad.isPickable = false;
    quad.billboardMode = Mesh.BILLBOARDMODE_ALL;
    const mat = new StandardMaterial(`freudProj_impactMat_${i}`, scene);
    mat.disableLighting = true;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveTexture = impactTex;
    mat.opacityTexture = impactTex;
    mat.disableDepthWrite = true;
    quad.material = mat;
    quad.setEnabled(false);
    impacts.push({ quad, mat, age: 0, active: false });
  }

  const impact = (pos: Vector3, color: Color3, size: number): void => {
    const f = impacts.find((q) => !q.active) ?? impacts[0]!;
    f.quad.position.copyFrom(pos);
    f.quad.scaling.setAll(size);
    f.mat.emissiveColor = color.clone();
    f.mat.alpha = 0.95;
    f.age = 0;
    f.quad.setEnabled(true);
    f.active = true;
  };

  const fwd = Vector3.Zero();
  const aim = Vector3.Zero();
  const dressAim = Vector3.Zero();
  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.1);
    for (const p of pool) {
      if (!p.active) continue;
      p.age += dt;
      const u = p.age / p.life;
      if (u >= 1) {
        p.active = false;
        p.onHit = null;
        p.trail.stop();
        p.orb.setEnabled(false);
        p.trail.setEnabled(false);
        continue;
      }
      if (p.target) {
        // Auto-aim: re-steer onto the (possibly moving) target every frame.
        const dest = typeof p.target === "function" ? p.target() : p.target;
        dest.subtractToRef(p.orb.position, aim);
        const dist = aim.length();
        if (dist <= p.hitRadius) {
          impact(p.orb.position, p.mat.emissiveColor, Math.max(1.6, p.orb.scaling.x * 9));
          p.onHit?.(p.orb.position.clone());
          p.active = false;
          p.onHit = null;
          p.trail.stop();
          p.orb.setEnabled(false);
          p.trail.setEnabled(false);
          continue;
        }
        aim.normalizeToRef(p.dir);
        p.side.set(-p.dir.z, 0, p.dir.x);
      }
      p.orb.position.addInPlace(p.dir.scale(p.speed * dt));
      if (p.wobble > 0) {
        const sway = Math.sin(p.age * 9) * p.wobble * dt;
        p.orb.position.addInPlace(p.side.scale(sway));
      }
      // Fade out over the last third of the flight.
      const fade = u < 0.66 ? 1 : 1 - (u - 0.66) / 0.34;
      p.mat.alpha = fade;
      p.trailMat.alpha = p.trailBase * fade;
      const rig = p.dressing ? p.rigs[p.dressing] : undefined;
      if (rig) {
        let dressFade = fade;
        if (p.dressing === "steak") {
          // Nose down the flight path (the orb itself never rotates, so
          // parent space == world space here), tumbling end over end.
          dressAim.copyFrom(p.dir);
          rig.root.lookAt(dressAim);
          rig.spin.rotation.x += dt * 8;
        } else if (p.dressing === "bell") {
          // Upright, spinning on its own axis — the CS fan's spin, handheld.
          rig.spin.rotation.y += dt * 7;
        } else if (p.dressing === "hourglass") {
          // End over end, the sand flipping with every turn.
          rig.spin.rotation.z += dt * 6;
        } else if (p.dressing === "lifering") {
          // The ring orbits its core; the tilt on the root keeps it legible.
          rig.spin.rotation.y += dt * 9;
        } else if (p.dressing === "gem") {
          // A fast jeweller's spin, with a slow bob so the facets flash.
          rig.spin.rotation.y += dt * 11;
          rig.spin.position.y = Math.sin(p.age * 12) * 0.06;
        } else if (p.dressing === "heart" || p.dressing === "locket") {
          // A heartbeat: a slow turn, and a double pulse twice a second.
          rig.spin.rotation.y += dt * 2.4;
          const beat = Math.max(0, Math.sin(p.age * 12.6)) ** 6;
          rig.spin.scaling.setAll((p.dressing === "locket" ? 1.25 * (1 + u * 0.5) : 0.8) * (1 + beat * 0.22));
        } else if (p.dressing === "spiral") {
          // Three rings, three axes: the whole cycle turning at once, and
          // swelling as it closes on the target.
          rig.spin.rotation.x += dt * 3.1;
          rig.spin.rotation.y += dt * 4.3;
          rig.spin.rotation.z += dt * 1.7;
          rig.spin.scaling.setAll(1.5 * (1 + u * 0.6));
        } else if (p.dressing === "schema") {
          dressAim.copyFrom(p.dir);
          rig.root.lookAt(dressAim);
          rig.spin.rotation.y += dt * 4.2;
          rig.spin.rotation.z += dt * 1.4;
        } else if (p.dressing === "balance") {
          rig.spin.rotation.y += dt * 1.8;
          rig.spin.rotation.z = Math.sin(p.age * 5) * 0.16;
          rig.spin.scaling.setAll(1.15 + u * 0.25);
        } else if (p.dressing === "echo") {
          dressAim.copyFrom(p.dir);
          rig.root.lookAt(dressAim);
          rig.spin.rotation.z += dt * 2.2;
          rig.spin.scaling.set(1 + Math.sin(p.age * 10) * 0.1, 1, 1);
        } else if (p.dressing === "reproduction") {
          rig.spin.rotation.y += dt * 4.5;
          rig.spin.rotation.z = Math.sin(p.age * 6) * 0.14;
          rig.spin.scaling.setAll(1.05 + u * 0.3);
        } else if (p.dressing === "thread") {
          dressAim.copyFrom(p.dir);
          rig.root.lookAt(dressAim);
          rig.spin.rotation.z = Math.sin(p.age * 8) * 0.18;
          rig.spin.scaling.setAll(1 + Math.max(0, Math.sin(p.age * 12.6)) ** 6 * 0.12);
        } else {
          // Smoke: ring plane square to the flight, swelling and thinning as
          // it drifts — the far end of a blown ring's life.
          dressAim.copyFrom(p.dir);
          rig.root.lookAt(dressAim);
          rig.spin.scaling.setAll(3.0 * (1 + u * 0.9));
          dressFade = fade * 0.75 * (1 - 0.45 * u);
        }
        for (const m of rig.mats) m.alpha = dressFade;
      }
    }
    for (const f of impacts) {
      if (!f.active) continue;
      f.age += dt;
      const u = f.age / IMPACT_LIFE;
      if (u >= 1) {
        f.active = false;
        f.quad.setEnabled(false);
        continue;
      }
      const s = f.quad.scaling.x;
      f.quad.scaling.setAll(s + s * 5 * dt);
      f.mat.alpha = 0.95 * (1 - u);
    }
  });

  function fire(spec: ProjectileSpec): void {
      if (isLazyDressing(spec.dressing) && !RIG_BUILDERS[spec.dressing]) {
        if (lazyDressingFailed) spec = { ...spec, dressing: undefined };
        else {
          pendingDressingCasts.push(spec);
          return;
        }
      }
      const p = pool.find((q) => !q.active) ?? pool[0]!;
      p.dressing = spec.dressing ?? null;
      if (p.dressing && !p.rigs[p.dressing]) {
        p.rigs[p.dressing] = RIG_BUILDERS[p.dressing]!(p, pool.indexOf(p));
      }
      // A slot may have flown a different prop last cast — only the live
      // dressing's rig renders.
      for (const [kind, rig] of Object.entries(p.rigs) as [DressingKind, DressingRig][]) {
        rig.root.setEnabled(kind === p.dressing);
      }
      // In dressed mode the orb still flies (and drags the trail) but stays
      // invisible — visibility is not inherited, so the prop renders.
      p.orb.visibility = p.dressing ? 0 : 1;
      p.trailBase = p.dressing === "smoke" ? 0.14 : p.dressing ? 0.3 : 0.48;
      const rig = p.dressing ? p.rigs[p.dressing] : undefined;
      if (rig) {
        for (const m of rig.mats) m.alpha = p.dressing === "smoke" ? 0.75 : 1;
        if (p.dressing === "schema") {
          rig.mats[0]!.emissiveColor = spec.color.scale(0.85);
          rig.mats[1]!.emissiveColor = spec.color.scale(0.5);
        } else if (p.dressing === "heart") {
          rig.mats[0]!.emissiveColor = spec.color.scale(0.85);
          rig.mats[1]!.emissiveColor = spec.color.scale(0.42);
        }
        if (p.dressing === "steak") rig.spin.rotation.x = Math.random() * Math.PI * 2;
        if (p.dressing === "bell") rig.spin.rotation.y = Math.random() * Math.PI * 2;
        if (p.dressing === "smoke") rig.spin.scaling.setAll(3.0);
        if (p.dressing === "spiral") rig.spin.scaling.setAll(1.5);
        if (p.dressing === "balance") rig.spin.scaling.setAll(1.15);
        if (p.dressing === "echo" || p.dressing === "thread") rig.spin.scaling.setAll(1);
        if (p.dressing === "reproduction") rig.spin.scaling.setAll(1.05);
      }
      // Same launch convention as the ult eye in freudCasts: the Tripo model
      // looks down the wrapper's -Z, so visible "forward" is Backward().
      hero.getDirection(Vector3.Backward()).normalizeToRef(fwd);
      fwd.y = 0;
      fwd.normalize();

      p.target = spec.target ?? null;
      p.hitRadius = spec.hitRadius ?? 1.2;
      p.onHit = spec.onHit ?? null;

      if (p.target) {
        // Homing: initial heading straight at the target, no spread.
        const dest = typeof p.target === "function" ? p.target() : p.target;
        const h0 = hero.getAbsolutePosition();
        p.origin.set(h0.x, h0.y + 1.35, h0.z);
        dest.subtractToRef(p.origin, p.dir).normalize();
      } else {
        const spread = spec.spread ?? 0.4;
        const yaw = (Math.random() * 2 - 1) * spread;
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        p.dir.set(fwd.x * cos - fwd.z * sin, 0.06 * Math.random(), fwd.x * sin + fwd.z * cos).normalize();
        const h0 = hero.getAbsolutePosition();
        p.origin.set(h0.x + p.dir.x * 0.5, h0.y + 1.35, h0.z + p.dir.z * 0.5);
      }
      p.side.set(-p.dir.z, 0, p.dir.x);
      p.orb.position.copyFrom(p.origin);

      p.speed = spec.speed;
      p.life = spec.lifeSec;
      p.age = 0;
      p.wobble = spec.wobble ?? 0;
      p.orb.scaling.setAll(spec.size);

      p.mat.emissiveColor = spec.color.clone();
      p.mat.alpha = 1;
      p.trailMat.emissiveColor = spec.color.clone();
      p.trailMat.alpha = p.trailBase;
      p.trail.diameter = spec.size * (p.dressing ? 0.28 : 0.5);

      p.orb.setEnabled(true);
      p.trail.setEnabled(true);
      // Drop the stale ribbon from the orb's previous flight before restarting.
      p.trail.reset();
      p.trail.start();
      p.active = true;
  }

  return { fire };
}
