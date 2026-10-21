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

import { AINSWORTH } from "@shared/heroes/ainsworth";

import type { FreudCastKind, FreudSkillVfx } from "./freudCasts";

/**
 * Ainsworth's cast VFX: attachment, drawn around her. Pure Babylon (meshes,
 * two DynamicTexture bakes, one particle system, no assets), in her colours,
 * which match her icons (tools/gen-ainsworth-assets.sh): CYAN heart-shield,
 * TEAL cardigan, GOLD piping, and one hue per attachment style.
 *
 *  - Secure (1):            two ROSE arcs close round her like an embrace,
 *                           then a ring sweeps outward: the team let go to
 *                           explore.
 *  - Avoidant (2):          a cool STEEL shell closes over her, turned away;
 *                           inside it a heartbeat ring flickers (the calm is
 *                           only on the outside).
 *  - Ambivalent (3):        CORAL, twice: a ring pulls in to her, then a
 *                           shockwave pushes out. Cling, push.
 *  - Disorganized (4):      VIOLET glitch panes freeze round her, then a wide
 *                           VIOLET-CYAN dome bursts over the team and holds
 *                           for the immunity.
 *  - Safe Haven (E):        a CYAN heart-in-shield glyph on the ground under a
 *                           dome, for the whole mitigation window.
 *  - Strange Situation (R): a GOLD doorway rises behind her; she steps away
 *                           and back (the door swings), and a reveal ring
 *                           sweeps out from the threshold.
 *  - Earned Security (F):   a cracked heart rises over her head, its cracks
 *                           fill with GOLD until it shines whole, then a
 *                           radiant wave washes over the team.
 *
 * Loaded on demand (heroCasts.ts), so none of this is in the boot chunk. Same
 * lifecycle contract as the other hero modules: built once, re-armed per
 * cast, one onBeforeRenderObservable, every effect self-disables, shaders
 * compiled up front, glow only on tiers that allow it (core/quality.ts).
 */

const CYAN = new Color3(0.36, 0.92, 1.0);
const TEAL = new Color3(0.16, 0.7, 0.72);
const GOLD = new Color3(1.0, 0.82, 0.34);
const ROSE = new Color3(1.0, 0.48, 0.62);
const STEEL = new Color3(0.62, 0.74, 0.88);
const CORAL = new Color3(1.0, 0.42, 0.28);
const VIOLET = new Color3(0.66, 0.42, 1.0);

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
  const tex = new DynamicTexture("ainsworthFxDot", { width: size, height: size }, scene, false);
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

/** A heart path centred on (cx, cy), `r` wide-ish. */
function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.95);
  ctx.bezierCurveTo(cx - r * 1.35, cy + r * 0.1, cx - r * 0.95, cy - r * 0.95, cx, cy - r * 0.35);
  ctx.bezierCurveTo(cx + r * 0.95, cy - r * 0.95, cx + r * 1.35, cy + r * 0.1, cx, cy + r * 0.95);
  ctx.closePath();
}

/**
 * Safe Haven's ground glyph: a heart inside a shield inside a ring. White, so
 * the material tints it cyan; opacity rides the same texture.
 */
