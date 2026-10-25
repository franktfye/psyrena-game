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
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/tubeBuilder";
import "@babylonjs/core/Meshes/Builders/ribbonBuilder";

import { AINSWORTH } from "@shared/heroes/ainsworth";

import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Ainsworth's cast VFX — attachment made visible as ribbons, distance and
 * repair. Broad procedural strips and fine bonded seams give each cast a clear
 * silhouette without relying on translucent spheres or domes. Emissive levels
 * and the included-only glow layer are deliberately restrained.
 *
 *  - Secure (1):            paired rose ribbons meet in an embrace, hold, then
 *                           open into a wide release bond: closeness with room
 *                           to explore.
 *  - Avoidant (2):          two steel arcs remain conspicuously separated;
 *                           a small, measured double heartbeat sits between.
 *  - Ambivalent (3):        unequal coral ribbons alternate an urgent inward
 *                           pull with an abrupt outward push.
 *  - Disorganized (4):      broken violet strips snap into alignment and are
 *                           rewoven with cyan into an open shelter for the
 *                           entire team-immunity window.
 *  - Safe Haven (E):        a cyan ribbed canopy and quiet ground bond protect
 *                           her for the entire mitigation window.
 *  - Strange Situation (R): a luminous threshold appears; a separation ribbon
 *                           travels out and a rose-gold reunion arc returns.
 *  - Earned Security (F):   a rose heart is repaired by gold kintsugi seams,
 *                           then paired gold bonds carry the wave outward.
 *
 * Loaded on demand by heroCasts.ts. One factory, one render observer, no
 * external assets. Roots self-disable, every material is precompiled, and glow
 * is created only when vfxGlowOptions() permits it.
 */

const CYAN = new Color3(0.3, 0.86, 0.96);
const TEAL = new Color3(0.14, 0.64, 0.68);
const GOLD = new Color3(1.0, 0.78, 0.3);
const ROSE = new Color3(1.0, 0.4, 0.58);
const STEEL = new Color3(0.55, 0.68, 0.82);
const CORAL = new Color3(1.0, 0.36, 0.24);
const VIOLET = new Color3(0.6, 0.36, 0.94);
const TAU = Math.PI * 2;

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
const pulse = (u: number, a: number, b: number, edge: number): number =>
  sstep(a, a + edge, u) * (1 - sstep(b - edge, b, u));

function fxMat(scene: Scene, name: string, tint: Color3, alpha: number): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.emissiveColor = tint.scale(0.55);
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.alpha = alpha;
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  return m;
}

