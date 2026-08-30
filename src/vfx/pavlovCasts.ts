import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";

import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";

import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Pavlov's cast VFX — the conditioning lab as light, pure Babylon (meshes +
 * DynamicTexture bakes + one particle system, no assets). Palette follows the
 * icon briefs in docs/design-prompts.md: amber for his instruments, cyan for
 * Extinction's dome.
 *
 *  - UCS (Q):      the food — a warm amber bowl-ring at the feet and a rising
 *                  aroma curl. Bright and unmissable, like the boss's UCR tell.
 *  - CS (Q, lit):  the bell — three concentric amber sound-rings expanding out
 *                  from chest height, the blazing-bell icon in motion.
 *  - Defense (E):  Spontaneous Recovery — a green ring that rises up the body,
 *                  looping back on itself the way the icon's arrow does.
 *  - Chain (R):    Generalization — the winged pocket-watch pops in ahead and
 *                  flies forward, hands spinning, motion arcs behind it.
 *  - Ultimate (F): Extinction — the bell-shaped dome (7 m, matching
 *                  `zoneRadius`) holds for the zone's 10 s while sound-rings
 *                  COLLAPSE inward: the response being unlearned, the exact
 *                  reverse of the CS rings.
 *
 * Same lifecycle contract as freudCasts: everything is created once and
 * re-armed per cast, one onBeforeRenderObservable drives whatever is live,
 * every effect self-disables, shaders are force-compiled up front, and every
 * mesh is named pavlovFx_* so the hub's shadow denylist skips it.
 */

/** Palette tints by id suffix — the analogue of Freud's STAGE_TINTS. */
export const PAVLOV_TINTS: Record<string, Color3> = {
  ucs: new Color3(1.0, 0.62, 0.22), // food amber
  cs: new Color3(1.0, 0.82, 0.35), // blazing bell amber
};

/** Extinction is the one cyan thing he does (design-prompts: dome icon). */
const DOME_TINT = new Color3(0.35, 0.9, 1.0);
const RECOVERY_TINT = new Color3(0.45, 1.0, 0.6);

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
  const tex = new DynamicTexture("pavlovFxDot", { width: size, height: size }, scene, false);
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
 * The Generalization pocket-watch: a white-on-transparent clock face — outer
 * bezel, hour ticks, hands frozen at a jaunty ten-past — with swept wing arcs
 * on both sides. White so emissiveColor tints it amber.
 */
function clockTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("pavlovClockTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const r = 74;
  // Wing arcs left and right of the bezel.
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      ctx.lineWidth = 6 - i * 1.5;
      ctx.beginPath();
      ctx.arc(c + side * (r + 26 + i * 16), c, 44 + i * 10, Math.PI * 0.62, Math.PI * 1.38, side > 0);
      ctx.stroke();
    }
  }
  // Bezel + face.
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 7;
  ctx.stroke();
  // Crown at 12 o'clock — reads "pocket-watch", not "wall clock".
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillRect(c - 8, c - r - 16, 16, 12);
  // Hour ticks.
  ctx.lineWidth = 4;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * (r - 14), c + Math.sin(a) * (r - 14));
    ctx.lineTo(c + Math.cos(a) * (r - 5), c + Math.sin(a) * (r - 5));
    ctx.stroke();
  }
  // Hands.
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(-Math.PI / 3) * 34, c + Math.sin(-Math.PI / 3) * 34);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(Math.PI * 0.13) * 52, c + Math.sin(Math.PI * 0.13) * 52);
  ctx.stroke();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/** Flat ring with a soft outer falloff, for the UCS bowl-ring at the feet. */
function bowlRingTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("pavlovBowlTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  // A narrow halo band around a crisp ring — wide falloffs read as a splotch
  // in the hub's daylight, not a bowl.
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

export function createPavlovSkillVfx(scene: Scene, hero: TransformNode): FreudSkillVfx {
  // ---- UCS: amber bowl-ring + aroma curl ----------------------------------
  const bowlRoot = new TransformNode("pavlovFx_bowlRoot", scene);
  bowlRoot.parent = hero;
  bowlRoot.position.y = 0.07;
  const bowl = MeshBuilder.CreateDisc("pavlovFx_bowl", { radius: 1.4, tessellation: 48 }, scene);
  bowl.parent = bowlRoot;
  bowl.rotation.x = Math.PI / 2;
  bowl.isPickable = false;
  const bowlMat = fxMat(scene, "pavlovFx_bowlMat", PAVLOV_TINTS.ucs!, 1);
  const bowlTex = bowlRingTexture(scene);
  bowlMat.emissiveTexture = bowlTex;
  bowlMat.opacityTexture = bowlTex;
  bowl.material = bowlMat;

  // Shared spark burst — the factory's ONE particle system, recoloured per
  // cast (UCS aroma amber, E heal green, F dome cyan). Emitter is an invisible
  // box mesh, the ParticleSystem emitter contract.
  const sparkAnchor = MeshBuilder.CreateBox("pavlovFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.0;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("pavlovFx_sparks", 200, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.5, -0.5, -0.5);
  sparks.maxEmitBox = new Vector3(0.5, 0.5, 0.5);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.08;
  sparks.maxSize = 0.32;
  sparks.minLifeTime = 0.4;
  sparks.maxLifeTime = 1.0;
  sparks.emitRate = 0; // manual bursts only
  sparks.direction1 = new Vector3(-0.6, 0.8, -0.6);
  sparks.direction2 = new Vector3(0.6, 2.4, 0.6);
  sparks.minEmitPower = 0.8;
  sparks.maxEmitPower = 2.4;
  sparks.gravity = new Vector3(0, -0.6, 0);
  sparks.start();

  // ---- CS + Extinction: sound-rings ---------------------------------------
  // One torus set serves both casts: CS expands them outward (the bell heard),
  // Extinction collapses them inward (the bell unlearned). Chest height.
  const ringRoot = new TransformNode("pavlovFx_ringRoot", scene);
  ringRoot.parent = hero;
  ringRoot.position.y = 1.35;
  const ringMat = fxMat(scene, "pavlovFx_ringMat", PAVLOV_TINTS.cs!, 0.9);
  const rings: Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = MeshBuilder.CreateTorus(
      "pavlovFx_ring",
      { diameter: 1, thickness: 0.05, tessellation: 48 },
      scene
    );
    ring.parent = ringRoot;
    ring.rotation.x = Math.PI / 2; // ripple out horizontally
    ring.isPickable = false;
    ring.material = ringMat;
    rings.push(ring);
  }
  // The bell's clapper wheel: four blades sweeping one full turn per CS —
  // a torus is rotationally symmetric, so the rings alone can't show spin.
  // CS only; the ult's reverse collapse keeps the rings bare.
  const fanRoot = new TransformNode("pavlovFx_fanRoot", scene);
  fanRoot.parent = ringRoot;
  // Own material, dimmer and thinner than the rings: under the arena's bloom
  // a ring-bright blade blooms into a lighthouse beam, not a fan.
  const fanMat = fxMat(scene, "pavlovFx_fanMat", PAVLOV_TINTS.cs!.scale(0.6), 0.5);
  const fanBlades: Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const blade = MeshBuilder.CreateBox(
      "pavlovFx_fanBlade",
      { width: 0.14, height: 0.02, depth: 1.2 },
      scene
    );
    blade.parent = fanRoot;
    const a = (i / 4) * Math.PI * 2;
    blade.rotation.y = a;
    blade.position.set(Math.sin(a) * 0.8, 0, Math.cos(a) * 0.8);
    blade.isPickable = false;
    blade.material = fanMat;
    fanBlades.push(blade);
  }

  // ---- Defense: the recovery loop -----------------------------------------
  const loopRoot = new TransformNode("pavlovFx_loopRoot", scene);
  loopRoot.parent = hero;
  const loop = MeshBuilder.CreateTorus(
    "pavlovFx_loop",
    { diameter: 2.2, thickness: 0.07, tessellation: 48 },
    scene
  );
  loop.parent = loopRoot;
  loop.isPickable = false;
  const loopMat = fxMat(scene, "pavlovFx_loopMat", RECOVERY_TINT, 0.85);
  loop.material = loopMat;
  const loopEcho = MeshBuilder.CreateTorus(
    "pavlovFx_loopEcho",
    { diameter: 2.5, thickness: 0.04, tessellation: 48 },
    scene
  );
  loopEcho.parent = loopRoot;
  loopEcho.isPickable = false;
  const loopEchoMat = fxMat(scene, "pavlovFx_loopEchoMat", RECOVERY_TINT.scale(1.3), 0.5);
  loopEcho.material = loopEchoMat;

  // ---- Chain: the flying pocket-watch -------------------------------------
  // World-space like Freud's eye — it flies AWAY from the hero.
  const clockRoot = new TransformNode("pavlovFx_clockRoot", scene);
  const clock = MeshBuilder.CreatePlane("pavlovFx_clock", { size: 2.6 }, scene);
  clock.parent = clockRoot;
  clock.billboardMode = Mesh.BILLBOARDMODE_ALL;
  clock.isPickable = false;
  const clockMat = fxMat(scene, "pavlovFx_clockMat", new Color3(1.0, 0.78, 0.32), 1);
  const clockTex = clockTexture(scene);
  clockMat.emissiveTexture = clockTex;
  clockMat.opacityTexture = clockTex;
  clock.material = clockMat;

  // ---- Ultimate: the bell dome --------------------------------------------
  // World-space: the zone stays where it was rung. Radius mirrors
  // `PAVLOV.ultimate.zoneRadius` (7 m); a half-sphere IS the bell shape.
  const DOME_RADIUS = 7;
  const domeRoot = new TransformNode("pavlovFx_domeRoot", scene);
  const dome = MeshBuilder.CreateSphere(
    "pavlovFx_dome",
    { diameter: DOME_RADIUS * 2, segments: 24, slice: 0.5 },
    scene
  );
  dome.parent = domeRoot;
  dome.isPickable = false;
  const domeMat = fxMat(scene, "pavlovFx_domeMat", DOME_TINT, 0.12);
  dome.material = domeMat;
  const domeCage = MeshBuilder.CreateSphere(
    "pavlovFx_domeCage",
    { diameter: DOME_RADIUS * 2 + 0.2, segments: 10, slice: 0.5 },
    scene
  );
  domeCage.parent = domeRoot;
  domeCage.isPickable = false;
  const domeCageMat = fxMat(scene, "pavlovFx_domeCageMat", DOME_TINT.scale(1.3), 0.22);
  domeCageMat.wireframe = true;
  domeCage.material = domeCageMat;
  // The rim ring where dome meets ground — the bell's mouth.
  const domeRim = MeshBuilder.CreateTorus(
    "pavlovFx_domeRim",
    { diameter: DOME_RADIUS * 2, thickness: 0.1, tessellation: 64 },
    scene
  );
  domeRim.parent = domeRoot;
  domeRim.position.y = 0.05;
  domeRim.isPickable = false;
  const domeRimMat = fxMat(scene, "pavlovFx_domeRimMat", DOME_TINT.scale(1.5), 0.8);
  domeRim.material = domeRimMat;

  // Everything starts dark.
  bowlRoot.setEnabled(false);
  ringRoot.setEnabled(false);
  fanRoot.setEnabled(false);
  loopRoot.setEnabled(false);
  clockRoot.setEnabled(false);
  domeRoot.setEnabled(false);

  // Compile every effect shader NOW, not on first cast — a still-compiling
  // material renders as nothing (see freudCasts for the full story).
  const warmPairs: [Mesh, StandardMaterial][] = [
    [bowl, bowlMat],
    [rings[0]!, ringMat],
    [fanBlades[0]!, fanMat],
    [loop, loopMat],
    [loopEcho, loopEchoMat],
    [clock, clockMat],
    [dome, domeMat],
    [domeCage, domeCageMat],
    [domeRim, domeRimMat],
  ];
  for (const [mesh, mat] of warmPairs) {
    mesh.applyFog = false;
    mat.forceCompilation(mesh);
  }
  for (const r of rings) r.applyFog = false;
  for (const b of fanBlades) b.applyFog = false;

  // ---- Per-frame driver ---------------------------------------------------
  let ucsT = -1;
  let csT = -1;
  let defenseT = -1;
  let chainT = -1;
  let ultT = -1;
  const chainDir = new Vector3(0, 0, 1);

  const UCS_SECS = 1.1;
  const CS_SECS = 1.2;
  const DEFENSE_SECS = 2.2;
  const CHAIN_SECS = 2.0;
  // Matches the zone's real 10 s (`zone.extinction` durationMs) — the visual
  // must not outlive or undersell the mitigation window it stands for.
  const ULT_SECS = 10;
  const RING_MAX = 6; // how far the CS sound-rings travel (diameter scale)

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;

    if (ucsT >= 0) {
      ucsT += dt;
      const u = clamp01(ucsT / UCS_SECS);
      if (u >= 1) {
        ucsT = -1;
        bowlRoot.setEnabled(false);
      } else {
        const grow = outBack(clamp01(ucsT / 0.3));
        bowlRoot.scaling.setAll(Math.max(0.01, grow));
        bowlMat.alpha = 1 - sstep(0.5, 1, u);
        bowl.rotation.y += dt * 1.2;
      }
    }

    if (csT >= 0) {
      csT += dt;
      const u = clamp01(csT / CS_SECS);
      if (u >= 1) {
        csT = -1;
        ringRoot.setEnabled(false);
        fanRoot.setEnabled(false);
      } else {
        ringMat.emissiveColor.copyFrom(PAVLOV_TINTS.cs!);
        ringMat.alpha = 0.9 * (1 - sstep(0.55, 1, u));
        // Three ripples, staggered launches, expanding outward.
        for (let i = 0; i < rings.length; i++) {
          const local = clamp01((u - i * 0.16) / (1 - i * 0.16));
          const d = 0.6 + local * RING_MAX;
          rings[i]!.scaling.set(d, 1, d);
        }
        // The fan: exactly one full 360° sweep over the cast, easing out with
        // the ripple — a rung bell spun by its own sound.
        fanMat.alpha = 0.5 * (1 - sstep(0.55, 1, u));
        fanRoot.rotation.y = sstep(0, 1, u) * Math.PI * 2;
        const swell = 1 + u * 1.2;
        fanRoot.scaling.set(swell, 1, swell);
      }
    }

    if (defenseT >= 0) {
      defenseT += dt;
      const u = clamp01(defenseT / DEFENSE_SECS);
      if (u >= 1) {
        defenseT = -1;
        loopRoot.setEnabled(false);
      } else {
        // The ring rises from the feet to over the head — the icon's arrow
        // looping back — then a fainter echo follows one beat behind.
        const fade = sstep(0, 0.1, u) * (1 - sstep(0.75, 1, u));
        loop.position.y = 0.2 + u * 2.2;
        loop.scaling.setAll(1 - 0.25 * u);
        loopMat.alpha = 0.85 * fade;
        const echoU = clamp01(u - 0.18) / 0.82;
        loopEcho.position.y = 0.2 + echoU * 2.2;
        loopEcho.scaling.setAll(1.1 - 0.25 * echoU);
        loopEchoMat.alpha = 0.5 * fade;
        loop.rotation.y += dt * 2.0;
      }
    }

    if (chainT >= 0) {
      chainT += dt;
      const u = clamp01(chainT / CHAIN_SECS);
      if (u >= 1) {
        chainT = -1;
        clockRoot.setEnabled(false);
      } else {
        // Pops in, then accelerates away — a thrown watch, not a drifting eye.
        const speed = 2.5 + 8 * sstep(0.2, 1, u);
        clockRoot.position.addInPlace(chainDir.scale(speed * dt));
        clockRoot.position.y += Math.sin(chainT * 5) * 0.3 * dt;
        clock.scaling.setAll(Math.max(0.01, outBack(clamp01(chainT / 0.35))));
        clockMat.alpha = sstep(0, 0.08, u) * (1 - sstep(0.8, 1, u));
        clock.rotation.z += dt * 2.4; // the face spins as it flies
      }
    }

    if (ultT >= 0) {
      ultT += dt;
      const u = clamp01(ultT / ULT_SECS);
      if (u >= 1) {
        ultT = -1;
        domeRoot.setEnabled(false);
        ringRoot.setEnabled(false);
      } else {
        const pop = outBack(clamp01(ultT / 0.5));
        domeRoot.scaling.setAll(Math.max(0.01, pop));
        const fade = 1 - sstep(0.85, 1, u);
        // Low alphas on purpose: with backFaceCulling off the in-dome camera
        // sees both shells, and the fight has to stay readable through 10 s.
        domeMat.alpha = (0.05 + 0.02 * Math.sin(ultT * 2.1)) * fade;
        domeCageMat.alpha = 0.12 * fade;
        domeRimMat.alpha = (0.7 + 0.2 * Math.sin(ultT * 3.1)) * fade;
        domeCage.rotation.y += dt * 0.25;
        // The first two seconds: sound-rings collapse INWARD over the hero —
        // extinction is the CS ripple played backwards.
        const rev = clamp01(ultT / 2.0);
        if (rev < 1) {
          ringMat.emissiveColor.copyFrom(DOME_TINT);
          ringMat.alpha = 0.8 * (1 - sstep(0.8, 1, rev));
          for (let i = 0; i < rings.length; i++) {
            const local = clamp01((rev - i * 0.16) / (1 - i * 0.16));
            const d = 0.6 + (1 - local) * RING_MAX;
            rings[i]!.scaling.set(d, 1, d);
          }
        } else {
          ringRoot.setEnabled(false);
        }
      }
    }
  });

  return {
    cast(kind: FreudCastKind, id: string) {
      switch (kind) {
        case "palette": {
          const suffix = id.split(".").pop() ?? "";
          if (suffix === "cs") {
            csT = 0;
            ringRoot.setEnabled(true);
            fanRoot.setEnabled(true);
            fanRoot.rotation.y = 0;
            fanRoot.scaling.setAll(1);
            fanMat.alpha = 0.5;
            for (const r of rings) r.scaling.set(0.6, 1, 0.6);
            sparks.color1 = new Color4(1.0, 0.85, 0.4, 0.9);
            sparks.color2 = new Color4(1.0, 0.95, 0.7, 0.6);
            sparks.colorDead = new Color4(0.5, 0.3, 0.05, 0);
            sparks.manualEmitCount = 60;
          } else {
            ucsT = 0;
            bowlRoot.setEnabled(true);
            bowlRoot.scaling.setAll(0.01);
            sparks.color1 = new Color4(1.0, 0.62, 0.22, 0.9);
            sparks.color2 = new Color4(1.0, 0.8, 0.45, 0.55);
            sparks.colorDead = new Color4(0.45, 0.22, 0.05, 0);
            sparks.manualEmitCount = 40;
          }
          break;
        }
        case "defense":
          defenseT = 0;
          loopRoot.setEnabled(true);
          sparks.color1 = new Color4(0.45, 1.0, 0.6, 0.9);
          sparks.color2 = new Color4(0.7, 1.0, 0.8, 0.6);
          sparks.colorDead = new Color4(0.1, 0.4, 0.2, 0);
          sparks.manualEmitCount = 45;
          break;
        case "chain": {
          chainT = 0;
          // Same handedness note as Freud's eye: visual forward is Backward().
          hero.getDirection(Vector3.Backward()).normalizeToRef(chainDir);
          chainDir.y = 0;
          chainDir.normalize();
          const p = hero.getAbsolutePosition();
          clockRoot.position.set(p.x + chainDir.x * 1.2, p.y + 1.6, p.z + chainDir.z * 1.2);
          clock.scaling.setAll(0.01);
          clockRoot.setEnabled(true);
          break;
        }
        case "ultimate": {
          ultT = 0;
          csT = -1; // the collapse owns the rings now — cancel a live CS ripple
          fanRoot.setEnabled(false); // the collapse is ringless — no fan
          const p = hero.getAbsolutePosition();
          domeRoot.position.set(p.x, p.y + 0.02, p.z);
          domeRoot.scaling.setAll(0.01);
          domeRoot.setEnabled(true);
          ringRoot.setEnabled(true);
          for (const r of rings) r.scaling.set(0.6 + RING_MAX, 1, 0.6 + RING_MAX);
          sparks.color1 = new Color4(0.35, 0.9, 1.0, 0.9);
          sparks.color2 = new Color4(0.7, 1.0, 1.0, 0.6);
          sparks.colorDead = new Color4(0.05, 0.3, 0.4, 0);
          sparks.manualEmitCount = 80;
          break;
        }
      }
    },
  };
}