function havenTexture(scene: Scene): DynamicTexture {
  const size = 512;
  const tex = new DynamicTexture("ainsworthFxHaven", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.45, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  // The shield.
  const w = size * 0.26;
  ctx.beginPath();
  ctx.moveTo(c - w, c - w * 0.95);
  ctx.lineTo(c + w, c - w * 0.95);
  ctx.lineTo(c + w, c + w * 0.1);
  ctx.quadraticCurveTo(c + w * 0.9, c + w * 0.95, c, c + w * 1.25);
  ctx.quadraticCurveTo(c - w * 0.9, c + w * 0.95, c - w, c + w * 0.1);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.stroke();
  // The heart.
  heartPath(ctx, c, c, size * 0.13);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fill();
  tex.update();
  tex.hasAlpha = true;
  return tex;
}

/**
 * Earned Security's heart, two layers: the heart body, and the cracks across
 * it on a second texture so they can turn gold independently.
 */
function heartTextures(scene: Scene): { body: DynamicTexture; cracks: DynamicTexture } {
  const size = 256;
  const c = size / 2;
  const body = new DynamicTexture("ainsworthFxHeart", { width: size, height: size }, scene, false);
  const b = body.getContext() as CanvasRenderingContext2D;
  b.clearRect(0, 0, size, size);
  heartPath(b, c, c, size * 0.36);
  b.fillStyle = "rgba(255,255,255,0.55)";
  b.fill();
  b.lineWidth = 8;
  b.strokeStyle = "rgba(255,255,255,0.95)";
  b.stroke();
  body.update();
  body.hasAlpha = true;

  const cracks = new DynamicTexture("ainsworthFxCracks", { width: size, height: size }, scene, false);
  const k = cracks.getContext() as CanvasRenderingContext2D;
  k.clearRect(0, 0, size, size);
  k.strokeStyle = "rgba(255,255,255,1)";
  k.lineWidth = 7;
  k.lineJoin = "round";
  const seams: [number, number][][] = [
    [[0.5, 0.25], [0.44, 0.4], [0.55, 0.5], [0.46, 0.62], [0.5, 0.78]],
    [[0.44, 0.4], [0.3, 0.44]],
    [[0.55, 0.5], [0.7, 0.46]],
    [[0.46, 0.62], [0.36, 0.66]],
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
  // ---- shared spark burst -----------------------------------------------------
  const sparkAnchor = MeshBuilder.CreateBox("ainsworthFx_sparkAnchor", { size: 0.02 }, scene);
  sparkAnchor.parent = hero;
  sparkAnchor.position.y = 1.2;
  sparkAnchor.isVisible = false;
  const sparks = new ParticleSystem("ainsworthFx_sparks", 220, scene);
  sparks.particleTexture = softDot(scene);
  sparks.emitter = sparkAnchor;
  sparks.minEmitBox = new Vector3(-0.5, -0.3, -0.5);
  sparks.maxEmitBox = new Vector3(0.5, 0.3, 0.5);
  sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
  sparks.minSize = 0.08;
  sparks.maxSize = 0.26;
  sparks.emitRate = 0;
  sparks.direction1 = new Vector3(-0.5, 1.0, -0.5);
  sparks.direction2 = new Vector3(0.5, 2.6, 0.5);
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

  const torus = (name: string, d: number, t: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const m = MeshBuilder.CreateTorus(name, { diameter: d, thickness: t, tessellation: 48 }, scene);
    m.parent = parent;
    m.isPickable = false;
    m.material = mat;
    return m;
  };
  const root = (name: string, y = 0): TransformNode => {
    const r = new TransformNode(name, scene);
    r.parent = hero;
    r.position.y = y;
    return r;
  };

  // ---- 1 Secure: the embrace and the release ----------------------------------
  const secureRoot = root("ainsworthFx_secureRoot", 1.15);
  const secureMat = fxMat(scene, "ainsworthFx_secureMat", ROSE, 0);
  // Two half-arcs: a full torus clipped visually by scaling one axis would not
  // read; two tori squashed into C-shapes from either side do.
  const arcs = [-1, 1].map((side) => {
    const a = torus(`ainsworthFx_secureArc_${side}`, 1.6, 0.06, secureMat, secureRoot);
    a.rotation.y = Math.PI / 2;
    a.scaling.set(1, 1, 0.45);
    a.position.x = side * 0.9;
    return a;
  });
  const releaseMat = fxMat(scene, "ainsworthFx_releaseMat", ROSE, 0);
  const release = torus("ainsworthFx_release", 1, 0.05, releaseMat, root("ainsworthFx_releaseRoot", 0.08));

  // ---- 2 Avoidant: the shell and the hidden heartbeat ---------------------------
  const avoidRoot = root("ainsworthFx_avoidRoot", 0);
  const shellMat = fxMat(scene, "ainsworthFx_shellMat", STEEL, 0);
  const shell = MeshBuilder.CreateSphere("ainsworthFx_shell", { diameter: 2.4, segments: 20, slice: 0.55 }, scene);
  shell.parent = avoidRoot;
  shell.isPickable = false;
  shell.material = shellMat;
  const beatMat = fxMat(scene, "ainsworthFx_beatMat", STEEL, 0);
  const beat = torus("ainsworthFx_beat", 0.7, 0.04, beatMat, avoidRoot);
  beat.position.y = 1.3;

  // ---- 3 Ambivalent: pull in, push out ----------------------------------------
  const ambRoot = root("ainsworthFx_ambRoot", 0.1);
  const pullMat = fxMat(scene, "ainsworthFx_pullMat", CORAL, 0);
  const pull = torus("ainsworthFx_pull", 1, 0.07, pullMat, ambRoot);
  const pushMat = fxMat(scene, "ainsworthFx_pushMat", CORAL, 0);
  const push = torus("ainsworthFx_push", 1, 0.09, pushMat, ambRoot);

  // ---- 4 Disorganized: glitch panes, then the shelter dome ----------------------
  const disRoot = root("ainsworthFx_disRoot", 0);
  const glitchMat = fxMat(scene, "ainsworthFx_glitchMat", VIOLET, 0);
  const panes = [0, 1, 2, 3, 4, 5].map((k) => {
    const m = MeshBuilder.CreatePlane(`ainsworthFx_pane_${k}`, { width: 0.5, height: 0.12 }, scene);
    m.parent = disRoot;
    m.isPickable = false;
    m.material = glitchMat;
    return m;
  });
  const shelterMat = fxMat(scene, "ainsworthFx_shelterMat", VIOLET, 0);
  const shelter = MeshBuilder.CreateSphere("ainsworthFx_shelter", { diameter: 2, segments: 24, slice: 0.5 }, scene);
  shelter.parent = disRoot;
  shelter.isPickable = false;
  shelter.material = shelterMat;
  const shelterRimMat = fxMat(scene, "ainsworthFx_shelterRimMat", CYAN, 0);
  const shelterRim = torus("ainsworthFx_shelterRim", 2, 0.03, shelterRimMat, disRoot);
  shelterRim.position.y = 0.05;

  // ---- E Safe Haven: glyph and dome --------------------------------------------
  const havenRoot = root("ainsworthFx_havenRoot", 0.06);
  const glyphMat = fxMat(scene, "ainsworthFx_glyphMat", CYAN, 0);
  const glyphTex = havenTexture(scene);
  glyphMat.emissiveTexture = glyphTex;
  glyphMat.opacityTexture = glyphTex;
  const glyph = MeshBuilder.CreateDisc("ainsworthFx_glyph", { radius: 2.2, tessellation: 64 }, scene);
  glyph.parent = havenRoot;
  glyph.rotation.x = Math.PI / 2;
  glyph.isPickable = false;
  glyph.material = glyphMat;
  const domeMat = fxMat(scene, "ainsworthFx_domeMat", CYAN, 0);
  const dome = MeshBuilder.CreateSphere("ainsworthFx_dome", { diameter: 4.4, segments: 28, slice: 0.5 }, scene);
  dome.parent = havenRoot;
  dome.isPickable = false;
  dome.material = domeMat;
  const domeBandMat = fxMat(scene, "ainsworthFx_domeBandMat", TEAL, 0);
  const domeBand = torus("ainsworthFx_domeBand", 4.4, 0.03, domeBandMat, havenRoot);

  // ---- R Strange Situation: the doorway ---------------------------------------
  const doorRoot = root("ainsworthFx_doorRoot", 0);
  const doorMat = fxMat(scene, "ainsworthFx_doorMat", GOLD, 0);
  const jambs = [-1, 1].map((side) => {
    const m = MeshBuilder.CreateBox(`ainsworthFx_jamb_${side}`, { width: 0.1, height: 2.3, depth: 0.1 }, scene);
    m.parent = doorRoot;
    m.position.set(side * 0.62, 1.15, 0);
    m.isPickable = false;
    m.material = doorMat;
    return m;
  });
  const lintel = MeshBuilder.CreateBox("ainsworthFx_lintel", { width: 1.34, height: 0.1, depth: 0.1 }, scene);
  lintel.parent = doorRoot;
  lintel.position.y = 2.3;
  lintel.isPickable = false;
  lintel.material = doorMat;
  const leafHinge = new TransformNode("ainsworthFx_leafHinge", scene);
  leafHinge.parent = doorRoot;
  leafHinge.position.set(-0.58, 1.12, 0);
  const leafMat = fxMat(scene, "ainsworthFx_leafMat", GOLD, 0);
  const leaf = MeshBuilder.CreatePlane("ainsworthFx_leaf", { width: 1.12, height: 2.2 }, scene);
  leaf.parent = leafHinge;
  leaf.position.x = 0.56;
  leaf.isPickable = false;
  leaf.material = leafMat;
  const revealMat = fxMat(scene, "ainsworthFx_revealMat", GOLD, 0);
  const reveal = torus("ainsworthFx_reveal", 1, 0.06, revealMat, root("ainsworthFx_revealRoot", 0.08));

  // ---- F Earned Security: the mended heart and the wave ---------------------------
  const earnRoot = root("ainsworthFx_earnRoot", 2.7);
  const { body: heartTex, cracks: crackTex } = heartTextures(scene);
  const heartMat = fxMat(scene, "ainsworthFx_heartMat", ROSE, 0);
  heartMat.emissiveTexture = heartTex;
  heartMat.opacityTexture = heartTex;
  const heart = MeshBuilder.CreatePlane("ainsworthFx_heart", { size: 1.3 }, scene);
  heart.parent = earnRoot;
  heart.billboardMode = Mesh.BILLBOARDMODE_ALL;
  heart.isPickable = false;
  heart.material = heartMat;
  const crackMat = fxMat(scene, "ainsworthFx_crackMat", GOLD, 0);
  crackMat.emissiveTexture = crackTex;
  crackMat.opacityTexture = crackTex;
  const crack = MeshBuilder.CreatePlane("ainsworthFx_crack", { size: 1.3 }, scene);
  crack.parent = earnRoot;
  crack.billboardMode = Mesh.BILLBOARDMODE_ALL;
  crack.isPickable = false;
  crack.material = crackMat;
  const waveMat = fxMat(scene, "ainsworthFx_waveMat", GOLD, 0);
  const wave = torus("ainsworthFx_wave", 1, 0.08, waveMat, root("ainsworthFx_waveRoot", 0.1));

  // ---- glow (tier-gated) ----------------------------------------------------------
  const glowOptions = vfxGlowOptions();
  const glow = glowOptions ? new GlowLayer("ainsworthFx_glow", scene, glowOptions) : null;
  if (glow) {
    glow.intensity = 1.0;
    for (const m of [...arcs, release, beat, pull, push, shelterRim, domeBand, ...jambs, lintel, reveal, crack, wave]) {
      glow.addIncludedOnlyMesh(m);
    }
    scene.onDisposeObservable.add(() => glow.dispose());
  }

  const roots = [secureRoot, release.parent, avoidRoot, ambRoot, disRoot, havenRoot, doorRoot, reveal.parent, earnRoot, wave.parent] as TransformNode[];
  for (const r of roots) r.setEnabled(false);

  // Compile every shader now — a still-compiling material renders as nothing.
  const warm: [Mesh, StandardMaterial][] = [
    [arcs[0]!, secureMat], [release, releaseMat], [shell, shellMat], [beat, beatMat], [pull, pullMat],
    [push, pushMat], [panes[0]!, glitchMat], [shelter, shelterMat], [shelterRim, shelterRimMat],
    [glyph, glyphMat], [dome, domeMat], [domeBand, domeBandMat], [jambs[0]!, doorMat], [leaf, leafMat],
    [reveal, revealMat], [heart, heartMat], [crack, crackMat], [wave, waveMat],
  ];
  for (const [mesh, mat] of warm) mat.forceCompilation(mesh);
  for (const m of scene.meshes) if (m.name.startsWith("ainsworthFx_")) m.applyFog = false;

  // ---- per-frame driver -----------------------------------------------------------
  const secs = (ms: number | undefined, fallback: number): number => (ms ?? fallback) / 1000;
  const SECURE_SECS = 1.3;
  const AVOID_SECS = secs(AINSWORTH.palette.find((p) => p.id === "ainsworth.avoidant")?.effects.find((e) => e.kind === "self.stagger")?.durationMs, 4_000);
  const AMB_SECS = 1.2;
  const IMMUNE_SECS = secs(AINSWORTH.palette.find((p) => p.id === "ainsworth.disorganized")?.effects.find((e) => e.kind === "team.immunity")?.durationMs, 3_000);
  const GLITCH_SECS = 0.55;
  const HAVEN_SECS = secs(AINSWORTH.defense.mitigation?.durationMs, 6_000);
  const DOOR_SECS = 1.7;
  const EARN_SECS = 2.6;
  /** Reach of the team-wide effects, metres: about where a party stands. */
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

    // 1 — the arcs close round her, hold a beat, then the release ring runs out.
    if (secureT >= 0) {
      secureT += dt;
      const u = clamp01(secureT / SECURE_SECS);
      const close = sstep(0, 0.35, u);
      const open = sstep(0.5, 0.75, u);
      for (const [k, a] of arcs.entries()) a.position.x = (k ? 1 : -1) * (0.9 - 0.45 * close + 0.9 * open);
      secureMat.alpha = 0.9 * pulse(u, 0, 0.8, 0.15);
      const r = sstep(0.5, 1, u);
      release.scaling.set(0.6 + r * TEAM_R * 1.6, 1, 0.6 + r * TEAM_R * 1.6);
      releaseMat.alpha = 0.8 * pulse(u, 0.5, 1, 0.12);
      if (secureT >= SECURE_SECS) {
        secureT = -1;
        secureRoot.setEnabled(false);
        release.parent!.setEnabled(false);
      }
    }

    // 2 — the shell closes, turned away, and the heartbeat races inside it.
    if (avoidT >= 0) {
      avoidT += dt;
      const u = clamp01(avoidT / AVOID_SECS);
      const fade = sstep(0, 0.06, u) * (1 - sstep(0.85, 1, u));
      shell.scaling.setAll(Math.max(0.01, outBack(clamp01(avoidT / 0.35))));
      shellMat.alpha = 0.22 * fade;
      // A fast double beat (lub-dub) — racing, under the calm surface.
      const ph = (avoidT * 2.2) % 1;
      const lub = Math.exp(-((ph - 0.08) ** 2) / 0.002) + 0.7 * Math.exp(-((ph - 0.26) ** 2) / 0.002);
      beat.scaling.setAll(1 + lub * 0.5);
      beatMat.alpha = (0.25 + 0.75 * lub) * fade;
      if (avoidT >= AVOID_SECS) {
        avoidT = -1;
        avoidRoot.setEnabled(false);
      }
    }

    // 3 — pull in, push out, twice.
    if (ambT >= 0) {
      ambT += dt;
      const u = clamp01(ambT / AMB_SECS);
      const half = u < 0.5 ? u * 2 : (u - 0.5) * 2;
      const pullS = 3.2 - 2.8 * sstep(0, 0.45, half);
      pull.scaling.set(pullS, 1, pullS);
      pullMat.alpha = 0.85 * pulse(half, 0, 0.5, 0.15);
      const pushS = 0.4 + 4.2 * sstep(0.45, 1, half);
      push.scaling.set(pushS, 1, pushS);
      pushMat.alpha = 0.9 * pulse(half, 0.45, 1, 0.12);
      if (ambT >= AMB_SECS) {
        ambT = -1;
        ambRoot.setEnabled(false);
      }
    }

    // 4 — glitch panes stutter round her (the freeze), then the dome.
    if (disT >= 0) {
      disT += dt;
      const glitchOn = disT < GLITCH_SECS;
      for (const p of panes) {
        p.setEnabled(glitchOn && Math.random() < 0.7);
        if (p.isEnabled()) {
          p.position.set((Math.random() - 0.5) * 1.4, 0.4 + Math.random() * 1.8, (Math.random() - 0.5) * 1.4);
          p.rotation.y = Math.random() * Math.PI;
        }
      }
      glitchMat.alpha = glitchOn ? 0.85 : 0;
      const d = disT - GLITCH_SECS;
      if (d >= 0) {
        const u = clamp01(d / IMMUNE_SECS);
        const grow = outBack(clamp01(d / 0.3));
        const fade = 1 - sstep(0.85, 1, u);
        shelter.scaling.setAll(Math.max(0.01, grow * TEAM_R));
        shelterMat.alpha = 0.14 * fade;
        shelterRim.scaling.set(grow * TEAM_R, 1, grow * TEAM_R);
        shelterRimMat.alpha = 0.8 * fade * (0.75 + 0.25 * Math.sin(d * 9));
        if (d >= IMMUNE_SECS) {
          disT = -1;
          disRoot.setEnabled(false);
        }
      } else {
        shelterMat.alpha = 0;
        shelterRimMat.alpha = 0;
      }
    }

    // E — the glyph and the dome, for the whole mitigation window.
    if (havenT >= 0) {
      havenT += dt;
      const u = clamp01(havenT / HAVEN_SECS);
      const fade = sstep(0, 0.05, u) * (1 - sstep(0.88, 1, u));
      const grow = outBack(clamp01(havenT / 0.4));
      glyph.scaling.setAll(Math.max(0.01, grow));
      glyph.rotation.z += dt * 0.25;
      glyphMat.alpha = 0.85 * fade;
      dome.scaling.setAll(Math.max(0.01, grow) * (1 + Math.sin(havenT * 2) * 0.015));
      domeMat.alpha = 0.12 * fade;
      domeBandMat.alpha = 0.6 * fade;
      domeBand.position.y = 0.1 + ((havenT * 0.6) % 1) * 2.0;
      const bandR = Math.sqrt(Math.max(0, 1 - (domeBand.position.y / 2.2) ** 2));
      domeBand.scaling.set(bandR, 1, bandR);
      if (havenT >= HAVEN_SECS) {
        havenT = -1;
        havenRoot.setEnabled(false);
      }
    }

    // R — the doorway rises, the door swings out and back, the reveal runs.
    if (doorT >= 0) {
      doorT += dt;
      const u = clamp01(doorT / DOOR_SECS);
      doorRoot.scaling.y = Math.max(0.01, outBack(clamp01(u / 0.25)));
      doorMat.alpha = 0.9 * pulse(u, 0, 1, 0.15);
      // Separation: the door opens (she leaves); reunion: it swings back.
      leafHinge.rotation.y = -1.6 * sstep(0.15, 0.4, u) * (1 - sstep(0.55, 0.75, u));
      leafMat.alpha = 0.35 * pulse(u, 0.05, 0.95, 0.15);
      const r = sstep(0.7, 1, u);
      reveal.scaling.set(0.5 + r * TEAM_R * 1.7, 1, 0.5 + r * TEAM_R * 1.7);
      revealMat.alpha = 0.85 * pulse(u, 0.7, 1, 0.08);
      if (doorT >= DOOR_SECS) {
        doorT = -1;
        doorRoot.setEnabled(false);
        reveal.parent!.setEnabled(false);
      }
    }

    // F — the cracked heart rises, the seams fill gold, it shines, the wave.
    if (earnT >= 0) {
      earnT += dt;
      const u = clamp01(earnT / EARN_SECS);
      earnRoot.position.y = 1.6 + 1.1 * sstep(0, 0.3, u);
      const mend = sstep(0.3, 0.65, u);
      heartMat.emissiveColor.copyFrom(Color3.Lerp(ROSE, GOLD, mend));
      heartMat.alpha = 0.95 * pulse(u, 0, 0.92, 0.1);
      crackMat.alpha = (0.35 + 0.65 * mend) * pulse(u, 0, 0.92, 0.1);
      const shine = pulse(u, 0.62, 0.85, 0.08);
      heart.scaling.setAll(1 + shine * 0.35);
      crack.scaling.setAll(1 + shine * 0.35);
      const w = sstep(0.7, 1, u);
      wave.scaling.set(0.6 + w * TEAM_R * 1.8, 1, 0.6 + w * TEAM_R * 1.8);
      waveMat.alpha = 0.9 * pulse(u, 0.7, 1, 0.06);
      if (earnT >= EARN_SECS) {
        earnT = -1;
        earnRoot.setEnabled(false);
        wave.parent!.setEnabled(false);
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
            release.parent!.setEnabled(true);
            burst(ROSE, new Color3(1, 0.85, 0.9), 34, 1.2);
          } else if (id === "ainsworth.avoidant") {
            avoidT = 0;
            avoidRoot.rotation.y = Math.PI; // the shell's open side turned away
            avoidRoot.setEnabled(true);
            burst(STEEL, new Color3(0.85, 0.92, 1), 18, 1.3, true);
          } else if (id === "ainsworth.ambivalent") {
            ambT = 0;
            ambRoot.setEnabled(true);
            burst(CORAL, new Color3(1, 0.75, 0.55), 40, 1.0);
          } else if (id === "ainsworth.disorganized") {
            disT = 0;
            disRoot.setEnabled(true);
            burst(VIOLET, CYAN, 50, 1.1);
          }
          break;
        case "defense":
          havenT = 0;
          havenRoot.setEnabled(true);
          burst(CYAN, TEAL, 30, 0.6, true);
          break;
        case "chain":
          doorT = 0;
          doorRoot.position.z = -1.1; // behind her
          doorRoot.setEnabled(true);
          reveal.parent!.setEnabled(true);
          burst(GOLD, new Color3(1, 0.95, 0.75), 36, 1.2);
          break;
        case "ultimate":
          earnT = 0;
          earnRoot.setEnabled(true);
          wave.parent!.setEnabled(true);
          burst(GOLD, CYAN, 70, 2.2);
          break;
      }
    },
  };
}