function softDot(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("ainsworthFxDot", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.4, "rgba(255,255,255,0.32)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.95);
  ctx.bezierCurveTo(cx - r * 1.35, cy + r * 0.1, cx - r * 0.95, cy - r * 0.95, cx, cy - r * 0.35);
  ctx.bezierCurveTo(cx + r * 0.95, cy - r * 0.95, cx + r * 1.35, cy + r * 0.1, cx, cy + r * 0.95);
  ctx.closePath();
}

/** Faceted rose heart and a separate white seam mask for the gold repair. */
function heartTextures(scene: Scene): { body: DynamicTexture; cracks: DynamicTexture } {
  const size = 256;
  const c = size / 2;
  const body = new DynamicTexture("ainsworthFxHeart", { width: size, height: size }, scene, false);
  const b = body.getContext() as CanvasRenderingContext2D;
  heartPath(b, c, c, size * 0.36);
  b.fillStyle = "rgba(255,255,255,0.48)";
  b.fill();
  b.save();
  heartPath(b, c, c, size * 0.36);
  b.clip();
  b.fillStyle = "rgba(255,255,255,0.18)";
  b.beginPath();
  b.moveTo(c, c);
  b.lineTo(0, 0);
  b.lineTo(c, 0);
  b.closePath();
  b.fill();
  b.fillStyle = "rgba(255,255,255,0.12)";
  b.beginPath();
  b.moveTo(c, c);
  b.lineTo(size, size * 0.2);
  b.lineTo(size, size);
  b.closePath();
  b.fill();
  b.restore();
  heartPath(b, c, c, size * 0.36);
  b.lineWidth = 5;
  b.strokeStyle = "rgba(255,255,255,0.9)";
  b.stroke();
  body.update();
  body.hasAlpha = true;

  const cracks = new DynamicTexture("ainsworthFxCracks", { width: size, height: size }, scene, false);
  const k = cracks.getContext() as CanvasRenderingContext2D;
  k.strokeStyle = "rgba(255,255,255,1)";
  k.lineWidth = 5;
  k.lineCap = "square";
  k.lineJoin = "miter";
  const seams: [number, number][][] = [
    [[0.5, 0.25], [0.43, 0.39], [0.55, 0.49], [0.45, 0.62], [0.5, 0.79]],
    [[0.43, 0.39], [0.29, 0.43], [0.24, 0.52]],
    [[0.55, 0.49], [0.7, 0.45], [0.76, 0.52]],
    [[0.45, 0.62], [0.35, 0.68]],
  ];
  for (const seam of seams) {
    k.beginPath();
    seam.forEach(([x, y], i) => (i ? k.lineTo(x * size, y * size) : k.moveTo(x * size, y * size)));
    k.stroke();
  }
  cracks.update();
  cracks.hasAlpha = true;
  return { body, cracks };
}

export function createAinsworthSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
  const root = (name: string, y = 0): TransformNode => {
    const r = new TransformNode(name, scene);
    r.parent = hero;
    r.position.y = y;
    return r;
  };
  const tube = (name: string, path: Vector3[], radius: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const m = MeshBuilder.CreateTube(name, { path, radius, tessellation: 6 }, scene);
    m.parent = parent;
    m.material = mat;
    m.isPickable = false;
    return m;
  };
  const ribbon = (name: string, left: Vector3[], right: Vector3[], mat: StandardMaterial, parent: TransformNode): Mesh => {
    const m = MeshBuilder.CreateRibbon(name, { pathArray: [left, right], sideOrientation: Mesh.DOUBLESIDE }, scene);
    m.parent = parent;
    m.material = mat;
    m.isPickable = false;
    return m;
  };
  const torus = (name: string, d: number, thickness: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const m = MeshBuilder.CreateTorus(name, { diameter: d, thickness, tessellation: 64 }, scene);
    m.parent = parent;
    m.material = mat;
    m.isPickable = false;
    return m;
  };
  /** A broad vertical arch ribbon in local XY, open at its foot. */
  const arch = (name: string, radius: number, width: number, start: number, end: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const inner: Vector3[] = [];
    const outer: Vector3[] = [];
    for (let i = 0; i <= 28; i++) {
      const a = start + (end - start) * (i / 28);
      inner.push(new Vector3(Math.cos(a) * (radius - width / 2), Math.sin(a) * (radius - width / 2), 0));
      outer.push(new Vector3(Math.cos(a) * (radius + width / 2), Math.sin(a) * (radius + width / 2), 0));
    }
    return ribbon(name, inner, outer, mat, parent);
  };
  const groundArc = (name: string, radius: number, width: number, start: number, end: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const inner: Vector3[] = [];
    const outer: Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = start + (end - start) * (i / 24);
      inner.push(new Vector3(Math.cos(a) * (radius - width / 2), 0, Math.sin(a) * (radius - width / 2)));
      outer.push(new Vector3(Math.cos(a) * (radius + width / 2), 0, Math.sin(a) * (radius + width / 2)));
    }
    return ribbon(name, inner, outer, mat, parent);
  };

  const sparkAnchor = MeshBuilder.CreateBox("ainsworthFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.2;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("ainsworthFx_sparks", 200, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.4, -0.2, -0.4);
  sparks.maxEmitBox = new Vector3(0.4, 0.2, 0.4);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.04;
  sparks.maxSize = 0.16;
  sparks.minLifeTime = 0.45;
  sparks.maxLifeTime = 1.0;
  sparks.emitRate = 0;
  sparks.direction1 = new Vector3(-0.4, 0.8, -0.4);
  sparks.direction2 = new Vector3(0.4, 2.0, 0.4);
  sparks.gravity = new Vector3(0, -0.3, 0);
  sparks.start();
  const burst = (c1: Color3, c2: Color3, n: number, y = 1.2, slow = false): void => {
    sparkAnchor.position.y = y;
    sparks.color1 = new Color4(c1.r, c1.g, c1.b, 0.72);
    sparks.color2 = new Color4(c2.r, c2.g, c2.b, 0.45);
    sparks.colorDead = new Color4(c1.r * 0.25, c1.g * 0.25, c1.b * 0.25, 0);
    sparks.minEmitPower = slow ? 0.12 : 0.5;
    sparks.maxEmitPower = slow ? 0.35 : 1.5;
    sparks.minLifeTime = slow ? 1.6 : 0.45;
    sparks.maxLifeTime = slow ? 2.6 : 1.0;
    sparks.manualEmitCount = n;
  };

  // ---- 1 Secure: two distinct ribbons close, then willingly release --------
  const secureRoot = root("ainsworthFx_secureRoot", 1.15);
  const secureMat = fxMat(scene, "ainsworthFx_secureMat", ROSE, 0);
  const secureAccentMat = fxMat(scene, "ainsworthFx_secureAccentMat", new Color3(1, 0.68, 0.74), 0);
  const secureArcs = [-1, 1].map((side, i) => {
    const a = arch(`ainsworthFx_secureArc_${side}`, 1.0, 0.16, -Math.PI * 0.42, Math.PI * 0.42, i ? secureAccentMat : secureMat, secureRoot);
    a.rotation.z = side * Math.PI / 2;
    a.position.x = side * 1.0;
    return a;
  });
  const releaseRoot = root("ainsworthFx_releaseRoot", 0.09);
  const releaseMat = fxMat(scene, "ainsworthFx_releaseMat", ROSE, 0);
  const release = [
    groundArc("ainsworthFx_releaseA", 1, 0.075, -Math.PI * 0.45, Math.PI * 0.45, releaseMat, releaseRoot),
    groundArc("ainsworthFx_releaseB", 1, 0.075, Math.PI * 0.55, Math.PI * 1.45, releaseMat, releaseRoot),
  ];

  // ---- 2 Avoidant: separated arcs and a restrained, private heartbeat ------
  const avoidRoot = root("ainsworthFx_avoidRoot", 1.25);
  const avoidMat = fxMat(scene, "ainsworthFx_avoidMat", STEEL, 0);
  const avoidArcs = [-1, 1].map((side) => {
    const a = arch(`ainsworthFx_avoidArc_${side}`, 1.05, 0.1, -Math.PI * 0.38, Math.PI * 0.38, avoidMat, avoidRoot);
    a.rotation.z = side * Math.PI / 2;
    a.position.x = side * 0.85;
    return a;
  });
  const beatMat = fxMat(scene, "ainsworthFx_beatMat", new Color3(0.72, 0.82, 0.9), 0);
  const beat = tube("ainsworthFx_beat", [
    new Vector3(-0.45, 0, 0), new Vector3(-0.18, 0, 0), new Vector3(-0.08, 0.12, 0),
    new Vector3(0.02, -0.16, 0), new Vector3(0.12, 0.08, 0), new Vector3(0.2, 0, 0), new Vector3(0.45, 0, 0),
  ], 0.018, beatMat, avoidRoot);
  beat.position.z = 0.08;

  // ---- 3 Ambivalent: asymmetric attachment ribbons pull then push ----------
  const ambRoot = root("ainsworthFx_ambRoot", 1.1);
  const pullMat = fxMat(scene, "ainsworthFx_pullMat", CORAL, 0);
  const pushMat = fxMat(scene, "ainsworthFx_pushMat", ROSE, 0);
  const pull = arch("ainsworthFx_pull", 1.35, 0.19, -Math.PI * 0.6, Math.PI * 0.42, pullMat, ambRoot);
  pull.rotation.z = Math.PI * 0.8;
  const push = arch("ainsworthFx_push", 0.9, 0.1, -Math.PI * 0.35, Math.PI * 0.55, pushMat, ambRoot);
  push.rotation.z = -Math.PI * 0.65;

  // ---- 4 Disorganized: fragments rewoven into a violet/cyan shelter --------
  const disRoot = root("ainsworthFx_disRoot");
  const glitchMat = fxMat(scene, "ainsworthFx_glitchMat", VIOLET, 0);
  const fragments = Array.from({ length: 10 }, (_, i) => {
    const m = MeshBuilder.CreatePlane(`ainsworthFx_fragment_${i}`, { width: 0.55, height: 0.12 }, scene);
    m.parent = disRoot;
    m.material = glitchMat;
    m.isPickable = false;
    return m;
  });
  const shelterVioletMat = fxMat(scene, "ainsworthFx_shelterVioletMat", VIOLET, 0);
  const shelterCyanMat = fxMat(scene, "ainsworthFx_shelterCyanMat", CYAN, 0);
  const shelterRibs = Array.from({ length: 8 }, (_, i) => {
    const rib = arch(`ainsworthFx_shelterRib_${i}`, 1, 0.055, 0, Math.PI, i % 2 ? shelterCyanMat : shelterVioletMat, disRoot);
    rib.rotation.y = (i / 8) * Math.PI;
    return rib;
  });
  const shelterBondMat = fxMat(scene, "ainsworthFx_shelterBondMat", CYAN, 0);
  const shelterBonds = [0, 1, 2].map((i) => {
    const bond = torus(`ainsworthFx_shelterBond_${i}`, 2, 0.018, shelterBondMat, disRoot);
    bond.position.y = 0.18 + i * 0.34;
    return bond;
  });

  // ---- E Safe Haven: a structured cyan canopy, never a translucent dome ----
  const havenRoot = root("ainsworthFx_havenRoot");
  const havenMat = fxMat(scene, "ainsworthFx_havenMat", CYAN, 0);
  const havenRibs = Array.from({ length: 6 }, (_, i) => {
    const rib = arch(`ainsworthFx_havenRib_${i}`, 2.15, 0.065, 0, Math.PI, havenMat, havenRoot);
    rib.rotation.y = (i / 6) * Math.PI;
    return rib;
  });
  const havenAccentMat = fxMat(scene, "ainsworthFx_havenAccentMat", TEAL, 0);
  const havenBond = torus("ainsworthFx_havenBond", 4.3, 0.025, havenAccentMat, havenRoot);
  havenBond.position.y = 0.06;
  const havenThreads = Array.from({ length: 4 }, (_, i) => {
    const a = (i / 4) * TAU + Math.PI / 4;
    return tube(`ainsworthFx_havenThread_${i}`, [new Vector3(Math.cos(a) * 2.12, 0.06, Math.sin(a) * 2.12), new Vector3(0, 2.15, 0)], 0.012, havenAccentMat, havenRoot);
  });

  // ---- R Strange Situation: threshold, separation, reunion -----------------
  const doorRoot = root("ainsworthFx_doorRoot");
  const doorMat = fxMat(scene, "ainsworthFx_doorMat", GOLD, 0);
  const jambs = [-1, 1].map((side) => {
    const m = MeshBuilder.CreateBox(`ainsworthFx_jamb_${side}`, { width: 0.055, height: 2.45, depth: 0.055 }, scene);
    m.parent = doorRoot;
    m.position.set(side * 0.66, 1.225, 0);
    m.material = doorMat;
    m.isPickable = false;
    return m;
  });
  const lintel = MeshBuilder.CreateBox("ainsworthFx_lintel", { width: 1.375, height: 0.055, depth: 0.055 }, scene);
  lintel.parent = doorRoot;
  lintel.position.y = 2.45;
  lintel.material = doorMat;
  lintel.isPickable = false;
  const threshold = tube("ainsworthFx_threshold", [new Vector3(-1.05, 0.06, 0), new Vector3(1.05, 0.06, 0)], 0.025, doorMat, doorRoot);
  const separationMat = fxMat(scene, "ainsworthFx_separationMat", STEEL, 0);
  const separation = ribbon("ainsworthFx_separation", [new Vector3(0, 0.25, 0), new Vector3(0, 0.5, 1), new Vector3(0, 0.2, 2)], [new Vector3(0.1, 0.25, 0), new Vector3(0.1, 0.5, 1), new Vector3(0.1, 0.2, 2)], separationMat, doorRoot);
  const reunionRoot = root("ainsworthFx_reunionRoot", 1.0);
  const reunionMat = fxMat(scene, "ainsworthFx_reunionMat", ROSE, 0);
  const reunion = arch("ainsworthFx_reunion", 1.2, 0.12, 0, Math.PI, reunionMat, reunionRoot);

  // ---- F Earned Security: kintsugi repair and paired gold bond wave --------
  const earnRoot = root("ainsworthFx_earnRoot", 2.7);
  const { body: heartTex, cracks: crackTex } = heartTextures(scene);
  const heartMat = fxMat(scene, "ainsworthFx_heartMat", ROSE, 0);
  heartMat.emissiveTexture = heartTex;
  heartMat.opacityTexture = heartTex;
  const heart = MeshBuilder.CreatePlane("ainsworthFx_heart", { size: 1.45 }, scene);
  heart.parent = earnRoot;
  heart.billboardMode = Mesh.BILLBOARDMODE_ALL;
  heart.material = heartMat;
  heart.isPickable = false;
  const crackMat = fxMat(scene, "ainsworthFx_crackMat", GOLD, 0);
  crackMat.emissiveTexture = crackTex;
  crackMat.opacityTexture = crackTex;
  const crack = MeshBuilder.CreatePlane("ainsworthFx_crack", { size: 1.45 }, scene);
  crack.parent = earnRoot;
  crack.billboardMode = Mesh.BILLBOARDMODE_ALL;
  crack.material = crackMat;
  crack.isPickable = false;
  const waveRoot = root("ainsworthFx_waveRoot", 0.1);
  const waveMat = fxMat(scene, "ainsworthFx_waveMat", GOLD, 0);
  const waves = [
    groundArc("ainsworthFx_waveA", 1, 0.09, -Math.PI * 0.43, Math.PI * 0.43, waveMat, waveRoot),
    groundArc("ainsworthFx_waveB", 1, 0.09, Math.PI * 0.57, Math.PI * 1.43, waveMat, waveRoot),
  ];

  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("ainsworthFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 0.7;
    for (const m of [...secureArcs, beat, ...shelterRibs, ...havenRibs, ...havenThreads, lintel, threshold, reunion, crack, ...waves]) glow.addIncludedOnlyMesh(m);
    scene.onDisposeObservable.add(() => glow.dispose());
  }

  const roots = [secureRoot, releaseRoot, avoidRoot, ambRoot, disRoot, havenRoot, doorRoot, reunionRoot, earnRoot, waveRoot];
  for (const r of roots) r.setEnabled(false);

  const warm: [Mesh, StandardMaterial][] = [
    [secureArcs[0]!, secureMat], [secureArcs[1]!, secureAccentMat], [release[0]!, releaseMat], [avoidArcs[0]!, avoidMat],
    [beat, beatMat], [pull, pullMat], [push, pushMat], [fragments[0]!, glitchMat], [shelterRibs[0]!, shelterVioletMat],
    [shelterRibs[1]!, shelterCyanMat], [shelterBonds[0]!, shelterBondMat], [havenRibs[0]!, havenMat], [havenBond, havenAccentMat],
    [jambs[0]!, doorMat], [separation, separationMat], [reunion, reunionMat], [heart, heartMat], [crack, crackMat], [waves[0]!, waveMat],
  ];
  for (const [mesh, mat] of warm) mat.forceCompilation(mesh);
  for (const m of scene.meshes) if (m.name.startsWith("ainsworthFx_")) m.applyFog = false;

  const secs = (ms: number | undefined, fallback: number): number => (ms ?? fallback) / 1000;
  const SECURE_SECS = 1.3;
  const AVOID_SECS = secs(AINSWORTH.palette.find((p) => p.id === "ainsworth.avoidant")?.effects.find((e) => e.kind === "self.stagger")?.durationMs, 4_000);
  const AMB_SECS = 1.2;
  const IMMUNE_SECS = secs(AINSWORTH.palette.find((p) => p.id === "ainsworth.disorganized")?.effects.find((e) => e.kind === "team.immunity")?.durationMs, 3_000);
  const GLITCH_SECS = 0.55;
  const HAVEN_SECS = secs(AINSWORTH.defense.mitigation?.durationMs, 6_000);
  const DOOR_SECS = 1.7;
  const EARN_SECS = 2.6;
  const TEAM_R = 6;
  let secureT = -1;
  let avoidT = -1;
  let ambT = -1;
  let disT = -1;
  let havenT = -1;
  let doorT = -1;
  let earnT = -1;

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (secureT >= 0) {
      secureT += dt;
      const u = clamp01(secureT / SECURE_SECS);
      const close = sstep(0, 0.32, u);
      const open = sstep(0.52, 0.82, u);
      for (let i = 0; i < secureArcs.length; i++) {
        const side = i ? 1 : -1;
        const a = secureArcs[i]!;
        a.position.x = side * (1.0 - close * 0.72 + open * 1.2);
        a.rotation.y = side * (0.4 * (1 - close) + open * 0.6);
        a.scaling.y = 0.85 + close * 0.15;
      }
      secureMat.alpha = 0.78 * pulse(u, 0, 0.88, 0.14);
      secureAccentMat.alpha = secureMat.alpha;
      const r = sstep(0.52, 1, u);
      releaseRoot.scaling.set(0.7 + r * TEAM_R * 1.45, 1, 0.7 + r * TEAM_R * 1.45);
      releaseMat.alpha = 0.58 * pulse(u, 0.52, 1, 0.1);
      if (secureT >= SECURE_SECS) {
        secureT = -1;
        secureRoot.setEnabled(false);
        releaseRoot.setEnabled(false);
      }
    }

    if (avoidT >= 0) {
      avoidT += dt;
      const u = clamp01(avoidT / AVOID_SECS);
      const fade = sstep(0, 0.045, u) * (1 - sstep(0.88, 1, u));
      const arrive = outBack(clamp01(avoidT / 0.35));
      avoidRoot.scaling.setAll(Math.max(0.01, arrive));
      avoidMat.alpha = 0.48 * fade;
      for (let i = 0; i < avoidArcs.length; i++) {
        const side = i ? 1 : -1;
        avoidArcs[i]!.position.x = side * (0.82 + 0.12 * Math.sin(Math.min(avoidT, 1) * Math.PI));
      }
      // A quiet lub-dub once per second, not a racing alarm.
      const ph = avoidT % 1;
      const lub = Math.exp(-((ph - 0.12) ** 2) / 0.004) + 0.55 * Math.exp(-((ph - 0.29) ** 2) / 0.005);
      beat.scaling.setAll(0.9 + lub * 0.12);
      beatMat.alpha = (0.2 + lub * 0.5) * fade;
      if (avoidT >= AVOID_SECS) {
        avoidT = -1;
        avoidRoot.setEnabled(false);
      }
    }

    if (ambT >= 0) {
      ambT += dt;
      const u = clamp01(ambT / AMB_SECS);
      const half = u < 0.5 ? u * 2 : (u - 0.5) * 2;
      const inward = sstep(0, 0.46, half);
      const outward = sstep(0.46, 1, half);
      pull.scaling.setAll(1.55 - inward * 0.75 + outward * 0.25);
      pull.rotation.y = -0.45 + inward * 0.7;
      pullMat.alpha = 0.78 * pulse(half, 0, 0.56, 0.14);
      push.scaling.setAll(0.65 + outward * 1.8);
      push.rotation.y = 0.55 - outward * 0.85;
      pushMat.alpha = 0.7 * pulse(half, 0.44, 1, 0.12);
      if (ambT >= AMB_SECS) {
        ambT = -1;
        ambRoot.setEnabled(false);
      }
    }

    if (disT >= 0) {
      disT += dt;
      const broken = disT < GLITCH_SECS;
      glitchMat.alpha = broken ? 0.7 : 0;
      for (let i = 0; i < fragments.length; i++) {
        const f = fragments[i]!;
        f.setEnabled(broken);
        if (broken) {
          const snap = Math.floor(disT * 18);
          const a = (i / fragments.length) * TAU + snap * 0.12;
          f.position.set(Math.cos(a) * (0.8 + (i % 3) * 0.22), 0.35 + (i % 5) * 0.38, Math.sin(a) * (0.8 + (i % 3) * 0.22));
          f.rotation.set(0, -a + Math.PI / 2, (i % 2 ? 1 : -1) * (0.3 + (snap % 3) * 0.22));
        }
      }
      const d = disT - GLITCH_SECS;
      if (d >= 0) {
        const u = clamp01(d / IMMUNE_SECS);
        const fade = 1 - sstep(0.88, 1, u);
        const grow = outBack(clamp01(d / 0.4));
        disRoot.scaling.setAll(Math.max(0.01, grow * TEAM_R));
        for (let i = 0; i < shelterRibs.length; i++) {
          const weave = sstep(i * 0.018, 0.12 + i * 0.018, d);
          shelterRibs[i]!.scaling.set(1, Math.max(0.01, weave), 1);
          shelterRibs[i]!.rotation.z = (1 - weave) * (i % 2 ? 0.5 : -0.5);
        }
        shelterVioletMat.alpha = 0.58 * fade;
        shelterCyanMat.alpha = 0.62 * fade;
        for (let i = 0; i < shelterBonds.length; i++) {
          const y = 0.18 + i * 0.34;
          const r = Math.sqrt(Math.max(0.05, 1 - y * y));
          shelterBonds[i]!.scaling.set(r, 1, r);
          shelterBonds[i]!.rotation.y = d * (i % 2 ? -0.35 : 0.35);
        }
        shelterBondMat.alpha = 0.38 * fade;
        if (d >= IMMUNE_SECS) {
          disT = -1;
          disRoot.setEnabled(false);
          disRoot.scaling.setAll(1);
        }
      }
    }

    if (havenT >= 0) {
      havenT += dt;
      const u = clamp01(havenT / HAVEN_SECS);
      const fade = sstep(0, 0.04, u) * (1 - sstep(0.9, 1, u));
      const grow = outBack(clamp01(havenT / 0.42));
      havenRoot.scaling.setAll(Math.max(0.01, grow));
      havenMat.alpha = (0.42 + Math.sin(havenT * 1.3) * 0.035) * fade;
      havenAccentMat.alpha = 0.48 * fade;
      for (let i = 0; i < havenRibs.length; i++) {
        const draw = sstep(i * 0.035, 0.22 + i * 0.035, havenT);
        havenRibs[i]!.scaling.y = Math.max(0.01, draw);
      }
      havenBond.rotation.y += dt * 0.12;
      if (havenT >= HAVEN_SECS) {
        havenT = -1;
        havenRoot.setEnabled(false);
      }
    }

    if (doorT >= 0) {
      doorT += dt;
      const u = clamp01(doorT / DOOR_SECS);
      doorRoot.scaling.y = Math.max(0.01, outBack(clamp01(u / 0.22)));
      doorMat.alpha = 0.72 * pulse(u, 0, 0.92, 0.14);
      const leave = sstep(0.12, 0.42, u) * (1 - sstep(0.48, 0.7, u));
      separation.scaling.z = Math.max(0.01, leave);
      separationMat.alpha = 0.42 * pulse(u, 0.12, 0.68, 0.12);
      const back = sstep(0.5, 0.82, u);
      reunionRoot.position.z = -1.1 + back * 1.1;
      reunionRoot.position.y = 0.3 + Math.sin(back * Math.PI) * 0.6;
      reunionRoot.scaling.setAll(0.5 + back * 0.7);
      reunionMat.alpha = 0.72 * pulse(u, 0.48, 1, 0.12);
      if (doorT >= DOOR_SECS) {
        doorT = -1;
        doorRoot.setEnabled(false);
        reunionRoot.setEnabled(false);
      }
    }

    if (earnT >= 0) {
      earnT += dt;
      const u = clamp01(earnT / EARN_SECS);
      earnRoot.position.y = 1.55 + 1.1 * sstep(0, 0.28, u);
      const mend = sstep(0.26, 0.66, u);
      heartMat.emissiveColor.copyFrom(Color3.Lerp(ROSE.scale(0.78), GOLD.scale(0.78), mend * 0.55));
      heartMat.alpha = 0.84 * pulse(u, 0, 0.9, 0.1);
      crackMat.alpha = (0.25 + mend * 0.65) * pulse(u, 0.22, 0.93, 0.1);
      const settle = 1 + Math.sin(mend * Math.PI) * 0.1;
      heart.scaling.setAll(settle);
      crack.scaling.setAll(settle);
      const w = sstep(0.68, 1, u);
      waveRoot.scaling.set(0.65 + w * TEAM_R * 1.65, 1, 0.65 + w * TEAM_R * 1.65);
      waveRoot.rotation.y = w * 0.3;
      waveMat.alpha = 0.64 * pulse(u, 0.68, 1, 0.07);
      if (earnT >= EARN_SECS) {
        earnT = -1;
        earnRoot.setEnabled(false);
        waveRoot.setEnabled(false);
      }
    }
  });

  return {
    cast(kind: FreudCastKind, id: string) {
      switch (kind) {
        case "palette":
          if (id === "ainsworth.secure") {
            secureT = 0;
            secureRoot.setEnabled(true);
            releaseRoot.setEnabled(true);
            burst(ROSE, new Color3(1, 0.82, 0.88), 26, 1.2);
          } else if (id === "ainsworth.avoidant") {
            avoidT = 0;
            avoidRoot.setEnabled(true);
            burst(STEEL, new Color3(0.82, 0.9, 1), 14, 1.3, true);
          } else if (id === "ainsworth.ambivalent") {
            ambT = 0;
            ambRoot.setEnabled(true);
            burst(CORAL, ROSE, 28, 1.0);
          } else if (id === "ainsworth.disorganized") {
            disT = 0;
            disRoot.scaling.setAll(1);
            disRoot.setEnabled(true);
            burst(VIOLET, CYAN, 36, 1.1);
          }
          break;
        case "defense":
          havenT = 0;
          havenRoot.setEnabled(true);
          burst(CYAN, TEAL, 24, 0.6, true);
          break;
        case "chain":
          doorT = 0;
          doorRoot.position.z = -1.1;
          reunionRoot.position.z = -1.1;
          doorRoot.setEnabled(true);
          reunionRoot.setEnabled(true);
          burst(GOLD, ROSE, 28, 1.2);
          break;
        case "ultimate":
          earnT = 0;
          earnRoot.setEnabled(true);
          waveRoot.setEnabled(true);
          burst(GOLD, CYAN, 46, 2.2);
          break;
      }
    },
  };
}
