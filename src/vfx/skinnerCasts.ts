import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { vfxGlowOptions } from "../core/quality";

import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/tubeBuilder";

import { SKINNER_REINFORCEMENT } from "@shared/heroes/skinner";

import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Skinner's cast VFX — the operant chamber as healing light, pure Babylon
 * (meshes + DynamicTexture bakes + one particle system, no assets). He is the
 * HEALER, so nearly everything here is warm and emissive: gold for schedules,
 * green for reinforcement, violet for punishment, cyan for the chamber tech.
 * There are no ally meshes in the solo arena, so team heals draw as
 * hero-centred radiance rather than beams to targets.
 *
 *  - Fixed Ratio (Q):       four pellet orbs pop up around the hero and burst
 *                           outward evenly — reward every Nth press — over an
 *                           expanding gold ground ring.
 *  - Variable Ratio (Q):    the slot machine — three stacked reels spin fast,
 *                           snap to a stop one by one, then a single bright
 *                           payout orb pops skyward. Flashy every time; the
 *                           sim decides jackpots, this layer doesn't know.
 *  - Fixed Interval (Q):    a glowing clock face rises and fades while green
 *                           pulse rings tick out at metronome-even offsets.
 *  - Variable Interval (Q): the same clock with scattered ticks, softer green,
 *                           pulse rings at randomized offsets — you never know
 *                           when the next one lands.
 *  - Defense (E):           the contingency toggle — a cyan holo-card at chest
 *                           height flips 180° with a glint. Short and crisp:
 *                           it's a free toggle pressed constantly.
 *  - Chain (R):             the consequence toggle — the mirrored flip, tinted
 *                           green-to-violet across the turn (reinforcement on
 *                           one face, punishment on the other).
 *  - Ultimate (F):          SHAPING — a holographic pigeon built from
 *                           primitives launches ahead and hops three
 *                           rising-and-falling arcs, each hop larger and
 *                           brighter than the last (successive approximation),
 *                           trailing gold heal sparks, ending in a soft gold
 *                           bloom and triple expanding ground rings.
 *
 * Same lifecycle contract as freudCasts: everything is created once and
 * re-armed per cast, one onBeforeRenderObservable drives whatever is live,
 * every effect self-disables, shaders are force-compiled up front, and every
 * mesh is named skinnerFx_* so the hub's shadow denylist skips it.
 */

/** Palette tints by schedule suffix — the analogue of Freud's STAGE_TINTS. */
export const SKINNER_TINTS: Record<string, Color3> = {
  fixed_ratio: new Color3(1.0, 0.82, 0.48), // pellet gold (#ffd27a)
  variable_ratio: new Color3(0.85, 0.98, 0.45), // jackpot gold-green
  fixed_interval: new Color3(0.45, 1.0, 0.6), // reinforcement green
  variable_interval: new Color3(0.62, 1.0, 0.76), // soft green
};

/** The chamber/pigeon tech is the one cyan thing he does. */
const TECH_TINT = new Color3(0.4, 0.9, 1.0);
const REINFORCE_TINT = new Color3(0.45, 1.0, 0.6);
const PUNISH_TINT = new Color3(0.7, 0.4, 1.0);
const HEAL_GOLD = new Color3(1.0, 0.82, 0.45);
const PIGEON_TINT = new Color3(0.75, 0.97, 1.0);
/** The team-flow streams — reinforcement yellow, brighter than pellet gold. */
const FLOW_TINT = new Color3(1.0, 0.92, 0.32);

/**
 * Every Skinner cast effect draws 50% larger (2026-08-05). Applied at the rig
 * ROOTS so the per-frame drivers, which scale and place CHILDREN, multiply
 * under it untouched. The two exceptions ride the factor inline: the pigeon,
 * whose root scale is runtime-driven, and the spark system, whose particle
 * sizes/box/power ignore node scaling. Flight-path distances stay unscaled —
 * where the pigeon lands is placement, not size.
 */
const FX_SCALE = 1.5;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const sstep = (e0: number, e1: number, x: number): number => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};
const outBack = (u: number): number => {
  const c = 1.70158;
  const v = u - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
};

function fxMat(scene: Scene, name: string, tint: Color3, alpha: number): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.emissiveColor = tint.clone();
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.alpha = alpha;
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  return m;
}

