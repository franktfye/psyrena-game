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
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";

import { ERIKSON, ERIKSON_PSYCHOSOCIAL } from "@shared/heroes/erikson";

import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Erikson's cast VFX — the life cycle, drawn around him. Pure Babylon (meshes,
 * one DynamicTexture bake, one particle system, no assets), in his colours:
 * AMBER for a crisis, GOLD for the virtue it yields, CYAN for his hourglass,
 * VIOLET for the pause, MAGENTA for the identity shock.
 *
 *  - Life Stage (1):      the LIFE WHEEL — a ring of eight markers settles on
 *                         the ground under him; the current stage's marker
 *                         flares and an amber pillar rises from it.
 *  - Virtue (2):          a gold gem forms over his head, spins, and bursts
 *                         into eight shards (one per virtue) with a gold rise;
 *                         the wheel flashes gold at the stage just completed.
 *  - Moratorium (E):      a translucent violet time bubble for the length of
 *                         the mitigation, an hourglass lying still on its side
 *                         above him and slow, drifting motes — time held.
 *  - Identity Crisis (R): four mirror panes orbit him, then shatter outward in
 *                         amber and magenta shards over a ground shock ring.
 *  - Life Review (F):     eight rings climb in a spiral from his feet to above
 *                         his head, lighting in order — a whole life — then
 *                         collapse into one bright orb (the projectile layer
 *                         flies his spiral at the boss).
 *
 * Loaded on demand (heroCasts.ts), so none of this is in the boot chunk. Same
 * lifecycle contract as the other hero modules: built once, re-armed per
 * cast, one onBeforeRenderObservable, every effect self-disables, shaders
 * compiled up front, glow only on tiers that allow it (core/quality.ts).
 *
 * `cast(kind, id)` takes the stage-suffixed key the bars build
 * (`voiceKeyFor`: "erikson.stage:5"), so the wheel knows which marker to light.
 */

const AMBER = new Color3(1.0, 0.58, 0.26);
const GOLD = new Color3(1.0, 0.82, 0.32);
const CYAN = new Color3(0.4, 0.9, 0.95);
const VIOLET = new Color3(0.62, 0.42, 1.0);
const MAGENTA = new Color3(1.0, 0.35, 0.72);

const STAGES = ERIKSON_PSYCHOSOCIAL.stages.length;
const WHEEL_R = 1.55;

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
/** 0 → 1 → 0 over [a, b], ramps of `edge`. */
const pulse = (u: number, a: number, b: number, edge: number): number =>
  sstep(a, a + edge, u) * (1 - sstep(b - edge, b, u));

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
  const tex = new DynamicTexture("eriksonFxDot", { width: size, height: size }, scene, false);
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
 * The life wheel: a thin outer ring, eight marker rings on it, and a faint
 * spiral from the centre out to marker one — the cycle as a dial. White, so
 * the material tints it amber (a crisis) or gold (a virtue).
 */
