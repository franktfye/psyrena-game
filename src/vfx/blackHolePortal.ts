import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Material } from "@babylonjs/core/Materials/material";

// Tree-shaken shape builders must be imported explicitly.
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";

import { createSoftRingTexture } from "./softSprites";

/**
 * The plaza portal — the arena's black-hole backdrop recipe (lookdevArena.ts)
 * shrunk from a 14 m sky object to a ~0.5 m pocket singularity hovering over a
 * rock stand at the exact centre of the village. This is the group-up point:
 * tapping it opens the game-rooms panel (src/ui/roomsPanel.ts) where parties
 * form before entering the boss arena.
 *
 * Same soft-gradient-sprite construction as the backdrop — gaussian ring bakes
 * on flat discs, never torus geometry, emissive held ≤ 1.0 so the hub's
 * tighter bloom gate (threshold 0.92) smears a glow instead of clipping to
 * white. Differences from the backdrop, all deliberate:
 *
 *  - No `ignoreCameraMaxZ` / inflated bounding spheres: those exist because a
 *    distant 64 m disc fails frustum tests while orbiting; a 2 m prop at the
 *    orbit centre never does.
 *  - Default rendering group (the arena used group 1 as a far-sky layer; here
 *    the portal must depth-test against the stand, hero and crowd).
 *  - Naming contract with villageHub.ts: `portalStand*` joins the solid
 *    collider set (players bump into the rock), `portalFx*`/`portalPick` join
 *    the shadow-caster denylist (a tilted transparent disc in the render-once
 *    shadow map would bake a frozen crescent onto the paving).
 */

export interface BlackHolePortal {
  root: TransformNode;
  /** Invisible pick body covering stand + hole — the raycast target for taps. */
  pickable: Mesh;
  tick(t: number): void;
}

/** Horizon radius. The arena backdrop runs RS = 14; this is person-scale. */
const RS = 0.52;
const PHOTON_R = RS * 1.55;
const DISC_INNER = PHOTON_R * 1.15;
/** Stand top surface height — three stacked rough drums get us here. */
const STAND_TOP = 1.8;
/** Black-hole centre above the plaza. Clears the stand by a head's height. */
const HOVER_Y = 3.3;