function softDot(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("skinnerFxDot", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * Narrow halo band around a crisp ring — Pavlov's bowl-ring recipe reused for
 * the fixed-ratio ground ring (wide falloffs read as a splotch in the hub's
 * daylight, not a reward circle).
 */
function groundRingTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("skinnerRingTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 40, c, c, c);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.52, "rgba(255,255,255,0)");
  g.addColorStop(0.6, "rgba(255,255,255,0.8)");
  g.addColorStop(0.7, "rgba(255,255,255,0.25)");
  g.addColorStop(0.8, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, 76, 0, Math.PI * 2);
  ctx.stroke();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * The interval clock: bezel, soft inner glow, tick marks — no hands, the
 * PULSES are the hands here. Regular gets four clean quarter ticks (fixed
 * interval); irregular gets scattered uneven ticks (variable interval).
 * White so emissiveColor tints it green.
 */
function clockFaceTexture(scene: Scene, name: string, regular: boolean): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const r = 92;
  // Soft glow behind the face — healer kit, everything radiates.
  const g = ctx.createRadialGradient(c, c, 20, c, c, 124);
  g.addColorStop(0, "rgba(255,255,255,0.35)");
  g.addColorStop(0.7, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Bezel.
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.stroke();
  // Ticks: metronome-even quarters vs a scatter you can't anticipate.
  const angles = regular ? [0, 90, 180, 270] : [18, 74, 131, 166, 224, 262, 331];
  for (const deg of angles) {
    const a = (deg / 180) * Math.PI;
    ctx.lineWidth = regular ? 7 : 4 + (deg % 3) * 1.5;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * (r - 24), c + Math.sin(a) * (r - 24));
    ctx.lineTo(c + Math.cos(a) * (r - 7), c + Math.sin(a) * (r - 7));
    ctx.stroke();
  }
  // Center pin.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(c, c, 9, 0, Math.PI * 2);
  ctx.fill();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * The contingency holo-card: rounded frame, data bars, a status lamp — a
 * settings panel, not a playing card. White so emissive tints cyan/green.
 */
function holoCardTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("skinnerCardTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  // Faint fill so the card reads as a pane, not a wire rectangle.
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.roundRect(28, 20, 200, 216, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 6;
  ctx.stroke();
  // Status lamp — the thing the toggle toggles.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(64, 60, 14, 0, Math.PI * 2);
  ctx.fill();
  // Data bars.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(52, 104 + i * 32, 100 + (i % 2) * 52, 12);
  }
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * Slot reel face: rim + a triangle of pellet dots, so the tumble reads as a
 * spinning symbol wheel and the snap shows a clean face.
 */
function reelTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const tex = new DynamicTexture("skinnerReelTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, 54, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * 26, c + Math.sin(a) * 26, 11, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

export function createSkinnerSkillVfx(
  scene: Scene,
  hero: TransformNode,
  /**
   * Live chest points of the caster's teammates. Optional: the hub and the
   * practice booth are solo, and there the schedules keep their hero-centred
   * radiance with no streams.
   */
  allies?: () => Vector3[]
): FreudSkillVfx {
  // ---- Fixed Ratio: pellet ring + gold ground ring ------------------------
  const pelletRoot = new TransformNode("skinnerFx_pelletRoot", scene);
  pelletRoot.parent = hero;
  pelletRoot.scaling.setAll(FX_SCALE);
  const pelletMat = fxMat(scene, "skinnerFx_pelletMat", HEAL_GOLD, 0.95);
  const pellets: Mesh[] = [];
  const PELLET_COUNT = 4; // one per press of the ratio — the "every 4th" tell
  for (let i = 0; i < PELLET_COUNT; i++) {
    const p = MeshBuilder.CreateSphere("skinnerFx_pellet", { diameter: 0.26, segments: 12 }, scene);
    p.parent = pelletRoot;
    p.isPickable = false;
    p.material = pelletMat;
    pellets.push(p);
  }
  const groundRing = MeshBuilder.CreateDisc(
    "skinnerFx_groundRing",
    { radius: 1.5, tessellation: 48 },
    scene
  );
  groundRing.parent = pelletRoot;
  groundRing.rotation.x = Math.PI / 2;
  groundRing.position.y = 0.07;
  groundRing.isPickable = false;
  const groundRingMat = fxMat(scene, "skinnerFx_groundRingMat", HEAL_GOLD, 1);
  const groundRingTex = groundRingTexture(scene);
  groundRingMat.emissiveTexture = groundRingTex;
  groundRingMat.opacityTexture = groundRingTex;
  groundRing.material = groundRingMat;

  // Shared spark burst — the factory's ONE particle system, recoloured per
  // cast (schedule gold/green, toggle cyan/violet, ult trail gold). Emitter is
  // an invisible box mesh, the ParticleSystem emitter contract.
  const sparkAnchor = MeshBuilder.CreateBox("skinnerFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.0;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("skinnerFx_sparks", 240, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.5, -0.5, -0.5).scaleInPlace(FX_SCALE);
  sparks.maxEmitBox = new Vector3(0.5, 0.5, 0.5).scaleInPlace(FX_SCALE);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.08 * FX_SCALE;
  sparks.maxSize = 0.32 * FX_SCALE;
  sparks.minLifeTime = 0.4;
  sparks.maxLifeTime = 1.0;
  sparks.emitRate = 0; // manual bursts; the ult trail turns this dial up
  sparks.direction1 = new Vector3(-0.6, 0.8, -0.6);
  sparks.direction2 = new Vector3(0.6, 2.4, 0.6);
  sparks.minEmitPower = 0.8 * FX_SCALE;
  sparks.maxEmitPower = 2.4 * FX_SCALE;
  sparks.gravity = new Vector3(0, -0.6, 0);
  sparks.start();

  // ---- Variable Ratio: the slot machine -----------------------------------
  const reelRoot = new TransformNode("skinnerFx_reelRoot", scene);
  reelRoot.parent = hero;
  reelRoot.position.y = 1.1;
  reelRoot.scaling.setAll(FX_SCALE);
  const reelMat = fxMat(scene, "skinnerFx_reelMat", SKINNER_TINTS.variable_ratio!, 0.95);
  const reelTex = reelTexture(scene);
  reelMat.emissiveTexture = reelTex;
  reelMat.opacityTexture = reelTex;
  const reels: Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const reel = MeshBuilder.CreateDisc("skinnerFx_reel", { radius: 0.34, tessellation: 32 }, scene);
    reel.parent = reelRoot;
    reel.position.y = i * 0.4;
    reel.isPickable = false;
    reel.material = reelMat;
    reels.push(reel);
  }
  // The payout orb — one bright pop, every time. The VFX layer never knows
  // whether the sim rolled a jackpot; it always celebrates.
  const orb = MeshBuilder.CreateSphere("skinnerFx_orb", { diameter: 0.4, segments: 16 }, scene);
  orb.parent = reelRoot;
  orb.isPickable = false;
  const orbMat = fxMat(scene, "skinnerFx_orbMat", new Color3(1.0, 0.95, 0.7), 0);
  orb.material = orbMat;
  // Reels tumble around a horizontal diameter, then snap. Snap times/speeds
  // are fixed so the end rotation is computable up front — no RNG, no drift.
  const REEL_SNAPS = [0.35, 0.5, 0.65];
  const REEL_SPEEDS = [14, -17, 20];
  const REEL_END_ROT = REEL_SNAPS.map((s, i) => (s * REEL_SPEEDS[i]!) % (Math.PI * 2));

  // ---- Fixed/Variable Interval: clock + pulse rings -----------------------
  const clockRoot = new TransformNode("skinnerFx_clockRoot", scene);
  clockRoot.parent = hero;
  clockRoot.scaling.setAll(FX_SCALE);
  const clockFixed = MeshBuilder.CreatePlane("skinnerFx_clockFixed", { size: 1.9 }, scene);
  const clockVar = MeshBuilder.CreatePlane("skinnerFx_clockVar", { size: 1.9 }, scene);
  const clockFixedMat = fxMat(scene, "skinnerFx_clockFixedMat", SKINNER_TINTS.fixed_interval!, 1);
  const clockVarMat = fxMat(scene, "skinnerFx_clockVarMat", SKINNER_TINTS.variable_interval!, 1);
  const clockFixedTex = clockFaceTexture(scene, "skinnerClockFixedTex", true);
  const clockVarTex = clockFaceTexture(scene, "skinnerClockVarTex", false);
  for (const [mesh, mat, tex] of [
    [clockFixed, clockFixedMat, clockFixedTex],
    [clockVar, clockVarMat, clockVarTex],
  ] as const) {
    mesh.parent = clockRoot;
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.isPickable = false;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mesh.material = mat;
  }
  // Pulse rings tick out at ground level. Three tori with their OWN materials
  // — pulses overlap, and alpha lives on the material, so sharing one would
  // yank every live ring to the newest pulse's fade.
  const pulseRoot = new TransformNode("skinnerFx_pulseRoot", scene);
  pulseRoot.parent = hero;
  pulseRoot.position.y = 0.06;
  pulseRoot.scaling.setAll(FX_SCALE);
  const pulseRings: Mesh[] = [];
  const pulseMats: StandardMaterial[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = MeshBuilder.CreateTorus(
      "skinnerFx_pulse",
      { diameter: 1, thickness: 0.06, tessellation: 48 },
      scene
    );
    ring.parent = pulseRoot;
    ring.isPickable = false;
    const mat = fxMat(scene, "skinnerFx_pulseMat", REINFORCE_TINT, 0.85);
    ring.material = mat;
    ring.setEnabled(false);
    pulseRings.push(ring);
    pulseMats.push(mat);
  }

  // ---- Defense + Chain: the contingency/consequence flips -----------------
  // Two separate card rigs: E and R are independent toggles and can overlap.
  // Cards sit at chest height on the visual-forward side (local -Z; the Tripo
  // wrapper's glTF handedness flip — see the pigeon launch below).
  const cardTex = holoCardTexture(scene);
  interface FlipRig {
    root: TransformNode;
    card: Mesh;
    cardMat: StandardMaterial;
    glint: Mesh;
    glintMat: StandardMaterial;
  }
  const makeFlip = (suffix: string, tint: Color3): FlipRig => {
    const root = new TransformNode(`skinnerFx_flipRoot${suffix}`, scene);
    root.parent = hero;
    root.position.set(0, 1.4, -0.9);
    root.scaling.setAll(FX_SCALE);
    const card = MeshBuilder.CreatePlane(`skinnerFx_card${suffix}`, { size: 1.1 }, scene);
    card.parent = root;
    card.isPickable = false;
    const cardMat = fxMat(scene, `skinnerFx_cardMat${suffix}`, tint, 0.9);
    cardMat.emissiveTexture = cardTex;
    cardMat.opacityTexture = cardTex;
    card.material = cardMat;
    // The glint: a thin bright bar that flashes exactly when the card is
    // edge-on and would otherwise vanish — the "flip" beat made visible.
    const glint = MeshBuilder.CreateBox(
      `skinnerFx_glint${suffix}`,
      { width: 0.05, height: 1.15, depth: 0.05 },
      scene
    );
    glint.parent = root;
    glint.isPickable = false;
    const glintMat = fxMat(scene, `skinnerFx_glintMat${suffix}`, new Color3(1, 1, 1), 0);
    glint.material = glintMat;
    return { root, card, cardMat, glint, glintMat };
  };
  const flipE = makeFlip("E", TECH_TINT);
  const flipR = makeFlip("R", REINFORCE_TINT);

  // ---- Ultimate: SHAPING — the holographic pigeon -------------------------
  // Built from primitives, all one emissive cyan-white material, boosted by a
  // GlowLayer. Local +Z is its nose; the root yaws to the hop direction.
  const pigeonRoot = new TransformNode("skinnerFx_pigeonRoot", scene);
  const pigeonMat = fxMat(scene, "skinnerFx_pigeonMat", PIGEON_TINT, 0.95);
  const body = MeshBuilder.CreateSphere("skinnerFx_pigeonBody", { diameter: 1, segments: 16 }, scene);
  body.parent = pigeonRoot;
  body.scaling.set(0.5, 0.45, 0.72);
  const head = MeshBuilder.CreateSphere("skinnerFx_pigeonHead", { diameter: 0.3, segments: 12 }, scene);
  head.parent = pigeonRoot;
  head.position.set(0, 0.32, 0.34);
  const beak = MeshBuilder.CreateCylinder(
    "skinnerFx_pigeonBeak",
    { height: 0.18, diameterBottom: 0.1, diameterTop: 0.001, tessellation: 8 },
    scene
  );
  beak.parent = pigeonRoot;
  beak.rotation.x = Math.PI / 2; // cone tip points down +Z — the nose
  beak.position.set(0, 0.32, 0.52);
  for (const m of [body, head, beak]) {
    m.isPickable = false;
    m.material = pigeonMat;
  }
  // Wings hang off pivots at the shoulder so the flap hinges at the body,
  // not at the wing's own centre.
  const wingPivots: TransformNode[] = [];
  const wings: Mesh[] = [];
  for (const side of [-1, 1]) {
    const pivot = new TransformNode("skinnerFx_wingPivot", scene);
    pivot.parent = pigeonRoot;
    pivot.position.set(side * 0.16, 0.12, 0);
    const wing = MeshBuilder.CreateBox(
      "skinnerFx_wing",
      { width: 0.72, height: 0.04, depth: 0.38 },
      scene
    );
    wing.parent = pivot;
    wing.position.x = side * 0.34;
    wing.isPickable = false;
    wing.material = pigeonMat;
    wingPivots.push(pivot);
    wings.push(wing);
  }
  // Trail emitter rides the pigeon; the ONE spark system points here for the
  // ult's duration, then hands the emitter back to the hero anchor. If a
  // palette burst fires mid-ult its sparks come off the pigeon — for a healer
  // that reads as intended, so it's left alone.
  const trailAnchor = MeshBuilder.CreateBox("skinnerFx_trailAnchor", { size: 0.02 }, scene);
  trailAnchor.parent = pigeonRoot;
  trailAnchor.position.z = -0.4;
  trailAnchor.isVisible = false;

  // The landing celebration: a big soft gold bloom + triple ground rings,
  // world-space at the final hop's touchdown.
  const burstRoot = new TransformNode("skinnerFx_burstRoot", scene);
  burstRoot.scaling.setAll(FX_SCALE);
  const bloom = MeshBuilder.CreatePlane("skinnerFx_bloom", { size: 1 }, scene);
  bloom.parent = burstRoot;
  bloom.billboardMode = Mesh.BILLBOARDMODE_ALL;
  bloom.position.y = 1.1;
  bloom.isPickable = false;
  const bloomMat = fxMat(scene, "skinnerFx_bloomMat", HEAL_GOLD, 0);
  const bloomTex = softDot(scene);
  bloomMat.emissiveTexture = bloomTex;
  bloomMat.opacityTexture = bloomTex;
  bloom.material = bloomMat;
  const ultRings: Mesh[] = [];
  const ultRingMat = fxMat(scene, "skinnerFx_ultRingMat", HEAL_GOLD.scale(1.2), 0.8);
  for (let i = 0; i < 3; i++) {
    const ring = MeshBuilder.CreateTorus(
      "skinnerFx_ultRing",
      { diameter: 1, thickness: 0.08, tessellation: 48 },
      scene
    );
    ring.parent = burstRoot;
    ring.position.y = 0.06;
    ring.isPickable = false;
    ring.material = ultRingMat;
    ultRings.push(ring);
  }

  // ---- Team flow: yellow streams from the healer to every teammate --------
  // Any schedule cast (keys 1-4) pours one arced stream per living ally —
  // world-space tubes rebuilt in place every frame (the nightmare-lightning
  // `instance:` pattern, no per-frame allocation), with two bright beads
  // riding each arc caster→ally so the flow has a direction. Solo play
  // (hub, booth, ranked) has no allies and never lights these.
  const FLOW_LINKS = 3; // full party: tank + healer-station bot + dps
  const FLOW_SEGS = 14;
  const flowMat = fxMat(scene, "skinnerFx_flowMat", FLOW_TINT, 0.85);
  const flowBeadMat = fxMat(scene, "skinnerFx_flowBeadMat", new Color3(1.0, 0.98, 0.7), 0.95);
  const flowLinks: { tube: Mesh; beads: Mesh[]; path: Vector3[] }[] = [];
  for (let i = 0; i < FLOW_LINKS; i++) {
    const path = Array.from({ length: FLOW_SEGS + 1 }, (_, s) => new Vector3(0, 0, s * 0.1));
    const tube = MeshBuilder.CreateTube(
      `skinnerFx_flowTube_${i}`,
      { path, radius: 0.06, tessellation: 6, updatable: true },
      scene
    );
    tube.isPickable = false;
    tube.material = flowMat;
    const beads: Mesh[] = [];
    for (let b = 0; b < 2; b++) {
      const bead = MeshBuilder.CreateSphere(
        `skinnerFx_flowBead_${i}_${b}`,
        { diameter: 0.24, segments: 10 },
        scene
      );
      bead.isPickable = false;
      bead.material = flowBeadMat;
      beads.push(bead);
    }
    flowLinks.push({ tube, beads, path });
  }

  // Bloom restricted to Skinner's own glow-worthy meshes so the rest of the
  // scene stays clean (freudFx_ultGlow precedent) — and this is the healer,
  // so the pellets and payout orb get the boost too, not just the ult. One
  // layer per factory; goes down with the scene. Sized by device tier
  // (core/quality.ts); the low tier skips it and the meshes keep their
  // emissive colour without the bloom.
  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("skinnerFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 1.2;
    for (const m of [body, head, beak, ...wings, bloom, orb, ...pellets]) {
      glow.addIncludedOnlyMesh(m);
    }
    // Beads only: a glowing tube blooms into a white-hot stream and the yellow
    // reads as blown-out light instead of a flow.
    for (const l of flowLinks) {
      for (const b of l.beads) glow.addIncludedOnlyMesh(b);
    }
    scene.onDisposeObservable.add(() => {
      glow.dispose();
    });
  }

  // Everything starts dark.
  pelletRoot.setEnabled(false);
  reelRoot.setEnabled(false);
  clockRoot.setEnabled(false);
  flipE.root.setEnabled(false);
  flipR.root.setEnabled(false);
  pigeonRoot.setEnabled(false);
  burstRoot.setEnabled(false);
  for (const l of flowLinks) {
    l.tube.setEnabled(false);
    for (const b of l.beads) b.setEnabled(false);
  }

  // Compile every effect shader NOW, not on first cast — a still-compiling
  // material renders as nothing (see freudCasts for the full story).
  const warmPairs: [Mesh, StandardMaterial][] = [
    [pellets[0]!, pelletMat],
    [groundRing, groundRingMat],
    [reels[0]!, reelMat],
    [orb, orbMat],
    [clockFixed, clockFixedMat],
    [clockVar, clockVarMat],
    [pulseRings[0]!, pulseMats[0]!],
    [flipE.card, flipE.cardMat],
    [flipR.card, flipR.cardMat],
    [flipE.glint, flipE.glintMat],
    [flipR.glint, flipR.glintMat],
    [body, pigeonMat],
    [bloom, bloomMat],
    [ultRings[0]!, ultRingMat],
    [flowLinks[0]!.tube, flowMat],
    [flowLinks[0]!.beads[0]!, flowBeadMat],
  ];
  for (const [mesh, mat] of warmPairs) {
    mesh.applyFog = false;
    mat.forceCompilation(mesh);
  }
  // Extra pulse materials, and siblings sharing warmed materials — everything
  // still needs the fog opt-out (fog adds a shader define and would recompile
  // on first cast, eating the opening frames).
  for (let i = 1; i < pulseRings.length; i++) {
    pulseRings[i]!.applyFog = false;
    pulseMats[i]!.forceCompilation(pulseRings[i]!);
  }
  for (const m of [...pellets, ...reels, ...ultRings, head, beak, ...wings]) {
    m.applyFog = false;
  }
  for (const l of flowLinks) {
    l.tube.applyFog = false;
    for (const b of l.beads) b.applyFog = false;
  }

  // ---- Per-frame driver ---------------------------------------------------
  let pelletT = -1;
  let reelT = -1;
  let intervalT = -1;
  let intervalVariable = false;
  let pulseOffsets: number[] = [];
  let pulseIdx = 0;
  const pulseT = [-1, -1, -1];
  let orbPopped = false;
  let flipET = -1;
  let flipRT = -1;
  let ultT = -1;
  let ultBloomed = false;
  const ultDir = new Vector3(0, 0, 1);
  const ultOrigin = new Vector3(); // launch point, captured per cast
  let flowT = -1;
  let flowTargets: Vector3[] = []; // live ally chest anchors, captured per cast
  const FLOW_SECS = 1.15;
  const flowFrom = new Vector3();

  const PELLET_SECS = 1.2;
  const REEL_SECS = 1.45;
  // The interval clocks run for the SKILL's whole window, read off the kit
  // spec so the sim and the screen can never disagree — the clock on the
  // ground IS the HoT's lifetime (fixed 8 s, variable 20 s).
  const SCHED = SKINNER_REINFORCEMENT.schedules;
  const INTERVAL_FIXED_SECS = SCHED.fixedInterval.durationMs / 1000;
  const INTERVAL_VAR_SECS = SCHED.variableInterval.durationMs / 1000;
  const FI_PERIOD_SECS = SCHED.fixedInterval.periodMs / 1000;
  const VI_TICK_CHANCE = SCHED.variableInterval.tickChancePerSec;
  const PULSE_SECS = 0.6;
  const FLIP_SECS = 0.5;
  // Three hops of successive approximation — each longer, farther, higher,
  // bigger — then the payoff bloom. ~3 s all told.
  const HOPS = [
    { dur: 0.6, dist: 1.7, height: 0.9, scale: 0.8 },
    { dur: 0.75, dist: 2.5, height: 1.4, scale: 1.1 },
    { dur: 0.9, dist: 3.3, height: 2.0, scale: 1.45 },
  ];
  const HOPS_TOTAL = HOPS.reduce((s, h) => s + h.dur, 0); // 2.25
  const ULT_DIST_TOTAL = HOPS.reduce((s, h) => s + h.dist, 0);
  const BLOOM_SECS = 0.75;
  const ULT_SECS = HOPS_TOTAL + BLOOM_SECS;

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (pelletT >= 0) {
      pelletT += dt;
      const u = clamp01(pelletT / PELLET_SECS);
      if (u >= 1) {
        pelletT = -1;
        pelletRoot.setEnabled(false);
      } else {
        // Pellets pop UP first (the dispenser click), then burst outward
        // evenly — the reward on the Nth press paid out to all four points.
        const rise = outBack(clamp01(pelletT / 0.25));
        const radius = 0.8 + sstep(0.3, 0.85, u) * 2.0;
        for (let i = 0; i < pellets.length; i++) {
          const a = (i / pellets.length) * Math.PI * 2;
          pellets[i]!.position.set(Math.cos(a) * radius, 0.15 + rise * 0.95, Math.sin(a) * radius);
          pellets[i]!.scaling.setAll(Math.max(0.01, rise));
        }
        pelletMat.alpha = 0.95 * (1 - sstep(0.65, 1, u));
        const grow = outBack(clamp01(pelletT / 0.35));
        groundRing.scaling.setAll(Math.max(0.01, grow * 2.0));
        groundRingMat.alpha = 1 - sstep(0.45, 1, u);
      }
    }

    if (reelT >= 0) {
      reelT += dt;
      const u = clamp01(reelT / REEL_SECS);
      if (u >= 1) {
        reelT = -1;
        reelRoot.setEnabled(false);
      } else {
        // Each reel tumbles fast, then snaps to face-on with a little
        // overshoot — the (1 - outBack) blend swings past zero and back.
        for (let i = 0; i < reels.length; i++) {
          const snap = REEL_SNAPS[i]!;
          if (reelT < snap) {
            reels[i]!.rotation.x = reelT * REEL_SPEEDS[i]!;
          } else {
            const s = clamp01((reelT - snap) / 0.15);
            reels[i]!.rotation.x = REEL_END_ROT[i]! * (1 - outBack(s));
          }
        }
        reelMat.alpha = 0.95 * (1 - sstep(0.8, 1, u));
        // The payout: one bright orb pops off the top of the stack after the
        // last snap lands.
        const ou = clamp01((reelT - 0.8) / 0.55);
        if (ou > 0) {
          if (!orbPopped) {
            orbPopped = true;
            sparks.manualEmitCount = 30; // still gold-green from the cast
          }
          orb.scaling.setAll(Math.max(0.01, outBack(clamp01(ou / 0.35))));
          orb.position.y = 1.0 + ou * 1.5;
          orbMat.alpha = 0.95 * (1 - sstep(0.5, 1, ou));
        } else {
          orb.scaling.setAll(0.01);
          orbMat.alpha = 0;
        }
      }
    }

    if (intervalT >= 0) {
      intervalT += dt;
      const secs = intervalVariable ? INTERVAL_VAR_SECS : INTERVAL_FIXED_SECS;
      const clock = intervalVariable ? clockVar : clockFixed;
      const clockMat = intervalVariable ? clockVarMat : clockFixedMat;
      // The grace past `secs` lets a pulse due exactly at the window's end
      // (the sim's final tick) fire before the clock is packed away.
      if (intervalT >= secs + 0.2) {
        intervalT = -1;
        clockRoot.setEnabled(false);
      } else {
        // The clock stays up for the schedule's WHOLE window — it is the
        // HoT's on-screen lifetime, not a cast flourish. Rise runs on
        // absolute seconds so 8 s and 20 s open with the same gesture; then
        // it hovers with a slow bob and dissolves over the final second.
        const rise = sstep(0, 0.9, intervalT);
        clock.position.y = 0.6 + rise * 1.6 + Math.sin(intervalT * 1.6) * 0.05;
        clock.scaling.setAll(0.8 + 0.3 * rise);
        clockMat.alpha = rise * (1 - sstep(secs - 1, secs, intervalT));
        // Fire pulses as their offsets come due; rings recycle round-robin.
        while (pulseIdx < pulseOffsets.length && intervalT >= pulseOffsets[pulseIdx]!) {
          const ri = pulseIdx % pulseRings.length;
          pulseT[ri] = 0;
          pulseRings[ri]!.scaling.set(0.8, 1, 0.8);
          pulseRings[ri]!.setEnabled(true);
          pulseIdx++;
        }
      }
    }
    // Pulse rings run on their own clocks so a ring fired at 1.65 s can
    // finish after the 2 s clock has already dissolved.
    for (let i = 0; i < pulseRings.length; i++) {
      if (pulseT[i]! < 0) continue;
      pulseT[i]! += dt;
      const local = clamp01(pulseT[i]! / PULSE_SECS);
      if (local >= 1) {
        pulseT[i] = -1;
        pulseRings[i]!.setEnabled(false);
      } else {
        const d = 0.8 + local * 5.5;
        pulseRings[i]!.scaling.set(d, 1, d);
        // Variable-interval pulses are softer — the schedule whispers.
        pulseMats[i]!.alpha = (intervalVariable ? 0.6 : 0.85) * (1 - sstep(0.35, 1, local));
      }
    }

    if (flipET >= 0) {
      flipET += dt;
      const u = clamp01(flipET / FLIP_SECS);
      if (u >= 1) {
        flipET = -1;
        flipE.root.setEnabled(false);
      } else {
        const pop = outBack(clamp01(flipET / 0.1));
        flipE.card.scaling.setAll(Math.max(0.01, pop));
        const spin = sstep(0.1, 0.8, u);
        flipE.card.rotation.y = Math.PI * spin;
        flipE.cardMat.alpha = 0.9 * (1 - sstep(0.8, 1, u));
        // Glint peaks exactly at the edge-on moment (spin = 0.5), covering
        // the frames where the flat card would otherwise vanish.
        flipE.glintMat.alpha = Math.max(0, 1 - Math.abs(spin - 0.5) / 0.14);
      }
    }

    if (flipRT >= 0) {
      flipRT += dt;
      const u = clamp01(flipRT / FLIP_SECS);
      if (u >= 1) {
        flipRT = -1;
        flipR.root.setEnabled(false);
      } else {
        const pop = outBack(clamp01(flipRT / 0.1));
        flipR.card.scaling.setAll(Math.max(0.01, pop));
        const spin = sstep(0.1, 0.8, u);
        // Mirrored flip, and the tint crosses the gradient as it turns:
        // reinforcement green on the way in, punishment violet on the way out.
        flipR.card.rotation.y = -Math.PI * spin;
        Color3.LerpToRef(REINFORCE_TINT, PUNISH_TINT, spin, flipR.cardMat.emissiveColor);
        flipR.cardMat.alpha = 0.9 * (1 - sstep(0.8, 1, u));
        flipR.glintMat.alpha = Math.max(0, 1 - Math.abs(spin - 0.5) / 0.14);
      }
    }

    if (ultT >= 0) {
      ultT += dt;
      const u = clamp01(ultT / ULT_SECS);
      if (u >= 1) {
        ultT = -1;
        pigeonRoot.setEnabled(false);
        burstRoot.setEnabled(false);
        // Hand the shared spark system back to the hero.
        sparks.emitRate = 0;
        sparks.emitter = sparkAnchor;
        if (glow) glow.intensity = 1.2;
      } else if (ultT < HOPS_TOTAL) {
        // Which hop are we in? Walk the segments (three entries, cheap).
        let t0 = 0;
        let dist0 = 0;
        let idx = 0;
        while (idx < HOPS.length - 1 && ultT >= t0 + HOPS[idx]!.dur) {
          t0 += HOPS[idx]!.dur;
          dist0 += HOPS[idx]!.dist;
          idx++;
        }
        const hop = HOPS[idx]!;
        const local = clamp01((ultT - t0) / hop.dur);
        // Parabolic hop; the ground track just accumulates distance forward.
        pigeonRoot.position.copyFrom(ultOrigin);
        pigeonRoot.position.addInPlace(ultDir.scale(dist0 + hop.dist * local));
        pigeonRoot.position.y = ultOrigin.y + 0.35 + hop.height * Math.sin(Math.PI * local);
        // Successive approximation: each hop the pigeon is LARGER and
        // BRIGHTER — the behaviour shaped closer to the target every rep.
        pigeonRoot.scaling.setAll(FX_SCALE * hop.scale * Math.max(0.01, outBack(clamp01(ultT / 0.3))));
        pigeonMat.emissiveColor.copyFrom(PIGEON_TINT).scaleInPlace(1 + idx * 0.35);
        if (glow) glow.intensity = 1.2 + idx * 0.5;
        // Wingbeats, widest at takeoff, tucking in toward each landing.
        const flap = Math.sin(ultT * 20) * (0.65 - 0.3 * local);
        wingPivots[0]!.rotation.z = -flap;
        wingPivots[1]!.rotation.z = flap;
        // Gold heal sparks stream off the tail for the whole flight.
        sparks.emitRate = 70;
      } else {
        // Touchdown: the pigeon dissolves into the payoff bloom.
        const tb = ultT - HOPS_TOTAL;
        if (!ultBloomed) {
          ultBloomed = true;
          pigeonRoot.setEnabled(false);
          burstRoot.setEnabled(true);
          sparks.emitRate = 0;
          sparks.manualEmitCount = 90; // colors already gold from the cast
        }
        const bu = clamp01(tb / BLOOM_SECS);
        bloom.scaling.setAll(Math.max(0.01, outBack(clamp01(tb / 0.3)) * (2.5 + 4 * bu)));
        bloomMat.alpha = 0.9 * (1 - sstep(0.35, 1, bu));
        if (glow) glow.intensity = 1.2 + 2.6 * (1 - bu);
        // Triple rings, staggered launches, expanding out from touchdown.
        for (let i = 0; i < ultRings.length; i++) {
          const local = clamp01((bu - i * 0.14) / (1 - i * 0.14));
          const d = 0.8 + local * 8;
          ultRings[i]!.scaling.set(d, 1, d);
        }
        ultRingMat.alpha = 0.8 * (1 - sstep(0.5, 1, bu));
      }
    }

    if (flowT >= 0) {
      flowT += dt;
      const u = clamp01(flowT / FLOW_SECS);
      if (u >= 1) {
        flowT = -1;
        for (const l of flowLinks) {
          l.tube.setEnabled(false);
          for (const b of l.beads) b.setEnabled(false);
        }
      } else {
        const h = hero.getAbsolutePosition();
        flowFrom.set(h.x, h.y + 1.35, h.z);
        flowMat.alpha = 0.85 * sstep(0, 0.12, u) * (1 - sstep(0.72, 1, u));
        flowBeadMat.alpha = 0.95 * (1 - sstep(0.8, 1, u));
        for (let i = 0; i < flowTargets.length && i < flowLinks.length; i++) {
          const link = flowLinks[i]!;
          const to = flowTargets[i]!;
          // A gentle vertical bow, deeper on longer throws.
          const bow = 0.45 + 0.07 * Vector3.Distance(flowFrom, to);
          for (let s = 0; s <= FLOW_SEGS; s++) {
            const t = s / FLOW_SEGS;
            link.path[s]!.set(
              flowFrom.x + (to.x - flowFrom.x) * t,
              flowFrom.y + (to.y - flowFrom.y) * t + Math.sin(Math.PI * t) * bow,
              flowFrom.z + (to.z - flowFrom.z) * t
            );
          }
          MeshBuilder.CreateTube(`skinnerFx_flowTube_${i}`, { path: link.path, instance: link.tube }, scene);
          // Two beads chase each other down the arc — the flow's direction.
          for (let b = 0; b < link.beads.length; b++) {
            const tb = clamp01(u * 1.4 - b * 0.28);
            link.beads[b]!.position.set(
              flowFrom.x + (to.x - flowFrom.x) * tb,
              flowFrom.y + (to.y - flowFrom.y) * tb + Math.sin(Math.PI * tb) * bow,
              flowFrom.z + (to.z - flowFrom.z) * tb
            );
          }
        }
      }
    }
  });

  return {
    cast(kind: FreudCastKind, id: string) {
      switch (kind) {
        case "palette": {
          // Every schedule (keys 1-4) opens the team flow — yellow streams to
          // each living teammate, on top of the per-schedule centrepiece.
          const targets = allies?.() ?? [];
          if (targets.length > 0) {
            flowT = 0;
            flowTargets = targets.slice(0, FLOW_LINKS);
            flowMat.alpha = 0;
            flowBeadMat.alpha = 0;
            for (let i = 0; i < flowLinks.length; i++) {
              const on = i < flowTargets.length;
              flowLinks[i]!.tube.setEnabled(on);
              for (const b of flowLinks[i]!.beads) b.setEnabled(on);
            }
          }
          const suffix = id.split(".").pop() ?? "";
          if (suffix === "variable_ratio") {
            reelT = 0;
            orbPopped = false;
            reelRoot.setEnabled(true);
            orb.scaling.setAll(0.01);
            orbMat.alpha = 0;
            reelMat.alpha = 0.95;
            sparks.color1 = new Color4(0.85, 0.98, 0.45, 0.9);
            sparks.color2 = new Color4(1.0, 1.0, 0.7, 0.6);
            sparks.colorDead = new Color4(0.3, 0.4, 0.1, 0);
            sparks.manualEmitCount = 35;
          } else if (suffix === "fixed_interval" || suffix === "variable_interval") {
            intervalT = 0;
            intervalVariable = suffix === "variable_interval";
            pulseIdx = 0;
            // Pulses land when the HEALS land. Fixed: the sim ticks every
            // periodMs through the window — [2, 4, 6, 8] s. Variable: the sim
            // rolls a 15% coin once a second; this layer can't see those
            // rolls, so it flips the same coin over the same seconds —
            // unpredictability IS the schedule's identity, so runtime RNG is
            // the point here, not a smell.
            pulseOffsets = intervalVariable
              ? Array.from({ length: Math.floor(INTERVAL_VAR_SECS) }, (_, i) => i + 1).filter(
                  () => Math.random() < VI_TICK_CHANCE
                )
              : Array.from(
                  { length: Math.floor(INTERVAL_FIXED_SECS / FI_PERIOD_SECS) },
                  (_, i) => (i + 1) * FI_PERIOD_SECS
                );
            clockFixed.setEnabled(!intervalVariable);
            clockVar.setEnabled(intervalVariable);
            clockRoot.setEnabled(true);
            const tint = intervalVariable
              ? SKINNER_TINTS.variable_interval!
              : SKINNER_TINTS.fixed_interval!;
            for (const m of pulseMats) m.emissiveColor.copyFrom(tint);
            sparks.color1 = new Color4(tint.r, tint.g, tint.b, 0.9);
            sparks.color2 = new Color4(0.8, 1.0, 0.85, 0.55);
            sparks.colorDead = new Color4(0.1, 0.35, 0.18, 0);
            sparks.manualEmitCount = intervalVariable ? 25 : 40;
          } else {
            // fixed_ratio — and the fallback for any unknown schedule id.
            pelletT = 0;
            pelletRoot.setEnabled(true);
            groundRing.scaling.setAll(0.01);
            for (const p of pellets) p.scaling.setAll(0.01);
            pelletMat.alpha = 0.95;
            groundRingMat.alpha = 1;
            sparks.color1 = new Color4(1.0, 0.82, 0.45, 0.9);
            sparks.color2 = new Color4(1.0, 0.95, 0.7, 0.6);
            sparks.colorDead = new Color4(0.5, 0.3, 0.05, 0);
            sparks.manualEmitCount = 50;
          }
          break;
        }
        case "defense":
          flipET = 0;
          flipE.card.rotation.y = 0;
          flipE.card.scaling.setAll(0.01);
          flipE.root.setEnabled(true);
          sparks.color1 = new Color4(0.4, 0.9, 1.0, 0.9);
          sparks.color2 = new Color4(0.75, 1.0, 1.0, 0.5);
          sparks.colorDead = new Color4(0.05, 0.3, 0.4, 0);
          sparks.manualEmitCount = 20;
          break;
        case "chain":
          flipRT = 0;
          flipR.card.rotation.y = 0;
          flipR.card.scaling.setAll(0.01);
          flipR.cardMat.emissiveColor.copyFrom(REINFORCE_TINT);
          flipR.root.setEnabled(true);
          sparks.color1 = new Color4(0.45, 1.0, 0.6, 0.9);
          sparks.color2 = new Color4(0.7, 0.4, 1.0, 0.5);
          sparks.colorDead = new Color4(0.2, 0.15, 0.35, 0);
          sparks.manualEmitCount = 20;
          break;
        case "ultimate": {
          ultT = 0;
          ultBloomed = false;
          // Same handedness note as Freud's eye: visual forward is Backward().
          hero.getDirection(Vector3.Backward()).normalizeToRef(ultDir);
          ultDir.y = 0;
          ultDir.normalize();
          const p = hero.getAbsolutePosition();
          ultOrigin.set(p.x + ultDir.x * 0.6, p.y, p.z + ultDir.z * 0.6);
          pigeonRoot.position.copyFrom(ultOrigin);
          pigeonRoot.position.y += 0.35;
          // Nose along the hop direction (the pigeon is modelled facing +Z).
          pigeonRoot.rotation.y = Math.atan2(ultDir.x, ultDir.z);
          pigeonRoot.scaling.setAll(0.01);
          pigeonMat.alpha = 0.95;
          pigeonRoot.setEnabled(true);
          // Stage the whole celebration at the touchdown point now — it is
          // fully determined by the launch data, nothing moves it later.
          burstRoot.position.set(
            ultOrigin.x + ultDir.x * ULT_DIST_TOTAL,
            ultOrigin.y,
            ultOrigin.z + ultDir.z * ULT_DIST_TOTAL
          );
          bloom.scaling.setAll(0.01);
          bloomMat.alpha = 0;
          for (const r of ultRings) r.scaling.set(0.8, 1, 0.8);
          ultRingMat.alpha = 0.8;
          // The trail rides the pigeon for the flight; gold from launch.
          sparks.emitter = trailAnchor;
          sparks.color1 = new Color4(1.0, 0.85, 0.4, 0.9);
          sparks.color2 = new Color4(1.0, 0.95, 0.7, 0.6);
          sparks.colorDead = new Color4(0.5, 0.3, 0.05, 0);
          sparks.manualEmitCount = 40;
          break;
        }
      }
    },
  };
}
