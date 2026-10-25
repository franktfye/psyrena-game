import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";

import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";

export type ProjectileDressingKind = "schema" | "balance" | "echo" | "reproduction" | "thread";

export interface ProjectileDressingRig {
  root: TransformNode;
  spin: TransformNode;
  mats: StandardMaterial[];
}

export type ProjectileDressingBuilder = (orb: Mesh, i: number) => ProjectileDressingRig;

export function createProjectileDressingBuilders(scene: Scene): Record<ProjectileDressingKind, ProjectileDressingBuilder> {
  const dressMat = (name: string, tint: Color3): StandardMaterial => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor = tint;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    return m;
  };
  const cone = (name: string, top: number, bottom: number, height: number, tess: number): Mesh =>
    MeshBuilder.CreateCylinder(name, { height, diameterTop: top, diameterBottom: bottom, tessellation: tess }, scene);
  const block = (
    name: string,
    options: { size?: number; width?: number; height?: number; depth?: number }
  ): Mesh => {
    const side = options.size ?? 1;
    const mesh = MeshBuilder.CreateCylinder(
      name,
      { height: options.height ?? side, diameterTop: Math.SQRT2, diameterBottom: Math.SQRT2, tessellation: 4 },
      scene
    );
    mesh.scaling.set(options.width ?? side, 1, options.depth ?? side);
    mesh.rotation.y = Math.PI / 4;
    return mesh;
  };
  const finishRig = (
    orb: Mesh,
    root: TransformNode,
    spin: TransformNode,
    meshes: Mesh[],
    mats: StandardMaterial[]
  ): ProjectileDressingRig => {
    root.parent = orb;
    for (const mesh of meshes) {
      mesh.parent = spin;
      mesh.isPickable = false;
      mesh.applyFog = false;
      (mesh.material as StandardMaterial).forceCompilation(mesh);
    }
    return { root, spin, mats };
  };

  const buildSchema: ProjectileDressingBuilder = (orb, i) => {
    const root = new TransformNode(`piagetProj_schemaRoot_${i}`, scene);
    const spin = new TransformNode(`piagetProj_schemaSpin_${i}`, scene);
    spin.parent = root;
    spin.rotation.set(0.35, 0.2, Math.PI / 4);
    const coreMat = dressMat(`piagetProj_schemaCore_${i}`, new Color3(0.28, 0.95, 0.58));
    const frameMat = dressMat(`piagetProj_schemaFrame_${i}`, new Color3(0.18, 0.65, 0.42));
    const crown = cone(`piagetProj_schemaCrownM_${i}`, 0, 0.56, 0.5, 4);
    crown.position.y = 0.25;
    crown.material = coreMat;
    const pavilion = cone(`piagetProj_schemaPavilionM_${i}`, 0.56, 0, 0.5, 4);
    pavilion.position.y = -0.25;
    pavilion.material = coreMat;
    const frame = [
      { width: 1.05, height: 0.055, depth: 0.055 },
      { width: 0.055, height: 1.05, depth: 0.055 },
      { width: 0.055, height: 0.055, depth: 1.05 },
    ].map((size, k) => {
      const bar = block(`piagetProj_schemaFrameM_${i}_${k}`, size);
      bar.material = frameMat;
      return bar;
    });
    return finishRig(orb, root, spin, [crown, pavilion, ...frame], [coreMat, frameMat]);
  };

  const buildBalance: ProjectileDressingBuilder = (orb, i) => {
    const root = new TransformNode(`piagetProj_balanceRoot_${i}`, scene);
    const spin = new TransformNode(`piagetProj_balanceSpin_${i}`, scene);
    spin.parent = root;
    spin.rotation.x = 0.22;
    const goldMat = dressMat(`piagetProj_balanceGold_${i}`, new Color3(1.0, 0.84, 0.36));
    const lightMat = dressMat(`piagetProj_balanceLight_${i}`, new Color3(0.72, 0.94, 1.0));
    const beam = block(`piagetProj_balanceBeamM_${i}`, { width: 1.8, height: 0.08, depth: 0.1 });
    beam.position.y = 0.25;
    beam.material = goldMat;
    const fulcrum = cone(`piagetProj_balanceFulcrumM_${i}`, 0, 0.55, 0.75, 4);
    fulcrum.position.y = -0.2;
    fulcrum.material = goldMat;
    const weights = [-1, 1].flatMap((side) => {
      const wire = block(`piagetProj_balanceWireM_${i}_${side}`, { width: 0.035, height: 0.42, depth: 0.035 });
      wire.position.set(side * 0.72, -0.02, 0);
      wire.material = lightMat;
      const weight = block(`piagetProj_balanceWeightM_${i}_${side}`, { size: 0.34 });
      weight.position.set(side * 0.72, -0.3, 0);
      weight.rotation.set(Math.PI / 4, 0, Math.PI / 4);
      weight.material = side < 0 ? lightMat : goldMat;
      return [wire, weight];
    });
    return finishRig(orb, root, spin, [beam, fulcrum, ...weights], [goldMat, lightMat]);
  };

  const buildEcho: ProjectileDressingBuilder = (orb, i) => {
    const root = new TransformNode(`banduraProj_echoRoot_${i}`, scene);
    const spin = new TransformNode(`banduraProj_echoSpin_${i}`, scene);
    spin.parent = root;
    spin.rotation.x = 0.28;
    const silverMat = dressMat(`banduraProj_echoSilver_${i}`, new Color3(0.72, 0.8, 0.88));
    const cyanMat = dressMat(`banduraProj_echoCyan_${i}`, new Color3(0.18, 0.72, 0.85));
    const dart = block(`banduraProj_echoDartM_${i}`, { width: 0.16, height: 0.16, depth: 1.15 });
    dart.rotation.z = Math.PI / 4;
    dart.material = silverMat;
    const mirrors = [-1, 1].map((side) => {
      const mirror = MeshBuilder.CreateTorus(
        `banduraProj_echoMirrorM_${i}_${side}`,
        { diameter: 0.58, thickness: 0.065, tessellation: 4 },
        scene
      );
      mirror.position.x = side * 0.48;
      mirror.rotation.set(Math.PI / 2, 0, Math.PI / 4);
      mirror.material = cyanMat;
      return mirror;
    });
    return finishRig(orb, root, spin, [dart, ...mirrors], [silverMat, cyanMat]);
  };

  const buildReproduction: ProjectileDressingBuilder = (orb, i) => {
    const root = new TransformNode(`banduraProj_reproRoot_${i}`, scene);
    const spin = new TransformNode(`banduraProj_reproSpin_${i}`, scene);
    spin.parent = root;
    spin.rotation.x = 0.35;
    const silverMat = dressMat(`banduraProj_reproSilver_${i}`, new Color3(0.78, 0.84, 0.9));
    const cyanMat = dressMat(`banduraProj_reproCyan_${i}`, new Color3(0.2, 0.8, 0.92));
    const frames = [-1, 1].map((side) => {
      const frame = MeshBuilder.CreateTorus(
        `banduraProj_reproFrameM_${i}_${side}`,
        { diameter: 0.9, thickness: 0.09, tessellation: 4 },
        scene
      );
      frame.position.x = side * 0.52;
      frame.rotation.set(Math.PI / 2, 0, Math.PI / 4);
      frame.material = side < 0 ? silverMat : cyanMat;
      return frame;
    });
    const axis = block(`banduraProj_reproAxisM_${i}`, { width: 1.25, height: 0.05, depth: 0.05 });
    axis.material = cyanMat;
    const copies = [-1, 1].map((side) => {
      const copy = block(`banduraProj_reproCopyM_${i}_${side}`, { size: 0.22 });
      copy.position.x = side * 0.52;
      copy.rotation.set(0.4, 0.4, Math.PI / 4);
      copy.material = side < 0 ? cyanMat : silverMat;
      return copy;
    });
    return finishRig(orb, root, spin, [...frames, axis, ...copies], [silverMat, cyanMat]);
  };

  const buildThread: ProjectileDressingBuilder = (orb, i) => {
    const root = new TransformNode(`ainsworthProj_threadRoot_${i}`, scene);
    const spin = new TransformNode(`ainsworthProj_threadSpin_${i}`, scene);
    spin.parent = root;
    const threadMat = dressMat(`ainsworthProj_threadMat_${i}`, new Color3(0.12, 0.68, 0.7));
    const heartMat = dressMat(`ainsworthProj_threadHeart_${i}`, new Color3(0.35, 0.9, 0.88));
    const segments = [-1, 0, 1].map((k) => {
      const segment = block(`ainsworthProj_threadM_${i}_${k}`, { width: 0.045, height: 0.045, depth: 0.52 });
      segment.position.set(k === 0 ? 0 : k * 0.09, 0, (k - 1) * 0.37);
      segment.rotation.y = k === 0 ? -0.5 : 0.5;
      segment.material = threadMat;
      return segment;
    });
    const lobes = [-1, 1].map((side) => {
      const lobe = MeshBuilder.CreateSphere(`ainsworthProj_threadLobeM_${i}_${side}`, { diameter: 0.22, segments: 8 }, scene);
      lobe.position.set(side * 0.075, 0.055, 0.58);
      lobe.material = heartMat;
      return lobe;
    });
    const tip = cone(`ainsworthProj_threadTipM_${i}`, 0.3, 0, 0.28, 12);
    tip.position.set(0, -0.08, 0.58);
    tip.scaling.z = 0.7;
    tip.material = heartMat;
    return finishRig(orb, root, spin, [...segments, ...lobes, tip], [threadMat, heartMat]);
  };

  return {
    schema: buildSchema,
    balance: buildBalance,
    echo: buildEcho,
    reproduction: buildReproduction,
    thread: buildThread,
  };
}
