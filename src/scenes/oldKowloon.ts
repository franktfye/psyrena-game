/**
 * "Old Kowloon in the Fog": the survival-mode map (docs/survival-design.md §12).
 *
 * The geometry that matters — where you can walk — is shared data
 * (`shared/survival/map/oldKowloon.ts`). This file only DRESSES it:
 *   - block masses: one merged dark box per solid region. They are the
 *     backdrop between buildings and the stand-in if a model fails to load;
 *   - buildings: Meshy-generated tong lau variants, instanced along every
 *     stretch of block edge that faces a street (one draw call per variant,
 *     culled per instance, hidden past the fog);
 *   - landmarks, props, boundary (harbour water to the north, walls elsewhere);
 *   - the hero, clamped by the SAME boxes the server will clamp against.
 *
 * Reached lazily (`?scene=kowloon` for now; the survival queue later) — never a
 * static import from main.ts (CLAUDE.md rule 3).
 */
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/instancedMesh";

import { OLD_KOWLOON } from "@shared/survival/map/oldKowloon";
import { buildWalkGrid, solidBoxes, pushOut, type Rect } from "@shared/survival/map/layout";
import { frontageLots, rng } from "@shared/survival/map/lots";
import { applyDayEnvironment } from "../core/environment";
import { applyPipelineQuality, sceneGlowOptions, qualityTier } from "../core/quality";
import { warmupShaders } from "../core/warmup";
import { heroById } from "@shared/heroes";
import { startSurvivalRun, type SurvivalRun } from "../survival/run";
import { createPetSlot } from "./petFollower";
import { takePendingRun } from "../survival/pending";
import { buildKowloonFloor, createNeonSigns, buildLampGlows, buildBorderWalls } from "../survival/kowloonDressing";
import {
  buildFreud,
  createHeroController,
  createHeroVoice,
  createMaterials,
  loadVillageProp,
  type Ticker,
} from "./villageHub";

const MAP = OLD_KOWLOON;
const ASSET_DIR = "/assets/survival/kowloon";

// ---- Look ---------------------------------------------------------------------
/** Grey-blue harbour fog: the map is 110 m and fog is what hides its edges. */
const FOG = new Color3(0.56, 0.6, 0.64);
/**
 * Exponential-squared: clear around the fight, then a fast wall. At 0.018 a
 * facade 20 m away keeps ~88 % of itself, 40 m ~60 %, 70 m ~20 %, 85 m ~10 %.
 */
const FOG_DENSITY = 0.018;
/** Buildings past this (from the camera target) are hidden: fully fogged anyway. */
const DRAW_DIST = 85;

// ---- Buildings ------------------------------------------------------------------
interface Variant {
  id: string;
  /** Storey height of the variant, metres. */
  height: number;
  /** Lot widths this variant suits. */
  minLot: number;
  maxLot: number;
  /** Model-local yaw so the facade faces +Z before placement (measured per model). */
  yaw: number;
}

const FRONTAGE: Variant[] = [
  { id: "tonglau_mid_a", height: 16, minLot: 7, maxLot: 11, yaw: 0 },
  { id: "tonglau_mid_b", height: 18, minLot: 7, maxLot: 11, yaw: 0 },
  { id: "tonglau_scaffold", height: 15, minLot: 7, maxLot: 11, yaw: 0 },
  { id: "tonglau_wide", height: 12, minLot: 10, maxLot: 14, yaw: 0 },
  { id: "shophouse_pawn", height: 10, minLot: 7, maxLot: 10, yaw: 0 },
  { id: "tonglau_corner", height: 15, minLot: 8, maxLot: 12, yaw: 0 },
];
const CORNER: Variant = { id: "tonglau_corner", height: 15, minLot: 8, maxLot: 12, yaw: 0 };
/** How deep a frontage building reaches into its block. */
const LOT_DEPTH = 11;

/** Landmarks sit on reserved lots; generic frontage skips these rects. */
const LANDMARKS: Array<{ id: string; rect: Rect; height: number; facing: "n" | "s" | "e" | "w"; yaw: number }> = [
  // Tin Hau temple on the west side of Temple Square, doors facing the square.
  { id: "temple", rect: { x0: -29, x1: -17, z0: -6, z1: 10 }, height: 9, facing: "e", yaw: 0 },
  // Wet-market hall closing the east side of the Wet Market square.
  { id: "wet_market", rect: { x0: 49, x1: 55, z0: -10, z1: 10 }, height: 9, facing: "w", yaw: 0 },
];