function wheelTexture(scene: Scene): DynamicTexture {
  const size = 512;
  const tex = new DynamicTexture("eriksonFxWheel", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const r = size * 0.4;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let t = 0; t <= 1; t += 0.01) {
    const a = -Math.PI / 2 + t * Math.PI * 2 * 1.75;
    const rr = r * t;
    const x = c + Math.cos(a) * rr;
    const y = c + Math.sin(a) * rr;
    if (t === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  for (let i = 0; i < STAGES; i++) {
    const a = -Math.PI / 2 + (i / STAGES) * Math.PI * 2;
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.stroke();
  }
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * A mirror pane: a bright frame, a faint vertical sheen, and a head-and-
 * shoulders silhouette — the reflection that is not quite you. White, so the
 * material tints it amber; the opacity rides the same texture, so the pane is
 * mostly glass rather than a solid card on tiers with no glow.
 */
function mirrorTexture(scene: Scene): DynamicTexture {
  const w = 128;
  const h = 240;
  const tex = new DynamicTexture("eriksonFxMirror", { width: w, height: h }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  const sheen = ctx.createLinearGradient(0, 0, w, 0);
  sheen.addColorStop(0, "rgba(255,255,255,0.10)");
  sheen.addColorStop(0.35, "rgba(255,255,255,0.32)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.12)");
  sheen.addColorStop(1, "rgba(255,255,255,0.06)");
  ctx.fillStyle = sheen;
  ctx.fillRect(6, 6, w - 12, h - 12);
  ctx.fillStyle = "rgba(255,255,255,0.42)";
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.36, w * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.66, w * 0.3, h * 0.13, 0, Math.PI, 0);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/** Marker position on the wheel, in the wheel root's local XZ. */
function markerPos(stage: number, out: Vector3): Vector3 {
  // The disc is laid flat with rotation.x = π/2, which maps texture-up to -Z.
  const a = -Math.PI / 2 + (stage / STAGES) * Math.PI * 2;
  return out.set(Math.cos(a) * WHEEL_R, 0, -Math.sin(a) * WHEEL_R);
}

/** "erikson.stage:5" → 4 (zero-based); anything else → 0. */
const stageOf = (id: string): number => {
  const n = Number(id.split(":")[1]);
  return Number.isFinite(n) && n >= 1 ? (n - 1) % STAGES : 0;
};

/** A bipyramid gem from two cones and a girdle — the virtue's shape. */
function buildGem(scene: Scene, name: string, mat: StandardMaterial, size: number): Mesh[] {
  const crown = MeshBuilder.CreateCylinder(`${name}_crown`, { height: 0.42 * size, diameterTop: 0, diameterBottom: 0.8 * size, tessellation: 6 }, scene);
  crown.position.y = 0.21 * size;
  const pav = MeshBuilder.CreateCylinder(`${name}_pav`, { height: 0.62 * size, diameterTop: 0.8 * size, diameterBottom: 0, tessellation: 6 }, scene);
  pav.position.y = -0.31 * size;
  for (const m of [crown, pav]) {
    m.material = mat;
    m.isPickable = false;
  }
  return [crown, pav];
}

export function createEriksonSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
  // ---- shared spark burst -----------------------------------------------------
  const sparkAnchor = MeshBuilder.CreateBox("eriksonFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.2;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("eriksonFx_sparks", 200, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.5, -0.3, -0.5);
  sparks.maxEmitBox = new Vector3(0.5, 0.3, 0.5);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.08;
  sparks.maxSize = 0.26;
  sparks.minLifeTime = 0.5;
  sparks.maxLifeTime = 1.1;
  sparks.emitRate = 0;
  sparks.direction1 = new Vector3(-0.5, 1.0, -0.5);
  sparks.direction2 = new Vector3(0.5, 2.6, 0.5);
  sparks.minEmitPower = 0.6;
  sparks.maxEmitPower = 1.8;
  sparks.gravity = new Vector3(0, -0.4, 0);
  sparks.start();
  const burst = (c1: Color3, c2: Color3, n: number, y = 1.2, slow = false): void => {
    sparkAnchor.position.y = y;
    sparks.color1 = new Color4(c1.r, c1.g, c1.b, 0.9);
    sparks.color2 = new Color4(c2.r, c2.g, c2.b, 0.6);
    sparks.colorDead = new Color4(c1.r * 0.3, c1.g * 0.3, c1.b * 0.3, 0);
    sparks.minEmitPower = slow ? 0.12 : 0.6;
    sparks.maxEmitPower = slow ? 0.35 : 1.8;
    sparks.minLifeTime = slow ? 1.6 : 0.5;
    sparks.maxLifeTime = slow ? 2.6 : 1.1;
    sparks.manualEmitCount = n;
  };

  // ---- Life wheel (keys 1 and 2) ----------------------------------------------
  const wheelRoot = new TransformNode("eriksonFx_wheelRoot", scene);
  wheelRoot.parent = hero;
  wheelRoot.position.y = 0.06;
  const wheel = MeshBuilder.CreateDisc("eriksonFx_wheel", { radius: WHEEL_R * 1.25, tessellation: 64 }, scene);
  wheel.parent = wheelRoot;
  wheel.rotation.x = Math.PI / 2;
  wheel.isPickable = false;
  const wheelMat = fxMat(scene, "eriksonFx_wheelMat", AMBER, 0);
  const wheelTex = wheelTexture(scene);
  wheelMat.emissiveTexture = wheelTex;
  wheelMat.opacityTexture = wheelTex;
  wheel.material = wheelMat;
  const flareMat = fxMat(scene, "eriksonFx_flareMat", AMBER, 0);
  const flare = MeshBuilder.CreateDisc("eriksonFx_flare", { radius: 0.28, tessellation: 24 }, scene);
  flare.parent = wheelRoot;
  flare.rotation.x = Math.PI / 2;
  flare.position.y = 0.02;
  flare.isPickable = false;
  flare.material = flareMat;
  const pillarMat = fxMat(scene, "eriksonFx_pillarMat", AMBER, 0);
  const pillar = MeshBuilder.CreateCylinder("eriksonFx_pillar", { height: 1, diameterTop: 0.08, diameterBottom: 0.34, tessellation: 16 }, scene);
  pillar.parent = wheelRoot;
  pillar.isPickable = false;
  pillar.material = pillarMat;

  // ---- Virtue gem (key 2) -------------------------------------------------------
  const gemRoot = new TransformNode("eriksonFx_gemRoot", scene);
  gemRoot.parent = hero;
  gemRoot.position.y = 2.45;
  const gemMat = fxMat(scene, "eriksonFx_gemMat", GOLD, 0.95);
  const gem = buildGem(scene, "eriksonFx_gem", gemMat, 0.7);
  for (const m of gem) m.parent = gemRoot;
  const shardMat = fxMat(scene, "eriksonFx_shardMat", GOLD, 0.95);
  const shards: Mesh[] = [];
  for (let i = 0; i < STAGES; i++) {
    const s = MeshBuilder.CreateCylinder(`eriksonFx_shard_${i}`, { height: 0.32, diameterTop: 0, diameterBottom: 0.14, tessellation: 4 }, scene);
    s.parent = gemRoot;
    s.isPickable = false;
    s.material = shardMat;
    shards.push(s);
  }

  // ---- Moratorium bubble (E) ----------------------------------------------------
  const bubbleRoot = new TransformNode("eriksonFx_bubbleRoot", scene);
  bubbleRoot.parent = hero;
  bubbleRoot.position.y = 1.05;
  const bubbleMat = fxMat(scene, "eriksonFx_bubbleMat", VIOLET, 0);
  const bubble = MeshBuilder.CreateSphere("eriksonFx_bubble", { diameter: 2.7, segments: 24 }, scene);
  bubble.parent = bubbleRoot;
  bubble.isPickable = false;
  bubble.material = bubbleMat;
  const bandMat = fxMat(scene, "eriksonFx_bandMat", VIOLET, 0);
  const bands = [0, 1].map((k) => {
    const b = MeshBuilder.CreateTorus(`eriksonFx_band_${k}`, { diameter: 2.72, thickness: 0.025, tessellation: 48 }, scene);
    b.parent = bubbleRoot;
    b.isPickable = false;
    b.material = bandMat;
    b.rotation.x = k === 0 ? 0 : Math.PI / 2;
    return b;
  });
  // The hourglass lying on its side — sand stopped, time held.
  const hgRoot = new TransformNode("eriksonFx_hgRoot", scene);
  hgRoot.parent = bubbleRoot;
  hgRoot.position.y = 1.65;
  hgRoot.rotation.z = Math.PI / 2;
  const hgMat = fxMat(scene, "eriksonFx_hgMat", CYAN, 0);
  const hgParts = [
    MeshBuilder.CreateCylinder("eriksonFx_hgUp", { height: 0.36, diameterTop: 0.42, diameterBottom: 0.04, tessellation: 14 }, scene),
    MeshBuilder.CreateCylinder("eriksonFx_hgLo", { height: 0.36, diameterTop: 0.04, diameterBottom: 0.42, tessellation: 14 }, scene),
    MeshBuilder.CreateCylinder("eriksonFx_hgCapT", { height: 0.04, diameter: 0.5, tessellation: 18 }, scene),
    MeshBuilder.CreateCylinder("eriksonFx_hgCapB", { height: 0.04, diameter: 0.5, tessellation: 18 }, scene),
  ];
  hgParts[0]!.position.y = 0.18;
  hgParts[1]!.position.y = -0.18;
  hgParts[2]!.position.y = 0.38;
  hgParts[3]!.position.y = -0.38;
  for (const m of hgParts) {
    m.parent = hgRoot;
    m.isPickable = false;
    m.material = hgMat;
  }

  // ---- Identity Crisis mirrors (R) ----------------------------------------------
  const mirrorRoot = new TransformNode("eriksonFx_mirrorRoot", scene);
  mirrorRoot.parent = hero;
  const mirrorMat = fxMat(scene, "eriksonFx_mirrorMat", AMBER, 0);
  const mirrorTex = mirrorTexture(scene);
  mirrorMat.emissiveTexture = mirrorTex;
  mirrorMat.opacityTexture = mirrorTex;
  // The shards keep a plain amber face: a shard of the frame, not the glass.
  const mShardAmberMat = fxMat(scene, "eriksonFx_mShardAmberMat", AMBER, 0);
  const mirrors = [0, 1, 2, 3].map((k) => {
    const m = MeshBuilder.CreatePlane(`eriksonFx_mirror_${k}`, { width: 0.8, height: 1.5 }, scene);
    m.parent = mirrorRoot;
    m.isPickable = false;
    m.material = mirrorMat;
    return m;
  });
  const mShardMat = fxMat(scene, "eriksonFx_mShardMat", MAGENTA, 0);
  const SHARDS_PER = 5;
  const mShards: { mesh: Mesh; dir: Vector3; spin: Vector3 }[] = [];
  for (let i = 0; i < mirrors.length * SHARDS_PER; i++) {
    const m = MeshBuilder.CreatePlane(`eriksonFx_mShard_${i}`, { width: 0.22, height: 0.34 }, scene);
    m.parent = mirrorRoot;
    m.isPickable = false;
    m.material = i % 2 ? mShardMat : mShardAmberMat;
    mShards.push({ mesh: m, dir: new Vector3(), spin: new Vector3() });
  }
  const shockMat = fxMat(scene, "eriksonFx_shockMat", MAGENTA, 0);
  const shock = MeshBuilder.CreateTorus("eriksonFx_shock", { diameter: 1, thickness: 0.05, tessellation: 48 }, scene);
  shock.parent = mirrorRoot;
  shock.position.y = 0.08;
  shock.isPickable = false;
  shock.material = shockMat;

  // ---- Life Review spiral (F) ---------------------------------------------------
  const spiralRoot = new TransformNode("eriksonFx_spiralRoot", scene);
  spiralRoot.parent = hero;
  const ringMats: StandardMaterial[] = [];
  const rings: Mesh[] = [];
  for (let i = 0; i < STAGES; i++) {
    // Amber early in life, gold by old age.
    const tint = Color3.Lerp(AMBER, GOLD, i / (STAGES - 1));
    const mat = fxMat(scene, `eriksonFx_ringMat_${i}`, tint, 0);
    const r = MeshBuilder.CreateTorus(`eriksonFx_ring_${i}`, { diameter: 1, thickness: 0.05, tessellation: 40 }, scene);
    r.parent = spiralRoot;
    r.isPickable = false;
    r.material = mat;
    ringMats.push(mat);
    rings.push(r);
  }
  const orbMat = fxMat(scene, "eriksonFx_orbMat", new Color3(1.0, 0.94, 0.7), 0);
  const orb = MeshBuilder.CreateSphere("eriksonFx_orb", { diameter: 0.6, segments: 16 }, scene);
  orb.parent = spiralRoot;
  orb.position.y = 3.0;
  orb.isPickable = false;
  orb.material = orbMat;

  // ---- glow (tier-gated) ----------------------------------------------------------
  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("eriksonFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 1.1;
    for (const m of [flare, pillar, ...gem, ...shards, ...hgParts, ...rings, orb, shock]) glow.addIncludedOnlyMesh(m);
    scene.onDisposeObservable.add(() => glow.dispose());
  }

  for (const r of [wheelRoot, gemRoot, bubbleRoot, mirrorRoot, spiralRoot]) r.setEnabled(false);

  // Compile every shader now — a still-compiling material renders as nothing.
  const warm: [Mesh, StandardMaterial][] = [
    [wheel, wheelMat], [flare, flareMat], [pillar, pillarMat], [gem[0]!, gemMat], [shards[0]!, shardMat],
    [bubble, bubbleMat], [bands[0]!, bandMat], [hgParts[0]!, hgMat], [mirrors[0]!, mirrorMat],
    [mShards[1]!.mesh, mShardMat], [mShards[0]!.mesh, mShardAmberMat], [shock, shockMat], [orb, orbMat],
    ...rings.map((r, i): [Mesh, StandardMaterial] => [r, ringMats[i]!]),
  ];
  for (const [mesh, mat] of warm) mat.forceCompilation(mesh);
  for (const m of scene.meshes) if (m.name.startsWith("eriksonFx_")) m.applyFog = false;

  // ---- per-frame driver -----------------------------------------------------------
  const STAGE_SECS = 1.0;
  const VIRTUE_SECS = 1.1;
  const MORATORIUM_SECS = (ERIKSON.defense.mitigation?.durationMs ?? 6_000) / 1000;
  const CRISIS_SECS = 1.3;
  const REVIEW_SECS = 2.4;

  let stageT = -1;
  let virtueT = -1;
  let wheelGold = false;
  let bubbleT = -1;
  let crisisT = -1;
  let reviewT = -1;
  const mp = new Vector3();

  const armWheel = (stage: number, gold: boolean): void => {
    wheelGold = gold;
    wheelMat.emissiveColor.copyFrom(gold ? GOLD : AMBER);
    flareMat.emissiveColor.copyFrom(gold ? GOLD : AMBER);
    pillarMat.emissiveColor.copyFrom(gold ? GOLD : AMBER);
    markerPos(stage, mp);
    flare.position.set(mp.x, 0.02, mp.z);
    pillar.position.set(mp.x, 0, mp.z);
    wheelRoot.setEnabled(true);
  };

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    // Key 1 — the wheel settles, the marker flares, the pillar rises.
    // Key 2 reuses the wheel in gold, briefly, beside the gem.
    const wheelT = Math.max(stageT, wheelGold ? virtueT : -1);
    if (wheelT >= 0) {
      const secs = wheelGold ? VIRTUE_SECS : STAGE_SECS;
      const u = clamp01(wheelT / secs);
      wheelRoot.rotation.y = (1 - sstep(0, 0.35, u)) * -0.7;
      wheelRoot.scaling.setAll(0.75 + 0.25 * outBack(clamp01(u / 0.3)));
      wheelMat.alpha = 0.8 * pulse(u, 0, 1, 0.25);
      flareMat.alpha = pulse(u, 0.12, 1, 0.2);
      flare.scaling.setAll(1 + 1.4 * sstep(0.12, 0.4, u));
      if (!wheelGold) {
        const rise = sstep(0.15, 0.5, u);
        pillar.scaling.set(1, Math.max(0.01, rise * 3.2), 1);
        pillar.position.y = (rise * 3.2) / 2;
        pillarMat.alpha = 0.75 * pulse(u, 0.15, 1, 0.3);
      } else {
        pillarMat.alpha = 0;
      }
    }
    if (stageT >= 0) {
      stageT += dt;
      if (stageT >= STAGE_SECS) stageT = -1;
    }

    // Key 2 — the gem forms, spins, bursts into eight shards.
    if (virtueT >= 0) {
      virtueT += dt;
      const u = clamp01(virtueT / VIRTUE_SECS);
      const form = outBack(clamp01(virtueT / 0.28));
      const burstAt = 0.42;
      gemRoot.rotation.y += dt * 9;
      for (const m of gem) m.setEnabled(u < burstAt);
      gemRoot.scaling.setAll(u < burstAt ? Math.max(0.01, form) : 1);
      const b = sstep(burstAt, 1, u);
      for (let i = 0; i < shards.length; i++) {
        const s = shards[i]!;
        s.setEnabled(u >= burstAt);
        const a = (i / shards.length) * Math.PI * 2;
        s.position.set(Math.cos(a) * b * 1.7, b * 0.6 - b * b * 0.9, Math.sin(a) * b * 1.7);
        s.rotation.set(a, a * 2, Math.PI / 2);
      }
      shardMat.alpha = 0.95 * (1 - sstep(0.7, 1, u));
      gemMat.alpha = 0.95;
      if (virtueT >= VIRTUE_SECS) {
        virtueT = -1;
        gemRoot.setEnabled(false);
      }
    }
    if (stageT < 0 && virtueT < 0 && wheelRoot.isEnabled()) wheelRoot.setEnabled(false);

    // E — the time bubble, for the whole mitigation window.
    if (bubbleT >= 0) {
      bubbleT += dt;
      const u = clamp01(bubbleT / MORATORIUM_SECS);
      const fade = sstep(0, 0.05, u) * (1 - sstep(0.88, 1, u));
      const breathe = 1 + Math.sin(bubbleT * 2.2) * 0.025;
      bubble.scaling.setAll(outBack(clamp01(bubbleT / 0.35)) * breathe);
      bubbleMat.alpha = 0.16 * fade;
      bandMat.alpha = 0.55 * fade;
      hgMat.alpha = 0.9 * fade;
      bands[0]!.rotation.y += dt * 0.25;
      bands[1]!.rotation.z += dt * 0.18;
      hgRoot.position.y = 1.65 + Math.sin(bubbleT * 1.3) * 0.05;
      if (bubbleT >= MORATORIUM_SECS) {
        bubbleT = -1;
        bubbleRoot.setEnabled(false);
      }
    }

    // R — mirrors orbit, then shatter.
    if (crisisT >= 0) {
      crisisT += dt;
      const u = clamp01(crisisT / CRISIS_SECS);
      const shatterAt = 0.4;
      const orbit = crisisT * 4.5;
      for (let k = 0; k < mirrors.length; k++) {
        const m = mirrors[k]!;
        m.setEnabled(u < shatterAt);
        const a = orbit + (k / mirrors.length) * Math.PI * 2;
        m.position.set(Math.cos(a) * 1.25, 1.1, Math.sin(a) * 1.25);
        m.rotation.y = -a + Math.PI / 2;
      }
      mirrorMat.alpha = sstep(0, 0.12, u) * (1 - sstep(0.75, 1, u));
      mShardMat.alpha = 0.9 * (1 - sstep(0.7, 1, u));
      mShardAmberMat.alpha = mShardMat.alpha;
      const s = sstep(shatterAt, 1, u);
      for (const sh of mShards) {
        sh.mesh.setEnabled(u >= shatterAt);
        if (u < shatterAt) continue;
        sh.mesh.position.set(sh.dir.x * s * 2.4, 1.1 + sh.dir.y * s * 1.4 - s * s * 0.8, sh.dir.z * s * 2.4);
        sh.mesh.rotation.x += sh.spin.x * dt;
        sh.mesh.rotation.y += sh.spin.y * dt;
      }
      shock.scaling.setAll(0.6 + sstep(shatterAt, 1, u) * 4.2);
      shockMat.alpha = 0.85 * pulse(u, shatterAt, 1, 0.15);
      if (crisisT >= CRISIS_SECS) {
        crisisT = -1;
        mirrorRoot.setEnabled(false);
      }
    }

    // F — eight rings climb and light in order, then collapse into one orb.
    if (reviewT >= 0) {
      reviewT += dt;
      const u = clamp01(reviewT / REVIEW_SECS);
      const collapse = sstep(0.62, 0.82, u);
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i]!;
        const lit = sstep(0.04 + i * 0.055, 0.1 + i * 0.055, u);
        const radius = (0.5 + (i / (STAGES - 1)) * 1.3) * (1 - collapse) + 0.1 * collapse;
        r.scaling.set(radius * 2 * Math.max(0.01, lit), 1, radius * 2 * Math.max(0.01, lit));
        const y = 0.15 + i * 0.36;
        r.position.y = y * (1 - collapse) + 3.0 * collapse;
        r.rotation.y += dt * (1.5 + i * 0.2);
        r.rotation.x = Math.sin(reviewT * 1.4 + i) * 0.12;
        ringMats[i]!.alpha = 0.9 * lit * (1 - sstep(0.8, 0.88, u));
      }
      orb.scaling.setAll(Math.max(0.01, sstep(0.7, 0.85, u) * 1.6 * (1 - sstep(0.9, 1, u) * 0.6)));
      orbMat.alpha = pulse(u, 0.7, 1, 0.12);
      if (reviewT >= REVIEW_SECS) {
        reviewT = -1;
        spiralRoot.setEnabled(false);
      }
    }
  });

  return {
    cast(kind: FreudCastKind, id: string) {
      switch (kind) {
        case "palette": {
          const stage = stageOf(id);
          if (id.startsWith("erikson.virtue")) {
            virtueT = 0;
            gemRoot.rotation.y = 0;
            gemRoot.setEnabled(true);
            armWheel(stage, true);
            burst(GOLD, new Color3(1, 0.97, 0.8), 45, 2.45);
          } else {
            stageT = 0;
            armWheel(stage, false);
            burst(AMBER, new Color3(1, 0.85, 0.6), 30, 0.3);
          }
          break;
        }
        case "defense":
          bubbleT = 0;
          bubble.scaling.setAll(0.01);
          bubbleRoot.setEnabled(true);
          burst(VIOLET, CYAN, 26, 1.1, true);
          break;
        case "chain":
          crisisT = 0;
          for (const sh of mShards) {
            const a = Math.random() * Math.PI * 2;
            sh.dir.set(Math.cos(a), 0.2 + Math.random() * 0.8, Math.sin(a));
            sh.spin.set(4 + Math.random() * 8, 4 + Math.random() * 8, 0);
            sh.mesh.rotation.set(0, a, 0);
          }
          mirrorRoot.rotation.y = Math.random() * Math.PI * 2;
          mirrorRoot.setEnabled(true);
          burst(MAGENTA, AMBER, 40, 1.1);
          break;
        case "ultimate":
          reviewT = 0;
          spiralRoot.setEnabled(true);
          burst(GOLD, CYAN, 60, 1.6);
          break;
      }
    },
  };
}
