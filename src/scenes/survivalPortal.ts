/**
 * The Dream Siege gate in the village: an old pailou archway (Tripo, from
 * assets/work/survival-portal) on the plaza edge between the Queue Terminal
 * and the Hall of Minds, its centre bay filled with dream fog. Walk through
 * the arch, or tap the gate, to open the survival picker — the same verb as
 * the dock's Dream Siege button.
 *
 * The pillars are solid through the hub's own collider sweep: invisible
 * cylinders named `portalStand_sv*` match its SOLID_NAME rule.
 */
import type { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import { loadVillageProp, type Ticker } from "./villageHub";

/** Plaza-edge spot: bearing 174° (0° = +Z), 18 m out, facing the plaza centre. */
const BEARING = 174;
const RADIUS = 18;
const WIDTH = 7.6;
const HEIGHT = 6.4;

export interface SurvivalGate {
  /** Per-frame: opens the picker when the hero walks into the arch. */
  watch(hero: TransformNode): Ticker;
}

function openPicker(): void {
  void Promise.all([import("../survival/hud"), import("../survival/pending")]).then(([hud, pending]) => {
    if (document.getElementById("sv-modal")) return;
    hud.openSurvivalPicker((d) => {
      pending.setPendingRun(d);
      queueMicrotask(() => {
        const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
        void psy?.go?.("kowloon");
      });
    });
  });
}

export async function buildSurvivalGate(scene: Scene): Promise<SurvivalGate> {
  const a = (BEARING * Math.PI) / 180;
  const centre = new Vector3(Math.sin(a) * RADIUS, 0, Math.cos(a) * RADIUS);
  const yaw = a; // local X runs along the plaza edge
  const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  // Tripo exported the gate facing ±X (its long axis on Z): turn it a quarter
  // so "width" measures the span between the outer pillars.
  const gate = await loadVillageProp(scene, "/assets/village/survival_portal.glb", "survivalGate", {
    axis: "width", metres: WIDTH, limits: { height: HEIGHT * 1.5 },
  }, Math.PI / 2);
  if (gate) {
    gate.position.copyFrom(centre);
    gate.rotation.y = yaw;
    gate.isPickable = true;
    gate.freezeWorldMatrix();
  }

  // Solid pillars (four, at the model's pillar spacing), invisible.
  for (const [i, f] of [-0.42, -0.2, 0.2, 0.42].entries()) {
    const p = MeshBuilder.CreateCylinder(`portalStand_sv${i}`, { diameter: 0.7, height: 3, tessellation: 8 }, scene);
    p.position.copyFrom(centre.add(right.scale(f * WIDTH)));
    p.position.y = 1.5;
    p.isVisible = false;
    p.isPickable = false;
    p.freezeWorldMatrix();
  }

  // Dream fog in the central bay: one emissive plane, alpha breathing.
  const fogMat = new StandardMaterial("survivalGateFog", scene);
  fogMat.disableLighting = true;
  fogMat.emissiveColor = new Color3(0.35, 0.65, 1);
  fogMat.alpha = 0.45;
  fogMat.backFaceCulling = false;
  const fog = MeshBuilder.CreatePlane("survivalGateFogPlane", { width: WIDTH * 0.34, height: HEIGHT * 0.55 }, scene);
  fog.material = fogMat;
  fog.position.copyFrom(centre);
  fog.position.y = HEIGHT * 0.3;
  fog.rotation.y = yaw;
  fog.isPickable = true;

  // The plaque names the gate (the model's plaque is blank on purpose: no AI text).
  const tex = new DynamicTexture("survivalGatePlaqueTex", { width: 512, height: 128 }, scene, false);
  tex.hasAlpha = true;
  tex.drawText("DREAM SIEGE", null, 88, "bold 64px Georgia", "#f6d27a", "transparent", true);
  const plaqueMat = new StandardMaterial("survivalGatePlaqueMat", scene);
  plaqueMat.diffuseTexture = tex;
  plaqueMat.useAlphaFromDiffuseTexture = true;
  plaqueMat.emissiveColor = new Color3(1, 0.9, 0.7);
  plaqueMat.disableLighting = true;
  plaqueMat.backFaceCulling = false;
  const plaque = MeshBuilder.CreatePlane("survivalGatePlaque", { width: WIDTH * 0.3, height: WIDTH * 0.075 }, scene);
  plaque.material = plaqueMat;
  plaque.position.copyFrom(centre.add(new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).scale(0.35)));
  plaque.position.y = HEIGHT * 0.69;
  plaque.rotation.y = yaw;
  plaque.isPickable = false;

  // Tap the gate (short, still press — the same tap-vs-drag rule as the hub portal).
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  scene.onPointerObservable.add((pi) => {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      downX = scene.pointerX;
      downY = scene.pointerY;
      downAt = performance.now();
      return;
    }
    if (pi.type !== PointerEventTypes.POINTERUP) return;
    if ((scene.pointerX - downX) ** 2 + (scene.pointerY - downY) ** 2 > 144 || performance.now() - downAt > 500) return;
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === gate || m === (fog as Mesh));
    if (hit?.hit) openPicker();
  });

  return {
    watch(hero) {
      let armed = true;
      return {
        tick: (t) => {
          fogMat.alpha = 0.38 + Math.sin(t * 1.7) * 0.1;
          const d = Vector3.Distance(hero.position, centre);
          if (armed && d < 1.4) {
            armed = false;
            openPicker();
          } else if (!armed && d > 4) armed = true; // walk away to re-arm
        },
      };
    },
  };
}
