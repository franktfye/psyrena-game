/**
 * Draws the survival sim: monsters (pooled model instances with their four
 * clips), telegraph decals, burning ground, projectiles, pickups and the
 * Recall Test circles. It only READS sim state; gameplay lives in
 * shared/survival/sim.ts.
 *
 * Mobile notes (CLAUDE.md rules 4–5): telegraphs are flat unlit discs; burns,
 * projectiles and pickups are emissive primitives from one material each; a
 * dead monster's instance goes back to its pool instead of being disposed, so
 * a long run does not instantiate hundreds of skeletons.
 */
import type { Scene } from "@babylonjs/core/scene";
import { Vector3, Vector4, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";

import type { SurvivalSim, Hostile, Hazard } from "@shared/survival/sim";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import "@babylonjs/core/Meshes/instancedMesh";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { qualityTier } from "../core/quality";
import { loadVillageProp } from "../scenes/villageHub";
import { MINIONS, ELITES, BOSSES } from "@shared/survival/content";
import { RECALL_COLORS, RECALL_LETTERS } from "./hud";

const MODEL_DIR = "/assets/survival/monsters";
/** Display heights (m). Bosses tower; everything still walks slower than a hero. */
const HEIGHT: Record<string, number> = {
  "sv-dream-wisp": 1.3, "sv-falling-dream": 1.8, "sv-afterimage": 1.85, "sv-kanizsa-pacman": 1.5,
  "sv-false-memory": 1.8, "sv-ebbinghaus-fade": 1.9, "sv-stroop-sprite": 1.3, "sv-bandwagon": 1.75,
  "sv-repressed": 2.5, "sv-startle-hound": 2.3, "sv-superstitious-pigeon": 2.4, "sv-identity-diffusion": 2.4, "sv-clinging-wraith": 2.4,
  "sv-imitator": 2.3, "sv-tall-glass": 2.6,
  "sv-dream-weaver": 5.0, "sv-ames-room": 5.2, "sv-invisible-gorilla": 4.4, "sv-old-hag": 4.6,
};
const AGE_LABEL: Record<string, string> = {
  "age.infant": "INFANT", "age.toddler": "TODDLER", "age.child": "CHILD", "age.school": "SCHOOL AGE", "age.adolescent": "ADOLESCENT",
};

interface Body {
  root: TransformNode;
  meshes: AbstractMesh[];
  clips: { idle?: AnimationGroup; walk?: AnimationGroup; attack?: AnimationGroup; death?: AnimationGroup };
  playing: string;
  ring: Mesh | null;
  tag: Mesh | null;
  /** The Imitator's "next copy" tag, and the text it shows now. */
  copyTag?: { mesh: Mesh; tex: DynamicTexture; text: string };
  /** Tall Glass: the pour shape, eased (−1 wide … 0 itself … +1 tall). */
  pour?: number;
  /** Violet sigil under a monster while a hero's damage-over-time rides it. */
  dotMark?: Mesh | null;
  lastX: number;
  lastZ: number;
  dyingT: number;
}

export interface SurvivalView {
  /**
   * Preload the models this run can show: every minion and boss, but only the
   * party's own elites (§4.1 spawns elites by roster) — a solo run skips four
   * of the five, ~15 MB on a phone.
   */
  preload(): Promise<void>;
  sync(dt: number): void;
  /** World point to aim casts at for a hostile (chest height). */
  aimPoint(h: Hostile): Vector3;
  onDie(id: number): void;
  onAttack(id: number): void;
  dispose(): void;
}

export function createSurvivalView(scene: Scene, sim: SurvivalSim): SurvivalView {
  const containers = new Map<string, Promise<AssetContainer | null>>();
  const pools = new Map<string, Body[]>();
  const live = new Map<number, Body>();
  const dying: Body[] = [];

  const container = (model: string) => {
    let p = containers.get(model);
    if (!p) {
      p = LoadAssetContainerAsync(`${MODEL_DIR}/${model}.glb`, scene).catch((err: unknown) => {
        console.warn(`[survival] ${model}.glb unavailable:`, err);
        return null;
      });
      containers.set(model, p);
    }
    return p;
  };
  const ready = new Map<string, AssetContainer | null>();

  // ---- materials ---------------------------------------------------------------
  const unlit = (name: string, c: Color3, alpha: number) => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor = c;
    m.alpha = alpha;
    m.backFaceCulling = false;
    return m;
  };
  // Floor effects are painted once into small canvas textures (no per-frame
  // cost, no post-processing): a rune-ringed sigil for a telegraph, a soft
  // closing fill, chevrons for a charge line, a cracked ember bed and flame
  // tongues for burning ground, a glow sprite for projectiles.
  const fancy = qualityTier() !== "low";
  const tex = (name: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, wrap = false) => {
    const t = new DynamicTexture(name, { width: w, height: h }, scene, true);
    const g = t.getContext() as unknown as CanvasRenderingContext2D;
    g.clearRect(0, 0, w, h);
    draw(g, w, h);
    t.hasAlpha = true;
    t.update();
    if (wrap) t.wrapV = Texture.WRAP_ADDRESSMODE;
    return t;
  };
  const decalMat = (name: string, t: DynamicTexture, additive = false) => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveTexture = t;
    m.opacityTexture = t;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.backFaceCulling = false;
    if (additive) m.alphaMode = Constants.ALPHA_ADD;
    m.zOffset = -2;
    return m;
  };
  const sigil = (rgb: string, glow: string) => (g: CanvasRenderingContext2D, w: number) => {
    const c = w / 2;
    const bed = g.createRadialGradient(c, c, 0, c, c, c);
    bed.addColorStop(0, `rgba(${rgb},0.06)`);
    bed.addColorStop(0.75, `rgba(${rgb},0.16)`);
    bed.addColorStop(0.93, `rgba(${rgb},0.34)`);
    bed.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = bed;
    g.fillRect(0, 0, w, w);
    g.shadowColor = glow;
    g.shadowBlur = w * 0.03;
    g.strokeStyle = `rgba(${rgb},0.95)`;
    g.lineWidth = w * 0.022;
    g.beginPath(); g.arc(c, c, c * 0.93, 0, Math.PI * 2); g.stroke();
    // Inner rune ring: dashes and ticks, the "something is being cast" read.
    g.lineWidth = w * 0.01;
    g.setLineDash([w * 0.035, w * 0.02]);
    g.beginPath(); g.arc(c, c, c * 0.8, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r0 = c * (i % 3 === 0 ? 0.62 : 0.7);
      g.beginPath();
      g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      g.lineTo(c + Math.cos(a) * c * 0.76, c + Math.sin(a) * c * 0.76);
      g.stroke();
    }
  };
  const tTele = tex("svTeleTex", 256, 256, sigil("255,92,64", "rgba(255,60,30,0.9)"));
  const tFake = tex("svFakeTex", 256, 256, sigil("230,200,120", "rgba(240,210,120,0.6)"));
  const tFill = tex("svFillTex", 256, 256, (g, w) => {
    const c = w / 2;
    const f = g.createRadialGradient(c, c, 0, c, c, c);
    f.addColorStop(0, "rgba(255,40,20,0.15)");
    f.addColorStop(0.8, "rgba(255,60,30,0.45)");
    f.addColorStop(0.97, "rgba(255,170,120,0.85)");
    f.addColorStop(1, "rgba(255,170,120,0)");
    g.fillStyle = f;
    g.fillRect(0, 0, w, w);
  });
  // Charge lines: chevrons pointing the way the boss will come (V repeats along the strip).
  const tLine = tex("svLineTex", 128, 128, (g, w, h) => {
    g.fillStyle = "rgba(255,70,45,0.18)";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,120,90,0.9)";
    g.fillRect(0, 0, w * 0.06, h);
    g.fillRect(w * 0.94, 0, w * 0.06, h);
    g.strokeStyle = "rgba(255,110,80,0.75)";
    g.lineWidth = w * 0.07;
    g.beginPath(); g.moveTo(w * 0.2, h * 0.75); g.lineTo(w * 0.5, h * 0.35); g.lineTo(w * 0.8, h * 0.75); g.stroke();
  }, true);
  const tLineFill = tex("svLineFillTex", 64, 64, (g, w, h) => {
    const f = g.createLinearGradient(0, 0, w, 0);
    f.addColorStop(0, "rgba(255,150,110,0.8)");
    f.addColorStop(0.2, "rgba(255,50,30,0.4)");
    f.addColorStop(0.8, "rgba(255,50,30,0.4)");
    f.addColorStop(1, "rgba(255,150,110,0.8)");
    g.fillStyle = f;
    g.fillRect(0, 0, w, h);
  });
  // Burning ground: a cracked ember bed (seeded, so every burn matches), and flame tongues on top.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tBurn = tex("svBurnTex", 256, 256, (g, w) => {
    const c = w / 2;
    const bed = g.createRadialGradient(c, c, 0, c, c, c);
    bed.addColorStop(0, "rgba(255,170,60,0.75)");
    bed.addColorStop(0.55, "rgba(220,70,20,0.6)");
    bed.addColorStop(0.9, "rgba(120,20,8,0.45)");
    bed.addColorStop(1, "rgba(60,10,4,0)");
    g.fillStyle = bed;
    g.fillRect(0, 0, w, w);
    g.strokeStyle = "rgba(255,220,120,0.85)";
    g.shadowColor = "rgba(255,160,40,1)";
    g.shadowBlur = 6;
    for (let k = 0; k < 9; k++) {
      let a = rnd() * Math.PI * 2, r = c * 0.1;
      g.lineWidth = 1.5 + rnd() * 2.5;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      while (r < c * 0.85) { r += c * (0.08 + rnd() * 0.1); a += (rnd() - 0.5) * 0.6; g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r); }
      g.stroke();
    }
  });
  const tFlame = tex("svFlameTex", 256, 256, (g, w) => {
    const c = w / 2;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rnd() * 0.2;
      const r = c * (0.45 + rnd() * 0.4);
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      const f = g.createRadialGradient(x, y, 0, x, y, c * (0.12 + rnd() * 0.1));
      f.addColorStop(0, "rgba(255,230,140,0.9)");
      f.addColorStop(0.5, "rgba(255,120,30,0.5)");
      f.addColorStop(1, "rgba(255,60,10,0)");
      g.fillStyle = f;
      g.fillRect(0, 0, w, w);
    }
  });
  const glowTex = (name: string, core: string, mid: string) => tex(name, 64, 64, (g, w) => {
    const c = w / 2;
    const f = g.createRadialGradient(c, c, 0, c, c, c);
    f.addColorStop(0, core);
    f.addColorStop(0.35, mid);
    f.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = f;
    g.fillRect(0, 0, w, w);
  });
  // Heroes' damage zones and DoT marks: the party's colours (cyan, violet), never the enemy's red.
  const mZone = decalMat("svZone", tex("svZoneTex", 256, 256, sigil("90,220,255", "rgba(60,200,255,0.9)")), true);
  const mDotMark = decalMat("svDotMark", tex("svDotTex", 128, 128, sigil("200,130,255", "rgba(170,90,255,0.9)")), true);
  const mTele = decalMat("svTele", tTele);
  const mTeleFill = decalMat("svTeleFill", tFill);
  const mFake = decalMat("svFake", tFake); // the lie: visible, but quieter than the real hit
  mFake.alpha = 0.55;
  const mLine = decalMat("svLine", tLine);
  const mLineFill = decalMat("svLineFill", tLineFill);
  const mBurn = decalMat("svBurn", tBurn);
  const mFlame = decalMat("svFlame", tFlame, true);
  const mShock = decalMat("svShock", tex("svShockTex", 128, 128, (g, w) => {
    const c = w / 2;
    const f = g.createRadialGradient(c, c, c * 0.6, c, c, c);
    f.addColorStop(0, "rgba(255,120,80,0)");
    f.addColorStop(0.75, "rgba(255,190,140,0.9)");
    f.addColorStop(1, "rgba(255,120,80,0)");
    g.fillStyle = f;
    g.fillRect(0, 0, w, w);
  }), true);
  // Projectiles: a hot core, a violet glow sprite, a fading trail and a floor spot to read where it is.
  const mProj = unlit("svProj", new Color3(1, 0.85, 1), 1);
  const mProjGlow = decalMat("svProjGlow", glowTex("svProjGlowTex", "rgba(255,230,255,1)", "rgba(190,90,255,0.6)"), true);
  mProjGlow.zOffset = 0;
  mProjGlow.disableDepthWrite = true;
  const mProjSpot = decalMat("svProjSpot", glowTex("svProjSpotTex", "rgba(200,120,255,0.55)", "rgba(140,60,220,0.25)"), true);
  const mHp = unlit("svHp", new Color3(0.35, 1, 0.45), 1);
  const mFocus = unlit("svFocus", new Color3(0.35, 0.7, 1), 1);
  const mDefended = unlit("svDefended", new Color3(0.7, 0.4, 1), 0.65);
  const mDebuffed = unlit("svDebuffed", new Color3(0.35, 1, 0.5), 0.8);
  const mShadow = unlit("svShadow", new Color3(0.05, 0.05, 0.08), 0.55);

  // ---- monsters ----------------------------------------------------------------
  function makeBody(h: Hostile): Body | null {
    const pool = pools.get(h.model);
    const reuse = pool?.pop();
    if (reuse) {
      reuse.root.setEnabled(true);
      reuse.dyingT = 0;
      reuse.playing = "";
      return reuse;
    }
    const c = ready.get(h.model);
    if (!c) return null;
    const entries = c.instantiateModelsToScene((n) => `sv_${h.id}_${n}`);
    const inner = entries.rootNodes[0] as TransformNode | undefined;
    if (!inner) return null;
    const root = new TransformNode(`sv_body_${h.id}`, scene);
    root.metadata = { model: h.model }; // its pool on death
    const meshes = inner.getChildMeshes(false);
    for (const m of meshes) {
      m.isPickable = false;
      if (m.getTotalVertices() > 0) m.alwaysSelectAsActiveMesh = true;
    }
    const bounds = inner.getHierarchyBoundingVectors();
    const s = (HEIGHT[h.model] ?? 1.8) / Math.max(0.01, bounds.max.y - bounds.min.y);
    inner.scaling.scaleInPlace(s);
    // Hero canon (villageHub remote rigs, arenaHero): drop the glTF loader's
    // 180° root turn so the model faces -Z at yaw 0, like a hero. Keeping it
    // had every monster walking at the heroes with its back to them.
    inner.rotationQuaternion = null;
    // Rigid monsters (Dream Wisp, Falling Dream) are raw Tripo models, which
    // face +X; the rigged ones went through template_rig.py (Mixamo, +Z front).
    // A quarter turn maps the Tripo front onto the same -Z.
    inner.rotation.y = entries.skeletons.length === 0 ? Math.PI / 2 : 0;
    inner.position.set(0, -bounds.min.y * s, 0);
    inner.parent = root;
    const find = (k: string) => entries.animationGroups.find((g) => g.name.toLowerCase().includes(k));
    for (const g of entries.animationGroups) g.stop();
    const body: Body = {
      root, meshes,
      clips: { idle: find("idle"), walk: find("walk"), attack: find("attack"), death: find("death") },
      playing: "", ring: null, tag: null, lastX: h.x, lastZ: h.z, dyingT: 0,
    };
    // A blob shadow under every monster: cheap grounding without a shadow map.
    const shadow = MeshBuilder.CreateDisc(`sv_sh_${h.id}`, { radius: 0.36, tessellation: 16 }, scene);
    shadow.rotation.x = Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.scaling.setAll(h.kind === "boss" ? 3.2 : h.kind === "elite" ? 1.5 : 1);
    shadow.material = mShadow;
    shadow.parent = root;
    shadow.isPickable = false;
    return body;
  }

  function play(b: Body, name: "idle" | "walk" | "attack" | "death", loop: boolean): void {
    if (b.playing === name) return;
    const g = b.clips[name];
    if (!g) return;
    for (const c of Object.values(b.clips)) c?.stop();
    g.start(loop, name === "walk" ? 0.8 : 1);
    b.playing = name;
  }

  function eliteDressing(b: Body, h: Hostile): void {
    if (!b.ring) {
      b.ring = MeshBuilder.CreateTorus(`sv_ring_${h.id}`, { diameter: 1.9, thickness: 0.07, tessellation: 32 }, scene);
      b.ring.position.y = 0.06;
      b.ring.parent = b.root;
      b.ring.isPickable = false;
    }
    const debuffed = (h.debuffUntil ?? 0) > sim.t;
    const waned = sim.t - h.born > 40;
    b.ring.material = debuffed || waned ? mDebuffed : mDefended;
    if (h.ageTag && !b.tag) {
      // The Repressed carries its age tag: the cue for Freud's matching stage.
      const tex = new DynamicTexture(`sv_tagtex_${h.id}`, { width: 256, height: 64 }, scene, false);
      tex.hasAlpha = true;
      tex.drawText(AGE_LABEL[h.ageTag] ?? "", null, 44, "bold 34px Georgia", "#e8d0ff", "transparent", true);
      const mat = new StandardMaterial(`sv_tagmat_${h.id}`, scene);
      mat.diffuseTexture = tex;
      mat.emissiveColor = new Color3(1, 1, 1);
      mat.disableLighting = true;
      mat.useAlphaFromDiffuseTexture = true;
      b.tag = MeshBuilder.CreatePlane(`sv_tag_${h.id}`, { width: 1.8, height: 0.45 }, scene);
      b.tag.material = mat;
      b.tag.billboardMode = TransformNode.BILLBOARDMODE_ALL;
      b.tag.position.y = (HEIGHT[h.model] ?? 2.4) + 0.4;
      b.tag.parent = b.root;
      b.tag.isPickable = false;
    }
  }

  /** The Imitator wears what it learned: "NEXT: <skill>", or "watching…" until it has seen one. */
  function copyTag(b: Body, h: Hostile): void {
    const text = h.copyNext ? `NEXT: ${h.copyNext}` : (h.debuffUntil ?? 0) > sim.t ? "" : "watching…";
    if (!b.copyTag) {
      const tex = new DynamicTexture(`sv_copytex_${h.id}`, { width: 512, height: 64 }, scene, false);
      tex.hasAlpha = true;
      const mat = new StandardMaterial(`sv_copymat_${h.id}`, scene);
      mat.diffuseTexture = tex;
      mat.emissiveColor = new Color3(1, 1, 1);
      mat.disableLighting = true;
      mat.useAlphaFromDiffuseTexture = true;
      const mesh = MeshBuilder.CreatePlane(`sv_copytag_${h.id}`, { width: 3.2, height: 0.4 }, scene);
      mesh.material = mat;
      mesh.billboardMode = TransformNode.BILLBOARDMODE_ALL;
      mesh.position.y = (HEIGHT[h.model] ?? 2.4) + 0.4;
      mesh.parent = b.root;
      mesh.isPickable = false;
      b.copyTag = { mesh, tex, text: "\u0000" };
    }
    if (b.copyTag.text === text) return;
    b.copyTag.text = text;
    const ctx = b.copyTag.tex.getContext();
    ctx.clearRect(0, 0, 512, 64);
    b.copyTag.tex.drawText(text, null, 44, "bold 30px Georgia", h.copyNext ? "#ffb36b" : "#c9b8e8", "transparent", true);
    b.copyTag.mesh.setEnabled(text !== "");
  }

  function syncHostiles(dt: number): void {
    const seen = new Set<number>();
    for (const h of sim.hostiles) {
      seen.add(h.id);
      let b = live.get(h.id);
      if (!b) {
        const made = makeBody(h);
        if (!made) continue;
        b = made;
        b.lastX = h.x;
        b.lastZ = h.z;
        live.set(h.id, b);
      }
      const moved = Math.hypot(h.x - b.lastX, h.z - b.lastZ) / Math.max(dt, 1e-3);
      b.lastX = h.x;
      b.lastZ = h.z;
      // Falling dreams drop in; rigid models bob.
      let y = 0;
      if (h.def === "falling" && h.invulnerable) y = Math.max(0, h.stateT) * 9;
      else if (!b.clips.walk) y = 0.15 + Math.sin(sim.t * 3 + h.id) * 0.12;
      b.root.position.set(h.x, y, h.z);
      // The hero models face -Z at rest; monsters from the same rig do too.
      b.root.rotation.y = h.facing + Math.PI;
      const invisible = (h.invisibleUntil ?? 0) > sim.t;
      const vis = invisible ? 0.06 : h.twinOf ? 0.5 : 1;
      for (const m of b.meshes) m.visibility = vis;
      if (h.state === "windup") play(b, "attack", false);
      else if (moved > 0.3) play(b, "walk", true);
      else play(b, "idle", true);
      if (h.kind === "elite") eliteDressing(b, h);
      if (h.def === "imitator") copyTag(b, h);
      if (h.def === "tallglass") {
        // Same amount, different glass: tall and thin or squat and wide, the volume
        // kept (x·y·z = 1), which is the lesson.
        const goal = h.form === "tall" ? 1 : h.form === "wide" ? -1 : 0;
        b.pour = (b.pour ?? 1) + (goal - (b.pour ?? 1)) * Math.min(1, dt * 5);
        const k = b.pour;
        const sy = k >= 0 ? 1 + 0.25 * k : 1 + 0.28 * k;
        b.root.scaling.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
      }
      const dotted = !!(h.dots?.length || h.dotted);
      if (dotted && !b.dotMark) {
        const m = MeshBuilder.CreatePlane(`sv_dot_${h.id}`, { size: 1.5 }, scene);
        m.rotation.x = Math.PI / 2;
        m.position.y = 0.035;
        m.scaling.setAll(h.kind === "boss" ? 3.4 : h.kind === "elite" ? 1.6 : 1);
        m.material = mDotMark;
        m.isPickable = false;
        m.parent = b.root;
        b.dotMark = m;
      }
      if (b.dotMark) {
        b.dotMark.setEnabled(dotted);
        if (dotted) {
          b.dotMark.rotation.y += dt * 1.8;
          b.dotMark.visibility = 0.7 + 0.3 * Math.sin(sim.t * 8 + h.id);
        }
      }
    }
    for (const [id, b] of live) {
      if (seen.has(id)) continue;
      live.delete(id);
      play(b, "death", false);
      b.dyingT = b.clips.death ? 2.2 : 0.01;
      dying.push(b);
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const b = dying[i];
      b.dyingT -= dt;
      if (b.dyingT > 0) {
        if (!b.clips.death) b.root.scaling.scaleInPlace(0.9);
        continue;
      }
      dying.splice(i, 1);
      b.root.setEnabled(false);
      b.root.scaling.setAll(1);
      b.ring?.dispose();
      b.ring = null;
      b.tag?.dispose();
      b.tag = null;
      const key = (b.root.metadata as { model?: string } | null)?.model;
      if (key) {
        const pool = pools.get(key) ?? [];
        if (pool.length < 12) pool.push(b);
        else b.root.dispose();
        pools.set(key, pool);
      } else b.root.dispose();
    }
  }

  // ---- heroes' damage zones ---------------------------------------------------------
  const zoneMeshes = new Map<number, { m: Mesh; ticks: number }>();
  function syncZones(dt: number): void {
    const seen = new Set<number>();
    for (const zn of sim.zones) {
      seen.add(zn.id);
      let z = zoneMeshes.get(zn.id);
      if (!z) {
        const m = MeshBuilder.CreatePlane(`sv_zone_${zn.id}`, { size: zn.r * 2 }, scene);
        m.rotation.x = Math.PI / 2;
        m.position.set(zn.x, 0.045, zn.z);
        m.material = mZone;
        m.isPickable = false;
        z = { m, ticks: zn.ticksLeft };
        zoneMeshes.set(zn.id, z);
      }
      // A pulse on every tick, so the rhythm of the damage reads on the floor.
      if (zn.ticksLeft < z.ticks) { z.ticks = zn.ticksLeft; z.m.scaling.setAll(1.08); }
      const k = z.m.scaling.x;
      z.m.scaling.setAll(1 + (k - 1) * Math.max(0, 1 - dt * 6));
      z.m.rotation.y += dt * 0.5;
      z.m.visibility = zn.ticksLeft <= 1 ? 0.55 : 0.85;
    }
    for (const [id, z] of zoneMeshes) {
      if (seen.has(id)) continue;
      z.m.dispose();
      zoneMeshes.delete(id);
    }
  }

  // ---- hazards -------------------------------------------------------------------
  interface Decal { ring: Mesh; fill: Mesh | null; flame: Mesh | null; x: number; z: number; r: number; burn: boolean; fake: boolean }
  const decals = new Map<number, Decal>();
  /** Detonation shockwaves: a bright ring that races out and fades (0.4 s). */
  const shocks: Array<{ m: Mesh; t: number; r: number }> = [];
  function syncHazards(dt: number): void {
    const seen = new Set<number>();
    for (const hz of sim.hazards) {
      seen.add(hz.id);
      let d = decals.get(hz.id);
      if (!d) {
        d = makeDecal(hz);
        decals.set(hz.id, d);
      }
      if (hz.kind === "burn") {
        // Breathing embers; the flame layer turns slowly the other way. Fades out over its last second.
        const fade = Math.min(1, Math.max(0, hz.t));
        d.ring.visibility = (0.8 + Math.sin(sim.t * 5 + hz.id) * 0.15) * fade;
        d.ring.rotation.y += dt * 0.15;
        if (d.flame) {
          d.flame.rotation.y -= dt * 0.6;
          d.flame.visibility = (0.65 + Math.sin(sim.t * 9 + hz.id * 1.7) * 0.25) * fade;
          d.flame.scaling.setAll(1 + Math.sin(sim.t * 3 + hz.id) * 0.05);
        }
      } else {
        // The rune ring turns while it charges, and flashes in the last half second.
        const left = Math.max(0, hz.t);
        if (hz.kind !== "line") d.ring.rotation.y += dt * (left < 0.5 ? 2.4 : 0.6);
        if (!hz.fake) d.ring.visibility = left < 0.5 ? 0.75 + 0.25 * Math.abs(Math.sin(sim.t * 22)) : 1;
        if (d.fill) {
          // The fill grows to the edge as the telegraph runs out.
          const k = 1 - left / Math.max(0.01, hz.total);
          if (hz.kind === "line") d.fill.scaling.x = Math.max(0.02, k);
          else d.fill.scaling.setAll(Math.max(0.02, k));
        }
      }
    }
    for (const [id, d] of decals) {
      if (seen.has(id)) continue;
      if (!d.burn && !d.fake) shock(d.x, d.z, d.r);
      d.ring.dispose();
      d.fill?.dispose();
      d.flame?.dispose();
      decals.delete(id);
    }
    for (let i = shocks.length - 1; i >= 0; i--) {
      const sh = shocks[i];
      sh.t += dt;
      const k = sh.t / 0.4;
      sh.m.scaling.setAll(0.6 + k * 0.7);
      sh.m.visibility = Math.max(0, 1 - k);
      if (k >= 1) { sh.m.dispose(); shocks.splice(i, 1); }
    }
  }
  function shock(x: number, z: number, r: number): void {
    if (shocks.length > 12) return;
    const m = MeshBuilder.CreatePlane(`sv_shock`, { size: r * 2.2 }, scene);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, 0.06, z);
    m.material = mShock;
    m.isPickable = false;
    shocks.push({ m, t: 0, r });
  }

  function makeDecal(hz: Hazard): Decal {
    const flat = (name: string, size: number, mat: StandardMaterial, x: number, z: number, y: number) => {
      const p = MeshBuilder.CreatePlane(name, { size }, scene);
      p.rotation.x = Math.PI / 2;
      p.position.set(x, y, z);
      p.material = mat;
      p.isPickable = false;
      return p;
    };
    if (hz.kind === "line") {
      const len = Math.hypot(hz.x2! - hz.x, hz.z2! - hz.z);
      const yaw = Math.atan2(hz.x2! - hz.x, hz.z2! - hz.z);
      // One chevron per strip-width: the UVs tile the texture along the line.
      const reps = Math.max(1, Math.round(len / (hz.r * 2)));
      const mk = (name: string, mat: StandardMaterial, y: number) => {
        const uv = new Vector4(0, 0, 1, mat === mLine ? reps : 1);
        const p = MeshBuilder.CreatePlane(name, { width: hz.r * 2, height: len, sideOrientation: 2 /* Mesh.DOUBLESIDE */, frontUVs: uv, backUVs: uv }, scene);
        p.rotation.set(Math.PI / 2, yaw, 0);
        p.position.set((hz.x + hz.x2!) / 2, y, (hz.z + hz.z2!) / 2);
        p.material = mat;
        p.isPickable = false;
        return p;
      };
      const ring = mk(`sv_hz_${hz.id}`, mLine, 0.03);
      const fill = mk(`sv_hzf_${hz.id}`, mLineFill, 0.04);
      return { ring, fill, flame: null, x: (hz.x + hz.x2!) / 2, z: (hz.z + hz.z2!) / 2, r: hz.r, burn: false, fake: false };
    }
    const r = hz.displayR ?? hz.r;
    const burn = hz.kind === "burn";
    const ring = flat(`sv_hz_${hz.id}`, r * 2, burn ? mBurn : hz.fake ? mFake : mTele, hz.x, hz.z, 0.03);
    ring.rotation.y = hz.id;
    const base = { x: hz.x, z: hz.z, r, burn, fake: !!hz.fake };
    if (burn) {
      const flame = fancy ? flat(`sv_hzfl_${hz.id}`, r * 2.1, mFlame, hz.x, hz.z, 0.05) : null;
      return { ring, fill: null, flame, ...base };
    }
    if (hz.fake) return { ring, fill: null, flame: null, ...base };
    const fill = flat(`sv_hzf_${hz.id}`, hz.r * 2, mTeleFill, hz.x, hz.z, 0.04);
    return { ring, fill, flame: null, ...base };
  }

  // ---- floor labels: what each telegraph means, over the decal -----------------------
  const labelRoot = typeof document === "undefined" ? null : document.createElement("div");
  if (labelRoot) { labelRoot.id = "sv-labels"; document.body.appendChild(labelRoot); }
  const labels = new Map<number, HTMLSpanElement>();
  const tmp = new Vector3();
  function syncLabels(): void {
    if (!labelRoot) return;
    const cam = scene.activeCamera;
    if (!cam) return;
    const engine = scene.getEngine();
    const vp = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const scale = engine.getHardwareScalingLevel();
    const seen = new Set<number>();
    for (const hz of sim.hazards) {
      if (!hz.label) continue;
      seen.add(hz.id);
      let el = labels.get(hz.id);
      if (!el) {
        el = document.createElement("span");
        el.textContent = hz.label;
        el.className = hz.fake ? "fake" : hz.kind === "burn" ? "burn" : "";
        labelRoot.appendChild(el);
        labels.set(hz.id, el);
      }
      const x = hz.kind === "line" ? (hz.x + hz.x2!) / 2 : hz.x;
      const z = hz.kind === "line" ? (hz.z + hz.z2!) / 2 : hz.z;
      tmp.set(x, 0.4, z);
      const p = Vector3.Project(tmp, Matrix.Identity(), scene.getTransformMatrix(), vp);
      const behind = p.z < 0 || p.z > 1;
      el.style.display = behind ? "none" : "block";
      el.style.left = `${p.x * scale}px`;
      el.style.top = `${p.y * scale}px`;
    }
    for (const [id, el] of labels) if (!seen.has(id)) { el.remove(); labels.delete(id); }
  }

  // ---- Temple Square's fog walls ----------------------------------------------------
  const mGate = unlit("svGateFog", new Color3(0.42, 0.36, 0.62), 0.3);
  const gates = sim.map.bossGates.map((g, i) => {
    const w = Math.max(g.x1 - g.x0, g.z1 - g.z0);
    const m = MeshBuilder.CreatePlane(`sv_gate_${i}`, { width: w, height: 6 }, scene);
    m.position.set((g.x0 + g.x1) / 2, 3, (g.z0 + g.z1) / 2);
    m.rotation.y = g.x1 - g.x0 >= g.z1 - g.z0 ? 0 : Math.PI / 2;
    m.material = mGate;
    m.isPickable = false;
    m.setEnabled(false);
    return m;
  });
  function syncGates(): void {
    for (const g of gates) {
      g.setEnabled(sim.gatesClosed);
      if (sim.gatesClosed) g.visibility = 0.7 + Math.sin(sim.t * 2.2) * 0.15;
    }
  }

  // ---- the Invisible Gorilla's footprints: the only sign of where it walks -----------
  const mFoot = unlit("svFoot", new Color3(0.02, 0.02, 0.03), 0.8);
  const prints: Array<{ m: Mesh; t: number }> = [];
  let printT = 0;
  function syncFootprints(dt: number): void {
    printT -= dt;
    for (const h of sim.hostiles) {
      if ((h.invisibleUntil ?? 0) <= sim.t || printT > 0) continue;
      const side = prints.length % 2 ? 0.45 : -0.45;
      const m = MeshBuilder.CreateDisc(`sv_fp_${prints.length}`, { radius: 0.32, tessellation: 10 }, scene);
      m.rotation.x = Math.PI / 2;
      m.scaling.y = 1.6;
      m.position.set(h.x + Math.cos(h.facing) * side, 0.03, h.z - Math.sin(h.facing) * side);
      m.rotation.y = h.facing;
      m.material = mFoot;
      m.isPickable = false;
      prints.push({ m, t: 3 });
      printT = 0.45;
    }
    for (let i = prints.length - 1; i >= 0; i--) {
      prints[i].t -= dt;
      prints[i].m.visibility = Math.max(0, prints[i].t / 3);
      if (prints[i].t <= 0) { prints[i].m.dispose(); prints.splice(i, 1); }
    }
  }

  // ---- projectiles + pickups (small pools of primitives) --------------------------
  const projMeshes = new Map<number, { core: InstancedMesh; glow: InstancedMesh; spot: InstancedMesh; trail: InstancedMesh[] }>();
  const projCore = MeshBuilder.CreateSphere("sv_pr_core", { diameter: 1, segments: 8 }, scene);
  projCore.material = mProj;
  const projGlow = MeshBuilder.CreatePlane("sv_pr_glow", { size: 1 }, scene);
  projGlow.material = mProjGlow;
  projGlow.billboardMode = TransformNode.BILLBOARDMODE_ALL;
  const projSpot = MeshBuilder.CreatePlane("sv_pr_spot", { size: 1 }, scene);
  projSpot.rotation.x = Math.PI / 2;
  projSpot.material = mProjSpot;
  for (const m of [projCore, projGlow, projSpot]) { m.isPickable = false; m.isVisible = false; }
  const pickMeshes = new Map<number, Mesh | InstancedMesh>();
  /** Tripo pickup models (public/assets/survival/pickups); spheres until they load. */
  const pickModels: { hp: Mesh | null; focus: Mesh | null } = { hp: null, focus: null };
  function syncSmall(): void {
    const seenP = new Set<number>();
    for (const p of sim.projectiles) {
      seenP.add(p.id);
      let m = projMeshes.get(p.id);
      if (!m) {
        const inst = (src: Mesh, size: number) => {
          const i = src.createInstance(`sv_pr_${p.id}`);
          i.scaling.setAll(size);
          i.isPickable = false;
          if (src === projGlow) i.billboardMode = TransformNode.BILLBOARDMODE_ALL;
          return i;
        };
        m = {
          core: inst(projCore, p.r * 1.1),
          glow: inst(projGlow, p.r * 4.2),
          spot: inst(projSpot, p.r * 3),
          // A comet tail: smaller glows strung out behind (skipped on the low tier).
          trail: fancy ? [0.7, 0.5, 0.32].map((k) => inst(projGlow, p.r * 3.4 * k)) : [],
        };
        projMeshes.set(p.id, m);
      }
      const pulse = 1 + Math.sin(sim.t * 18 + p.id) * 0.12;
      m.core.position.set(p.x, 1.2, p.z);
      m.glow.position.set(p.x, 1.2, p.z);
      m.glow.scaling.setAll(p.r * 4.2 * pulse);
      m.spot.position.set(p.x, 0.05, p.z);
      const sp = Math.hypot(p.vx, p.vz) || 1;
      m.trail.forEach((t, i) => t.position.set(p.x - (p.vx / sp) * p.r * 1.3 * (i + 1), 1.2, p.z - (p.vz / sp) * p.r * 1.3 * (i + 1)));
    }
    for (const [id, m] of projMeshes) {
      if (seenP.has(id)) continue;
      for (const i of [m.core, m.glow, m.spot, ...m.trail]) i.dispose();
      projMeshes.delete(id);
    }
    const seenK = new Set<number>();
    for (const k of sim.pickups) {
      seenK.add(k.id);
      let m = pickMeshes.get(k.id);
      if (!m) {
        const big = k.kind === "bigHp" || k.kind === "bigFocus";
        const isHp = k.kind === "hp" || k.kind === "bigHp";
        const src = isHp ? pickModels.hp : pickModels.focus;
        if (src) {
          m = src.createInstance(`sv_pk_${k.id}`);
          m.scaling.setAll(big ? 1.6 : 1);
        } else {
          m = MeshBuilder.CreateSphere(`sv_pk_${k.id}`, { diameter: big ? 0.6 : 0.38, segments: 8 }, scene);
          m.material = isHp ? mHp : mFocus;
        }
        m.isPickable = false;
        pickMeshes.set(k.id, m);
      }
      m.position.set(k.x, 0.35 + Math.sin(sim.t * 4 + k.id) * 0.12, k.z);
      m.rotation.y = sim.t * 1.8 + k.id;
      m.visibility = k.life < 3 ? 0.4 + 0.6 * Math.abs(Math.sin(sim.t * 10)) : 1;
    }
    for (const [id, m] of pickMeshes) if (!seenK.has(id)) { m.dispose(); pickMeshes.delete(id); }
  }

  // ---- Recall Test circles --------------------------------------------------------
  let recallMeshes: Mesh[] = [];
  let recallOpen = false;
  function syncRecall(): void {
    const r = sim.recall;
    if (r && !recallOpen) {
      recallOpen = true;
      r.circles.forEach((c, i) => {
        const col = Color3.FromHexString(RECALL_COLORS[i]);
        const disc = MeshBuilder.CreateDisc(`sv_rc_${i}`, { radius: c.r, tessellation: 40 }, scene);
        disc.rotation.x = Math.PI / 2;
        disc.position.set(c.x, 0.05, c.z);
        disc.material = unlit(`sv_rcm_${i}`, col, 0.55);
        disc.isPickable = false;
        const tex = new DynamicTexture(`sv_rct_${i}`, { width: 128, height: 128 }, scene, false);
        tex.hasAlpha = true;
        tex.drawText(RECALL_LETTERS[i], null, 100, "bold 96px Georgia", RECALL_COLORS[i], "transparent", true);
        const lm = new StandardMaterial(`sv_rcl_${i}`, scene);
        lm.diffuseTexture = tex;
        lm.useAlphaFromDiffuseTexture = true;
        lm.disableLighting = true;
        lm.emissiveColor = new Color3(1, 1, 1);
        const label = MeshBuilder.CreatePlane(`sv_rcp_${i}`, { size: 1.4 }, scene);
        label.material = lm;
        label.billboardMode = TransformNode.BILLBOARDMODE_ALL;
        label.position.set(c.x, 2.2, c.z);
        label.isPickable = false;
        recallMeshes.push(disc, label);
      });
    } else if (!r && recallOpen) {
      recallOpen = false;
      for (const m of recallMeshes) { m.material?.dispose(true, true); m.dispose(); }
      recallMeshes = [];
    }
  }

  return {
    async preload() {
      // Pickup models: one source mesh each, instanced per orb, with a soft glow tint.
      const [hp, focus] = await Promise.all([
        loadVillageProp(scene, "/assets/survival/pickups/hp.glb", "sv_pickup_hp", { axis: "height", metres: 0.5 }),
        loadVillageProp(scene, "/assets/survival/pickups/focus.glb", "sv_pickup_focus", { axis: "height", metres: 0.55 }),
      ]);
      for (const [m, c] of [[hp, new Color3(0.15, 0.55, 0.2)], [focus, new Color3(0.15, 0.35, 0.8)]] as const) {
        if (!m) continue;
        m.isVisible = false;
        if (m.material instanceof PBRMaterial) m.material.emissiveColor = c;
      }
      pickModels.hp = hp;
      pickModels.focus = focus;
      // A hero with no elite of their own (Piaget, Bandura) draws a random one
      // (sim.spawnElite), so then every elite can show up and all must load.
      const heroes = new Set<string>(sim.players.map((p) => p.hero));
      const ownOnly = [...heroes].every((h) => ELITES.some((e) => e.hero === h));
      const models = [
        ...MINIONS.map((m) => m.model),
        ...ELITES.filter((e) => !ownOnly || heroes.has(e.hero)).map((e) => e.model),
        ...BOSSES.map((b) => b.model),
      ];
      await Promise.all(models.map(async (m) => ready.set(m, await container(m))));
    },
    sync(dt) {
      syncHostiles(dt);
      syncHazards(dt);
      syncZones(dt);
      syncSmall();
      syncRecall();
      syncLabels();
      syncGates();
      syncFootprints(dt);
    },
    aimPoint(h) {
      return new Vector3(h.x, (HEIGHT[h.model] ?? 1.8) * 0.6, h.z);
    },
    onDie() {},
    onAttack() {},
    dispose() {
      for (const b of [...live.values(), ...dying]) b.root.dispose();
      for (const pool of pools.values()) for (const b of pool) b.root.dispose();
      for (const d of decals.values()) { d.ring.dispose(); d.fill?.dispose(); d.flame?.dispose(); }
      for (const sh of shocks) sh.m.dispose();
      for (const z of zoneMeshes.values()) z.m.dispose();
      for (const m of projMeshes.values()) for (const i of [m.core, m.glow, m.spot, ...m.trail]) i.dispose();
      for (const m of [projCore, projGlow, projSpot, ...pickMeshes.values(), ...recallMeshes]) m.dispose();
      for (const p of prints) p.m.dispose();
      labelRoot?.remove();
      for (const g of gates) g.dispose();
    },
  };
}