/** Obstacles from the map data, dressed with their model (sized to the rect). */
const OBSTACLE_MODELS: Record<string, { id: string; height: number; yaw: number }> = {
  "Banyan NW": { id: "banyan", height: 9, yaw: 0 },
  "Banyan NE": { id: "banyan", height: 9, yaw: Math.PI / 2 },
  "Tram Shelter": { id: "tram_shelter", height: 4, yaw: 0 },
  Tram: { id: "tram", height: 4.6, yaw: 0 },
  Minibus: { id: "minibus", height: 2.4, yaw: 0 },
};

/** Street furniture: [model, height m, collider radius m (0 = walk-through/wall-mounted)]. */
const KERB_PROPS: Array<[string, number, number]> = [
  ["oil_drum", 0.95, 0.4],
  ["baskets", 1.3, 0.6],
  ["postbox", 1.6, 0.35],
  ["kiosk", 2.6, 1.0],
  ["laundry_rack", 2.2, 0.6],
  ["daipaidong", 2.6, 1.3],
  ["stall_veg", 2.4, 1.2],
];

// ---- Scene ------------------------------------------------------------------------

export async function createOldKowloon(engine: AbstractEngine, heroId?: string, username?: string): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(FOG.r, FOG.g, FOG.b, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = FOG.clone();
  scene.fogDensity = FOG_DENSITY;
  // Overcast: the day IBL, dimmed, so PBR models are not black but nothing glints.
  await applyDayEnvironment(scene, 0.6);

  const camera = new ArcRotateCamera("kowloonCam", -Math.PI / 2, Math.PI / 3.1, 7, new Vector3(MAP.start.x, 1.6, MAP.start.z), scene);
  camera.lowerRadiusLimit = 2.2;
  camera.upperRadiusLimit = 16;
  camera.upperBetaLimit = Math.PI / 2 - 0.05;
  camera.minZ = 0.4;
  camera.maxZ = DRAW_DIST + 25;
  camera.wheelDeltaPercentage = 0.05;
  camera.panningSensibility = 0;
  camera.attachControl(true);

  const sky = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  sky.intensity = 0.55;
  sky.diffuse = new Color3(0.7, 0.75, 0.82);
  sky.groundColor = new Color3(0.25, 0.27, 0.3);
  const key = new DirectionalLight("key", new Vector3(0.3, -0.9, 0.35), scene);
  key.intensity = 1.9;
  key.diffuse = new Color3(0.92, 0.9, 0.86);

  // Sky: a fog-tinted dome INSIDE the fog. The clear colour skips the tone
  // mapping fogged geometry gets, so bare sky read as a bright hole at every
  // street end; a fully-fogged dome is graded exactly like a fogged facade.
  const dome = MeshBuilder.CreateSphere("kowloonSky", { diameter: (DRAW_DIST + 15) * 2, segments: 12, sideOrientation: Mesh.BACKSIDE }, scene);
  const domeMat = new StandardMaterial("kowloonSkyMat", scene);
  domeMat.disableLighting = true;
  domeMat.emissiveColor = FOG.clone();
  dome.material = domeMat;
  dome.isPickable = false;
  scene.onBeforeRenderObservable.add(() => dome.position.copyFrom(camera.position));

  const mats = createMaterials(scene);
  const grid = buildWalkGrid(MAP);
  const boxes = solidBoxes(grid);
  // Blocks are the solid boxes that are NOT obstacles: obstacles (tram, banyans)
  // collide like walls but get their own model, never a mass or building lots.
  const inObstacle = (b: Rect) =>
    MAP.obstacles.some((o) => b.x0 >= o.x0 - 0.01 && b.x1 <= o.x1 + 0.01 && b.z0 >= o.z0 - 0.01 && b.z1 <= o.z1 + 0.01);
  const blocks = boxes.filter((b) => !inObstacle(b));

  // ---- Ground: asphalt + paving come from kowloonDressing once the lots exist ----
  const ground = MeshBuilder.CreateGround("kowloonGround", { width: MAP.half * 2, height: MAP.half * 2 }, scene);
  ground.freezeWorldMatrix();

  // ---- Block masses: one merged mesh -----------------------------------------
  const massMat = new PBRMaterial("kowloonMass", scene);
  massMat.albedoColor = new Color3(0.3, 0.31, 0.3);
  massMat.metallic = 0;
  massMat.roughness = 0.95;
  // Interiors only: inset well behind the frontage buildings. A mass reaching
  // the street hides every facade detail recessed more than its inset (Meshy
  // balconies and arcades are a metre deep), which turned the streets into
  // flat grey walls.
  const MASS_INSET = LOT_DEPTH - 1;
  const massParts = blocks.flatMap((b, i) => {
    const w = b.x1 - b.x0 - 2 * MASS_INSET;
    const d = b.z1 - b.z0 - 2 * MASS_INSET;
    if (w < 1 || d < 1) return [];
    const h = 9;
    const m = MeshBuilder.CreateBox(`mass${i}`, { width: w, depth: d, height: h }, scene);
    m.position.set((b.x0 + b.x1) / 2, h / 2, (b.z0 + b.z1) / 2);
    return [m];
  });
  const masses = massParts.length ? Mesh.MergeMeshes(massParts, true, true) : null;
  if (masses) {
    masses.name = "kowloonMasses";
    masses.material = massMat;
    masses.freezeWorldMatrix();
  }

  // ---- Boundary: harbour water north, walls on the other three sides ----------
  const water = MeshBuilder.CreateGround("kowloonWater", { width: 260, height: 120 }, scene);
  water.position.set(0, -0.6, MAP.half + 60);
  const waterMat = new PBRMaterial("kowloonWaterMat", scene);
  waterMat.albedoColor = new Color3(0.12, 0.16, 0.18);
  waterMat.metallic = 0.2;
  waterMat.roughness = 0.15;
  water.material = waterMat;
  // Graffiti walls on every edge (a low sea wall on the harbour side).
  buildBorderWalls(scene, MAP.half);

  // ---- Buildings ------------------------------------------------------------------
  const sources = new Map<string, Mesh | null>();
  const loading = new Map<string, Promise<Mesh | null>>();
  function source(id: string, height: number, yaw: number): Promise<Mesh | null> {
    // Cache the PROMISE: two parallel requests for one model must share a load.
    let p = loading.get(id);
    if (!p) {
      p = loadVillageProp(scene, `${ASSET_DIR}/${id}.glb`, `kw_${id}`, { axis: "height", metres: height }, yaw).then((m) => {
        if (m) m.isVisible = false; // the source only feeds instances
        sources.set(id, m);
        return m;
      });
      loading.set(id, p);
    }
    return p;
  }
  // Load every model once up front, in parallel.
  await Promise.all([
    ...FRONTAGE.map((v) => source(v.id, v.height, v.yaw)),
    source(CORNER.id, CORNER.height, CORNER.yaw),
    ...LANDMARKS.map((l) => source(l.id, l.height, l.yaw)),
    ...Object.values(OBSTACLE_MODELS).map((o) => source(o.id, o.height, o.yaw)),
    ...KERB_PROPS.map(([id, h]) => source(id, h, 0)),
    source("streetlamp", 5.2, 0),
    source("neon_frame", 4, 0),
  ]);

  const instances: InstancedMesh[] = [];
  /** Instance `src` scaled to a w × d footprint (its own height kept), yawed, at x/z. */
  function place(src: Mesh, name: string, x: number, z: number, w: number, d: number, yaw: number, y = 0): InstancedMesh {
    const bb = src.getBoundingInfo().boundingBox;
    const sw = bb.maximum.x - bb.minimum.x || 1;
    const sd = bb.maximum.z - bb.minimum.z || 1;
    const inst = src.createInstance(name);
    inst.scaling.set(w / sw, 1, d / sd);
    inst.rotation.y = yaw;
    // Model origin is not guaranteed at the footprint centre: offset by the bbox centre.
    const cx = (bb.maximum.x + bb.minimum.x) / 2 * inst.scaling.x;
    const cz = (bb.maximum.z + bb.minimum.z) / 2 * inst.scaling.z;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    inst.position.set(x - (cx * c + cz * s), y - bb.minimum.y, z - (-cx * s + cz * c));
    inst.freezeWorldMatrix();
    instances.push(inst);
    return inst;
  }

  const rand = rng(1997);
  const lots = frontageLots(grid, blocks, LANDMARKS.map((l) => l.rect), LOT_DEPTH);
  const signs = createNeonSigns(scene);
  buildKowloonFloor(scene, MAP, lots, ground);
  const frontage = FRONTAGE.filter((v) => sources.get(v.id));
  const propColliders: Array<{ x: number; z: number; r: number }> = [];
  for (const [i, lot] of lots.entries()) {
    const variant = lot.corner && sources.get(CORNER.id)
      ? CORNER
      : (() => {
          const fit = frontage.filter((v) => lot.len >= v.minLot - 1 && lot.len <= v.maxLot + 2);
          const pool = fit.length ? fit : frontage;
          return pool[Math.floor(rand() * pool.length)];
        })();
    const src = variant ? sources.get(variant.id) : null;
    if (!src) continue;
    // Footprint in world axes: the model's x is the frontage, z the depth.
    place(src, `kw_bld${i}`, lot.x, lot.z, lot.len - 0.2, lot.depth - 0.2, lot.yaw);

    // Dressing in front of some lots, kept within 1.6 m of the facade so the
    // street stays open for fighting.
    const fx = Math.sin(lot.yaw);
    const fz = Math.cos(lot.yaw);
    const faceX = lot.x + fx * (lot.depth / 2);
    const faceZ = lot.z + fz * (lot.depth / 2);
    const neon = sources.get("neon_frame");
    if (neon && !lot.corner && rand() < 0.45) {
      const off = (rand() - 0.5) * (lot.len * 0.5);
      const nx = faceX + fx * 0.6 + fz * off;
      const nz = faceZ + fz * 0.6 - fx * off;
      const ny = 4 + rand() * 4;
      place(neon, `kw_neon${i}`, nx, nz, 1.2, 0.6, lot.yaw + Math.PI / 2, ny);
      // The frame ships blank; the face is ours (real characters, emissive).
      signs.place(nx, ny + 2, nz, lot.yaw + Math.PI / 2, Math.floor(rand() * 1000));
    }
    if (rand() < 0.3) {
      const [id, , r] = KERB_PROPS[Math.floor(rand() * KERB_PROPS.length)];
      const prop = sources.get(id);
      if (prop) {
        const off = (rand() - 0.5) * (lot.len * 0.6);
        const px = faceX + fx * 1.2 + fz * off;
        const pz = faceZ + fz * 1.2 - fx * off;
        const bb = prop.getBoundingInfo().boundingBox;
        place(prop, `kw_prop${i}`, px, pz, bb.maximum.x - bb.minimum.x, bb.maximum.z - bb.minimum.z, lot.yaw + rand() * 0.6 - 0.3);
        if (r > 0) propColliders.push({ x: px, z: pz, r });
      }
    }
  }

  for (const l of LANDMARKS) {
    const src = sources.get(l.id);
    if (!src) continue;
    const yaw = { n: 0, s: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }[l.facing];
    const along = l.facing === "n" || l.facing === "s" ? l.rect.x1 - l.rect.x0 : l.rect.z1 - l.rect.z0;
    const deep = l.facing === "n" || l.facing === "s" ? l.rect.z1 - l.rect.z0 : l.rect.x1 - l.rect.x0;
    place(src, `kw_${l.id}`, (l.rect.x0 + l.rect.x1) / 2, (l.rect.z0 + l.rect.z1) / 2, along, deep, yaw);
  }

  for (const o of MAP.obstacles) {
    const spec = OBSTACLE_MODELS[o.name];
    const src = spec ? sources.get(spec.id) : null;
    const w = o.x1 - o.x0;
    const d = o.z1 - o.z0;
    if (src) {
      // Long axis of the rect is the model's long axis (x).
      const yaw = w >= d ? 0 : Math.PI / 2;
      place(src, `kw_${o.name}`, (o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2, Math.max(w, d), Math.min(w, d), yaw + (spec?.yaw ?? 0));
    } else {
      const m = MeshBuilder.CreateBox(`kw_${o.name}`, { width: w, depth: d, height: 2.5 }, scene);
      m.position.set((o.x0 + o.x1) / 2, 1.25, (o.z0 + o.z1) / 2);
      m.material = massMat;
    }
  }

  // Street lamps down both kerbs of the main road and the cross street.
  signs.done();
  const lamp = sources.get("streetlamp");
  const lampSpots: Array<{ x: number; z: number }> = [];
  if (lamp) {
    const boss = MAP.squares.find((s) => s.role === "boss");
    let k = 0;
    for (let z = -50; z <= 42; z += 14) {
      if (boss && z > boss.z0 && z < boss.z1) continue;
      for (const x of [-6.3, 6.3]) { place(lamp, `kw_lamp${k++}`, x, z, 0.6, 0.6, x < 0 ? Math.PI / 2 : -Math.PI / 2); lampSpots.push({ x, z }); }
    }
    for (let x = -50; x <= 50; x += 14) {
      if (Math.abs(x) < 8) continue;
      for (const z of [20.7, 31.3]) { place(lamp, `kw_lamp${k++}`, x, z, 0.6, 0.6, z < 26 ? 0 : Math.PI); lampSpots.push({ x, z }); }
    }
    buildLampGlows(scene, lampSpots, 4.95);
  }

  // ---- Distance culling: everything past the fog stops drawing -----------------
  let cullT = 0;
  const cull: Ticker = {
    tick: () => {
      cullT += scene.getEngine().getDeltaTime() / 1000;
      if (cullT < 0.25) return;
      cullT = 0;
      const t = camera.target;
      const lim2 = DRAW_DIST * DRAW_DIST;
      for (const inst of instances) {
        const dx = inst.position.x - t.x;
        const dz = inst.position.z - t.z;
        inst.isVisible = dx * dx + dz * dz < lim2;
      }
    },
  };

  // ---- Hero, clamped by the shared map boxes -------------------------------------
  const hero = await buildFreud(scene, mats, { castStyle: "fight", heroId });
  hero.node.position.set(MAP.start.x, 0, MAP.start.z);
  const voice = createHeroVoice(heroId);
  scene.onDisposeObservable.add(() => voice.dispose());
  // A Dream Siege run, if one was asked for (dock button / village portal /
  // ?survival=). Without one the map is a free walk.
  const pendingRun = takePendingRun();
  const prev = hero.node.position.clone();
  let run: SurvivalRun | null = null;
  const clamp = (p: Vector3): void => {
    run?.constrain(p, prev);
    pushOut(p, 0.4, boxes, MAP.half);
    for (const c of propColliders) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const rr = c.r + 0.4;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x += (dx / d) * (rr - d);
        p.z += (dz / d) * (rr - d);
      }
    }
  };
  const tickers: Ticker[] = [
    { tick: () => prev.copyFrom(hero.node.position) },
    { tick: hero.tick },
    createHeroController(scene, camera, hero, mats, [], voice, clamp),
    cull,
    cameraPullIn(camera, boxes),
    // The equipped pet comes into the fog too (its stats ride the run's loadout, survival/run.ts).
    createPetSlot(scene, hero, heroById(heroId).id),
  ];
  if (pendingRun) {
    run = await startSurvivalRun({
      scene, camera, hero, voice, mats, kit: heroById(heroId), difficulty: pendingRun.difficulty, party: pendingRun.party, username,
      // Out of the frame first: go() disposes this scene synchronously.
      leave: () => queueMicrotask(() => {
        const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
        void psy?.go?.("village");
      }),
    });
    let last = performance.now();
    tickers.push({
      tick: () => {
        const now = performance.now();
        run?.tick(Math.min(0.1, (now - last) / 1000));
        last = now;
      },
    });
    scene.onDisposeObservable.add(() => run?.dispose());
  }
  let clock = 0;
  scene.onBeforeRenderObservable.add(() => {
    clock += engine.getDeltaTime() / 1000;
    for (const t of tickers) t.tick(clock);
  });

  // ---- Post: overcast grade; neon glow only where the tier allows ---------------
  const glowOptions = sceneGlowOptions();
  if (glowOptions) {
    const glow = new GlowLayer("glow", scene, glowOptions);
    glow.intensity = 0.7;
    // The sky dome is emissive only so fog can grade it; it must not glow.
    glow.addExcludedMesh(dome);
  }
  const pipeline = new DefaultRenderingPipeline("post", true, scene, [camera]);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = qualityTier() !== "low";
  pipeline.bloomThreshold = 0.85;
  pipeline.bloomWeight = 0.35;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 1.0;
  pipeline.imageProcessing.contrast = 1.1;
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 1.2;
  pipeline.imageProcessing.vignetteColor = new Color4(0.2, 0.22, 0.26, 1);
  applyPipelineQuality(pipeline);

  await warmupShaders(scene);
  return scene;
}

