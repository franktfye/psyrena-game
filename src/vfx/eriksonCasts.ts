import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { vfxGlowOptions } from "../core/quality";

import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/tubeBuilder";

import { ERIKSON, ERIKSON_PSYCHOSOCIAL } from "@shared/heroes/erikson";

import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Erikson's cast VFX — time rendered as illuminated draughtsmanship. Every
 * asset is procedural Babylon geometry, with fine tubes, open arcs and faceted
 * glass replacing closed bubbles and generic orbs. Emissive colour is held
 * below clipping so the silhouette survives bloom.
 *
 *  - Life Stage (1):      an eight-stage filigree dial; the active stage's
 *                         diamond and rising pointer catch amber light.
 *  - Virtue (2):          a cut-gold virtue kite opens over the dial, turns,
 *                         then divides into eight angular splinters.
 *  - Moratorium (E):      an upright hourglass hangs among plumb time lines;
 *                         nothing falls for the entire mitigation window.
 *  - Identity Crisis (R): four tall mirror panes close around him and break
 *                         along hard triangular, amber/magenta fractures.
 *  - Life Review (F):     eight arcs illuminate in sequence, gather into a
 *                         rising helix, then release as a slender gold lance.
 *
 * Loaded on demand by heroCasts.ts. The factory builds and precompiles once;
 * one render observer re-arms these meshes per cast and every root disables
 * itself at the end. Glow remains gated by vfxGlowOptions().
 */

const AMBER = new Color3(1.0, 0.55, 0.22);
const GOLD = new Color3(1.0, 0.78, 0.28);
const CYAN = new Color3(0.34, 0.86, 0.94);
const VIOLET = new Color3(0.56, 0.38, 0.94);
const MAGENTA = new Color3(0.94, 0.3, 0.66);
const STAGES = ERIKSON_PSYCHOSOCIAL.stages.length;
const WHEEL_R = 1.55;
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
  m.emissiveColor = tint.scale(0.65);
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
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

function mirrorTexture(scene: Scene): DynamicTexture {
  const w = 128;
  const h = 256;
  const tex = new DynamicTexture("eriksonFxMirror", { width: w, height: h }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const sheen = ctx.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, "rgba(255,255,255,0.03)");
  sheen.addColorStop(0.42, "rgba(255,255,255,0.3)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.08)");
  sheen.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = sheen;
  ctx.fillRect(7, 7, w - 14, h - 14);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 4;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, h - 22);
  ctx.lineTo(w * 0.46, h * 0.48);
  ctx.lineTo(w * 0.4, h * 0.28);
  ctx.moveTo(w * 0.46, h * 0.48);
  ctx.lineTo(w - 14, h * 0.35);
  ctx.moveTo(w * 0.46, h * 0.48);
  ctx.lineTo(w * 0.7, h * 0.72);
  ctx.stroke();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

const stageOf = (id: string): number => {
  const n = Number(id.split(":")[1]);
  return Number.isFinite(n) && n >= 1 ? (n - 1) % STAGES : 0;
};

/** An asymmetric, double-sided cut kite with real triangular facets. */
function kiteMesh(scene: Scene, name: string, mat: StandardMaterial): Mesh {
  const mesh = new Mesh(name, scene);
  const positions = [
    0, 0.95, 0, -0.48, 0.12, 0, 0, -1.05, 0, 0.48, 0.12, 0,
    0, 0.08, 0.28, 0, 0.08, -0.18,
  ];
  const indices = [
    0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4,
    1, 0, 5, 2, 1, 5, 3, 2, 5, 0, 3, 5,
  ];
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.material = mat;
  mesh.isPickable = false;
  return mesh;
}

