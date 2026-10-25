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

import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/tubeBuilder";

import { BANDURA } from "@shared/heroes/bandura";
import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Bandura — motion doubled into silver observations and cyan reproductions.
 * Crisp silhouettes and directional lines make copying legible without a wall
 * of bloom. Gold marks internal efficacy; the triad uses three distinct hues.
 */
const SILVER = new Color3(0.7, 0.8, 0.88);
const CYAN = new Color3(0.12, 0.78, 1.0);
const PALE = new Color3(0.72, 0.96, 1.0);
const VIOLET = new Color3(0.56, 0.38, 1.0);
const RED = new Color3(0.95, 0.16, 0.2);
const WHITE = new Color3(0.88, 0.92, 0.94);
const GOLD = new Color3(1.0, 0.76, 0.24);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const sstep = (a: number, b: number, x: number): number => {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const pulse = (u: number, a: number, b: number, edge: number): number =>
  sstep(a, a + edge, u) * (1 - sstep(b - edge, b, u));
const back = (u: number): number => {
  const v = u - 1;
  return 1 + 2.70158 * v * v * v + 1.70158 * v * v;
};

function material(scene: Scene, name: string, color: Color3, wireframe = false): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = color.scale(0.55);
  m.alpha = 0;
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.wireframe = wireframe;
  return m;
}

function moteTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture("banduraFxMote", { width: 64, height: 64 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,.8)");
  g.addColorStop(0.55, "rgba(255,255,255,.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

export function createBanduraSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
  const root = (name: string, y = 0): TransformNode => {
    const n = new TransformNode(name, scene);
    n.parent = hero;
    n.position.y = y;
    n.setEnabled(false);
    return n;
  };
  const attach = <T extends Mesh>(mesh: T, parent: TransformNode, mat: StandardMaterial): T => {
    mesh.parent = parent;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.applyFog = false;
    return mesh;
  };
  const ring = (name: string, diameter: number, thickness: number, parent: TransformNode, mat: StandardMaterial): Mesh =>
    attach(MeshBuilder.CreateTorus(name, { diameter, thickness, tessellation: 64 }, scene), parent, mat);
  const orb = (name: string, diameter: number, parent: TransformNode, mat: StandardMaterial, segments = 12): Mesh =>
    attach(MeshBuilder.CreateSphere(name, { diameter, segments }, scene), parent, mat);
  const box = (name: string, size: number, parent: TransformNode, mat: StandardMaterial): Mesh =>
    attach(MeshBuilder.CreateBox(name, { size }, scene), parent, mat);
  const tube = (name: string, points: Vector3[], radius: number, parent: TransformNode, mat: StandardMaterial): Mesh =>
    attach(MeshBuilder.CreateTube(name, { path: points, radius, tessellation: 6 }, scene), parent, mat);
  const arc = (name: string, radius: number, start: number, end: number, parent: TransformNode, mat: StandardMaterial): Mesh => {
    const points = Array.from({ length: 33 }, (_, i) => {
      const a = start + ((end - start) * i) / 32;
      return new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    });
    return tube(name, points, 0.022, parent, mat);
  };

  const anchor = box("banduraFx_anchor", 0.01, hero, material(scene, "banduraFx_anchorMat", CYAN));
  anchor.isVisible = false;
  const motes = new ParticleSystem("banduraFx_motes", 150, scene);
  motes.particleTexture = moteTexture(scene);
  motes.emitter = anchor;
  motes.minEmitBox = new Vector3(-0.3, -0.25, -0.3);
  motes.maxEmitBox = new Vector3(0.3, 0.25, 0.3);
  motes.blendMode = ParticleSystem.BLENDMODE_ADD;
  motes.minSize = 0.035;
  motes.maxSize = 0.13;
  motes.emitRate = 0;
  motes.direction1 = new Vector3(-0.5, 0.35, -0.5);
  motes.direction2 = new Vector3(0.5, 1.25, 0.5);
  motes.minLifeTime = 0.45;
  motes.maxLifeTime = 1.1;
  motes.minEmitPower = 0.3;
  motes.maxEmitPower = 1.0;
  motes.start();
  const burst = (color: Color3, count: number, y: number): void => {
    anchor.position.y = y;
    motes.color1 = new Color4(color.r, color.g, color.b, 0.8);
    motes.color2 = new Color4(PALE.r, PALE.g, PALE.b, 0.4);
    motes.colorDead = new Color4(color.r, color.g, color.b, 0);
    motes.manualEmitCount = count;
  };

  // Reproduction: observed silver pose, then two cyan afterimages perform it.
  const reproduce = root("banduraFx_reproduce", 0);
  const silverMat = material(scene, "banduraFx_silverMat", SILVER, true);
  const echoMat = material(scene, "banduraFx_echoMat", CYAN);
  const makeEcho = (name: string, mat: StandardMaterial): TransformNode => {
    const n = new TransformNode(name, scene);
    n.parent = reproduce;
    const body = attach(MeshBuilder.CreateCylinder(`${name}_body`, { height: 0.92, diameterTop: 0.34, diameterBottom: 0.48, tessellation: 8 }, scene), n, mat);
    body.position.y = 1.0;
    const head = orb(`${name}_head`, 0.32, n, mat, 10);
    head.position.y = 1.67;
    const arm = box(`${name}_arm`, 0.12, n, mat);
    arm.position.set(0.35, 1.18, 0.08);
    arm.scaling.set(1, 3.8, 1);
    arm.rotation.z = -0.65;
    for (const side of [-1, 1]) {
      const leg = box(`${name}_leg_${side}`, 0.13, n, mat);
      leg.position.set(side * 0.13, 0.35, 0);
      leg.scaling.y = 4.2;
    }
    return n;
  };
  const observed = makeEcho("banduraFx_observed", silverMat);
  const echoes = [0, 1].map((i) => makeEcho(`banduraFx_afterimage_${i}`, echoMat));
  const scanMat = material(scene, "banduraFx_scanMat", PALE);
  const scan = ring("banduraFx_scan", 1.25, 0.025, reproduce, scanMat);

  // Self-Efficacy: successive upward chevrons, not a generic heal glow.
  const efficacy = root("banduraFx_efficacy", 0.25);
  const effMat = material(scene, "banduraFx_effMat", GOLD);
  const chevrons = [0, 1, 2, 3].map((i) => {
    const n = new TransformNode(`banduraFx_chevronRoot_${i}`, scene);
    n.parent = efficacy;
    tube(`banduraFx_chevron_${i}`, [new Vector3(-0.55, -0.18, 0), new Vector3(0, 0.18, 0), new Vector3(0.55, -0.18, 0)], 0.035, n, effMat);
    n.position.y = i * 0.36;
    return n;
  });
  const effCore = box("banduraFx_effCore", 0.24, efficacy, effMat);
  effCore.position.set(0, 1.18, 0.16);
  effCore.rotation.set(0.5, 0.5, 0.78);

  // Bobo Doll: a graphic training effigy with readable recoil and rebound arcs.
  const bobo = root("banduraFx_bobo", 0);
  const boboPivot = new TransformNode("banduraFx_boboPivot", scene);
  boboPivot.parent = bobo;
  const redMat = material(scene, "banduraFx_redMat", RED);
  const whiteMat = material(scene, "banduraFx_whiteMat", WHITE);
  const base = orb("banduraFx_boboBase", 0.9, boboPivot, redMat, 16);
  base.position.y = 0.4;
  base.scaling.y = 0.72;
  const torso = attach(MeshBuilder.CreateCylinder("banduraFx_boboTorso", { height: 0.9, diameterTop: 0.38, diameterBottom: 0.62, tessellation: 12 }, scene), boboPivot, whiteMat);
  torso.position.y = 1.03;
  const head = orb("banduraFx_boboHead", 0.46, boboPivot, whiteMat, 12);
  head.position.y = 1.68;
  const target = ring("banduraFx_boboTarget", 0.42, 0.025, boboPivot, redMat);
  target.position.set(0, 1.08, 0.3);
  target.rotation.x = Math.PI / 2;
  const belt = ring("banduraFx_boboBelt", 0.66, 0.06, boboPivot, redMat);
  belt.position.y = 0.77;
  const recoilMat = material(scene, "banduraFx_recoilMat", RED);
  const recoilArcs = [0, 1, 2].map((i) => {
    const a = arc(`banduraFx_recoilArc_${i}`, 0.8 + i * 0.22, -0.8, 0.8, bobo, recoilMat);
    a.position.set(0, 1.05 + i * 0.18, 0.15);
    a.rotation.x = Math.PI / 2;
    return a;
  });
  const boboGround = ring("banduraFx_boboGround", 1.4, 0.025, bobo, redMat);
  boboGround.position.y = 0.035;

  // Reciprocal Determinism: three colors and three directional flows.
  const triad = root("banduraFx_triad", 0.55);
  const triadSpin = new TransformNode("banduraFx_triadSpin", scene);
  triadSpin.parent = triad;
  const triadColors = [GOLD, CYAN, VIOLET];
  const triadMats = triadColors.map((c, i) => material(scene, `banduraFx_triadMat_${i}`, c));
  const triadArcs = triadMats.map((m, i) => {
    const start = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    const a = arc(`banduraFx_triadArc_${i}`, 1.35, start + 0.16, start + Math.PI * 0.61, triadSpin, m);
    a.position.y = i * 0.16;
    const arrow = box(`banduraFx_triadArrow_${i}`, 0.16, triadSpin, m);
    const end = start + Math.PI * 0.61;
    arrow.position.set(Math.cos(end) * 1.35, i * 0.16, Math.sin(end) * 1.35);
    arrow.rotation.set(0.4, -end, 0.78);
    return { arc: a, arrow };
  });
  const triadNodes = triadMats.map((m, i) => {
    const n = orb(`banduraFx_triadNode_${i}`, 0.25, triadSpin, m, 10);
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
    n.position.set(Math.cos(a) * 1.35, i * 0.16, Math.sin(a) * 1.35);
    return n;
  });
  const triadWaveRoot = root("banduraFx_triadWaves", 0.08);
  const triadWaves = triadMats.map((m, i) => {
    const r = ring(`banduraFx_triadWave_${i}`, 1, 0.025, triadWaveRoot, m);
    r.position.y = i * 0.08;
    return r;
  });

  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("banduraFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 0.5;
    for (const m of [scan, effCore, target, ...recoilArcs, ...triadNodes, ...triadWaves]) glow.addIncludedOnlyMesh(m);
    scene.onDisposeObservable.add(() => glow.dispose());
  }

  const warm: [Mesh, StandardMaterial][] = [
    [observed.getChildMeshes()[0] as Mesh, silverMat], [echoes[0]!.getChildMeshes()[0] as Mesh, echoMat],
    [scan, scanMat], [chevrons[0]!.getChildMeshes()[0] as Mesh, effMat], [effCore, effMat],
    [base, redMat], [torso, whiteMat], [recoilArcs[0]!, recoilMat], [triadArcs[0]!.arc, triadMats[0]!],
    [triadArcs[1]!.arc, triadMats[1]!], [triadArcs[2]!.arc, triadMats[2]!],
  ];
  for (const [mesh, mat] of warm) mat.forceCompilation(mesh);

  let reproduceT = -1;
  let efficacyT = -1;
  let boboT = -1;
  let triadT = -1;
  let side = 1;
  const BOBO_SECS = (BANDURA.chain.effects.find((e) => e.kind === "decoy")?.durationMs ?? 4000) / 1000;

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (reproduceT >= 0) {
      reproduceT += dt;
      const u = clamp01(reproduceT / 1.2);
      observed.position.set(-side * 0.85, 0, -0.15);
      observed.rotation.y = side * 0.35;
      silverMat.alpha = 0.4 * pulse(u, 0, 0.72, 0.12);
      echoes.forEach((e, i) => {
        const v = sstep(0.18 + i * 0.12, 0.82, u);
        e.position.set(-side * 0.85 + side * v * (1.25 + i * 0.35), 0, -0.15 + v * (0.55 + i * 0.2));
        e.rotation.y = side * (0.35 + v * 0.65);
        e.scaling.setAll(0.94 + i * 0.05);
      });
      echoMat.alpha = 0.42 * pulse(u, 0.18, 1, 0.13);
      scan.position.y = 0.15 + sstep(0, 0.55, u) * 1.8;
      scan.scaling.setAll(0.75 + Math.sin(u * Math.PI) * 0.35);
      scanMat.alpha = 0.8 * pulse(u, 0, 0.75, 0.1);
      if (u >= 1) { reproduceT = -1; reproduce.setEnabled(false); }
    }

    if (efficacyT >= 0) {
      efficacyT += dt;
      const u = clamp01(efficacyT / 1.55);
      chevrons.forEach((c, i) => {
        const v = back(clamp01((efficacyT - i * 0.13) / 0.35));
        c.scaling.setAll(Math.max(0.01, v));
        c.position.z = 0.2 + i * 0.05;
      });
      effMat.alpha = 0.78 * pulse(u, 0, 1, 0.12);
      effCore.rotation.y += dt * 2.2;
      effCore.scaling.setAll(0.85 + 0.25 * sstep(0.55, 0.75, u));
      if (u >= 1) { efficacyT = -1; efficacy.setEnabled(false); }
    }

    if (boboT >= 0) {
      boboT += dt;
      const u = clamp01(boboT / BOBO_SECS);
      const pop = back(clamp01(boboT / 0.32));
      boboPivot.scaling.setAll(Math.max(0.01, pop));
      const since = boboT % 2;
      const recoil = Math.exp(-since * 3.2);
      boboPivot.rotation.x = -0.5 * recoil * Math.cos(since * 8);
      boboPivot.position.z = -0.25 * recoil;
      const fade = sstep(0, 0.04, u) * (1 - sstep(0.94, 1, u));
      redMat.alpha = 0.85 * fade;
      whiteMat.alpha = 0.72 * fade;
      recoilMat.alpha = 0.75 * recoil * fade;
      recoilArcs.forEach((a, i) => a.scaling.setAll(0.85 + (1 - recoil) * (0.35 + i * 0.12)));
      boboGround.scaling.setAll(0.85 + 0.15 * Math.sin(boboT * 3));
      if (u >= 1) { boboT = -1; bobo.setEnabled(false); burst(RED, 34, 1.0); }
    }

    if (triadT >= 0) {
      triadT += dt;
      const u = clamp01(triadT / 2.6);
      triadSpin.rotation.y += dt * (0.35 + sstep(0.4, 0.7, u) * 1.4);
      triadSpin.scaling.setAll(Math.max(0.01, back(clamp01(triadT / 0.42))));
      triadMats.forEach((m, i) => {
        m.alpha = 0.78 * pulse(u, i * 0.06, 0.92, 0.1);
      });
      triadNodes.forEach((n, i) => n.scaling.setAll(0.8 + 0.3 * Math.max(0, Math.sin(triadT * 6 - i * 1.8))));
      triadWaves.forEach((w, i) => {
        const v = sstep(0.62 + i * 0.06, 0.96, u);
        w.scaling.set(0.8 + v * 8.5, 1, 0.8 + v * 8.5);
      });
      if (u >= 1) { triadT = -1; triad.setEnabled(false); triadWaveRoot.setEnabled(false); }
    }
  });

  return {
    cast(kind: FreudCastKind, id: string) {
      if (kind === "palette" && id.startsWith("bandura.observe")) {
        reproduceT = 0;
        side = -side;
        reproduce.setEnabled(true);
        burst(CYAN, 22, 1.2);
      } else if (kind === "defense") {
        efficacyT = 0;
        efficacy.setEnabled(true);
        burst(GOLD, 22, 1.2);
      } else if (kind === "chain") {
        boboT = 0;
        bobo.position.set(0, 0, -1.8);
        bobo.setEnabled(true);
        burst(RED, 26, 0.8);
      } else if (kind === "ultimate") {
        triadT = 0;
        triad.setEnabled(true);
        triadWaveRoot.setEnabled(true);
        burst(GOLD, 46, 1.4);
      }
    },
  };
}
