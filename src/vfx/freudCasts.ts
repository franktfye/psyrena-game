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

/**
 * Freud's cast VFX — one big magic moment per skill family, pure Babylon
 * (meshes + DynamicTexture bakes + small particle systems, no assets).
 *
 *  - Palette 1-5: a spinning rune circle under the hero, a rising light
 *    pillar, tinted per psychosexual stage.
 *  - Defense (E):  a translucent shield bubble that pops in, holds, shatters.
 *  - Chain (R):    yellow light-streaks orbiting the hero on tilted paths.
 *  - Ultimate (F): a huge glowing slit-pupil eye that pushes forward slowly,
 *    trailing violet mist, ringed by a swarm of orbiting motes/mini-eyes.
 *
 * Everything is created once and re-armed per cast; per-frame animation runs
 * on one onBeforeRenderObservable and each effect self-disables when done, so
 * an idle hero costs nothing.
 */

export type FreudCastKind = "palette" | "defense" | "chain" | "ultimate";

export interface FreudSkillVfx {
  /** Fire the effect for a slot. `id` picks the palette stage tint. */
  cast(kind: FreudCastKind, id: string): void;
}

/** Per-stage tints for the 1-5 palette (id suffix → colour). */
export const STAGE_TINTS: Record<string, Color3> = {
  oral: new Color3(0.3, 0.9, 1.0), // cyan — the mouth of the river
  anal: new Color3(1.0, 0.62, 0.22), // amber
  phallic: new Color3(1.0, 0.3, 0.66), // magenta
  latency: new Color3(0.42, 1.0, 0.6), // calm green
  genital: new Color3(0.72, 0.42, 1.0), // violet
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const sstep = (e0: number, e1: number, x: number): number => {
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};
/** Overshooting pop-in for "arrival" moments. */
const outBack = (u: number): number => {
  const c = 1.70158;
  const v = u - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
};

/** Deterministic 0..1 hash — orbit variation without runtime RNG. */
const det = (i: number, salt: number): number => {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Unlit tint-and-alpha material — the workhorse of every effect here. */
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

/** 64² radial soft dot for the particle systems. */
function softDot(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("freudFxDot", { width: size, height: size }, scene, false);
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
 * White-on-transparent summoning circle: concentric rings, tick marks, a
 * hexagram, orbiting nodes. White so emissiveColor tints it per stage.
 */
function magicCircleTexture(scene: Scene): DynamicTexture {
  const size = 512;
  const tex = new DynamicTexture("freudRuneTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(c, c, 238, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(c, c, 206, 0, Math.PI * 2);
  ctx.stroke();
  // Tick marks between the two outer rings.
  ctx.lineWidth = 5;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * 210, c + Math.sin(a) * 210);
    ctx.lineTo(c + Math.cos(a) * 232, c + Math.sin(a) * 232);
    ctx.stroke();
  }
  // Hexagram inside the mid ring.
  const tri = (phase: number): void => {
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      const a = phase + (i / 3) * Math.PI * 2;
      const x = c + Math.cos(a) * 168;
      const y = c + Math.sin(a) * 168;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  ctx.lineWidth = 4;
  tri(-Math.PI / 2);
  tri(Math.PI / 2);
  // Inner ring + orbiting nodes.
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, 96, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * 168, c + Math.sin(a) * 168, 13, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/** Vertical fade for the light pillar: opaque at the feet, gone at the top. */
function pillarFadeTexture(scene: Scene): DynamicTexture {
  const h = 128;
  const tex = new DynamicTexture("freudPillarFade", { width: 4, height: h }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  // DynamicTexture v=0 is the bottom row of the canvas (flipped) — cylinder
  // v=0 is its bottom cap edge, so paint bright at canvas-bottom.
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.55, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, h);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/** The ultimate's eye: almond outline, streaked iris, slit pupil, glow. */
function eyeTexture(scene: Scene): DynamicTexture {
  const size = 512;
  const tex = new DynamicTexture("freudEyeTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  // Soft violet aura behind everything.
  let g = ctx.createRadialGradient(c, c, 40, c, c, 250);
  g.addColorStop(0, "rgba(190,120,255,0.6)");
  g.addColorStop(0.6, "rgba(140,70,235,0.25)");
  g.addColorStop(1, "rgba(120,50,220,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Almond sclera.
  const almond = (): void => {
    ctx.beginPath();
    ctx.moveTo(48, c);
    ctx.quadraticCurveTo(c, 92, size - 48, c);
    ctx.quadraticCurveTo(c, size - 92, 48, c);
    ctx.closePath();
  };
  almond();
  ctx.fillStyle = "rgba(240,232,255,0.96)";
  ctx.fill();
  ctx.save();
  almond();
  ctx.clip();
  // Iris — hot magenta core into deep violet rim.
  g = ctx.createRadialGradient(c, c, 10, c, c, 118);
  g.addColorStop(0, "rgba(255,120,220,1)");
  g.addColorStop(0.55, "rgba(190,60,200,1)");
  g.addColorStop(1, "rgba(84,32,170,1)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, 118, 0, Math.PI * 2);
  ctx.fill();
  // Radial iris striations.
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 3;
  for (let i = 0; i < 42; i++) {
    const a = (i / 42) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * 34, c + Math.sin(a) * 34);
    ctx.lineTo(c + Math.cos(a) * 114, c + Math.sin(a) * 114);
    ctx.stroke();
  }
  // Vertical slit pupil.
  ctx.fillStyle = "rgba(8,4,16,0.98)";
  ctx.beginPath();
  ctx.ellipse(c, c, 26, 84, 0, 0, Math.PI * 2);
  ctx.fill();
  // Specular glint.
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(c - 38, c - 44, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Lid line.
  almond();
  ctx.strokeStyle = "rgba(255,150,255,0.9)";
  ctx.lineWidth = 7;
  ctx.stroke();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

export function createFreudSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
  // ---- Palette: rune circle + light pillar --------------------------------
  const runeTex = magicCircleTexture(scene);
  const runeRoot = new TransformNode("freudFx_runeRoot", scene);
  runeRoot.parent = hero;
  runeRoot.position.y = 0.07;
  const runeA = MeshBuilder.CreateDisc("freudFx_runeA", { radius: 2.3, tessellation: 48 }, scene);
  const runeB = MeshBuilder.CreateDisc("freudFx_runeB", { radius: 1.55, tessellation: 48 }, scene);
  const runeMatA = fxMat(scene, "freudFx_runeMatA", Color3.White(), 1);
  const runeMatB = fxMat(scene, "freudFx_runeMatB", Color3.White(), 1);
  for (const [mesh, mat] of [
    [runeA, runeMatA],
    [runeB, runeMatB],
  ] as const) {
    mesh.parent = runeRoot;
    mesh.rotation.x = Math.PI / 2;
    mat.emissiveTexture = runeTex;
    mat.opacityTexture = runeTex;
    mesh.material = mat;
    mesh.isPickable = false;
  }
  runeB.position.y = 0.02;

  const pillar = MeshBuilder.CreateCylinder(
    "freudFx_pillar",
    { height: 5.2, diameterBottom: 2.0, diameterTop: 1.1, tessellation: 24 },
    scene
  );
  pillar.parent = hero;
  pillar.position.y = 2.6;
  pillar.isPickable = false;
  const pillarMat = fxMat(scene, "freudFx_pillarMat", Color3.White(), 1);
  const pillarTex = pillarFadeTexture(scene);
  pillarMat.emissiveTexture = pillarTex;
  pillarMat.opacityTexture = pillarTex;
  pillar.material = pillarMat;

  // Spark burst shared by palette casts and the shield pop. Emitter is an
  // invisible box mesh — the ParticleSystem emitter contract (villageHub
  // precedent), not a TransformNode.
  const sparkAnchor = MeshBuilder.CreateBox("freudFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.1;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("freudFx_sparks", 200, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.3, -0.6, -0.3);
  sparks.maxEmitBox = new Vector3(0.3, 0.6, 0.3);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.08;
  sparks.maxSize = 0.3;
  sparks.minLifeTime = 0.35;
  sparks.maxLifeTime = 0.8;
  sparks.emitRate = 0; // manual bursts
  sparks.direction1 = new Vector3(-1, 0.6, -1);
  sparks.direction2 = new Vector3(1, 2.2, 1);
  sparks.minEmitPower = 1.2;
  sparks.maxEmitPower = 3.2;
  sparks.gravity = new Vector3(0, -1.5, 0);
  sparks.start();

  // ---- Defense: shield bubble --------------------------------------------
  const shieldRoot = new TransformNode("freudFx_shieldRoot", scene);
  shieldRoot.parent = hero;
  shieldRoot.position.y = 1.25;
  const shieldTint = new Color3(0.62, 0.4, 1.0);
  const bubble = MeshBuilder.CreateSphere("freudFx_bubble", { diameter: 3.4, segments: 24 }, scene);
  bubble.parent = shieldRoot;
  bubble.isPickable = false;
  const bubbleMat = fxMat(scene, "freudFx_bubbleMat", shieldTint, 0.16);
  bubble.material = bubbleMat;
  const cage = MeshBuilder.CreateSphere("freudFx_cage", { diameter: 3.55, segments: 10 }, scene);
  cage.parent = shieldRoot;
  cage.isPickable = false;
  const cageMat = fxMat(scene, "freudFx_cageMat", shieldTint.scale(1.4), 0.3);
  cageMat.wireframe = true;
  cage.material = cageMat;
  const halo = MeshBuilder.CreateTorus(
    "freudFx_halo",
    { diameter: 3.7, thickness: 0.06, tessellation: 48 },
    scene
  );
  halo.parent = shieldRoot;
  halo.isPickable = false;
  const haloMat = fxMat(scene, "freudFx_haloMat", new Color3(0.85, 0.7, 1.0), 0.7);
  halo.material = haloMat;

  // ---- Chain: orbiting yellow light-streaks ------------------------------
  const streakRoot = new TransformNode("freudFx_streakRoot", scene);
  streakRoot.parent = hero;
  streakRoot.position.y = 1.2;
  const streakMat = fxMat(scene, "freudFx_streakMat", new Color3(1.0, 0.85, 0.3), 0.9);
  interface StreakOrbit {
    spinner: TransformNode;
    line: Mesh;
    radius: number;
    speed: number;
  }
  const streaks: StreakOrbit[] = [];
  // Deterministic orbit set — tilt/radius/speed tuples, no RNG at runtime.
  const ORBITS: [number, number, number, number][] = [
    [0.4, 0.2, 1.7, 5.2],
    [1.2, 0.9, 2.1, -4.4],
    [2.1, 0.4, 1.9, 6.0],
    [0.9, 1.6, 2.3, -5.6],
    [1.7, 2.4, 1.6, 4.8],
    [2.6, 1.1, 2.0, -6.4],
    [0.2, 2.9, 2.2, 5.8],
    [1.4, 0.6, 1.8, -5.0],
    [2.9, 1.9, 2.4, 4.2],
  ];
  let firstStreak: Mesh | null = null;
  for (const [tiltX, tiltZ, radius, speed] of ORBITS) {
    const pivot = new TransformNode("freudFx_streakPivot", scene);
    pivot.parent = streakRoot;
    pivot.rotation.x = tiltX;
    pivot.rotation.z = tiltZ;
    const spinner = new TransformNode("freudFx_streakSpin", scene);
    spinner.parent = pivot;
    const line = MeshBuilder.CreateBox(
      "freudFx_streak",
      { width: 0.045, height: 0.045, depth: 1.5 },
      scene
    );
    line.parent = spinner;
    line.position.x = radius;
    line.isPickable = false;
    line.material = streakMat;
    firstStreak ??= line;
    streaks.push({ spinner, line, radius, speed });
  }

  // ---- Ultimate: the forward-drifting eye --------------------------------
  const eyeRoot = new TransformNode("freudFx_eyeRoot", scene);
  const eye = MeshBuilder.CreatePlane("freudFx_eye", { size: 5.5 }, scene);
  eye.parent = eyeRoot;
  eye.billboardMode = Mesh.BILLBOARDMODE_ALL;
  eye.isPickable = false;
  // Slightly sub-white so the sclera doesn't clip to a featureless blob under
  // the hub's daylight exposure.
  const eyeMat = fxMat(scene, "freudFx_eyeMat", new Color3(0.8, 0.74, 0.88), 1);
  const eyeTex = eyeTexture(scene);
  eyeMat.emissiveTexture = eyeTex;
  eyeMat.opacityTexture = eyeTex;
  eye.material = eyeMat;

  // Bloom restricted to the ult's own meshes so the rest of the scene stays
  // clean. One layer per factory; goes down with the scene. Sized by device
  // tier (core/quality.ts); skipped on low, where the eye keeps its emissive.
  const ultGlowOptions = vfxGlowOptions();
  const ultGlow = ultGlowOptions ? new GlowLayer("freudFx_ultGlow", scene, ultGlowOptions) : null;
  if (ultGlow) {
    ultGlow.intensity = 1.5;
    ultGlow.addIncludedOnlyMesh(eye);
    scene.onDisposeObservable.add(() => {
      ultGlow.dispose();
    });
  }

  // Swarm: tiny glowing motes and mini-eyes orbiting the eye on deterministic
  // radii/speeds/phases — a swirling retinue around the slow, heavy eye.
  const moteDotTex = softDot(scene);
  const moteMat = fxMat(scene, "freudFx_moteMat", new Color3(0.85, 0.5, 1.0), 0);
  moteMat.emissiveTexture = moteDotTex;
  moteMat.opacityTexture = moteDotTex;
  const moteEyeMat = fxMat(scene, "freudFx_moteEyeMat", new Color3(0.8, 0.74, 0.88), 0);
  moteEyeMat.emissiveTexture = eyeTex;
  moteEyeMat.opacityTexture = eyeTex;
  interface MoteOrbit {
    mesh: Mesh;
    radius: number;
    speed: number;
    phase: number;
    yAmp: number;
    yFreq: number;
    yPhase: number;
  }
  const motes: MoteOrbit[] = [];
  const MOTE_COUNT = 16; // 10 soft dots + 6 mini-eyes
  for (let i = 0; i < MOTE_COUNT; i++) {
    const isEye = i >= 10;
    const m = MeshBuilder.CreatePlane("freudFx_mote", { size: isEye ? 0.6 : 0.32 }, scene);
    m.parent = eyeRoot;
    m.billboardMode = Mesh.BILLBOARDMODE_ALL;
    m.isPickable = false;
    m.material = isEye ? moteEyeMat : moteMat;
    m.applyFog = false;
    motes.push({
      mesh: m,
      radius: 0.8 + det(i, 1) * 1.4,
      speed: (0.6 + det(i, 2) * 1.4) * (det(i, 3) < 0.5 ? -1 : 1),
      phase: det(i, 4) * Math.PI * 2,
      yAmp: 0.2 + det(i, 5) * 0.5,
      yFreq: 1.0 + det(i, 6) * 1.5,
      yPhase: det(i, 7) * Math.PI * 2,
    });
    ultGlow?.addIncludedOnlyMesh(m);
  }

  const wakeAnchor = MeshBuilder.CreateBox("freudFx_eyeWakeAnchor", { size: 0.02 }, scene);
  wakeAnchor.parent = eyeRoot;
  wakeAnchor.isVisible = false;
  const wake = new ParticleSystem("freudFx_eyeWake", 260, scene);
  wake.particleTexture = softDot(scene);
  wake.emitter = wakeAnchor;
  wake.minEmitBox = new Vector3(-0.7, -0.7, -0.7);
  wake.maxEmitBox = new Vector3(0.7, 0.7, 0.7);
  wake.color1 = new Color4(0.75, 0.4, 1.0, 0.5);
  wake.color2 = new Color4(1.0, 0.45, 0.85, 0.35);
  wake.colorDead = new Color4(0.3, 0.1, 0.5, 0);
  wake.minSize = 0.25;
  wake.maxSize = 0.8;
  wake.minLifeTime = 0.5;
  wake.maxLifeTime = 1.1;
  wake.emitRate = 0;
  wake.blendMode = ParticleSystem.BLENDMODE_ADD;
  wake.direction1 = new Vector3(-0.5, -0.3, -0.5);
  wake.direction2 = new Vector3(0.5, 0.5, 0.5);
  wake.minEmitPower = 0.2;
  wake.maxEmitPower = 0.7;
  wake.start();

  // Denser burst trailing behind the eye; the anchor sits at -ultDir (eyeRoot
  // never rotates, so a local offset tracks world-behind).
  const trailAnchor = MeshBuilder.CreateBox("freudFx_eyeTrailAnchor", { size: 0.02 }, scene);
  trailAnchor.parent = eyeRoot;
  trailAnchor.isVisible = false;
  const trail = new ParticleSystem("freudFx_eyeTrail", 360, scene);
  trail.particleTexture = softDot(scene);
  trail.emitter = trailAnchor;
  trail.minEmitBox = new Vector3(-0.4, -0.4, -0.4);
  trail.maxEmitBox = new Vector3(0.4, 0.4, 0.4);
  trail.color1 = new Color4(0.8, 0.45, 1.0, 0.45);
  trail.color2 = new Color4(1.0, 0.5, 0.9, 0.3);
  trail.colorDead = new Color4(0.35, 0.12, 0.55, 0);
  trail.minSize = 0.12;
  trail.maxSize = 0.4;
  trail.minLifeTime = 0.6;
  trail.maxLifeTime = 1.4;
  trail.emitRate = 0;
  trail.blendMode = ParticleSystem.BLENDMODE_ADD;
  trail.direction1 = new Vector3(-0.4, -0.2, -0.4);
  trail.direction2 = new Vector3(0.4, 0.4, 0.4);
  trail.minEmitPower = 0.15;
  trail.maxEmitPower = 0.5;
  trail.start();

  // Everything starts dark.
  runeRoot.setEnabled(false);
  pillar.setEnabled(false);
  shieldRoot.setEnabled(false);
  streakRoot.setEnabled(false);
  eyeRoot.setEnabled(false);

  // Compile every effect shader NOW, not on first cast. A still-compiling
  // material renders as nothing, and on a slow GPU that silence can outlive
  // a whole 1-3 s effect — the first cast of each skill would be invisible.
  const warmPairs: [Mesh, StandardMaterial][] = [
    [runeA, runeMatA],
    [runeB, runeMatB],
    [pillar, pillarMat],
    [bubble, bubbleMat],
    [cage, cageMat],
    [halo, haloMat],
    [eye, eyeMat],
  ];
  // One mote per material warms both swarm variants.
  warmPairs.push([motes[0]!.mesh, moteMat], [motes[10]!.mesh, moteEyeMat]);
  if (firstStreak) warmPairs.push([firstStreak, streakMat]);
  for (const [mesh, mat] of warmPairs) {
    // No fog on magic glows — and critically, this keeps the precompiled
    // variant identical to the rendered one (fog would add a define and
    // trigger a recompile on first cast, eating the opening frames).
    mesh.applyFog = false;
    mat.forceCompilation(mesh);
  }
  // The other streaks share the warmed material but still need the fog opt-out.
  for (const s of streaks) s.spinner.getChildMeshes(false).forEach((m) => (m.applyFog = false));

  // ---- Per-frame driver ---------------------------------------------------
  // Effect timers; <0 means idle. One observer drives whichever are live.
  let paletteT = -1;
  let paletteTint = STAGE_TINTS.oral!;
  let shieldT = -1;
  let chainT = -1;
  let ultT = -1;
  const ultDir = new Vector3(0, 0, 1);

  const PALETTE_SECS = 1.15;
  const SHIELD_SECS = 2.8;
  const CHAIN_SECS = 2.6;
  const ULT_SECS = 6.5;

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (paletteT >= 0) {
      paletteT += dt;
      const t = paletteT;
      const u = clamp01(t / PALETTE_SECS);
      if (u >= 1) {
        paletteT = -1;
        runeRoot.setEnabled(false);
        pillar.setEnabled(false);
      } else {
        const grow = outBack(clamp01(t / 0.35));
        runeRoot.scaling.setAll(Math.max(0.01, grow));
        const fade = 1 - sstep(0.55, 1, u);
        runeMatA.alpha = fade;
        runeMatB.alpha = fade * 0.9;
        runeMatA.emissiveColor.copyFrom(paletteTint);
        runeMatB.emissiveColor.copyFrom(paletteTint.scale(1.35));
        runeA.rotation.y += dt * 1.6;
        runeB.rotation.y -= dt * 2.6;
        // Pillar: shoots up fast, narrows as it fades out.
        const rise = outBack(clamp01(t / 0.3));
        pillar.scaling.set(1 - 0.35 * u, Math.max(0.01, rise), 1 - 0.35 * u);
        pillarMat.alpha = 0.55 * fade;
        pillarMat.emissiveColor.copyFrom(paletteTint);
        pillar.rotation.y += dt * 3;
      }
    }

    if (shieldT >= 0) {
      shieldT += dt;
      const t = shieldT;
      const u = clamp01(t / SHIELD_SECS);
      if (u >= 1) {
        shieldT = -1;
        shieldRoot.setEnabled(false);
      } else {
        const pop = outBack(clamp01(t / 0.35));
        shieldRoot.scaling.setAll(Math.max(0.01, pop));
        const fade = 1 - sstep(0.8, 1, u);
        bubbleMat.alpha = (0.15 + 0.05 * Math.sin(t * 7)) * fade;
        cageMat.alpha = (0.26 + 0.1 * Math.sin(t * 7 + 1.3)) * fade;
        haloMat.alpha = 0.7 * fade;
        cage.rotation.y += dt * 0.7;
        halo.rotation.y += dt * 2.4;
        halo.rotation.x = 0.5 * Math.sin(t * 1.7);
      }
    }

    if (chainT >= 0) {
      chainT += dt;
      const t = chainT;
      const u = clamp01(t / CHAIN_SECS);
      if (u >= 1) {
        chainT = -1;
        streakRoot.setEnabled(false);
      } else {
        streakMat.alpha = 0.9 * sstep(0, 0.15, u) * (1 - sstep(0.75, 1, u));
        // The streaks bloom outward as the cast runs, reaching 4x range at
        // the end — the widening ring is the cast's wind-up readout.
        const expand = 1 + 3 * u;
        for (const s of streaks) {
          s.spinner.rotation.y += dt * s.speed;
          s.line.position.x = s.radius * expand;
        }
        // The whole swarm precesses so no orbit reads as a static hoop.
        streakRoot.rotation.y += dt * 0.9;
      }
    }

    if (ultT >= 0) {
      ultT += dt;
      const t = ultT;
      const u = clamp01(t / ULT_SECS);
      if (u >= 1) {
        ultT = -1;
        wake.emitRate = 0;
        trail.emitRate = 0;
        eyeRoot.setEnabled(false);
      } else {
        // Slow, implacable push forward; eases off near the end.
        const speed = 0.9 * (1 - sstep(0.75, 1, u));
        eyeRoot.position.addInPlace(ultDir.scale(speed * dt));
        eyeRoot.position.y += Math.sin(t * 1.3) * 0.15 * dt;
        eye.scaling.setAll(Math.max(0.01, outBack(clamp01(t / 0.5)) * (1 + 0.6 * u)));
        const env = sstep(0, 0.12, u) * (1 - sstep(0.82, 1, u));
        eyeMat.alpha = 0.88 * env;
        moteMat.alpha = 0.85 * env;
        moteEyeMat.alpha = 0.9 * env;
        // Swarm: each mote orbits the eye on its own radius/speed, bobbing.
        for (const mo of motes) {
          const a = mo.phase + t * mo.speed;
          mo.mesh.position.set(
            Math.cos(a) * mo.radius,
            Math.sin(t * mo.yFreq + mo.yPhase) * mo.yAmp,
            Math.sin(a) * mo.radius
          );
        }
        trailAnchor.position.copyFrom(ultDir.scale(-1.6));
        wake.emitRate = 50 * (1 - sstep(0.7, 1, u));
        trail.emitRate = 90 * (1 - sstep(0.7, 1, u));
      }
    }
  });

  return {
    cast(kind, id) {
      switch (kind) {
        case "palette": {
          paletteTint = STAGE_TINTS[id.split(".").pop() ?? ""] ?? STAGE_TINTS.oral!;
          paletteT = 0;
          runeRoot.setEnabled(true);
          pillar.setEnabled(true);
          sparks.color1 = new Color4(paletteTint.r, paletteTint.g, paletteTint.b, 0.9);
          sparks.color2 = new Color4(1, 1, 1, 0.6);
          sparks.colorDead = new Color4(paletteTint.r * 0.4, paletteTint.g * 0.4, paletteTint.b * 0.4, 0);
          sparks.manualEmitCount = 60;
          break;
        }
        case "defense":
          shieldT = 0;
          shieldRoot.setEnabled(true);
          sparks.color1 = new Color4(0.62, 0.4, 1.0, 0.9);
          sparks.color2 = new Color4(0.85, 0.7, 1.0, 0.6);
          sparks.colorDead = new Color4(0.25, 0.15, 0.4, 0);
          sparks.manualEmitCount = 45;
          break;
        case "chain":
          chainT = 0;
          streakRoot.setEnabled(true);
          break;
        case "ultimate": {
          ultT = 0;
          // Launch from the hero's chest, along the current facing. The Tripo
          // model looks down the wrapper's -Z (glTF handedness flip), so the
          // "forward" the player sees is Backward() on the node.
          hero.getDirection(Vector3.Backward()).normalizeToRef(ultDir);
          ultDir.y = 0;
          ultDir.normalize();
          const p = hero.getAbsolutePosition();
          eyeRoot.position.set(p.x + ultDir.x * 1.4, p.y + 2.2, p.z + ultDir.z * 1.4);
          eye.scaling.setAll(0.01);
          eyeRoot.setEnabled(true);
          break;
        }
      }
    },
  };
}
