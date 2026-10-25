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

import { PIAGET } from "@shared/heroes/piaget";
import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Piaget — luminous construction kits rather than solid magical domes.
 * Every cast assembles a thought: repetition, focus, conservation, hypothesis,
 * adaptation, persistence and balance. Fine wireframes carry the silhouette;
 * small saturated cores and a few motes provide the light.
 */
const EMERALD = new Color3(0.18, 0.82, 0.5);
const MINT = new Color3(0.58, 1.0, 0.76);
const AMBER = new Color3(1.0, 0.62, 0.18);
const CORAL = new Color3(1.0, 0.32, 0.4);
const SKY = new Color3(0.24, 0.68, 1.0);
const VIOLET = new Color3(0.58, 0.36, 1.0);
const GOLD = new Color3(1.0, 0.78, 0.26);
const IVORY = new Color3(1.0, 0.95, 0.76);

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
  const tex = new DynamicTexture("piagetFxMote", { width: 64, height: 64 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,.85)");
  g.addColorStop(0.5, "rgba(255,255,255,.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

export function createPiagetSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
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
  const box = (name: string, size: number, parent: TransformNode, mat: StandardMaterial): Mesh =>
    attach(MeshBuilder.CreateBox(name, { size }, scene), parent, mat);
  const orb = (name: string, diameter: number, parent: TransformNode, mat: StandardMaterial, segments = 12): Mesh =>
    attach(MeshBuilder.CreateSphere(name, { diameter, segments }, scene), parent, mat);
  const arc = (name: string, radius: number, start: number, end: number, parent: TransformNode, mat: StandardMaterial): Mesh => {
    const points = Array.from({ length: 33 }, (_, i) => {
      const a = start + ((end - start) * i) / 32;
      return new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    });
    return attach(MeshBuilder.CreateTube(name, { path: points, radius: 0.018, tessellation: 6 }, scene), parent, mat);
  };

  const moteAnchor = box("piagetFx_moteAnchor", 0.01, hero as TransformNode, material(scene, "piagetFx_moteAnchorMat", EMERALD));
  moteAnchor.isVisible = false;
  const motes = new ParticleSystem("piagetFx_motes", 140, scene);
  motes.particleTexture = moteTexture(scene);
  motes.emitter = moteAnchor;
  motes.minEmitBox = new Vector3(-0.3, -0.2, -0.3);
  motes.maxEmitBox = new Vector3(0.3, 0.2, 0.3);
  motes.blendMode = ParticleSystem.BLENDMODE_ADD;
  motes.minSize = 0.035;
  motes.maxSize = 0.13;
  motes.emitRate = 0;
  motes.direction1 = new Vector3(-0.35, 0.4, -0.35);
  motes.direction2 = new Vector3(0.35, 1.5, 0.35);
  motes.minLifeTime = 0.5;
  motes.maxLifeTime = 1.25;
  motes.minEmitPower = 0.25;
  motes.maxEmitPower = 0.9;
  motes.start();
  const burst = (color: Color3, count: number, y: number): void => {
    moteAnchor.position.y = y;
    motes.color1 = new Color4(color.r, color.g, color.b, 0.75);
    motes.color2 = new Color4(MINT.r, MINT.g, MINT.b, 0.35);
    motes.colorDead = new Color4(color.r, color.g, color.b, 0);
    motes.manualEmitCount = count;
  };

  // Circular Reaction: three rhythmic tracks with a repeating bright bead.
  const sens = root("piagetFx_sensorimotor", 1.05);
  const sensMat = material(scene, "piagetFx_sensorimotorMat", AMBER);
  const sensRings = [0, 1, 2].map((i) => {
    const r = ring(`piagetFx_sensRing_${i}`, 1.45 + i * 0.27, 0.022, sens, sensMat);
    r.rotation.set(i * 0.38, i * 0.5, i * 0.25);
    return r;
  });
  const sensBeadMat = material(scene, "piagetFx_sensBeadMat", IVORY);
  const sensBead = orb("piagetFx_sensBead", 0.18, sens, sensBeadMat, 10);

  // Centration: many possibilities collapse into one deliberate prism.
  const pre = root("piagetFx_preoperational", 1.15);
  const preMat = material(scene, "piagetFx_preMat", CORAL);
  const fragments = Array.from({ length: 7 }, (_, i) => {
    const f = box(`piagetFx_preFragment_${i}`, i === 0 ? 0.48 : 0.2, pre, preMat);
    f.rotation.set(0.5, i * 0.7, 0.78);
    return f;
  });
  const preFocusMat = material(scene, "piagetFx_preFocusMat", IVORY);
  const preFocus = ring("piagetFx_preFocus", 1.4, 0.025, pre, preFocusMat);
  preFocus.rotation.x = Math.PI / 2;

  // Conservation: equal luminous contents in two very different outlines.
  const concrete = root("piagetFx_concrete", 0.12);
  const conWire = material(scene, "piagetFx_conWire", SKY, true);
  const conCore = material(scene, "piagetFx_conCore", SKY);
  const tall = attach(MeshBuilder.CreateCylinder("piagetFx_tallVessel", { height: 1.45, diameter: 0.5, tessellation: 12 }, scene), concrete, conWire);
  tall.position.set(-0.7, 0.75, -0.75);
  const wide = attach(MeshBuilder.CreateCylinder("piagetFx_wideVessel", { height: 0.65, diameter: 1.0, tessellation: 12 }, scene), concrete, conWire);
  wide.position.set(0.7, 0.35, -0.75);
  const conBlocks = [tall, wide].map((vessel, i) => {
    const b = box(`piagetFx_conContent_${i}`, 0.32, concrete, conCore);
    b.position.copyFrom(vessel.position);
    return b;
  });
  const conBridge = arc("piagetFx_conBridge", 0.72, Math.PI, Math.PI * 2, concrete, conCore);
  conBridge.position.set(0, 1.45, -0.75);

  // Formal Operational: an elegant three-axis hypothesis cage.
  const formal = root("piagetFx_formal", 1.0);
  const formalMat = material(scene, "piagetFx_formalMat", VIOLET);
  const formalCage = [0, 1, 2].map((i) => {
    const r = ring(`piagetFx_formalCage_${i}`, 2.05, 0.026, formal, formalMat);
    r.rotation.set(i === 0 ? Math.PI / 2 : 0, i === 2 ? Math.PI / 2 : 0, i * 0.45);
    return r;
  });
  const formalShellMat = material(scene, "piagetFx_formalShellMat", VIOLET, true);
  const formalShell = orb("piagetFx_formalShell", 2.0, formal, formalShellMat, 8);
  const formalNodes = Array.from({ length: 6 }, (_, i) => {
    const n = box(`piagetFx_formalNode_${i}`, 0.1, formal, formalMat);
    const a = (i / 6) * Math.PI * 2;
    n.position.set(Math.cos(a), 0, Math.sin(a));
    return n;
  });

  // Accommodation: the lattice flexes, then finds a new stable geometry.
  const accommodation = root("piagetFx_accommodation", 0.06);
  const accMat = material(scene, "piagetFx_accMat", EMERALD);
  const accRings = [0, 1, 2].map((i) => {
    const r = ring(`piagetFx_accRing_${i}`, 2.4 + i * 0.65, 0.024, accommodation, accMat);
    r.position.y = i * 0.48;
    return r;
  });
  const accBlocks = Array.from({ length: 8 }, (_, i) => box(`piagetFx_accBlock_${i}`, 0.16, accommodation, accMat));
  const accCanopyMat = material(scene, "piagetFx_accCanopyMat", EMERALD, true);
  const accCanopy = orb("piagetFx_accCanopy", 3.25, accommodation, accCanopyMat, 10);
  accCanopy.position.y = 0.7;
  accCanopy.scaling.y = 0.62;

  // Object Permanence: the central light never goes out, even when occluded.
  const permanence = root("piagetFx_permanence", 1.15);
  const objCoreMat = material(scene, "piagetFx_objCoreMat", GOLD);
  const objCore = orb("piagetFx_objCore", 0.38, permanence, objCoreMat, 16);
  const objHalo = ring("piagetFx_objHalo", 0.9, 0.025, permanence, objCoreMat);
  objHalo.rotation.x = Math.PI / 2;
  const objCoverMat = material(scene, "piagetFx_objCoverMat", new Color3(0.34, 0.26, 0.14));
  const objCover = orb("piagetFx_objCover", 1.05, permanence, objCoverMat, 16);

  // Equilibration: four ordered thoughts counterweight one another.
  const equilibrium = root("piagetFx_equilibrium", 1.85);
  const eqMat = material(scene, "piagetFx_eqMat", GOLD);
  const eqBeam = box("piagetFx_eqBeam", 0.05, equilibrium, eqMat);
  eqBeam.scaling.set(32, 1, 1);
  const eqPivot = ring("piagetFx_eqPivot", 0.5, 0.025, equilibrium, eqMat);
  eqPivot.rotation.x = Math.PI / 2;
  const eqWeights = [-1, 1].flatMap((side) => [0, 1].map((i) => {
    const b = box(`piagetFx_eqWeight_${side}_${i}`, 0.22, equilibrium, eqMat);
    b.position.set(side * (0.62 + i * 0.28), -0.42, 0);
    b.rotation.y = i * 0.5;
    return b;
  }));
  const eqWaveRoot = root("piagetFx_eqWaves", 0.08);
  const eqWaves = [0, 1, 2].map((i) => ring(`piagetFx_eqWave_${i}`, 1, 0.028, eqWaveRoot, i === 1 ? accMat : eqMat));

  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("piagetFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 0.55;
    for (const m of [sensBead, preFocus, ...conBlocks, ...formalCage, objCore, objHalo, eqBeam, ...eqWaves]) glow.addIncludedOnlyMesh(m);
    scene.onDisposeObservable.add(() => glow.dispose());
  }

  const warm: [Mesh, StandardMaterial][] = [
    [sensRings[0]!, sensMat], [sensBead, sensBeadMat], [fragments[0]!, preMat], [preFocus, preFocusMat],
    [tall, conWire], [conBlocks[0]!, conCore], [formalCage[0]!, formalMat], [formalShell, formalShellMat],
    [accRings[0]!, accMat], [accCanopy, accCanopyMat], [objCore, objCoreMat], [objCover, objCoverMat],
    [eqBeam, eqMat], [eqWaves[0]!, eqMat],
  ];
  for (const [mesh, mat] of warm) mat.forceCompilation(mesh);

  let sensT = -1;
  let preT = -1;
  let conT = -1;
  let formalT = -1;
  let accT = -1;
  let objT = -1;
  let eqT = -1;
  const ACC_SECS = (PIAGET.defense.mitigation?.durationMs ?? 6000) / 1000;

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (sensT >= 0) {
      sensT += dt;
      const u = clamp01(sensT / 1.55);
      const fade = pulse(u, 0, 1, 0.14);
      sensRings.forEach((r, i) => {
        r.rotation.y += dt * (i % 2 ? -1.4 : 1.4);
        r.scaling.setAll(Math.max(0.01, back(clamp01((sensT - i * 0.06) / 0.3))));
      });
      sensMat.alpha = 0.72 * fade;
      const a = sensT * Math.PI * 2.6;
      sensBead.position.set(Math.cos(a) * 0.98, Math.sin(sensT * 5) * 0.13, Math.sin(a) * 0.98);
      sensBeadMat.alpha = fade;
      sensBead.scaling.setAll(0.8 + 0.35 * Math.max(0, Math.sin(sensT * 12)));
      if (u >= 1) { sensT = -1; sens.setEnabled(false); }
    }

    if (preT >= 0) {
      preT += dt;
      const u = clamp01(preT / 1.25);
      const focus = sstep(0.12, 0.7, u);
      fragments.forEach((f, i) => {
        if (i === 0) {
          f.scaling.setAll(Math.max(0.01, sstep(0.45, 0.72, u)));
          f.rotation.y += dt * 2;
        } else {
          const a = (i / 6) * Math.PI * 2;
          const r = (1.25 - focus * 1.12) * (1 + (i % 2) * 0.22);
          f.position.set(Math.cos(a) * r, (i - 3.5) * 0.18 * (1 - focus), Math.sin(a) * r);
          f.scaling.setAll(Math.max(0.01, 1 - sstep(0.65, 0.85, u)));
        }
      });
      preMat.alpha = 0.82 * pulse(u, 0, 1, 0.12);
      preFocus.scaling.setAll(1.3 - focus * 0.8);
      preFocusMat.alpha = 0.8 * pulse(u, 0.1, 0.9, 0.1);
      if (u >= 1) { preT = -1; pre.setEnabled(false); }
    }

    if (conT >= 0) {
      conT += dt;
      const u = clamp01(conT / 1.65);
      const grow = back(clamp01(conT / 0.35));
      concrete.scaling.setAll(Math.max(0.01, grow));
      conWire.alpha = 0.5 * pulse(u, 0, 1, 0.13);
      const fill = sstep(0.15, 0.6, u);
      conBlocks.forEach((b, i) => {
        b.scaling.set(i === 0 ? 0.55 : 1.25, 0.15 + fill * (i === 0 ? 3.0 : 0.8), i === 0 ? 0.55 : 1.25);
        b.rotation.y += dt * (i ? -0.7 : 0.7);
      });
      conCore.alpha = 0.72 * pulse(u, 0.15, 1, 0.12);
      conBridge.rotation.y += dt * 0.35;
      if (u >= 1) { conT = -1; concrete.setEnabled(false); }
    }

    if (formalT >= 0) {
      formalT += dt;
      const u = clamp01(formalT / 1.55);
      const assemble = sstep(0, 0.55, u);
      formalCage.forEach((r, i) => {
        r.scaling.setAll(Math.max(0.01, back(clamp01((formalT - i * 0.08) / 0.45))));
        r.rotation.y += dt * (i % 2 ? -0.45 : 0.45);
      });
      formalMat.alpha = 0.72 * pulse(u, 0, 1, 0.13);
      formalShellMat.alpha = 0.22 * assemble * (1 - sstep(0.75, 1, u));
      formalShell.rotation.y += dt * 0.3;
      formalNodes.forEach((n, i) => { n.scaling.setAll(0.6 + 0.4 * Math.sin(formalT * 5 + i)); });
      if (u >= 1) { formalT = -1; formal.setEnabled(false); }
    }

    if (accT >= 0) {
      accT += dt;
      const u = clamp01(accT / ACC_SECS);
      const fade = sstep(0, 0.06, u) * (1 - sstep(0.9, 1, u));
      const settle = Math.exp(-accT * 0.8);
      const flex = Math.sin(accT * 4) * settle;
      accRings.forEach((r, i) => {
        r.scaling.set(1 + flex * (i - 1) * 0.12, 1, 1 - flex * (i - 1) * 0.12);
        r.rotation.y += dt * (i % 2 ? -0.16 : 0.16);
      });
      accBlocks.forEach((b, i) => {
        const a = (i / 8) * Math.PI * 2 + accT * 0.12;
        b.position.set(Math.cos(a) * (1.45 + flex * 0.2), 0.45 + (i % 3) * 0.42, Math.sin(a) * (1.45 - flex * 0.2));
        b.rotation.set(a * 0.3, -a, flex);
      });
      accCanopy.scaling.set(1 + flex * 0.08, 0.62 - flex * 0.05, 1 - flex * 0.08);
      accMat.alpha = 0.58 * fade;
      accCanopyMat.alpha = 0.16 * fade;
      if (u >= 1) { accT = -1; accommodation.setEnabled(false); }
    }

    if (objT >= 0) {
      objT += dt;
      const u = clamp01(objT / 1.9);
      const reveal = sstep(0.45, 0.72, u);
      objCoreMat.alpha = 0.9 * pulse(u, 0, 1, 0.08);
      objCore.scaling.setAll(0.85 + 0.3 * Math.max(0, Math.sin(objT * 8)));
      objHalo.rotation.z += dt * 0.8;
      objHalo.scaling.setAll(1 + reveal * 1.8);
      objCoverMat.alpha = 0.72 * sstep(0, 0.2, u) * (1 - reveal);
      objCover.scaling.set(1 + reveal * 0.6, 1 - reveal * 0.45, 1 + reveal * 0.6);
      objCover.rotation.y += dt * 0.5;
      if (u >= 1) { objT = -1; permanence.setEnabled(false); }
    }

    if (eqT >= 0) {
      eqT += dt;
      const u = clamp01(eqT / 2.65);
      const fade = pulse(u, 0, 0.9, 0.1);
      eqMat.alpha = 0.78 * fade;
      equilibrium.rotation.z = 0.24 * Math.exp(-eqT * 1.6) * Math.cos(eqT * 6);
      equilibrium.scaling.setAll(Math.max(0.01, back(clamp01(eqT / 0.4))));
      eqWeights.forEach((w, i) => { w.rotation.y += dt * (i % 2 ? -1 : 1); });
      eqWaves.forEach((w, i) => {
        const v = sstep(0.5 + i * 0.09, 0.9 + i * 0.04, u);
        w.scaling.set(0.8 + v * 8.5, 1, 0.8 + v * 8.5);
        w.position.y = i * 0.09;
      });
      if (u >= 1) { eqT = -1; equilibrium.setEnabled(false); eqWaveRoot.setEnabled(false); }
    }
  });

  return {
    cast(kind: FreudCastKind, id: string) {
      if (kind === "palette") {
        if (id === "piaget.sensorimotor") { sensT = 0; sens.setEnabled(true); burst(AMBER, 22, 1.1); }
        if (id === "piaget.preoperational") { preT = 0; pre.setEnabled(true); burst(CORAL, 20, 1.2); }
        if (id === "piaget.concrete") { conT = 0; concrete.setEnabled(true); burst(SKY, 24, 0.8); }
        if (id === "piaget.formal") { formalT = 0; formal.setEnabled(true); burst(VIOLET, 24, 1.1); }
      } else if (kind === "defense") {
        accT = 0; accommodation.setEnabled(true); burst(EMERALD, 24, 0.6);
      } else if (kind === "chain") {
        objT = 0; permanence.setEnabled(true); burst(GOLD, 26, 1.2);
      } else if (kind === "ultimate") {
        eqT = 0; equilibrium.setEnabled(true); eqWaveRoot.setEnabled(true); burst(GOLD, 48, 1.8);
      }
    },
  };
}