/**
 * Keep the camera out of the buildings. Tall walls line 9 m streets, so an
 * orbit that swings behind a block would show its inside. Each frame, march
 * the hero → camera ray over the solid boxes on the ground plane and pull the
 * radius in to just short of the first wall the ray meets below roof height.
 */
function cameraPullIn(camera: ArcRotateCamera, boxes: Rect[]): Ticker {
  let wanted = camera.radius;
  let lastSet = camera.radius;
  return {
    tick: () => {
      // A user zoom (wheel/pinch) changes the radius we did not set: adopt it.
      if (Math.abs(camera.radius - lastSet) > 1e-3) wanted = camera.radius;
      const t = camera.target;
      const dir = camera.position.subtract(t).normalize();
      let hit = wanted;
      for (let s = 0.5; s < wanted; s += 0.25) {
        const x = t.x + dir.x * s;
        const y = t.y + dir.y * s;
        const z = t.z + dir.z * s;
        if (y > 9) break; // above the block masses' roofline: clear
        if (boxes.some((b) => x > b.x0 + 0.3 && x < b.x1 - 0.3 && z > b.z0 + 0.3 && z < b.z1 - 0.3)) {
          hit = Math.max(camera.lowerRadiusLimit ?? 1.5, s - 0.4);
          break;
        }
      }
      camera.radius = hit;
      lastSet = hit;
    },
  };
}