export function buildBlackHolePortal(scene: Scene, standMat?: Material): BlackHolePortal {
  const root = new TransformNode("plazaPortal", scene);

  // ---- Rock stand --------------------------------------------------------
  // Low-tessellation drums, each turned a little against the last so the
  // silhouette reads as stacked hewn rock rather than a lathed column. Baked
  // still: freeze after positioning, same as every static hub prop.
  const rock =
    standMat ??
    (() => {
      const m = new PBRMaterial("portalStandMat", scene);
      m.albedoColor = new Color3(0.34, 0.33, 0.32);
      m.metallic = 0.02;
      m.roughness = 0.92;
      return m;
    })();

  const drum = (
    name: string,
    dTop: number,
    dBottom: number,
    height: number,
    y: number,
    tess: number,
    ry: number
  ): Mesh => {
    const m = MeshBuilder.CreateCylinder(
      name,
      { diameterTop: dTop, diameterBottom: dBottom, height, tessellation: tess },
      scene
    );
    m.parent = root;
    m.position.y = y;
    m.rotation.y = ry;
    m.material = rock;
    m.isPickable = false;
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    return m;
  };

  drum("portalStandBase", 3.6, 4.4, 0.55, 0.275, 9, 0);
  drum("portalStandMid", 2.4, 3.2, 0.85, 0.975, 7, 0.45);
  drum("portalStandTop", 2.9, 2.4, 0.4, STAND_TOP - 0.2, 8, 0.2);

  // Cyan holo rim inlaid on the top slab — the same accent language as the
  // plaza rim torus, so the stand reads as village furniture, not a ruin.
  // "Rim" in the name is deliberate: it puts the flat torus on villageHub's
  // shadow denylist.
  const rim = MeshBuilder.CreateTorus(
    "portalStandRim",
    { diameter: 2.55, thickness: 0.05, tessellation: 48 },
    scene
  );
  rim.parent = root;
  rim.position.y = STAND_TOP + 0.02;
  const rimMat = new StandardMaterial("portalStandRimMat", scene);
  rimMat.disableLighting = true;
  rimMat.emissiveColor = new Color3(0.3, 0.85, 1.0);
  rimMat.diffuseColor = Color3.Black();
  rimMat.specularColor = Color3.Black();
  rimMat.alpha = 0.8;
  rim.material = rimMat;
  rim.isPickable = false;
  rim.freezeWorldMatrix();

  // ---- Pocket black hole -------------------------------------------------
  // Own transform so the whole system can bob and precess without touching
  // the frozen stand. Never freeze anything under here.
  const fx = new TransformNode("portalFxRoot", scene);
  fx.parent = root;
  fx.position.y = HOVER_Y;

  const mark = (m: Mesh): void => {
    m.parent = fx;
    m.isPickable = false;
    m.receiveShadows = false;
    m.applyFog = false;
  };

  // Event horizon: pure black, keeps depth so the ring hole reveals it.
  const horizon = MeshBuilder.CreateSphere(
    "portalFxHorizon",
    { diameter: RS * 2, segments: 24 },
    scene
  );
  mark(horizon);
  const horizonMat = new StandardMaterial("portalFxHorizonMat", scene);
  horizonMat.disableLighting = true;
  horizonMat.diffuseColor = Color3.Black();
  horizonMat.emissiveColor = Color3.Black();
  horizonMat.specularColor = Color3.Black();
  horizon.material = horizonMat;

  // The disc stack: same tilt and the same ring-texture parameters as the
  // backdrop (ringR is relative to mesh radius, so the bakes scale for free).
  const discTilt = Math.PI / 2.4;

  const softDisc = (
    name: string,
    radius: number,
    emissive: Color3,
    texRingR: number,
    sigmaIn: number,
    sigmaOut: number,
    noise: number,
    alpha: number,
    yOffset: number,
    alphaIndex: number,
    depthWrite = true
  ): { mesh: Mesh; mat: StandardMaterial } => {
    const mesh = MeshBuilder.CreateDisc(
      name,
      { radius, tessellation: 48, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    mark(mesh);
    mesh.rotation.x = discTilt;
    mesh.position.y = yOffset;
    const mat = new StandardMaterial(`${name}Mat`, scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.emissiveColor = emissive.clone();
    if (!depthWrite) mat.disableDepthWrite = true;
    const tex = createSoftRingTexture(scene, `${name}Tex`, 128, texRingR, sigmaIn, sigmaOut, noise);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
    mat.alpha = alpha;
    mesh.material = mat;
    mesh.alphaIndex = alphaIndex;
    return { mesh, mat };
  };

  const photon = softDisc(
    "portalFxPhoton", PHOTON_R * 2.3, new Color3(0.9, 0.76, 0.58),
    1 / 2.3, 0.05, 0.1, 0.15, 0.8, 0.015, 4
  );
  const photon2 = softDisc(
    "portalFxPhoton2", PHOTON_R * 2.8, new Color3(0.68, 0.36, 0.85),
    1.12 / 2.8, 0.09, 0.18, 0.3, 0.5, 0.022, 5
  );
  const inner = softDisc(
    "portalFxInner", DISC_INNER * 1.7, new Color3(0.95, 0.72, 0.46),
    0.58, 0.1, 0.22, 0.35, 0.7, 0.008, 3
  );
  // Haze runs dimmer than the arena's (0.3): at prop scale the discs overlap
  // on far fewer pixels, so the same alphas stack into a white smear.
  const haze = softDisc(
    "portalFxHaze", RS * 4.6, new Color3(0.75, 0.35, 1.0),
    0.42, 0.3, 0.3, 0.3, 0.2, -0.015, 1, false
  );

  // ---- Pick body ---------------------------------------------------------
  // One invisible cylinder over stand + hole. visibility 0 keeps it out of
  // every render path; the tap handler picks it with an explicit predicate,
  // so the default isVisible filtering never applies.
  const pickable = MeshBuilder.CreateCylinder(
    "portalPick",
    { diameter: 4.6, height: HOVER_Y + 2.2, tessellation: 12 },
    scene
  );
  pickable.parent = root;
  pickable.position.y = (HOVER_Y + 2.2) / 2;
  pickable.visibility = 0;
  pickable.isPickable = true;
  pickable.freezeWorldMatrix();

  return {
    root,
    pickable,
    tick(t: number) {
      // Keplerian-ish differential spin, plus a slow whole-system precession
      // and bob — the "alive" read, straight from the backdrop's tick.
      photon.mesh.rotation.y = t * 0.15;
      photon2.mesh.rotation.y = -t * 0.1;
      inner.mesh.rotation.y = -t * 0.55;
      haze.mesh.rotation.y = -t * 0.12;
      fx.rotation.y = t * 0.05;
      fx.rotation.z = Math.sin(t * 0.09) * 0.06;
      fx.position.y = HOVER_Y + Math.sin(t * 0.5) * 0.1;

      // Breath on the emissives; peaks stay ~1.0 so bloom glows, never clips.
      const breath = 0.85 + (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.25;
      photon.mat.emissiveColor.set(0.9 * breath, 0.76 * breath, 0.58 * breath);
      photon2.mat.emissiveColor.set(0.68 * breath, 0.36 * breath, 0.85 * breath);
      const hot = 0.8 + (Math.sin(t * 2.2 + 0.7) * 0.5 + 0.5) * 0.25;
      inner.mat.emissiveColor.set(0.95 * hot, 0.72 * hot, 0.46 * hot);
      haze.mat.alpha = 0.15 + (Math.sin(t * 0.9) * 0.5 + 0.5) * 0.1;

      // Stand rim pulses in time with the veil — the "this is a device, tap
      // it" cue at plaza distance.
      rimMat.alpha = 0.55 + (Math.sin(t * 1.2) * 0.5 + 0.5) * 0.35;
    },
  };
}