export function createEriksonSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
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
  const torus = (name: string, d: number, thickness: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const m = MeshBuilder.CreateTorus(name, { diameter: d, thickness, tessellation: 64 }, scene);
    m.parent = parent;
    m.material = mat;
    m.isPickable = false;
    return m;
  };

  const sparkAnchor = MeshBuilder.CreateBox("eriksonFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.2;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("eriksonFx_sparks", 180, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.35, -0.2, -0.35);
  sparks.maxEmitBox = new Vector3(0.35, 0.2, 0.35);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.04;
  sparks.maxSize = 0.15;
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

  // ---- Life Stage / Virtue: open filigree dial -----------------------------
  const wheelRoot = root("eriksonFx_wheelRoot", 0.065);
  const wheelMat = fxMat(scene, "eriksonFx_wheelMat", AMBER, 0);
  const dialOuter = torus("eriksonFx_dialOuter", WHEEL_R * 2.25, 0.026, wheelMat, wheelRoot);
  const dialInner = torus("eriksonFx_dialInner", WHEEL_R * 1.55, 0.014, wheelMat, wheelRoot);
  const stageMat = fxMat(scene, "eriksonFx_stageMat", GOLD, 0);
  const spokes: Mesh[] = [];
  const markers: Mesh[] = [];
  for (let i = 0; i < STAGES; i++) {
    const a = -Math.PI / 2 + (i / STAGES) * TAU;
    const radial = new Vector3(Math.cos(a), 0, Math.sin(a));
    spokes.push(tube(`eriksonFx_spoke_${i}`, [radial.scale(0.88), radial.scale(1.12), radial.scale(1.7)], 0.012, wheelMat, wheelRoot));
    const marker = kiteMesh(scene, `eriksonFx_marker_${i}`, i === 0 ? stageMat : wheelMat);
    marker.parent = wheelRoot;
    marker.position.copyFrom(radial.scale(WHEEL_R));
    marker.rotation.x = Math.PI / 2;
    marker.rotation.z = -a - Math.PI / 2;
    marker.scaling.set(0.19, 0.23, 0.19);
    markers.push(marker);
  }
  const pointer = kiteMesh(scene, "eriksonFx_stagePointer", stageMat);
  pointer.parent = wheelRoot;
  pointer.scaling.set(0.2, 0.48, 0.2);
  const pointerStem = tube("eriksonFx_pointerStem", [new Vector3(0, 0, 0), new Vector3(0, 1, 0)], 0.018, stageMat, wheelRoot);

  // ---- Virtue: a faceted gold kite, not a round gem -------------------------
  const gemRoot = root("eriksonFx_gemRoot", 2.5);
  const gemMat = fxMat(scene, "eriksonFx_gemMat", GOLD, 0);
  const gem = kiteMesh(scene, "eriksonFx_gem", gemMat);
  gem.parent = gemRoot;
  gem.scaling.set(0.62, 0.62, 0.62);
  const gemEdgeMat = fxMat(scene, "eriksonFx_gemEdgeMat", new Color3(1, 0.92, 0.64), 0);
  gemEdgeMat.wireframe = true;
  const gemEdges = kiteMesh(scene, "eriksonFx_gemEdges", gemEdgeMat);
  gemEdges.parent = gemRoot;
  gemEdges.scaling.setAll(0.635);
  const shardMat = fxMat(scene, "eriksonFx_shardMat", GOLD, 0);
  const shards = Array.from({ length: STAGES }, (_, i) => {
    const s = MeshBuilder.CreateDisc(`eriksonFx_shard_${i}`, { radius: 0.18, tessellation: 3 }, scene);
    s.parent = gemRoot;
    s.material = shardMat;
    s.isPickable = false;
    return s;
  });

  // ---- Moratorium: suspended time lines and stopped sand -------------------
  const timeRoot = root("eriksonFx_timeRoot");
  const timeMat = fxMat(scene, "eriksonFx_timeMat", VIOLET, 0);
  const timeLines = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * TAU;
    const r = i % 2 ? 1.25 : 1.5;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    return tube(`eriksonFx_timeLine_${i}`, [new Vector3(x, 0.08, z), new Vector3(x, 2.8, z)], 0.012, timeMat, timeRoot);
  });
  const timeCapA = torus("eriksonFx_timeCapA", 3, 0.018, timeMat, timeRoot);
  timeCapA.position.y = 2.8;
  const timeCapB = torus("eriksonFx_timeCapB", 3, 0.018, timeMat, timeRoot);
  timeCapB.position.y = 0.08;
  const hgRoot = new TransformNode("eriksonFx_hgRoot", scene);
  hgRoot.parent = timeRoot;
  hgRoot.position.y = 2.25;
  const hgGlassMat = fxMat(scene, "eriksonFx_hgGlassMat", CYAN, 0);
  hgGlassMat.wireframe = true;
  const hgSandMat = fxMat(scene, "eriksonFx_hgSandMat", GOLD, 0);
  const hgGlass = [
    MeshBuilder.CreateCylinder("eriksonFx_hgUp", { height: 0.5, diameterTop: 0.48, diameterBottom: 0.045, tessellation: 8 }, scene),
    MeshBuilder.CreateCylinder("eriksonFx_hgLo", { height: 0.5, diameterTop: 0.045, diameterBottom: 0.48, tessellation: 8 }, scene),
  ];
  hgGlass[0]!.position.y = 0.25;
  hgGlass[1]!.position.y = -0.25;
  const hgSand = MeshBuilder.CreateCylinder("eriksonFx_hgSand", { height: 0.18, diameterTop: 0.035, diameterBottom: 0.32, tessellation: 8 }, scene);
  hgSand.position.y = -0.4;
  const hgCaps = [-1, 1].map((side) => {
    const c = MeshBuilder.CreateCylinder(`eriksonFx_hgCap_${side}`, { height: 0.045, diameter: 0.58, tessellation: 8 }, scene);
    c.position.y = side * 0.53;
    return c;
  });
  for (const m of [...hgGlass, hgSand, ...hgCaps]) {
    m.parent = hgRoot;
    m.material = hgGlass.includes(m) ? hgGlassMat : hgSandMat;
    m.isPickable = false;
  }
  const hgThreads = [-1, 1].map((side) => tube(`eriksonFx_hgThread_${side}`, [new Vector3(side * 0.32, 0.53, 0), new Vector3(side * 0.32, 1.05, 0)], 0.012, hgSandMat, hgRoot));

  // ---- Identity Crisis: tall panes and triangular fractures ----------------
  const mirrorRoot = root("eriksonFx_mirrorRoot");
  const mirrorMat = fxMat(scene, "eriksonFx_mirrorMat", AMBER, 0);
  mirrorMat.emissiveTexture = mirrorTexture(scene);
  mirrorMat.opacityTexture = mirrorMat.emissiveTexture;
  const mirrors = Array.from({ length: 4 }, (_, i) => {
    const m = MeshBuilder.CreatePlane(`eriksonFx_mirror_${i}`, { width: 0.82, height: 2.25 }, scene);
    m.parent = mirrorRoot;
    m.material = mirrorMat;
    m.isPickable = false;
    return m;
  });
  const mShardMat = fxMat(scene, "eriksonFx_mShardMat", MAGENTA, 0);
  const mShardAmberMat = fxMat(scene, "eriksonFx_mShardAmberMat", AMBER, 0);
  const mShards: { mesh: Mesh; pane: number; offset: Vector3; dir: Vector3; spin: Vector3 }[] = [];
  for (let i = 0; i < mirrors.length * 6; i++) {
    const mesh = MeshBuilder.CreateDisc(`eriksonFx_mShard_${i}`, { radius: 0.24, tessellation: 3 }, scene);
    mesh.parent = mirrorRoot;
    mesh.material = i % 2 ? mShardMat : mShardAmberMat;
    mesh.isPickable = false;
    mShards.push({ mesh, pane: Math.floor(i / 6), offset: new Vector3(), dir: new Vector3(), spin: new Vector3() });
  }
  const shockMat = fxMat(scene, "eriksonFx_shockMat", MAGENTA, 0);
  const shockPath = Array.from({ length: 9 }, (_, i) => {
    const a = (i / 8) * TAU;
    const r = i % 2 ? 1 : 0.86;
    return new Vector3(Math.cos(a) * r, 0.06, Math.sin(a) * r);
  });
  const shock = tube("eriksonFx_shock", shockPath, 0.025, shockMat, mirrorRoot);

  // ---- Life Review: eight arcs become a helix and a released lance ---------
  const spiralRoot = root("eriksonFx_spiralRoot");
  const arcs: Mesh[] = [];
  const arcMats: StandardMaterial[] = [];
  for (let i = 0; i < STAGES; i++) {
    const mat = fxMat(scene, `eriksonFx_arcMat_${i}`, Color3.Lerp(AMBER, GOLD, i / (STAGES - 1)), 0);
    const path = Array.from({ length: 17 }, (_, j) => {
      const a = (j / 16) * Math.PI * 1.35;
      return new Vector3(Math.cos(a), 0, Math.sin(a));
    });
    const arc = tube(`eriksonFx_arc_${i}`, path, 0.025, mat, spiralRoot);
    arcs.push(arc);
    arcMats.push(mat);
  }
  const releaseMat = fxMat(scene, "eriksonFx_releaseMat", new Color3(1, 0.9, 0.58), 0);
  const release = kiteMesh(scene, "eriksonFx_release", releaseMat);
  release.parent = spiralRoot;
  release.position.y = 3.25;
  release.scaling.set(0.16, 0.85, 0.16);
  const releaseThread = tube("eriksonFx_releaseThread", [new Vector3(0, 2.4, 0), new Vector3(0, 4.1, 0)], 0.018, releaseMat, spiralRoot);

  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("eriksonFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 0.72;
    for (const m of [dialOuter, dialInner, pointer, gem, gemEdges, timeCapA, timeCapB, hgSand, ...hgThreads, release, releaseThread, shock, ...arcs]) glow.addIncludedOnlyMesh(m);
    scene.onDisposeObservable.add(() => glow.dispose());
  }

  const roots = [wheelRoot, gemRoot, timeRoot, mirrorRoot, spiralRoot];
  for (const r of roots) r.setEnabled(false);

  const warm: [Mesh, StandardMaterial][] = [
    [dialOuter, wheelMat], [pointer, stageMat], [gem, gemMat], [gemEdges, gemEdgeMat], [shards[0]!, shardMat],
    [timeLines[0]!, timeMat], [hgGlass[0]!, hgGlassMat], [hgSand, hgSandMat], [mirrors[0]!, mirrorMat],
    [mShards[0]!.mesh, mShardAmberMat], [mShards[1]!.mesh, mShardMat], [shock, shockMat], [release, releaseMat],
    ...arcs.map((m, i): [Mesh, StandardMaterial] => [m, arcMats[i]!]),
  ];
  for (const [mesh, mat] of warm) mat.forceCompilation(mesh);
  for (const m of scene.meshes) if (m.name.startsWith("eriksonFx_")) m.applyFog = false;

  const STAGE_SECS = 1.0;
  const VIRTUE_SECS = 1.1;
  const MORATORIUM_SECS = (ERIKSON.defense.mitigation?.durationMs ?? 6_000) / 1000;
  const CRISIS_SECS = 1.3;
  const REVIEW_SECS = 2.4;
  let stageT = -1;
  let virtueT = -1;
  let wheelGold = false;
  let timeT = -1;
  let crisisT = -1;
  let reviewT = -1;
  let activeStage = 0;

  const armWheel = (stage: number, gold: boolean): void => {
    activeStage = stage;
    wheelGold = gold;
    wheelMat.emissiveColor.copyFrom((gold ? GOLD : AMBER).scale(0.82));
    for (let i = 0; i < markers.length; i++) markers[i]!.material = i === stage ? stageMat : wheelMat;
    const a = -Math.PI / 2 + (stage / STAGES) * TAU;
    pointer.position.set(Math.cos(a) * WHEEL_R, 0.5, Math.sin(a) * WHEEL_R);
    pointerStem.position.set(Math.cos(a) * WHEEL_R, 0.5, Math.sin(a) * WHEEL_R);
    wheelRoot.setEnabled(true);
  };

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (stageT >= 0) stageT += dt;
    if (virtueT >= 0) virtueT += dt;
    const wheelT = wheelGold ? virtueT : stageT;
    if (wheelT >= 0) {
      const u = clamp01(wheelT / (wheelGold ? VIRTUE_SECS : STAGE_SECS));
      const enter = outBack(clamp01(wheelT / 0.24));
      wheelRoot.scaling.setAll(Math.max(0.01, enter));
      wheelRoot.rotation.y = (1 - sstep(0, 0.45, u)) * -0.5;
      wheelMat.alpha = 0.58 * pulse(u, 0, 1, 0.2);
      stageMat.alpha = 0.92 * pulse(u, 0.04, 1, 0.18);
      const rise = sstep(0.08, 0.42, u);
      pointer.position.y = 0.12 + rise * 0.65;
      pointerStem.position.y = rise * 0.28;
      pointerStem.scaling.y = Math.max(0.01, rise * 0.62);
      pointer.rotation.y = Math.sin(wheelT * 4) * 0.12;
      markers[activeStage]!.scaling.setAll(0.23 + 0.055 * Math.sin(wheelT * 12));
    }

    if (virtueT >= 0) {
      const u = clamp01(virtueT / VIRTUE_SECS);
      const form = outBack(clamp01(virtueT / 0.25));
      const broken = sstep(0.46, 0.56, u);
      gemRoot.rotation.y += dt * 4.2;
      gemRoot.scaling.setAll(Math.max(0.01, form));
      gem.setEnabled(u < 0.5);
      gemEdges.setEnabled(u < 0.5);
      gemMat.alpha = 0.72 * (1 - broken);
      gemEdgeMat.alpha = 0.9 * (1 - broken);
      for (let i = 0; i < shards.length; i++) {
        const s = shards[i]!;
        s.setEnabled(u >= 0.46);
        const a = (i / STAGES) * TAU;
        const b = sstep(0.46, 1, u);
        s.position.set(Math.cos(a) * b * 1.55, 0.25 * Math.sin(a * 2) - b * b * 0.5, Math.sin(a) * b * 1.55);
        s.rotation.set(a * 1.7, -a, a + b * 3);
        s.scaling.set(0.75, 1.6, 0.75);
      }
      shardMat.alpha = 0.82 * (1 - sstep(0.72, 1, u));
      if (virtueT >= VIRTUE_SECS) {
        virtueT = -1;
        gemRoot.setEnabled(false);
      }
    }
    if (stageT >= STAGE_SECS) stageT = -1;
    if (stageT < 0 && virtueT < 0 && wheelRoot.isEnabled()) wheelRoot.setEnabled(false);

    if (timeT >= 0) {
      timeT += dt;
      const u = clamp01(timeT / MORATORIUM_SECS);
      const fade = sstep(0, 0.04, u) * (1 - sstep(0.9, 1, u));
      const grow = outBack(clamp01(timeT / 0.4));
      timeRoot.scaling.setAll(Math.max(0.01, grow));
      timeMat.alpha = 0.38 * fade;
      hgGlassMat.alpha = 0.42 * fade;
      hgSandMat.alpha = 0.82 * fade;
      hgRoot.position.y = 2.18 + Math.sin(timeT * 0.9) * 0.045;
      hgRoot.rotation.y = Math.sin(timeT * 0.45) * 0.18;
      for (let i = 0; i < timeLines.length; i++) timeLines[i]!.scaling.y = 0.86 + 0.14 * Math.sin(timeT * 0.7 + i * 0.8);
      if (timeT >= MORATORIUM_SECS) {
        timeT = -1;
        timeRoot.setEnabled(false);
      }
    }

    if (crisisT >= 0) {
      crisisT += dt;
      const u = clamp01(crisisT / CRISIS_SECS);
      const fracture = 0.42;
      const close = sstep(0, fracture, u);
      mirrorMat.alpha = 0.58 * sstep(0, 0.1, u) * (1 - sstep(fracture, fracture + 0.08, u));
      for (let k = 0; k < mirrors.length; k++) {
        const m = mirrors[k]!;
        m.setEnabled(u < fracture);
        const a = (k / mirrors.length) * TAU + close * 0.35;
        const r = 1.65 - close * 0.45;
        m.position.set(Math.cos(a) * r, 1.25, Math.sin(a) * r);
        m.rotation.y = -a + Math.PI / 2;
      }
      const s = sstep(fracture, 1, u);
      for (const sh of mShards) {
        sh.mesh.setEnabled(u >= fracture);
        if (u < fracture) continue;
        const a = (sh.pane / mirrors.length) * TAU + 0.35;
        const radial = new Vector3(Math.cos(a), 0, Math.sin(a));
        const tangent = new Vector3(-Math.sin(a), 0, Math.cos(a));
        const base = radial.scale(1.2).add(tangent.scale(sh.offset.x));
        base.y = 1.25 + sh.offset.y;
        sh.mesh.position.copyFrom(base.add(sh.dir.scale(s * 2.0)));
        sh.mesh.position.y -= s * s * 0.65;
        sh.mesh.rotation.x += sh.spin.x * dt;
        sh.mesh.rotation.y += sh.spin.y * dt;
        sh.mesh.rotation.z += sh.spin.z * dt;
      }
      mShardMat.alpha = 0.76 * (1 - sstep(0.72, 1, u));
      mShardAmberMat.alpha = mShardMat.alpha;
      shock.scaling.setAll(0.4 + s * 3.8);
      shockMat.alpha = 0.65 * pulse(u, fracture, 1, 0.13);
      if (crisisT >= CRISIS_SECS) {
        crisisT = -1;
        mirrorRoot.setEnabled(false);
      }
    }

    if (reviewT >= 0) {
      reviewT += dt;
      const u = clamp01(reviewT / REVIEW_SECS);
      const gather = sstep(0.56, 0.76, u);
      spiralRoot.rotation.y += dt * (0.8 + gather * 2.2);
      for (let i = 0; i < arcs.length; i++) {
        const lit = sstep(0.025 + i * 0.055, 0.095 + i * 0.055, u);
        const radius = (1.5 - i * 0.075) * (1 - gather) + 0.52 * gather;
        arcs[i]!.scaling.set(radius * Math.max(0.01, lit), 1, radius * Math.max(0.01, lit));
        arcs[i]!.position.y = (0.18 + i * 0.2) * (1 - gather) + (1.1 + i * 0.22) * gather;
        arcs[i]!.rotation.y = i * 0.78 + gather * i * 0.12;
        arcMats[i]!.alpha = 0.78 * lit * (1 - sstep(0.77, 0.88, u));
      }
      const releaseU = sstep(0.72, 1, u);
      releaseMat.alpha = 0.88 * pulse(u, 0.7, 1, 0.09);
      release.position.y = 2.85 + releaseU * 1.8;
      releaseThread.position.y = releaseU * 0.9;
      releaseThread.scaling.y = Math.max(0.01, sstep(0.7, 0.82, u));
      release.scaling.set(0.14 + releaseU * 0.05, 0.7 + releaseU * 0.5, 0.14 + releaseU * 0.05);
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
            burst(GOLD, new Color3(1, 0.95, 0.72), 34, 2.45);
          } else {
            stageT = 0;
            armWheel(stage, false);
            burst(AMBER, GOLD, 22, 0.3);
          }
          break;
        }
        case "defense":
          timeT = 0;
          timeRoot.scaling.setAll(0.01);
          timeRoot.setEnabled(true);
          burst(VIOLET, CYAN, 22, 1.1, true);
          break;
        case "chain":
          crisisT = 0;
          for (let i = 0; i < mShards.length; i++) {
            const sh = mShards[i]!;
            const local = i % 6;
            sh.offset.set(((local % 3) - 1) * 0.24, (Math.floor(local / 3) - 0.5) * 0.85, 0);
            const a = (sh.pane / mirrors.length) * TAU + 0.35;
            sh.dir.set(Math.cos(a) + sh.offset.x * 0.4, 0.2 + (local % 3) * 0.2, Math.sin(a) + sh.offset.x * 0.4);
            sh.spin.set(3 + local, 4 + sh.pane, 2 + local * 0.5);
            sh.mesh.rotation.set(0, -a + Math.PI / 2, local * 0.6);
          }
          mirrorRoot.setEnabled(true);
          burst(MAGENTA, AMBER, 30, 1.2);
          break;
        case "ultimate":
          reviewT = 0;
          spiralRoot.setEnabled(true);
          burst(GOLD, CYAN, 42, 1.6);
          break;
      }
    },
  };
}
