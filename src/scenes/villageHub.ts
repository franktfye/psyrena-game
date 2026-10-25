import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
// Side-effect import: registers the scene component ShadowGenerator's
// constructor looks up. Nothing else pulls it in since the pet-slot rework
// trimmed the import graph — without it the village dies at boot with
// "ShadowGeneratorSceneComponent needs to be imported before…".
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
// Side-effect import: installs Camera.prototype.getForwardRay, which the hero
// controller calls on the first movement frame. Without it the WebGL2 path
// throws "Ray needs to be imported before..." inside the render loop and the
// whole tab freezes — the WebGPU engine happens to pull Ray in transitively,
// so localhost dev (WebGPU) never sees this. Do not remove.
import "@babylonjs/core/Culling/ray";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { ImportMeshAsync, LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Bone } from "@babylonjs/core/Bones/bone";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Node } from "@babylonjs/core/node";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

// Tree-shaken shape builders must be imported explicitly.
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import "@babylonjs/core/Meshes/Builders/latheBuilder";

import { HUB } from "../core/budget";
import { PALETTE, VILLAGE, VILLAGE_DAY } from "../core/palette";
import { warmupShaders } from "../core/warmup";
import { trackLoad } from "../core/loadProgress";
import { applyDayEnvironment } from "../core/environment";
import { ActionBar, type BarSlotDef } from "../ui/actionBar";
import { showCastWarning } from "../ui/castWarning";
import { TouchStick, STICK_RUN_AT } from "../ui/touchStick";
import { detectControlScheme, uiScale, isTypingInField } from "../ui/inputMode";
import { wireBasicAttack } from "../fight/basicAttack";
import { MODELED_HEROES, SKILL_ICON_HEROES, stanceKey } from "../fight/arenaHero";
import { player } from "../state/player";
import {
  basicProjectileStyle,
  createHeroSkillVfx,
  paletteTint,
  paletteDressing,
  ultimateTint,
  ultimateDressing,
  type HeroSkillVfx,
} from "../vfx/heroCasts";
import type { FreudCastKind } from "../vfx/freudCasts";
import { createCastProjectiles, type CastProjectiles } from "../vfx/projectiles";
import { buildBlackHolePortal } from "../vfx/blackHolePortal";
import { openRoomsPanel, closeRoomsPanel, configureRoomsPanel } from "../ui/roomsPanel";
import { setPracticeMode } from "../fight/practice";
import { buildSurvivalGate } from "./survivalPortal";
import { enterRankedArena } from "../fight/arenaEntry";
import { STAGE_DETAIL } from "../ui/heroLore";
import { overTimeText, reachText } from "../ui/skillText";
import { openPracticePitIntro } from "../ui/practicePit";
import { isVoiceMuted } from "../ui/heroCodex";
import { bindOstPlayer } from "../state/musicSettings";
import { playCastSfx, playImpactSfx } from "../state/sfx";
import { openShopPanel } from "../ui/shopPanel";
import { openCoffeePanel, closeCoffeePanel } from "../ui/coffeeShopPanel";
import { openSkinPanel } from "../ui/skinPanel";
import { openPetPanel } from "../ui/petPanel";
import { openHallPanel } from "../ui/hallPanel";
import { openLootInventory, setCacheOpenedListener } from "../ui/lootPanel";
import { getEconomy } from "../net/economy";
import { refreshStance } from "../ui/playerHud";
import { syncPotionBuffs } from "../state/potions";
import { syncLoadout } from "../state/loadout";
import { wardrobe } from "../state/wardrobe";
import type { Profile } from "../ui/authFlow";
import { VillageClient, type VillagePlayer } from "../net/village";
import { showPlayerCard } from "../ui/playerCard";
import {
  PET_PARK_ROSTER, createPetSlot, createPetFollower, petForHero, type PetHandle,
} from "./petFollower";
import { FREUD } from "@shared/heroes/freud";
import { heroById } from "@shared/heroes";
import type { Hero, PaletteEntry } from "@shared/types";
import { BEAT_PERIOD_S, heroHeightM } from "@shared/combat";
import {
  castAddon,
  castLifeStage,
  castVirtue,
  lifeReview,
  psychosocialStart,
  type PsychosocialHudState,
  type PsychosocialState,
} from "@shared/fight/psychosocial";
import { psychosocialFaces } from "../ui/psychosocialFaces";
import { stageBannerFor } from "../ui/stageBanner";
import { applyPipelineQuality, sceneGlowOptions } from "../core/quality";
import { audioUrl } from "../core/audio";

/**
 * The Village Hub — Psyrena's social scene and the first thing a player sees.
 *
 * Reference art: `assets/concept/village/` — V1 (aerial) is the blockout
 * authority, V3 (plaza dusk) is the colour script. Per the manifest, V2's
 * storefront lettering is deliberately NOT reproduced: readable text in the
 * concept never reaches the game. Function signage is procedural abstract
 * glyphs (DynamicTexture, no letters) tinted with each facility's accent.
 * One sanctioned exception (2026-08-01): the small floating name-tags over
 * NPC heads (`buildNameTag`) — they label a character's FUNCTION for the
 * player, which is UI, not concept-art branding.
 *
 * WHY THE HUB IS BUILT LIKE THIS
 * ------------------------------
 * The hub is where the budget goes to die if you let it. No gameplay happens
 * here, yet it is the one place with up to `HUB.maxPlayers` skinned characters
 * wearing unique cosmetics — the single largest draw-call and memory item in
 * the game (see `07-open-design-issues.md#p-2-hub-population-cap`). So the
 * geometry rules are stricter here than in the arena, not looser:
 *
 *  - ONE ring of eight facades around a plaza. Nothing outside `HUB.fogEnd`.
 *  - Repeated props (trees, benches, bollards, crowd) are hardware INSTANCES:
 *    N copies cost one draw call and one copy of the vertex data.
 *  - Every static mesh is `freezeWorldMatrix()`d — the hub's transforms never
 *    change, so paying to recompute them 60x a second is pure waste.
 *  - THREE real-time lights, total. Every warm pool of light on the pavement is
 *    an emissive disc, not a point light. Emissive + bloom is free; lights are
 *    not, and they multiply shader permutations across every material.
 *
 * Layout, scale and colour script are locked; plaza props and the nine-piece
 * facade kit (see `assets/work/village/README.md`) replace the crude stand-ins
 * via `loadVillageProp` + `placeMany`. Remaining primitives are intentional —
 * shells, emissive glass, holo interiors — or fallbacks if a glb is missing.
 */

/** Plaza radius — the open, walkable centre. Facades start beyond this. */
const PLAZA_RADIUS = 15;

/** Facade ring radius, from plaza centre to building front. */
const RING_RADIUS = 23;

type FacilityId =
  | "outfitter"
  | "style-lab"
  | "pet-park"
  | "hall-of-minds"
  | "queue-terminal"
  | "practice-booth"
  | "coffee-shop"
  | "residential";

/**
 * Where the perpendicular kit sign plate ended up, facility-local, so the
 * glyph planes can mount on its faces. `x`/`z` locate the plate centre,
 * `centreY` its vertical middle, `halfThickness` half its post-yaw depth.
 */
interface SignPlateMount {
  x: number;
  z: number;
  centreY: number;
  halfThickness: number;
}

interface Facility {
  id: FacilityId;
  /** Player-facing name (doc 01 hub facility table). Not rendered — no text in 3D. */
  label: string;
  /** Bearing around the plaza, degrees. 0 = +Z (north in the V1 aerial). */
  bearing: number;
  width: number;
  depth: number;
  height: number;
  /** Storefront glow. The building's identity colour at a distance. */
  accent: Color3;
  /** Pale marble shell instead of charcoal — Hall of Minds only. */
  marble?: boolean;
  /** Open-air: turf + fence, no shell (Pet Park). */
  openAir?: boolean;
}

/**
 * The eight-facade ring. Doc 01 lists six facilities plus a coffee shop; the
 * eighth is a residential block that closes the last gap so the plaza reads as
 * an enclosed city block rather than a set of props on a plate.
 *
 * Bearings are spaced to match V1's arrangement, not evenly — the aerial puts
 * the retail cluster (Outfitter + Style Lab) shoulder to shoulder on one side
 * and gives the Hall of Minds a wide frontage of its own.
 */
const FACILITIES: Facility[] = [
  { id: "outfitter", label: "Outfitter", bearing: 20, width: 14, depth: 10, height: 8.5, accent: VILLAGE.magenta },
  { id: "style-lab", label: "Style Lab", bearing: 62, width: 12, depth: 10, height: 7.5, accent: VILLAGE.magenta },
  { id: "pet-park", label: "Pet Park", bearing: 105, width: 15, depth: 12, height: 0, accent: PALETTE.cyan, openAir: true },
  { id: "queue-terminal", label: "Queue Terminal", bearing: 148, width: 13, depth: 11, height: 7, accent: PALETTE.cyan },
  { id: "hall-of-minds", label: "Hall of Minds", bearing: 200, width: 18, depth: 12, height: 10, accent: PALETTE.cyan, marble: true },
  { id: "practice-booth", label: "Practice Booth", bearing: 245, width: 9, depth: 8, height: 0, accent: PALETTE.violet, openAir: true },
  { id: "coffee-shop", label: "Coffee Shop", bearing: 288, width: 13, depth: 10, height: 6.5, accent: VILLAGE.warmLight },
  { id: "residential", label: "Residential", bearing: 330, width: 14, depth: 11, height: 11, accent: VILLAGE.shellLight },
];

/** Shared material set. Built once per scene, reused by every mesh in it. */
export interface Mats {
  pavement: PBRMaterial;
  shell: PBRMaterial;
  marble: PBRMaterial;
  metal: PBRMaterial;
  turf: PBRMaterial;
  foliage: PBRMaterial;
  suit: PBRMaterial;
  coat: PBRMaterial;
  skin: PBRMaterial;
  hair: PBRMaterial;
  /** Dark flat-roof membrane — see the roof deck note in `buildFacility`. */
  roofDeck: PBRMaterial;
  /** Rooftop ad hoardings, keyed by facility. Absent when a poster is missing. */
  adPosters: Map<FacilityId, StandardMaterial>;
  /** Emissive holo materials, keyed by colour so they are shared, not per-mesh. */
  holo: Map<string, StandardMaterial>;
  /**
   * Function-glyph materials, one per facility. Shared by the sign-bracket
   * panel and the plaza-facing banner/flag so a building costs one material
   * for its icon, not one per mesh.
   */
  glyphs: Map<FacilityId, StandardMaterial>;
  /**
   * Tiling brick shells, one material per distinct facade size. `null` until
   * `loadBrickShells` has confirmed the texture set is actually on disk — the
   * flat `shell` colour is the fallback.
   */
  brick: BrickShells | null;
}

/**
 * The tiling brick wall set (`public/assets/village/wall/`).
 *
 * WHY TILING AND NOT A PER-BUILDING BAKE
 * --------------------------------------
 * The obvious way to texture eight facades is to bake one texture per building.
 * At building scale that fails on texel density: a unique map stretched over a
 * 14 m facade resolves ~146 texels/m at 2048², against ~569 for a hero, so brick
 * courses and joints turn to mush. A tiling texture has no fixed extent to
 * stretch — it repeats — so density is set by how many metres one tile covers
 * (here 2 m => ~512 texels/m) and is identical on the smallest kiosk and the
 * widest hall. It is also *one* texture set for the whole village rather than
 * eight, which is why `asset-pipeline-notes.md` mandates tiling + trim sheets
 * for environment art in the first place.
 */
interface BrickShells {
  /** Keyed by `${width}x${height}` — one material per distinct facade size. */
  bySize: Map<string, PBRMaterial>;
}

/** Metres of wall covered by one tile of the brick texture. */
const BRICK_TILE_M = 2;

/**
 * Rooftop ad hoarding, height / width. Matches the generated poster's own
 * proportions so the artwork is never stretched to fit the board.
 */
const AD_POSTER_ASPECT = 768 / 512;

/**
 * Rooftop hoardings: exactly two, each with its own poster.
 *
 * Two is a deliberate cap, not a placeholder. A billboard on every roof reads as
 * a shopping mall rather than a lived-in block, and the Queue Terminal roof is
 * excluded entirely because its screen is the one rooftop element that is
 * gameplay rather than set dressing. These two sit on opposite arcs of the ring
 * (bearing 20 and 330) so one is in frame from most of the plaza without both
 * crowding the same sightline.
 */
const AD_BOARDS: ReadonlyArray<{ facility: FacilityId; url: string }> = [
  { facility: "outfitter", url: "/assets/village/ad_counselling_a.ktx2" },
  { facility: "residential", url: "/assets/village/ad_counselling_b.ktx2" },
];

/**
 * Metres of ground covered by one tile of a ground texture. Larger than the
 * wall tile because paving slabs are 1 m and asphalt has no features at all —
 * repeating either every 2 m would make the repetition obvious.
 */
const GROUND_TILE_M = 4;

/**
 * Does this asset actually exist?
 *
 * `res.ok` alone is NOT enough. A dev server with an SPA fallback (Vite, and
 * most static hosts configured for one) answers ANY unmatched path with
 * index.html and HTTP 200 — so a missing .ktx2 comes back "successfully" as a
 * page of HTML, every fallback in this file silently fails to trigger, and
 * Babylon reports the baffling "texture missing KTX identifier" instead.
 *
 * Checking the content type is what makes the fallbacks real: an asset that
 * resolves to HTML is a missing asset, whatever the status code says.
 */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return false;
    return !(res.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

/**
 * Rooftop hoarding materials, one per entry in `AD_BOARDS`.
 *
 * The generated posters have no alpha channel, so `getAlphaFromRGB` derives
 * opacity from each image's own luminance. That is what makes them read as
 * projected holograms rather than printed billboards: the dark poster ground
 * drops out and only the bright artwork and lettering hang in the air. Painting
 * an alpha channel by hand would reach the same result via an extra asset and
 * an extra way to get it wrong.
 *
 * The UV flips below are load-bearing — see the comment at the flip itself.
 *
 * Unlit (`disableLighting`) because a light-responsive sign would darken at
 * dusk, and this is a lit hoarding — it makes its own light. The scene's
 * existing GlowLayer supplies the bloom.
 */
async function loadAdPosters(scene: Scene): Promise<Map<FacilityId, StandardMaterial>> {
  const out = new Map<FacilityId, StandardMaterial>();
  if (typeof fetch !== "function") return out;

  for (const board of AD_BOARDS) {
    if (!(await assetExists(board.url))) {
      console.info(`[village] ad poster ${board.url} unavailable, skipping`);
      continue;
    }

    // Flip vertically on the UVs, NOT via the constructor's invertY argument.
    // Passing explicit constructor parameters sends Babylon down a different
    // loader path that fails on a standalone .ktx2 outright ("texture missing
    // KTX identifier"), so the two-argument form is the only one that parses.
    // vScale -1 with vOffset 1 mirrors V and shifts it back into 0..1, which
    // corrects the upside-down poster without touching how the file is read.
    const tex = new Texture(board.url, scene);
    // TWO independent flips, both required — they fix different things:
    //   V: a standalone .ktx2 arrives with its rows in the opposite order to
    //      Babylon's default, so the artwork hangs upside down.
    //   U: the board is turned to face the plaza with rotation.y = PI, which
    //      flips the quad over and mirrors whatever is on it left-to-right.
    //      Harmless on abstract art, fatal the moment the poster has words on
    //      it — the headline and phone number read backwards.
    // Symmetric textures (brick, paving) hide both completely, which is why
    // this only ever showed up on the hoardings. Textures inside a .glb are
    // unaffected: the glTF loader handles orientation itself.
    tex.uScale = -1;
    tex.uOffset = 1;
    tex.vScale = -1;
    tex.vOffset = 1;
    const m = new StandardMaterial(`adPoster_${board.facility}`, scene);
    m.disableLighting = true;
    m.emissiveTexture = tex;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.opacityTexture = tex;
    m.opacityTexture.getAlphaFromRGB = true;
    // Slightly under 1 so the board never reads as a solid slab edge-on.
    m.alpha = 0.92;
    m.backFaceCulling = false;
    out.set(board.facility, m);
  }
  return out;
}

/** Ground texture sets, sharing the brick set's directory and conventions. */
type GroundKind = "paving" | "road";

/**
 * Material for one ground layer, tiled to real-world scale.
 *
 * Returns `null` when the brick/ground set is absent (`mats.brick` is the same
 * availability flag — one HEAD request covers the whole directory), so callers
 * can fall back to flat colour exactly as the shells do.
 *
 * `spanM` is how many metres the mesh covers, so a 60 m ground plane and a 30 m
 * disc both end up with the same physical slab size instead of one being a
 * scaled copy of the other.
 */
function groundMaterial(
  scene: Scene,
  mats: Mats,
  kind: GroundKind,
  spanM: number
): PBRMaterial | null {
  if (!mats.brick) return null;

  const key = `ground_${kind}_${spanM}`;
  const cached = mats.brick.bySize.get(key);
  if (cached) return cached;

  const m = new PBRMaterial(key, scene);
  const s = spanM / GROUND_TILE_M;

  const albedo = new Texture(`/assets/village/wall/${kind}_albedo.ktx2`, scene);
  const normal = new Texture(`/assets/village/wall/${kind}_normal.ktx2`, scene);
  const orm = new Texture(`/assets/village/wall/${kind}_orm.ktx2`, scene);
  for (const t of [albedo, normal, orm]) {
    t.uScale = s;
    t.vScale = s;
  }

  m.albedoTexture = albedo;
  m.bumpTexture = normal;
  m.metallicTexture = orm;
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;

  mats.brick.bySize.set(key, m);
  return m;
}

/**
 * Facade dressing textures — a photoreal window and an entrance door, generated
 * with `tools/civitai-gen.mjs` (see `assets/work/village/facade/`). They ship in
 * the same directory as the wall set on purpose: `mats.brick` doubles as the
 * availability flag for the whole directory, so a missing set degrades to the
 * old emissive-quad look instead of to black planes.
 */
type FacadeKind = "window" | "door";

function facadeMaterial(scene: Scene, mats: Mats, kind: FacadeKind): PBRMaterial | null {
  if (!mats.brick) return null;

  const key = `facade_${kind}`;
  const cached = mats.brick.bySize.get(key);
  if (cached) return cached;

  const m = new PBRMaterial(key, scene);
  m.albedoTexture = new Texture(`/assets/village/wall/${kind}_albedo.ktx2`, scene);
  if (kind === "window") {
    // Glazing: sky reflection is baked into the albedo, but a low roughness
    // lets the panes also pick up the day IBL so they shift as the camera
    // orbits — the difference between a photo of a window and a window.
    m.metallic = 0.2;
    m.roughness = 0.25;
  } else {
    // Painted steel door — matte enough not to mirror the plaza.
    m.metallic = 0.25;
    m.roughness = 0.55;
  }
  mats.brick.bySize.set(key, m);
  return m;
}

/**
 * Shopfront glazing — dark, glossy, reflective, with a whisper of the shop's
 * accent colour. Keyed per accent so the two magenta shops share one material.
 * Cached in the same map as the other texture-era materials because it is part
 * of the same look; the flat holoMat glow is the fallback when textures are
 * absent, and this must never exist alongside it.
 */
function storefrontGlazing(scene: Scene, mats: Mats, accent: Color3): PBRMaterial {
  const key = `glazing_${accent.toHexString()}`;
  const cached = mats.brick!.bySize.get(key);
  if (cached) return cached;

  const m = new PBRMaterial(key, scene);
  m.albedoColor = new Color3(0.015, 0.02, 0.025);
  m.metallic = 0.55;
  m.roughness = 0.12;
  m.environmentIntensity = 1.15;
  // 0.04: a tint, not a light box. At 0.10 the pane read as a solid accent-
  // coloured panel in daylight (measured on screenshots); at 0.04 it reads as
  // tinted glass and the glyph signage carries the identity colour instead.
  // Either way it sits far below bloomThreshold (0.92), so it never glows.
  m.emissiveColor = accent.scale(0.04);
  mats.brick!.bySize.set(key, m);
  return m;
}

const BRICK_URLS = {
  albedo: "/assets/village/wall/brick_albedo.ktx2",
  normal: "/assets/village/wall/brick_normal.ktx2",
  orm: "/assets/village/wall/brick_orm.ktx2",
} as const;

/**
 * Confirm the brick set exists before any material references it.
 *
 * Texture loading in Babylon is asynchronous and reports failure through a
 * callback rather than by throwing, so a missing file yields a black material
 * rather than an error we could catch and fall back from. One HEAD request up
 * front turns that into a clean yes/no, matching how `buildFreud` refuses to
 * hard-depend on an asset that may still be iterating.
 */
async function loadBrickShells(): Promise<BrickShells | null> {
  if (typeof fetch !== "function") return null; // headless soak test
  if (!(await assetExists(BRICK_URLS.albedo))) {
    console.info("[village] brick wall set unavailable, using flat shells");
    return null;
  }
  return { bySize: new Map() };
}

/**
 * Brick material sized to one facade.
 *
 * `uScale`/`vScale` live on the Texture, not the material, so a facade of a
 * different size needs its own Texture wrappers to keep bricks the same real
 * size everywhere — without this, a 9 m kiosk and an 18 m hall would show bricks
 * at half and double scale, which reads as a bug. The wrappers are cheap:
 * Babylon caches the decoded image per URL, so all eight facades share three
 * GPU textures (~4.2 MB total) no matter how many wrappers exist.
 */
function brickShellMaterial(scene: Scene, brick: BrickShells, f: Facility): PBRMaterial {
  const key = `${f.width}x${f.height}`;
  const cached = brick.bySize.get(key);
  if (cached) return cached;

  const m = new PBRMaterial(`brick_${key}`, scene);
  const u = f.width / BRICK_TILE_M;
  const v = f.height / BRICK_TILE_M;

  const albedo = new Texture(BRICK_URLS.albedo, scene);
  const normal = new Texture(BRICK_URLS.normal, scene);
  const orm = new Texture(BRICK_URLS.orm, scene);
  for (const t of [albedo, normal, orm]) {
    t.uScale = u;
    t.vScale = v;
  }

  m.albedoTexture = albedo;
  m.bumpTexture = normal;
  // One packed map drives all three scalars — occlusion R, roughness G,
  // metallic B, the same convention tripo ships for the props.
  m.metallicTexture = orm;
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  // Scalars multiply the map, so they must be 1 or they would scale it down.
  m.metallic = 1;
  m.roughness = 1;

  brick.bySize.set(key, m);
  return m;
}

/**
 * The facility id a tapped mesh belongs to, from `metadata.shopNpc` set by
 * buildShopNpcs — the picked mesh is usually a CHILD of the NPC root (glb
 * primitives), so walk up the parent chain to find the tag.
 */
function shopNpcFacility(mesh: AbstractMesh): FacilityId | null {
  let node: Node | null = mesh;
  while (node) {
    const id = (node.metadata as { shopNpc?: FacilityId } | null)?.shopNpc;
    if (id) return id;
    node = node.parent;
  }
  return null;
}

/**
 * Everything under the village that is not a building: sky, fog, IBL, camera,
 * the three lights, the material set, and the plaza ground plus the island it
 * sits on.
 *
 * Extracted so the Practice Booth scene can stand on the IDENTICAL foundation
 * rather than a copy of it that drifts. Anything a second scene would have to
 * re-implement to look like the village belongs in here; anything that makes
 * the village *the village* (facilities, props, crowd, shop NPCs, the arena
 * portal) stays in `createVillageHub`.
 */
export interface VillageFoundation {
  camera: ArcRotateCamera;
  /** The sun. Returned because the shadow generator is bound to it. */
  key: DirectionalLight;
  mats: Mats;
}

export async function buildVillageFoundation(scene: Scene): Promise<VillageFoundation> {
  scene.clearColor = VILLAGE_DAY.sky;

  // ---- Atmosphere -------------------------------------------------------
  // DAYLIGHT on a floating island. The skybox paints sky + sea; fog is the
  // soft edge that keeps that equirect from reading as a hard wallpaper.
  //
  // Start past the facade ring (plaza stays crisp), full veil by the paving
  // edge so island geometry dissolves into sea-air haze before the panorama's
  // horizon stretch / pole distortion is obvious. Skybox itself stays
  // unfogged (zenith must stay clear) — fogColor matches the painted horizon
  // so the two meet as one continuous veil.
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = VILLAGE_DAY.fog.clone();
  // Plaza stays crisp inside the facade ring; the veil then builds fast enough
  // that a zoomed-out orbit sees the island edge dissolving into sea-air haze
  // (full veil just past the far cliff at max zoom, ~48 m radius + 30 m rock).
  // RING_RADIUS = 23 m → start ~35 m; full veil ~84 m.
  scene.fogStart = RING_RADIUS + 12;
  scene.fogEnd = HUB.playableExtent * 1.4;

  // IBL must exist before `warmupShaders` runs at the end of this function:
  // setting an environment texture flips the REFLECTION define on every PBR
  // shader, and warming the un-reflective variant would compile 40 shaders
  // only to recompile all of them on the first real frame.
  await applyDayEnvironment(scene);

  // ---- Camera -----------------------------------------------------------
  // WoW-style third person: orbits the HERO (target follows in the
  // controller), full 360 yaw, drag to look, wheel to zoom. Zooming far out
  // still gives the old diorama view for lookdev.
  // Initial alpha puts the camera over the hero's shoulder: the spawn faces
  // the plaza (world direction (0.5, -0.87) out the residential door), so
  // behind-the-back means the door side — offset (-0.5, 0.87), i.e. alpha =
  // atan2(0.87, -0.5) = 120° ≈ 0.67π (screenshot-verified boot frame). The
  // starting radius is 6, not 8: the spawn stands 5.5 m off the residential
  // facade, and 8 × sin(beta) ≈ 6.8 m of pullback would open the first frame
  // inside the building's shell.
  const camera = new ArcRotateCamera(
    "hub",
    Math.PI * 0.67,
    Math.PI / 3.1,
    6,
    new Vector3(FREUD_SPOT.x, 1.6, FREUD_SPOT.z),
    scene
  );
  camera.lowerRadiusLimit = 2.2;
  camera.upperRadiusLimit = 48;
  // beta = π/2 is horizontal; clamp just above it so the orbit bottoms out at
  // the horizon and can never look up from under the island.
  camera.upperBetaLimit = Math.PI / 2 - 0.02;
  camera.minZ = 0.5;
  // Far plane past fogEnd so the haze can finish before depth clip.
  camera.maxZ = Math.max(HUB.fogEnd, scene.fogEnd * 1.05);
  camera.wheelDeltaPercentage = 0.05;
  // Right-drag panning would decouple the camera from the hero — off.
  camera.panningSensibility = 0;
  camera.attachControl(true);

  // ---- Lighting ---------------------------------------------------------
  // Midday. Still exactly THREE real-time lights — the rule that keeps shader
  // permutations bounded does not relax just because the sun came up.
  //
  // Sky bounce is now blue-white from above and warm off the pavement below,
  // which is what a hemispheric light is actually for; at dusk both halves were
  // nearly black and the IBL did most of the work.
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.95;
  ambient.diffuse = new Color3(0.68, 0.76, 0.92); // open sky
  // Sea bounce (not dirt) — the island floats over open water.
  ambient.groundColor = new Color3(0.22, 0.34, 0.42);

  // The sun. Direction MUST stay in step with `KEY_DIR` in tools/gen-day-hdr.py
  // or the shadows will fall away from the sun disc painted in the sky, which
  // is the single most obvious way a daylight scene reads as fake.
  const key = new DirectionalLight("key", new Vector3(0.38, -0.9, -0.22), scene);
  key.intensity = 2.6;
  key.diffuse = new Color3(1.0, 0.97, 0.90); // near-white midday sun
  key.specular = new Color3(1.0, 0.98, 0.94);

  // Sky fill from the shaded side. Cool, weak, and purely to stop north-facing
  // walls going flat — under a bright key an unfilled shadow side reads as a
  // hole rather than as shade.
  const fill = new DirectionalLight("fill", new Vector3(-0.5, -0.35, 0.7), scene);
  fill.intensity = 0.5;
  fill.diffuse = new Color3(0.55, 0.68, 0.9);

  const mats = createMaterials(scene);
  // Probe the tiling texture set BEFORE anything that might use it:
  // buildPlaza needs it for the ground layers, and buildFacility for the
  // brick shells. One HEAD request covers the whole directory.
  mats.brick = await loadBrickShells();
  mats.adPosters = await loadAdPosters(scene);

  buildPlaza(scene, mats);

  return { camera, key, mats };
}

export async function createVillageHub(engine: AbstractEngine, profile?: Profile): Promise<Scene> {
  const scene = new Scene(engine);
  const { camera, key, mats } = await buildVillageFoundation(scene);

  // Facade kit: one load per module for the whole scene, then instance across
  // every building that needs it. Loading inside buildFacility would re-fetch
  // window_bay five times and pay five draw calls for what should be one.
  const kit = await loadVillageKit(scene);
  const kitPlacements = emptyKitPlacements();

  const tickers: Ticker[] = [];
  for (const f of FACILITIES) {
    tickers.push(...(await buildFacility(scene, mats, f, kit, kitPlacements)));
  }
  // World-space batch: placeMany freezes after positioning, and instances do
  // not share a parent — each facility root is a different transform.
  placeVillageKit(kit, kitPlacements);

  await buildPlazaProps(scene, mats);

  // Centre-of-plaza portal: the group-up point where parties form and enter
  // the boss arena. Rock stand (island cliff rock — same material story as
  // the cliff it stands on) + pocket black hole; tapping it opens the rooms
  // panel. Built before the collider sweep so portalStand* becomes solid.
  const portal = buildBlackHolePortal(
    scene,
    islandAlbedoMaterial(
      scene,
      "portalStandMat",
      "/assets/village/island/island_cliff_albedo.ktx2",
      "/assets/village/island/island_cliff_albedo.png",
      2,
      1
    )
  );
  tickers.push(portal);
  // The Dream Siege pailou on the plaza edge (survival mode). Also before the
  // collider sweep, so its pillars are solid.
  const survivalGate = await buildSurvivalGate(scene);

  tickers.push(...(await buildCrowd(scene, mats)));
  tickers.push(...(await buildShopNpcs(scene, kit)));

  // The hub body IS the selected hero now that pavlov.glb ships; unknown ids
  // fall back to Freud inside heroById.
  const selectedHero = heroById(profile?.selectedHero);
  const hero = await buildFreud(scene, mats, { heroId: selectedHero.id });
  tickers.push({ tick: hero.tick });
  tickers.push(survivalGate.watch(hero.node));

  // Floating name + equipped-title captions over the hero. The title lives on
  // the module (setLocalHeroTitle) so an equip survives a scene rebuild; the
  // profile seeds it on the FIRST build only — an unequip later in the
  // session must not be undone by the stale profile snapshot.
  if (profile) {
    if (localHeroTitle === undefined) localHeroTitle = profile.title || null;
    buildLocalHeroTags(scene, hero, profile);
  }
  const voice = createHeroVoice(selectedHero.id);
  const music = createVillageMusic();
  scene.onDisposeObservable.add(() => {
    voice.dispose();
    music.dispose();
  });
  // Collect AFTER every static mesh is placed and frozen (bounding boxes are
  // world-space by then) and after the hero — his meshes are named freud_* and
  // deliberately not in the solid set.
  tickers.push(createHeroController(scene, camera, hero, mats, collectStaticColliders(scene), voice));
  // Casts announce themselves over the village presence channel so friends see
  // the VFX too. The presence client is wired a few lines down (it needs the
  // profile), so the bar publishes through this late-bound slot — null until
  // wireVillagePresence fills it, and null again after scene teardown.
  const castAnnounce: CastAnnounce = { fn: null };
  setupSkillBar(scene, hero, voice, { onCast: (slot) => castAnnounce.fn?.(slot) }, selectedHero);

  // The equipped pet at his heel — a live slot, so equipping or unequipping
  // in the Pet Park takes effect immediately instead of on the next rebuild.
  tickers.push(createPetSlot(scene, hero, selectedHero.id));

  // Remote players — live village presence. No profile (headless soak test)
  // means no session to join; any failure inside degrades to the solo village.
  if (profile) wireVillagePresence(scene, profile, hero, selectedHero.id, tickers, castAnnounce);

  // The rooms panel's options live on the module (single source of truth), so
  // the portal tap below and the left dock's Boss Queue button open the same
  // panel with the same arena hand-off — a go() shim until the real
  // matchmaker lands (main.ts exposes go() on window.psyrena).
  configureRoomsPanel({
    onEnterPractice: () => {
      const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
      // Practice runs are free: no admission gate, no daily-entry spend. The
      // flag rides localStorage to the arena (fight/practice.ts), where the
      // two bot teammates and the 3-man boss script come from.
      setPracticeMode(true);
      void psy?.go?.("arena");
    },
    // Admission gate + scene switch both live in fight/arenaEntry.ts — the
    // party-launch push (main.ts) walks in through the exact same door.
    onEnterArena: () => void enterRankedArena(),
  });

  // The portal is the game's first pickable object. The ArcRotateCamera owns
  // pointer drags for the orbit, so only a short, still press counts as a tap
  // on it — same tap-vs-drag gate every touch UI uses. The pick predicate
  // targets the one invisible proxy directly; no scene-wide isPickable audit.
  let pressX = 0;
  let pressY = 0;
  let pressAt = 0;
  scene.onPointerObservable.add((pi) => {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      pressX = scene.pointerX;
      pressY = scene.pointerY;
      pressAt = performance.now();
    } else if (pi.type === PointerEventTypes.POINTERUP) {
      const dx = scene.pointerX - pressX;
      const dy = scene.pointerY - pressY;
      if (dx * dx + dy * dy > 12 * 12 || performance.now() - pressAt > 500) return;
      const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === portal.pickable);
      if (hit?.hit) {
        openRoomsPanel();
        return;
      }
      // Not the portal — maybe the unclaimed-cache pickup beside the queue
      // terminal (spawned only when the ledger holds unopened boxes; tapping
      // it opens the cache inventory, same as the gear panel's Caches button).
      const cacheHit = scene.pick(scene.pointerX, scene.pointerY, (m) => m.name === "unclaimedCache");
      if (cacheHit?.hit) {
        openLootInventory();
        return;
      }
      // Not the portal — maybe a shop attendant. The facilities with a panel
      // open it; the practice booth's attendant is a doorman instead and asks
      // first (Practice Pit intro) before handing off to its own scene. The
      // queue terminal toggles the same rooms panel as the dock's Boss Queue
      // button. No profile (headless soak test) → no account panels.
      const npcHit = scene.pick(scene.pointerX, scene.pointerY, (m) => shopNpcFacility(m) !== null);
      const facility = npcHit?.hit && npcHit.pickedMesh ? shopNpcFacility(npcHit.pickedMesh) : null;
      // Checked before the profile gate: entering the booth needs no account,
      // so the soak test can walk this path too. The confirmation modal is
      // equally profile-free (practicePit.ts does no fetch).
      if (facility === "practice-booth") {
        openPracticePitIntro(() => {
          const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } }).psyrena;
          void psy?.go?.("practice");
        });
        return;
      }
      // Same open/close pair as the dock's queue button (leftDock.ts) — a tap
      // while the panel is up closes it instead of no-op'ing on idempotence.
      if (facility === "queue-terminal") {
        if (!closeRoomsPanel()) openRoomsPanel();
        return;
      }
      if (!profile) return;
      if (facility === "outfitter") openShopPanel();
      else if (facility === "style-lab") openSkinPanel(profile);
      else if (facility === "pet-park") openPetPanel(profile);
      else if (facility === "hall-of-minds") openHallPanel(profile);
      // The barista is the ONLY way into the potion menu — no dock button, by
      // design. Toggle like the queue terminal: a tap while it is up closes it.
      else if (facility === "coffee-shop") {
        if (!closeCoffeePanel()) openCoffeePanel();
      }
      // Not a facility — maybe another player. Capsule stand-in, rigged hero
      // and nameplate all carry `metadata.remotePlayer` (stamped by
      // wireVillagePresence), so one predicate covers every representation.
      // Checked LAST so the portal/cache/NPC picks above keep priority.
      else if (facility === null) {
        const playerHit = scene.pick(
          scene.pointerX,
          scene.pointerY,
          (m) => typeof (m.metadata as { remotePlayer?: unknown } | null)?.remotePlayer === "string"
        );
        const who = (playerHit?.pickedMesh?.metadata as { remotePlayer?: string } | null)
          ?.remotePlayer;
        if (playerHit?.hit && who) showPlayerCard(who);
      }
    }
  });

  finishVillageRender(scene, camera, key);

  // Unclaimed-loot marker beside the queue terminal (see buildUnclaimedLootBox
  // — local-only, re-checks the ledger on every hub load). Deliberately AFTER
  // finishVillageRender's one-shot shadow bake and the collider sweep above:
  // the pickup casts no baked shadow and never becomes a hero collider.
  if (profile) buildUnclaimedLootBox(scene, tickers);

  // Coffee Shop potions: pull the account's live buffs once per hub load so
  // the HUD tiles (and the next fight's multipliers) reflect the ledger —
  // fire-and-forget, a failure just means no tile until the shop is opened.
  if (profile) void syncPotionBuffs();
  if (profile) void syncLoadout();

  // ---- Motion -----------------------------------------------------------
  // One observer for the whole scene. A per-prop observer would be tidier to
  // write and would cost a closure call per prop per frame.
  let t = 0;
  scene.onBeforeRenderObservable.add(() => {
    t += engine.getDeltaTime() / 1000;
    for (const c of tickers) c.tick(t);
  });

  await warmupShaders(scene);
  return scene;
}

/**
 * Shadow map and post pipeline — the second half of the shared foundation.
 *
 * Runs LAST in a scene build, after every static mesh exists: the caster sweep
 * walks `scene.meshes`, and the shadow map is render-once, so a mesh added
 * afterwards never appears in it.
 */
export function finishVillageRender(
  scene: Scene,
  camera: ArcRotateCamera,
  key: DirectionalLight
): void {
  // ---- Shadows ----------------------------------------------------------
  // One shadow map, rendered ONCE. The hub is static (frozen matrices), so
  // re-rendering ~180 meshes into a depth map at 60 Hz would buy nothing.
  // The animated meshes are excluded or sway by ~1 cm, which a static shadow
  // absorbs invisibly; the shape-shifting practice dummy is excluded because
  // a frozen shadow under a growing hologram would read as a bug.
  const shadows = new ShadowGenerator(1024, key);
  shadows.usePoissonSampling = true;
  shadows.bias = 0.002;

  // Flat decals (ground, light spills, paw prints, holo glass) must not cast:
  // a coplanar caster is acne by definition. Denylist by the names this file
  // itself assigns.
  // "freud" is excluded because the hero MOVES: his shadow would stay baked
  // at the spawn point in a render-once map. He gets a blob shadow instead
  // (see createHeroController) — the classic trade for characters under a
  // static shadow map.
  // glyph/banner/flag/signPost/upperLight: flat facade quads — coplanar casters
  // are shadow acne, so they join the denylist by deliberate name.
  // `skyBox` is the critical one now that the hub has a sky: it is a 2 km cube,
  // and letting it into the shadow map would stretch the light's depth range
  // across two kilometres, quantising every real shadow in the block out of
  // existence. `plazaRoad` joins the flat-decal group for the usual reason — a
  // coplanar caster is shadow acne by definition.
  const noCast =
    /ground|inlay|paw|rim|glass|screen|win|turf|dummy|mannequin|drone|smoke|catwalk|strip|freud|pavlovFx|remote|glyph|banner|flag|signPost|upperLight|doorPanel|skyBox|plazaRoad|roofDeck|adBoard|islandLip|islandCone|portalFx|portalPick/i;
  for (const mesh of scene.meshes) {
    if (!noCast.test(mesh.name)) shadows.addShadowCaster(mesh, false);
  }
  // Island mass casts under the key light so the rock reads as solid.
  for (const name of ["islandCone", "islandLip"]) {
    const m = scene.getMeshByName(name);
    if (m) shadows.addShadowCaster(m, false);
  }
  for (const name of ["plazaGround", "plazaInlay", "pet-park_turf"]) {
    const m = scene.getMeshByName(name);
    if (m) m.receiveShadows = true;
  }

  const shadowMap = shadows.getShadowMap();
  if (shadowMap) shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  // ---- Post pipeline ----------------------------------------------------
  // Matched to the arena's recipe so the two scenes grade as one game, with the
  // exposure/contrast pulled back: the hub is "the calm between fights" (V3),
  // and it has far more emissive surface area than the arena does.
  // Device tier (core/quality.ts) decides the luxury allocations: on phones
  // 4x MSAA goes (it multiplies every pipeline render target) and the glow
  // layer drops to quarter-res. iOS answers GPU memory pressure by killing the
  // WebGL context mid-boot, so on an iPhone these buffers aren't a quality
  // trade — they're the margin between booting and a black screen. The low
  // tier drops the glow layer outright. FXAA stays on everywhere and covers
  // the missing MSAA well enough at phone pixel density.
  const glowOptions = sceneGlowOptions();
  const glow = glowOptions ? new GlowLayer("glow", scene, glowOptions) : null;
  if (glow) glow.intensity = 0.62;

  const pipeline = new DefaultRenderingPipeline("post", true, scene, [camera]);
  pipeline.fxaaEnabled = true;

  // Bloom threshold RISES for daylight. At dusk almost nothing but the neon sat
  // above 0.68, so that was a fine gate; under a bright sky sunlit paving and
  // white marble clear it too, and a scene where everything blooms is a scene
  // where nothing reads as glowing. Lifting the gate keeps bloom for what is
  // genuinely emissive — signage, glyphs, holo glass — and leaves lit surfaces
  // alone.
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.92;
  pipeline.bloomWeight = 0.42;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;

  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  // Exposure comes DOWN even though the scene got brighter: the sun is 2.6 and
  // the sky IBL adds more again, so holding 1.05 would clip the pavement to
  // white and take every ground decal with it.
  pipeline.imageProcessing.exposure = 0.92;
  pipeline.imageProcessing.contrast = 1.06;

  // Vignette almost off. A heavy dark vignette is a night-time device; at midday
  // it reads as a lens defect rather than as mood.
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 0.45;
  pipeline.imageProcessing.vignetteColor = new Color4(0.16, 0.2, 0.28, 1);

  // Grain eased right back. At dusk it hid banding in the dark gradients; in
  // daylight there are no near-black gradients to band, so it only adds noise
  // to a bright image.
  pipeline.grainEnabled = true;
  pipeline.grain.intensity = 2;
  pipeline.grain.animated = true;

  // Lower than the arena's 8: the hub is where players read menus and each
  // other's cosmetics, and aberration costs legibility (doc 05 VFX rule).
  pipeline.chromaticAberrationEnabled = true;
  pipeline.chromaticAberration.aberrationAmount = 4;

  applyPipelineQuality(pipeline);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export function createMaterials(scene: Scene): Mats {
  const pavement = new PBRMaterial("pavement", scene);
  pavement.albedoColor = VILLAGE_DAY.pavement.clone();
  pavement.metallic = 0.25;
  // Dusk pavement is damp: a low roughness lets it mirror the storefronts back,
  // which is most of why the plaza reads as "expensive" for zero extra geometry.
  pavement.roughness = 0.35;
  pavement.environmentIntensity = 0.5;

  const shell = new PBRMaterial("shell", scene);
  shell.albedoColor = VILLAGE_DAY.shell.clone();
  shell.metallic = 0.15;
  shell.roughness = 0.72;

  const marble = new PBRMaterial("marble", scene);
  marble.albedoColor = VILLAGE_DAY.marble.clone();
  marble.metallic = 0.1;
  marble.roughness = 0.24;
  marble.environmentIntensity = 0.7;

  const metal = new PBRMaterial("metal", scene);
  metal.albedoColor = new Color3(0.11, 0.12, 0.14);
  metal.metallic = 0.85;
  metal.roughness = 0.4;

  const turf = new PBRMaterial("turf", scene);
  turf.albedoColor = VILLAGE_DAY.turf.clone();
  turf.metallic = 0;
  turf.roughness = 0.95;

  const foliage = new PBRMaterial("foliage", scene);
  foliage.albedoColor = new Color3(0.07, 0.14, 0.1);
  foliage.metallic = 0;
  foliage.roughness = 0.9;

  // Freud, per `assets/concept/freud/F1_turnaround.png`: black three-piece
  // under a charcoal overcoat with cyan circuit trim.
  const suit = new PBRMaterial("suit", scene);
  suit.albedoColor = new Color3(0.022, 0.024, 0.03);
  suit.metallic = 0.05;
  suit.roughness = 0.62;

  const coat = new PBRMaterial("coat", scene);
  coat.albedoColor = new Color3(0.055, 0.058, 0.068);
  coat.metallic = 0.05;
  coat.roughness = 0.78;

  const skin = new PBRMaterial("skin", scene);
  skin.albedoColor = new Color3(0.55, 0.42, 0.35);
  skin.metallic = 0;
  skin.roughness = 0.7;

  const hair = new PBRMaterial("hair", scene);
  hair.albedoColor = new Color3(0.72, 0.72, 0.7); // gray-white beard + slicked hair
  hair.metallic = 0;
  hair.roughness = 0.85;

  // Flat-roof membrane: near-black and fully rough, so roofs read as a dark cap
  // under a sun that would clip any mid-value surface facing straight up.
  const roofDeck = new PBRMaterial("roofDeck", scene);
  roofDeck.albedoColor = new Color3(0.075, 0.075, 0.085);
  roofDeck.metallic = 0;
  roofDeck.roughness = 0.95;

  return {
    pavement,
    shell,
    marble,
    metal,
    turf,
    foliage,
    suit,
    coat,
    skin,
    hair,
    roofDeck,
    adPosters: new Map(),
    holo: new Map(),
    glyphs: new Map(),
    brick: null,
  };
}

/**
 * Get (or create) a shared unlit emissive material.
 *
 * Keyed by colour+alpha so twenty holo panels of the same cyan share ONE
 * material and therefore one compiled shader. Creating a StandardMaterial per
 * panel is the classic way a blockout quietly ends up with sixty shader
 * permutations and a two-second first-frame hitch.
 */
export function holoMat(scene: Scene, mats: Mats, color: Color3, alpha = 1): StandardMaterial {
  const key = `${color.toHexString()}:${alpha}`;
  const existing = mats.holo.get(key);
  if (existing) return existing;

  const m = new StandardMaterial(`holo_${key}`, scene);
  m.disableLighting = true;
  m.emissiveColor = color.clone();
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.alpha = alpha;
  if (alpha < 1) m.backFaceCulling = false;
  mats.holo.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// Plaza
// ---------------------------------------------------------------------------

function buildPlaza(scene: Scene, mats: Mats): void {
  // The ground is three stacked discs so the block reads as a street rather
  // than a car park — and the OUTER disc is circular to match the cone mass
  // under the floating island (a square top over a round cone read as a bug):
  //
  //   y=0.000  outer paving  (r≈30)   sidewalk, runs under the buildings
  //   y=0.006  asphalt disc  (r=23)   the road ring in front of the shopfronts
  //   y=0.012  paving disc   (r=15)   the pedestrian plaza in the middle
  //
  // Each layer is fully drawn and simply covered by the next, so the visible
  // road is the annulus between 15 m and 23 m. Stacked discs are far cheaper
  // than authoring an annulus mesh and let the radii be tuned by changing one
  // number. The 6 mm steps are pure z-fighting insurance — invisible at any
  // camera angle the orbit limits allow.
  //
  // Outer paving is slightly larger than the rock mass so the cliff/cone
  // brown never peeks around the rim as a dirt halo.
  const islandR = HUB.playableExtent * 0.5; // 30 m — rock mass radius
  const groundR = islandR + 0.35; // paving overhang past the cliff lip
  const ground = MeshBuilder.CreateDisc(
    "plazaGround",
    { radius: groundR, tessellation: 72 },
    scene
  );
  ground.rotation.x = Math.PI / 2; // disc is XY; lay flat on XZ
  ground.material =
    groundMaterial(scene, mats, "paving", groundR * 2) ?? mats.pavement;
  ground.receiveShadows = true;
  ground.freezeWorldMatrix();

  const road = MeshBuilder.CreateDisc(
    "plazaRoad",
    { radius: RING_RADIUS, tessellation: 64 },
    scene
  );
  road.rotation.x = Math.PI / 2;
  road.position.y = 0.006;
  const roadMat = groundMaterial(scene, mats, "road", RING_RADIUS * 2);
  if (roadMat) {
    road.material = roadMat;
    road.receiveShadows = true;
    road.freezeWorldMatrix();
  } else {
    road.dispose(); // no texture set — fall back to plain paving everywhere
  }

  // Inlaid plaza disc + emissive rim: the "you are here" read from the rooftop
  // camera in V1, and the thing that stops a flat 60 m plane looking flat.
  const inlay = MeshBuilder.CreateDisc(
    "plazaInlay",
    { radius: PLAZA_RADIUS, tessellation: 64 },
    scene
  );
  inlay.rotation.x = Math.PI / 2;
  inlay.position.y = 0.012;
  const paved = groundMaterial(scene, mats, "paving", PLAZA_RADIUS * 2);
  if (paved) {
    inlay.material = paved;
  } else {
    const inlayMat = new PBRMaterial("plazaInlayMat", scene);
    inlayMat.albedoColor = VILLAGE_DAY.plazaInlay.clone();
    inlayMat.metallic = 0.35;
    inlayMat.roughness = 0.28;
    inlay.material = inlayMat;
  }
  inlay.freezeWorldMatrix();

  const rim = MeshBuilder.CreateTorus(
    "plazaRim",
    { diameter: PLAZA_RADIUS * 2, thickness: 0.09, tessellation: 96 },
    scene
  );
  rim.position.y = 0.03;
  rim.material = holoMat(scene, mats, PALETTE.cyan, 0.75);
  rim.freezeWorldMatrix();

  // Floating-island mass — circular cliff lip under the paving disc, then a
  // matching pointy cone (Grok albedos in public/assets/village/island/).
  buildIslandThickness(scene);
}

/**
 * Classic floating-island silhouette: open circular cliff lip under the paving
 * (no top cap — the paving disc owns the top surface), then a cone of the same
 * radius tapering to a point.
 */
function buildIslandThickness(scene: Scene): void {
  const islandR = HUB.playableExtent * 0.5; // rock mass radius
  const LIP_H = 1.4; // short vertical cliff under the paving rim
  const CONE_H = 16; // pointy mass hanging below the lip
  const TIP = 0.25; // diameterBottom can't be 0 in Babylon
  const TILE_M = 8;
  const circum = 2 * Math.PI * islandR;

  const cliffMat = islandAlbedoMaterial(
    scene,
    "islandCliffMat",
    "/assets/village/island/island_cliff_albedo.ktx2",
    "/assets/village/island/island_cliff_albedo.png",
    circum / TILE_M,
    LIP_H / (TILE_M * 0.35)
  );
  // Cone surface is the "underside" — dirt, roots, rock.
  const underMat = islandAlbedoMaterial(
    scene,
    "islandUnderMat",
    "/assets/village/island/island_underside_albedo.ktx2",
    "/assets/village/island/island_underside_albedo.png",
    circum / TILE_M,
    CONE_H / (TILE_M * 0.7)
  );

  // --- Open cliff ring (sides only) ----------------------------------------
  // A solid cylinder had a brown top cap coplanar with the paving that leaked
  // through as a dirt halo. Lathe a vertical line so only the wall exists.
  const lip = MeshBuilder.CreateLathe(
    "islandLip",
    {
      shape: [new Vector3(islandR, 0, 0), new Vector3(islandR, -LIP_H, 0)],
      radius: 1,
      tessellation: 64,
      sideOrientation: Mesh.DOUBLESIDE,
      closed: false,
      cap: Mesh.NO_CAP,
    },
    scene
  );
  lip.material = cliffMat;
  lip.isPickable = false;
  lip.receiveShadows = true;
  lip.freezeWorldMatrix();

  // --- Pointy cone: top slightly under the paving overhang ------------------
  const cone = MeshBuilder.CreateCylinder(
    "islandCone",
    {
      height: CONE_H,
      diameterTop: islandR * 2,
      diameterBottom: TIP,
      tessellation: 48,
      hasRings: false,
    },
    scene
  );
  // Top of cone sits under the lip so the join is hidden from the plaza.
  cone.position.y = -LIP_H - CONE_H / 2;
  cone.material = underMat;
  cone.isPickable = false;
  cone.receiveShadows = true;
  cone.freezeWorldMatrix();
}

/**
 * Albedo-only PBR for island rock. Prefers KTX2; falls back to PNG if the
 * standalone KTX2 path fails (same two-arg Texture rule as the ad posters).
 */
function islandAlbedoMaterial(
  scene: Scene,
  name: string,
  urlKtx2: string,
  urlPng: string,
  uScale: number,
  vScale: number
): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  // TWO-ARG constructor — multi-arg breaks standalone .ktx2 in this project.
  // Prefer KTX2; fall back to PNG on load failure.
  let tex = new Texture(urlKtx2, scene);
  tex.uScale = uScale;
  // Standalone KTX2 often arrives V-flipped vs engine default.
  tex.vScale = -Math.abs(vScale);
  tex.vOffset = 1;
  const t0 = performance.now();
  const ensure = (): void => {
    if (tex.isReady()) return;
    if (performance.now() - t0 > 4000) {
      tex = new Texture(urlPng, scene);
      tex.uScale = uScale;
      tex.vScale = -Math.abs(vScale);
      tex.vOffset = 1;
      m.albedoTexture = tex;
      return;
    }
    setTimeout(ensure, 100);
  };
  setTimeout(ensure, 100);

  m.albedoTexture = tex;
  m.metallic = 0.02;
  m.roughness = 0.88;
  m.environmentIntensity = 0.45;
  return m;
}

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

/** Position on the facade ring for a bearing in degrees. 0deg = +Z. */
function ringPoint(bearing: number, radius: number, y = 0): Vector3 {
  const a = (bearing * Math.PI) / 180;
  return new Vector3(Math.sin(a) * radius, y, Math.cos(a) * radius);
}

/**
 * Y-rotation that faces a ring-mounted mesh back toward the plaza centre.
 *
 * NO `+ Math.PI`. Everything a building shows the plaza — glass, signage, spill
 * disc, and every kit module — is authored at local -Z. Babylon rotates local
 * (0,0,-1) to world (-sin y, 0, -cos y), so yaw = bearing already points that
 * face straight down the inward radius; adding PI spun all eight buildings
 * around and presented their backs to the plaza. Verified numerically: with the
 * bare bearing the storefront lands at r = RING_RADIUS (23 m), which is exactly
 * what that constant is defined to mean; with the extra PI it landed at 33 m,
 * i.e. on the far side of the shell.
 */
function facingIn(bearing: number): number {
  return (bearing * Math.PI) / 180;
}

async function buildFacility(
  scene: Scene,
  mats: Mats,
  f: Facility,
  kit: VillageKit,
  kitPlacements: KitPlacements
): Promise<Ticker[]> {
  const root = new TransformNode(`facility_${f.id}`, scene);
  const centre = ringPoint(f.bearing, RING_RADIUS + f.depth / 2);
  root.position = centre;
  root.rotation.y = facingIn(f.bearing);

  if (f.openAir) {
    // Pet park / practice booth: open-air, no shell, no kit dress — but they
    // still need a plaza-facing function glyph on a standing post.
    const tickers: Ticker[] = [];
    if (f.id === "pet-park") {
      await buildPetPark(scene, mats, root, f);
    } else {
      tickers.push(await buildPracticeBooth(scene, mats, root, f));
    }
    // Open-air: no shell, so no plate and no bracketY — the standing-post branch
    // returns before either is read.
    for (const m of mountFacilitySignage(scene, mats, root, f, {
      glassH: 0,
      bracketY: 0,
      bracket: null,
    })) {
      m.freezeWorldMatrix();
    }
    root.freezeWorldMatrix();
    return tickers;
  }

  // ---- Shell ------------------------------------------------------------
  const shell = MeshBuilder.CreateBox(
    `${f.id}_shell`,
    { width: f.width, height: f.height, depth: f.depth },
    scene
  );
  shell.parent = root;
  shell.position.y = f.height / 2;
  // Marble hall keeps its stone; everything else gets tiling brick when the
  // set loaded, else the flat charcoal it always had.
  shell.material = f.marble
    ? mats.marble
    : mats.brick
      ? brickShellMaterial(scene, mats.brick, f)
      : mats.shell;

  // Roof parapet box — full footprint lip. The kit parapet *cap* tiles only the
  // plaza-facing roofline on top of this; both stay (box = silhouette, cap = trim).
  const parapet = MeshBuilder.CreateBox(
    `${f.id}_parapet`,
    { width: f.width + 0.5, height: 0.45, depth: f.depth + 0.5 },
    scene
  );
  parapet.parent = root;
  parapet.position.y = f.height + 0.2;
  parapet.material = f.marble ? mats.marble : mats.shell;

  // Roof deck — a dark membrane slab laid over the shell's top face.
  //
  // Without it the roof IS the shell's top face, wearing the same brick/marble
  // as the walls. A horizontal surface takes the sun almost head-on (the key
  // points mostly -Y) plus the full sky ambient from above, so a mid-value
  // albedo that reads correctly on a wall clips to white on a roof — the whole
  // block ended up capped in glowing white lids. Toning the lights down instead
  // would have dimmed the walls and plaza to fix a problem only the roofs had.
  //
  // A dark deck is also just what flat roofs are: bitumen or membrane, near
  // black, which is why real roofs never blow out in daylight photography.
  const roof = MeshBuilder.CreateBox(
    `${f.id}_roofDeck`,
    { width: f.width - 0.3, height: 0.12, depth: f.depth - 0.3 },
    scene
  );
  roof.parent = root;
  // Must clear the parapet's TOP face, not sit inside it. The parapet above is a
  // solid box (not a hollow lip), centred at height + 0.2 with height 0.45, so
  // its top face is at height + 0.425 — anything below that is buried and the
  // pale parapet remains the surface you actually see from above. Sitting the
  // deck just proud of it leaves a thin light parapet rim around a dark roof,
  // which is what a real flat roof looks like from the air.
  roof.position.y = f.height + 0.47;
  roof.material = mats.roofDeck;
  roof.receiveShadows = true;

  // Rooftop ad hoarding — a lit billboard facing the plaza.
  //
  // Only on the taller shells: on a 6.5 m coffee shop a 6 m hoarding would out-
  // mass the building it stands on, and it must not block the sightline to the
  // Queue Terminal's screen, which is the one rooftop element that is gameplay.
  const adPoster = mats.adPosters.get(f.id);
  if (adPoster) {
    // Driven by HEIGHT, not width. The poster is portrait, so sizing it by the
    // facade width would put a 13 m hoarding on a 10 m hall — the sign would
    // read as the building. Capping the height at 6 m keeps every board a
    // rooftop fixture rather than a tower.
    const boardH = Math.min(f.height * 0.6, 6);
    const boardW = boardH / AD_POSTER_ASPECT;
    const board = MeshBuilder.CreatePlane(
      `${f.id}_adBoard`,
      { width: boardW, height: boardH },
      scene
    );
    board.parent = root;
    // Set back from the parapet so the hoarding reads as standing ON the roof
    // rather than growing out of the facade, and raised by its own half-height
    // because a plane's origin is its centre.
    board.position.set(0, f.height + 0.65 + boardH / 2, -(f.depth / 2 - 1.2));
    // ry = PI for the same reason as the upper-storey windows: Babylon's plane
    // faces +Z by default and local -Z is the plaza.
    board.rotation.y = Math.PI;
    board.material = adPoster;

    // Support legs, so it does not float. Thin, dark, and deliberately sparse.
    for (const side of [-1, 1]) {
      const leg = MeshBuilder.CreateBox(
        `${f.id}_adLeg`,
        { width: 0.16, height: boardH * 0.55, depth: 0.16 },
        scene
      );
      leg.parent = root;
      leg.position.set(side * boardW * 0.36, f.height + 0.4, -(f.depth / 2 - 1.2));
      leg.material = mats.metal;
    }
  }

  // ---- Storefront -------------------------------------------------------
  // Hall of Minds is marble and monumental: pilasters + grand entrance, no
  // retail shopfront glazing. Everyone else gets the emissive glass plane.
  //
  // CRITICAL: window_bay / entrance are FRAMES WITH OPEN APERTURES — no glass
  // in the glb on purpose. This emissive plane stays forever; kit frames mount
  // a few cm proud of it so the glow reads through the openings. Delete this
  // plane and every shopfront goes dark.
  const glassH = Math.min(4.2, f.height - 1.6);
  const wantsStorefrontGlass = !f.marble;
  const parts: Mesh[] = [shell, parapet];

  if (wantsStorefrontGlass) {
    const glass = MeshBuilder.CreatePlane(
      `${f.id}_glass`,
      { width: f.width - 1.4, height: glassH },
      scene
    );
    glass.parent = root;
    glass.position.set(0, glassH / 2 + 0.35, -(f.depth / 2 + 0.04));
    // No yaw: a plane's front face is its −Z side, already toward the plaza.
    // (The old ry=π only worked because the holo fallback is double-sided.)
    // Real glazing when the texture set shipped: near-black, glossy, with a
    // faint accent emissive so each shop keeps its identity colour at a
    // distance without reading as a light box in daylight. The old flat
    // accent-glow holoMat remains as the no-texture fallback.
    if (mats.brick) {
      glass.material = storefrontGlazing(scene, mats, f.accent);
    } else {
      glass.material = holoMat(scene, mats, f.accent.scale(0.55), 0.42);
    }
    parts.push(glass);
  }

  // NOTE: the storefronts used to spill an emissive accent disc onto the
  // pavement here. Cut — at dusk it read as light through glass, but under
  // midday sun an unexplained glowing circle in front of every door read as a
  // rendering artefact, not as illumination.

  // Kit sign plate on every enclosed building — the charcoal panel is the
  // mount for the procedural function glyph. Readable text never ships
  // (concept manifest).
  //
  // The plate HANGS OFF THE WALL, perpendicular to the facade near the front
  // corner, like a real projecting shop sign — flat on the wall above the
  // entrance it read as a decal plate, and edge-on it was invisible from
  // along the ring road. ry = π/2 swings the plate's baked width onto Z, so
  // it projects from the facade; the inner edge stays ~0.25 m inside the
  // wall face so it reads as mounted, not floating.
  //
  // Sole-on-ground bake → y is the plate's BOTTOM. "Above the glass" alone is
  // not enough: the panel is ~2.1 m tall, so on the two low buildings glassH +
  // 0.55 pushed its top through their own roofline — 6.84 m of sign on a 6.5 m
  // coffee shop, straight into the parapet lip. Clamp so the panel always
  // finishes under the parapet, and let the glyph follow it down.
  //
  // With no authored plate the same clamp still applies, against 1.7 m — the
  // span the fallback glyph plane occupies below — so a plate-less facade does
  // not hang its glyph over the parapet either.
  const bracketH = kit.signBracket ? meshExtent(kit.signBracket, "y") : 1.7;
  const bracketY = Math.min(glassH + 0.55, f.height - bracketH - 0.2);
  let bracket: SignPlateMount | null = null;
  if (kit.signBracket) {
    const plateW = meshExtent(kit.signBracket, "x");
    const plateD = meshExtent(kit.signBracket, "z");
    const signX = f.width / 2 - 0.9;
    const plateZ = -(f.depth / 2) - plateW / 2 + 0.25;
    pushKit(kitPlacements.signBracket, root, {
      x: signX,
      y: bracketY,
      z: plateZ,
      ry: Math.PI / 2,
    });
    bracket = {
      x: signX,
      z: plateZ,
      halfThickness: plateD / 2,
      centreY: bracketY + bracketH / 2,
    };
  }

  parts.push(...mountFacilitySignage(scene, mats, root, f, { glassH, bracketY, bracket }));

  // Plaza-facing dress only — never ring the building. Local −Z is the front
  // (root already faces the plaza). Frames sit at frontZ, a few cm proud of the
  // glass plane (−depth/2 − 0.04) to avoid z-fighting while staying flush-looking.
  const frontZ = -(f.depth / 2 + 0.12);
  const entranceHalfW = dressFacade(f, root, kit, kitPlacements, frontZ);

  // A real door in the entrance aperture. The kit entrance is a frame with an
  // OPEN aperture (see the storefront note above); until now what showed
  // through it was the glow plane or bare brick — a shop with no way in. The
  // panel sits at −0.07: behind the frame (−0.12), proud of the glass (−0.04)
  // and the shell face (−depth/2), so nothing z-fights.
  const doorMat = facadeMaterial(scene, mats, "door");
  if (entranceHalfW > 0 && doorMat) {
    // 0.575 is the door texture's aspect (736x1280); clamp to the measured
    // aperture so a narrow entrance stretches the texture slightly rather
    // than poking the door through its own frame.
    const doorH = 2.9;
    const doorW = Math.min(doorH * 0.575, entranceHalfW * 2 * 0.8);
    const door = MeshBuilder.CreatePlane(
      `${f.id}_doorPanel`,
      { width: doorW, height: doorH },
      scene
    );
    door.parent = root;
    door.position.set(0, doorH / 2, -(f.depth / 2 + 0.07));
    // No yaw: a plane's front face is its −Z side, already toward the plaza.
    door.material = doorMat;
    parts.push(door);
  }

  // Lit window grid so multi-floor shells do not read as blank slabs.
  //
  // Where the grid STARTS depends on whether the ground floor is already busy.
  // A retail front is full of glazing, so windows begin above the shopfront. The
  // non-retail fronts had nothing but a ~2.5 m door on a 13-18 m facade — over
  // 80% blank wall at eye level, which is exactly what reads as "unfinished".
  // Those start almost at the pavement instead, with the door column masked out
  // so no window lands on top of the entrance.
  if (f.height > 5.5) {
    const glassTop = wantsStorefrontGlass ? glassH + 0.35 : 1.1;
    const doorGuard = wantsStorefrontGlass
      ? undefined
      : { maxY: 3.9, halfW: entranceHalfW + 0.5 };
    buildUpperStoreys(scene, mats, root, f, glassTop, doorGuard);
  }

  // ---- Per-facility fixtures -------------------------------------------
  switch (f.id) {
    case "outfitter":
      parts.push(...buildHoloRacks(scene, mats, root, f));
      break;
    case "style-lab":
      parts.push(...(await buildCatwalk(scene, mats, root, f)));
      break;
    case "hall-of-minds":
      parts.push(...buildHallOfMinds(scene, mats, root, f));
      break;
    case "queue-terminal":
      parts.push(...(await buildQueueTerminal(scene, mats, root, f, kit, kitPlacements)));
      break;
    case "coffee-shop":
      parts.push(...(await buildCoffeeShop(scene, mats, root, f, kit, kitPlacements)));
      break;
  }

  root.freezeWorldMatrix();
  for (const m of parts) m.freezeWorldMatrix();
  return [];
}

/**
 * Per-building kit assignment on the plaza-facing face only.
 *
 *  - outfitter / style-lab / coffee-shop: tiled window bays + entrance
 *  - hall-of-minds: pilasters (no bays) + entrance — marble frontage
 *  - queue-terminal / residential: entrance only (no retail glazing frames)
 *  - every roofed building: parapet cap along the front roofline + one HVAC
 */
function dressFacade(
  f: Facility,
  root: TransformNode,
  kit: VillageKit,
  kitPlacements: KitPlacements,
  frontZ: number
): number {
  const retail =
    f.id === "outfitter" || f.id === "style-lab" || f.id === "coffee-shop";
  // Every enclosed building needs a visible door. Open-air facilities skip
  // this function entirely.
  const wantsEntrance = true;
  const wantsPilasters = f.id === "hall-of-minds";
  const wantsBays = retail;

  // ---- Entrance (center) ------------------------------------------------
  let entranceHalfW = 0;
  if (wantsEntrance && kit.entrance) {
    entranceHalfW = meshExtent(kit.entrance, "x") / 2;
    pushKit(kitPlacements.entrance, root, { x: 0, y: 0, z: frontZ });
  }

  // ---- Window bays, packed out from the entrance ------------------------
  // Bays are frames; glow comes from `${f.id}_glass` behind them. Tile by
  // measured baked width so a proportion change in the glb still fits.
  if (wantsBays && kit.storefrontBay) {
    const bayW = meshExtent(kit.storefrontBay, "x");
    const margin = 0.35;
    const halfFace = f.width / 2 - margin;
    // How many bays fit on one side of the entrance (or of centre if no door).
    const sideRoom = halfFace - entranceHalfW - 0.1;
    const nPerSide = Math.max(1, Math.floor(sideRoom / bayW));
    for (const side of [-1, 1]) {
      for (let i = 0; i < nPerSide; i++) {
        const x = side * (entranceHalfW + 0.12 + bayW * (i + 0.5));
        if (Math.abs(x) + bayW / 2 > halfFace + 0.15) continue;
        // y=0: sole-on-ground bake; bay height 4.2 covers glassH (~4.2).
        pushKit(kitPlacements.storefrontBay, root, { x, y: 0, z: frontZ });
      }
    }
  }

  // ---- Hall of Minds pilasters ------------------------------------------
  // Spaced across the marble frontage; glass plane still glows between them.
  if (wantsPilasters && kit.pilaster) {
    const pilW = meshExtent(kit.pilaster, "x");
    const span = f.width - 1.2;
    // Five columns match the five statues inside — one full team (doc 01).
    const count = 5;
    const step = span / (count - 1);
    for (let i = 0; i < count; i++) {
      const x = -span / 2 + i * step;
      // Skip the centre slot if an entrance sits there, so the door stays clear.
      if (entranceHalfW > 0 && Math.abs(x) < entranceHalfW + pilW * 0.35) continue;
      pushKit(kitPlacements.pilaster, root, { x, y: 0, z: frontZ });
    }
  }

  // ---- Parapet cap along the front roofline -----------------------------
  if (kit.parapetCap) {
    const capW = meshExtent(kit.parapetCap, "x");
    const n = Math.max(1, Math.round(f.width / capW));
    const step = f.width / n;
    for (let i = 0; i < n; i++) {
      const x = -f.width / 2 + step * (i + 0.5);
      // Sole on the shell top; cap height 0.45 matches the procedural lip.
      pushKit(kitPlacements.parapetCap, root, {
        x,
        y: f.height,
        z: -(f.depth / 2),
      });
    }
  }

  // ---- HVAC on the roof -------------------------------------------------
  // One cluster per flat roof, set back from the plaza edge so it reads as
  // rooftop plant rather than a cornice ornament.
  if (kit.hvac) {
    pushKit(kitPlacements.hvac, root, {
      x: f.width * 0.18,
      y: f.height + 0.45,
      z: f.depth * 0.12,
    });
  }

  // Reported so `buildUpperStoreys` can keep its ground-floor row clear of the
  // doorway rather than hanging a lit window over the entrance.
  return entranceHalfW;
}

/** Outfitter: rotating holo display racks behind the glass (V1/V2 panel 1). */
function buildHoloRacks(scene: Scene, mats: Mats, root: TransformNode, f: Facility): Mesh[] {
  const out: Mesh[] = [];
  const mat = holoMat(scene, mats, PALETTE.cyan, 0.8);
  for (let i = 0; i < 3; i++) {
    const rack = MeshBuilder.CreateBox(`${f.id}_rack${i}`, { width: 1.5, height: 2.4, depth: 0.1 }, scene);
    rack.parent = root;
    rack.position.set(-3.6 + i * 3.6, 1.55, -(f.depth / 2 - 1.4));
    rack.material = mat;
    out.push(rack);

    const plinth = MeshBuilder.CreateCylinder(
      `${f.id}_plinth${i}`,
      { diameter: 1.7, height: 0.25, tessellation: 20 },
      scene
    );
    plinth.parent = root;
    plinth.position.set(-3.6 + i * 3.6, 0.12, -(f.depth / 2 - 1.4));
    plinth.material = holoMat(scene, mats, VILLAGE.magenta, 0.9);
    out.push(plinth);
  }
  return out;
}

/** Style Lab: a short glowing catwalk with hologram mannequins (V2 panel 2). */
async function buildCatwalk(
  scene: Scene,
  mats: Mats,
  root: TransformNode,
  f: Facility
): Promise<Mesh[]> {
  const out: Mesh[] = [];
  const strip = MeshBuilder.CreateBox(`${f.id}_catwalk`, { width: 2.2, height: 0.12, depth: 6.5 }, scene);
  strip.parent = root;
  strip.position.set(0, 0.3, -(f.depth / 2 - 3.6));
  strip.material = holoMat(scene, mats, VILLAGE.magenta, 0.85);
  out.push(strip);

  // Authored silhouette, holographic material (V6): the bake is thrown away on
  // purpose — these are projections, and a projection is its outline. One load,
  // one clone; a clone shares geometry but takes its own material, which is the
  // whole point (cyan and magenta, as the capsules were).
  const authored = await loadVillageProp(
    scene,
    "/assets/village/mannequin.glb",
    `${f.id}_mannequin0`,
    { axis: "height", metres: MANNEQUIN_HEIGHT, limits: { width: 1.2, depth: 1.2 } },
    MANNEQUIN_MODEL_YAW
  );

  // Capsule bottoms sat on the catwalk deck; the authored mesh is sole-baked,
  // so its y IS the deck height (0.3 centre + 0.06 half-thickness).
  const deckY = 0.36;
  if (authored) {
    const bake = authored.material;
    const pair = [authored, authored.clone(`${f.id}_mannequin1`)];
    // Cyan walks the catwalk inside; magenta works the street. The capsule era
    // parked the outside one dead-centre in the doorway, floating at deck
    // height — unreadable as a pill, absurd as a person. Beside the entrance,
    // soles on the pavement.
    const spots: Array<[number, number, number]> = [
      [0, deckY, -(f.depth / 2 - 1.8)],
      [2.3, 0, -(f.depth / 2 + 1.4)],
    ];
    pair.forEach((m, i) => {
      m.parent = root;
      m.material = holoMat(scene, mats, i === 0 ? PALETTE.cyan : VILLAGE.magenta, 0.55);
      m.position.set(...spots[i]!);
      out.push(m);
    });
    // After both reassignments nothing references the bake — drop its textures
    // too, or every load pays ~350 KB of GPU memory for maps nobody samples.
    bake?.dispose(true, true);
  } else {
    for (let i = 0; i < 2; i++) {
      const mannequin = MeshBuilder.CreateCapsule(
        `${f.id}_mannequin${i}`,
        { height: 1.8, radius: 0.26, tessellation: 10, capSubdivisions: 3 },
        scene
      );
      mannequin.parent = root;
      mannequin.position.set(0, 1.28, -(f.depth / 2 - 1.8) - i * 3.0);
      mannequin.material = holoMat(scene, mats, i === 0 ? PALETTE.cyan : VILLAGE.magenta, 0.55);
      out.push(mannequin);
    }
  }
  return out;
}

/**
 * Hall of Minds: leaderboard columns + luminous statues of top seasonal teams
 * (doc 01, doc 05). The statues are the reward loop made physical — the reason
 * this building faces the plaza head-on with the widest frontage in the block.
 */
function buildHallOfMinds(scene: Scene, mats: Mats, root: TransformNode, f: Facility): Mesh[] {
  const out: Mesh[] = [];
  const statueMat = holoMat(scene, mats, PALETTE.cyan.scale(0.85), 0.6);
  const plinthMat = mats.marble;

  // Five statues = one full team, the maximum party size (doc 01).
  for (let i = 0; i < 5; i++) {
    const x = -6.4 + i * 3.2;
    const plinth = MeshBuilder.CreateBox(`${f.id}_plinth${i}`, { width: 1.2, height: 0.7, depth: 1.2 }, scene);
    plinth.parent = root;
    plinth.position.set(x, 0.35, -(f.depth / 2 - 2.2));
    plinth.material = plinthMat;
    out.push(plinth);

    const statue = MeshBuilder.CreateCapsule(
      `${f.id}_statue${i}`,
      { height: 2.0, radius: 0.3, tessellation: 10, capSubdivisions: 3 },
      scene
    );
    statue.parent = root;
    statue.position.set(x, 1.7, -(f.depth / 2 - 2.2));
    statue.material = statueMat;
    out.push(statue);
  }

  // Leaderboard columns flanking the entrance.
  for (let i = 0; i < 2; i++) {
    const col = MeshBuilder.CreateBox(`${f.id}_board${i}`, { width: 0.9, height: 5.5, depth: 0.2 }, scene);
    col.parent = root;
    col.position.set(i === 0 ? -8.2 : 8.2, 3.0, -(f.depth / 2 + 0.06));
    col.material = holoMat(scene, mats, PALETTE.cyan, 0.85);
    out.push(col);
  }
  return out;
}

/**
 * Queue Terminal: rooftop platform reached by an exterior stair, with the big
 * holographic boss-selection screen (doc 01, V1 aerial right-hand side).
 *
 * Stair + deck rails prefer the kit modules; procedural step boxes / rail bars
 * remain as fallbacks so a missing kit/ folder still reads as a terminal.
 */
/**
 * Yaw of the generated queue-board glb's display face relative to facility
 * local -Z (the plaza side). Same visually-calibrated-constant pattern as
 * FREUD_MODEL_YAW: tripo does not document facing, so if the board shows the
 * plaza its housing, fix it HERE in multiples of PI/2.
 */
const QUEUE_BOARD_MODEL_YAW = -Math.PI / 2;

async function buildQueueTerminal(
  scene: Scene,
  mats: Mats,
  root: TransformNode,
  f: Facility,
  kit: VillageKit,
  kitPlacements: KitPlacements
): Promise<Mesh[]> {
  const out: Mesh[] = [];
  const roofY = f.height + 0.45;

  // Rooftop deck.
  const deck = MeshBuilder.CreateBox(`${f.id}_deck`, { width: f.width - 1, height: 0.2, depth: f.depth - 1 }, scene);
  deck.parent = root;
  deck.position.set(0, roofY + 0.1, 0);
  deck.material = mats.metal;
  out.push(deck);

  // The big queue-status board — the hub's focal point. Preferred tier is the
  // generated prop (gpt-image-2 concept → tripo, assets/work/village/
  // queue-board/): a framed billboard on two posts whose display face carries
  // the queue UI in its albedo. The bake alone would read as a switched-off
  // TV under the day light, so the albedo is re-used as emissive: green UI
  // texels glow, the charcoal frame texels multiply to ~nothing. Intensity
  // stays under the double-expose threshold the concept-sheet rules warn
  // about — the glow layer + bloom pick up only the brightest UI marks.
  const board = await loadVillageProp(
    scene,
    "/assets/village/queue_board.glb",
    `${f.id}_board`,
    // Drive the visible axis to the old 9 m screen + frame margin; the guard
    // caps the other two where the silhouette would stop reading as a slim
    // rooftop billboard (panel ~5 m + posts, thin housing).
    { axis: "width", metres: 9.6, limits: { height: 8.2, depth: 3.2 } },
    QUEUE_BOARD_MODEL_YAW
  );
  if (board) {
    board.parent = root;
    // Soled at y=0 by the loader, so the post feet stand on the deck top.
    board.position.set(0, roofY + 0.2, -1.5);
    const mat = board.material;
    if (mat instanceof PBRMaterial) {
      mat.emissiveTexture = mat.albedoTexture;
      // Kept low: the emissive rides the WHOLE albedo, so the mid-gray housing
      // texels glow at ~a third of the UI green's strength — at 1.15 the back
      // of the board read as a single blown-out pale slab from the plaza.
      mat.emissiveColor = new Color3(0.42, 0.8, 0.55);
      mat.emissiveIntensity = 0.65;
    }
    out.push(board);
  } else {
    // Procedural fallback: flat holo plane + rectangle frame.
    const screen = MeshBuilder.CreatePlane(`${f.id}_screen`, { width: 9, height: 5 }, scene);
    screen.parent = root;
    screen.position.set(0, roofY + 3.4, -1.5);
    screen.rotation.y = Math.PI;
    screen.material = holoMat(scene, mats, PALETTE.cyan.scale(0.8), 0.55);
    out.push(screen);

    const screenFrame = MeshBuilder.CreateTorus(
      `${f.id}_screenFrame`,
      { diameter: 9.6, thickness: 0.08, tessellation: 4 },
      scene
    );
    screenFrame.parent = root;
    screenFrame.rotation.set(Math.PI / 2, Math.PI / 4, 0);
    screenFrame.scaling.set(1, 1, 0.56);
    screenFrame.position.set(0, roofY + 3.4, -1.4);
    screenFrame.material = holoMat(scene, mats, PALETTE.cyan);
    out.push(screenFrame);
  }

  // Deck railing — kit sections tiled along front + back edges; procedural
  // magenta bars if the glb is missing.
  if (kit.railing) {
    const railW = meshExtent(kit.railing, "x");
    const deckW = f.width - 1;
    const n = Math.max(1, Math.round(deckW / railW));
    const step = deckW / n;
    for (const zEdge of [-(f.depth / 2 - 0.5), f.depth / 2 - 0.5]) {
      for (let i = 0; i < n; i++) {
        const x = -deckW / 2 + step * (i + 0.5);
        // Sole on the deck; baked height 1.05 matches the old rail top.
        // Back edge faces the opposite way so the posts sit outside the deck.
        const ry = zEdge > 0 ? Math.PI : 0;
        pushKit(kitPlacements.railing, root, { x, y: roofY, z: zEdge, ry });
      }
    }
  } else {
    const railMat = holoMat(scene, mats, VILLAGE.magenta, 0.9);
    for (let i = 0; i < 2; i++) {
      const rail = MeshBuilder.CreateBox(
        `${f.id}_rail${i}`,
        { width: f.width - 1, height: 0.08, depth: 0.08 },
        scene
      );
      rail.parent = root;
      rail.position.set(0, roofY + 1.05, i === 0 ? -(f.depth / 2 - 0.5) : f.depth / 2 - 0.5);
      rail.material = railMat;
      out.push(rail);
    }
  }

  // Exterior stair, plaza-facing left edge. Kit flight replaces 14 step boxes.
  if (kit.stair) {
    const run = meshExtent(kit.stair, "z");
    const stairW = meshExtent(kit.stair, "x");
    // Bottom of the run near the plaza face; climbs +Z toward the deck.
    pushKit(kitPlacements.stair, root, {
      x: -(f.width / 2 + stairW * 0.55 + 0.3),
      y: 0,
      z: -(f.depth / 2) + run * 0.5,
    });
  } else {
    const steps = 14;
    const rise = roofY / steps;
    for (let i = 0; i < steps; i++) {
      const step = MeshBuilder.CreateBox(
        `${f.id}_step${i}`,
        { width: 2.4, height: 0.14, depth: 0.55 },
        scene
      );
      step.parent = root;
      step.position.set(-(f.width / 2 + 1.6), rise * (i + 1), -(f.depth / 2) + 0.55 * i + 0.3);
      step.material = mats.metal;
      out.push(step);
    }
  }
  return out;
}

/** Coffee shop: warm interior, awning, outdoor seating (V1 left, V3 left). */
async function buildCoffeeShop(
  scene: Scene,
  mats: Mats,
  root: TransformNode,
  f: Facility,
  kit: VillageKit,
  kitPlacements: KitPlacements
): Promise<Mesh[]> {
  const out: Mesh[] = [];

  // Authored awning (depth-driven cantilever) or the procedural slab fallback.
  if (kit.awning) {
    // y ≈ under the upper facade; z centres the cantilever over the pavement
    // seating. Depth is already baked to 2.6 m.
    //
    // The awning's top (4.53) sits above the clamped sign-bracket sole (4.22) on
    // this 6.5 m facade, so the bottom 0.31 m of the sign panel is buried inside
    // the slab. That is intentional and reads correctly — a shop sign standing on
    // its awning. Do not "fix" it by raising the bracket: there is no room under
    // the parapet for both, which is what the clamp in `buildFacility` is about.
    const awningDepth = meshExtent(kit.awning, "z");
    pushKit(kitPlacements.awning, root, {
      x: 0,
      y: 3.9,
      z: -(f.depth / 2 + awningDepth * 0.45),
    });
  } else {
    const awning = MeshBuilder.CreateBox(
      `${f.id}_awning`,
      { width: f.width - 0.6, height: 0.22, depth: 2.6 },
      scene
    );
    awning.parent = root;
    awning.position.set(0, 4.0, -(f.depth / 2 + 1.2));
    awning.material = mats.shell;
    out.push(awning);
  }

  // The under-awning strip light — the warm anchor of the whole colour script.
  // Kept even when the kit awning lands: modules are matte; colour is emissive.
  const strip = MeshBuilder.CreateBox(`${f.id}_strip`, { width: f.width - 1.2, height: 0.09, depth: 0.09 }, scene);
  strip.parent = root;
  strip.position.set(0, 3.85, -(f.depth / 2 + 2.3));
  strip.material = holoMat(scene, mats, VILLAGE.warmLight);
  out.push(strip);

  // Pavement seating: authored cafe.glb is table+chair fused as one mesh. One
  // load, three instances — same draw-call discipline as the plaza props.
  // Name deliberately avoids the shadow denylist (`rim|win|strip|…`).
  const seatSrc = await loadVillageProp(
    scene,
    "/assets/village/cafe.glb",
    `${f.id}_seat`,
    { axis: "height", metres: 0.85 },
    CAFE_MODEL_YAW
  );

  const seatZ = -(f.depth / 2 + 2.6);
  if (seatSrc) {
    const seats: Placement[] = [];
    for (let i = 0; i < 3; i++) {
      seats.push({ x: -4.0 + i * 4.0, y: 0, z: seatZ, ry: 0 });
    }
    // Already freezeWorldMatrix'd inside placeMany; not pushed into `out`.
    placeMany(seatSrc, seats, root);
  } else {
    // Primitive stand-in: round table + single leg (pre-authored blockout).
    for (let i = 0; i < 3; i++) {
      const x = -4.0 + i * 4.0;
      const top = MeshBuilder.CreateCylinder(`${f.id}_table${i}`, { diameter: 1.0, height: 0.08, tessellation: 16 }, scene);
      top.parent = root;
      top.position.set(x, 0.74, seatZ);
      top.material = mats.metal;
      out.push(top);

      const leg = MeshBuilder.CreateCylinder(`${f.id}_leg${i}`, { diameter: 0.12, height: 0.72, tessellation: 8 }, scene);
      leg.parent = root;
      leg.position.set(x, 0.36, seatZ);
      leg.material = mats.metal;
      out.push(leg);
    }
  }
  return out;
}

/**
 * Lit upper-storey windows above the shopfront.
 *
 * One shared warm material + `placeMany` instances (one draw call per building).
 * Pattern is deterministic from the facility index — no RNG — so screenshot
 * diffs stay meaningful. Names use `upperLight` (shadow denylist) so flat wall
 * quads never cast and never z-fight the static shadow map with acne.
 */
function buildUpperStoreys(
  scene: Scene,
  mats: Mats,
  root: TransformNode,
  f: Facility,
  glassTop: number,
  /** Keep the doorway clear: skip any window below `maxY` within `halfW` of centre. */
  doorGuard?: { maxY: number; halfW: number }
): AbstractMesh[] {
  const headroom = f.height - glassTop - 0.5;
  if (headroom < 1.15) return [];

  const rows = Math.min(3, Math.max(1, Math.floor(headroom / 1.65)));
  const cols = Math.max(3, Math.round(f.width / 3.2));
  const facilityIndex = FACILITIES.findIndex((x) => x.id === f.id);
  const spanX = f.width - 2.0;
  const z = -(f.depth / 2 + 0.05);
  // Even vertical spacing so 2-row facades do not crowd the parapet.
  const rowStep = headroom / (rows + 0.35);
  const placements: Placement[] = [];

  // Photoreal window texture when the facade set shipped; warm emissive quad
  // otherwise. The distinction also drives the grid: textured windows fill
  // EVERY slot (a real building does not have missing windows), while the
  // emissive fallback keeps its deterministic "some lights are off" gaps —
  // dark quads read as lights out, absent quads read as wall.
  const windowMat = facadeMaterial(scene, mats, "window");

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!windowMat && (row * cols + col * 3 + facilityIndex * 5) % 5 === 2) continue;
      const x = cols === 1 ? 0 : -spanX / 2 + (spanX / (cols - 1)) * col;
      const y = glassTop + 0.75 + row * rowStep;
      if (y + 0.55 > f.height - 0.25) continue;
      if (doorGuard && y < doorGuard.maxY && Math.abs(x) < doorGuard.halfW) continue;
      // NO yaw. CreatePlane's front face is its −Z side (vertex normal is
      // (0,0,−1) — measured), and local −Z is already the plaza. The old ry=π
      // here presented the BACK face to the plaza, which the double-sided
      // emissive quads shrugged off and a backface-culled PBR window does not.
      placements.push({ x, y, z });
    }
  }
  if (placements.length === 0) return [];

  const mat = windowMat ?? holoMat(scene, mats, VILLAGE.warmLight.scale(0.42), 0.75);
  const src = MeshBuilder.CreatePlane(
    `${f.id}_upperLight`,
    // 1.45/1.065 matches the window texture's 1024x752 so panes stay square.
    { width: 1.45, height: 1.065 },
    scene
  );
  src.material = mat;
  return placeMany(src, placements, root);
}

/**
 * Tile a fence panel run along a line segment (facility-local).
 * Uses natural panel width; leftover length becomes end margin so panels never
 * stretch or stack on top of each other.
 */
function appendFenceRun(
  out: Placement[],
  panelW: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  ry: number
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < panelW * 0.55) return;
  const n = Math.max(1, Math.floor(len / panelW + 1e-4));
  const used = n * panelW;
  const margin = (len - used) * 0.5;
  const ux = dx / len;
  const uz = dz / len;
  for (let i = 0; i < n; i++) {
    const t = margin + panelW * (i + 0.5);
    out.push({ x: x0 + ux * t, y: 0, z: z0 + uz * t, ry });
  }
}

/**
 * Pet Park: turf, metal fence with plaza-side open entrance, glowing paw path,
 * roaming pets (doc 01). Fence/gate are tripo modules; pets stay inset so they
 * never sit on the fence line or in the entrance corridor.
 */
async function buildPetPark(scene: Scene, mats: Mats, root: TransformNode, f: Facility): Promise<void> {
  const parts: Mesh[] = [];

  const turf = MeshBuilder.CreateGround(`${f.id}_turf`, { width: f.width, height: f.depth }, scene);
  turf.parent = root;
  turf.position.y = 0.03;
  // Dark gray paving fills the park — the real ground texture set, pulled
  // well down toward charcoal so the pen reads as its own surface against
  // the plaza paving outside the fence. Falls back to a flat dark gray if
  // the texture set is absent (same degrade rule as every ground surface).
  const paved = groundMaterial(scene, mats, "paving", Math.max(f.width, f.depth));
  if (paved) {
    const dark = paved.clone(`${f.id}_turfDark`);
    dark.albedoColor = new Color3(0.34, 0.34, 0.36);
    turf.material = dark;
  } else {
    const dark = new PBRMaterial(`${f.id}_turfDark`, scene);
    dark.albedoColor = new Color3(0.16, 0.16, 0.175);
    dark.metallic = 0.1;
    dark.roughness = 0.9;
    turf.material = dark;
  }
  parts.push(turf);

  const halfW = f.width * 0.5;
  const halfD = f.depth * 0.5;
  // Plaza-facing edge is local −Z (root already faces the plaza).
  const frontZ = -halfD;
  const backZ = halfD;

  // Metal fence panel: length-on-Z in the unit box → KIT_FACE_YAW puts length on X.
  const fenceSrc = await loadVillageProp(
    scene,
    "/assets/village/pet_fence.glb",
    `${f.id}_fencePanel`,
    { axis: "height", metres: PET_FENCE_HEIGHT, limits: { depth: 0.55 } },
    PET_FENCE_MODEL_YAW
  );
  // Gate posts pair: drive width so the entrance is player-walkable (~3 m).
  const gateSrc = await loadVillageProp(
    scene,
    "/assets/village/pet_gate.glb",
    `${f.id}_gate`,
    { axis: "width", metres: PET_GATE_WIDTH, limits: { height: 2.8, depth: 1.2 } },
    PET_FENCE_MODEL_YAW
  );

  const panelW = fenceSrc ? meshExtent(fenceSrc, "x") : 1.45;
  // Match the gap to the real gate footprint so panels stop cleanly at the posts.
  const gateW = gateSrc ? meshExtent(gateSrc, "x") : PET_GATE_WIDTH;
  const entranceHalf = Math.max(PET_ENTRANCE_GAP * 0.5, gateW * 0.5 + 0.15);

  const fencePlacements: Placement[] = [];
  // Front (−Z): two wings with open entrance for the paw path.
  appendFenceRun(fencePlacements, panelW, -halfW, frontZ, -entranceHalf, frontZ, 0);
  appendFenceRun(fencePlacements, panelW, entranceHalf, frontZ, halfW, frontZ, 0);
  // Back (+Z)
  appendFenceRun(fencePlacements, panelW, -halfW, backZ, halfW, backZ, Math.PI);
  // Sides — inset half a panel so corner posts do not double-stack on the fronts.
  const sideInset = panelW * 0.45;
  appendFenceRun(fencePlacements, panelW, -halfW, frontZ + sideInset, -halfW, backZ - sideInset, Math.PI / 2);
  appendFenceRun(fencePlacements, panelW, halfW, frontZ + sideInset, halfW, backZ - sideInset, -Math.PI / 2);

  if (fenceSrc && fencePlacements.length > 0) {
    placeMany(fenceSrc, fencePlacements, root);
  } else {
    // Procedural metal-looking rails if the glb is missing.
    const fenceMat = new PBRMaterial(`${f.id}_fenceMat`, scene);
    fenceMat.albedoColor = new Color3(0.12, 0.13, 0.15);
    fenceMat.metallic = 0.85;
    fenceMat.roughness = 0.35;
    for (const p of fencePlacements.length
      ? fencePlacements
      : [
          { x: 0, y: 0, z: frontZ, ry: 0 },
          { x: 0, y: 0, z: backZ, ry: Math.PI },
          { x: -halfW, y: 0, z: 0, ry: Math.PI / 2 },
          { x: halfW, y: 0, z: 0, ry: -Math.PI / 2 },
        ]) {
      const rail = MeshBuilder.CreateBox(
        `${f.id}_fence`,
        { width: panelW, height: PET_FENCE_HEIGHT, depth: 0.08 },
        scene
      );
      rail.parent = root;
      rail.position.set(p.x, PET_FENCE_HEIGHT * 0.5, p.z);
      rail.rotation.y = p.ry ?? 0;
      rail.material = fenceMat;
      parts.push(rail);
    }
  }

  if (gateSrc) {
    gateSrc.parent = root;
    gateSrc.position.set(0, 0, frontZ);
    gateSrc.rotation.y = 0;
    parts.push(gateSrc);
  } else {
    // Two cyan-capped posts marking the open entrance.
    const postMat = new PBRMaterial(`${f.id}_gatePostMat`, scene);
    postMat.albedoColor = new Color3(0.1, 0.11, 0.13);
    postMat.metallic = 0.9;
    postMat.roughness = 0.3;
    for (const sx of [-entranceHalf + 0.15, entranceHalf - 0.15]) {
      const post = MeshBuilder.CreateBox(
        `${f.id}_gatePost`,
        { width: 0.18, height: 1.35, depth: 0.18 },
        scene
      );
      post.parent = root;
      post.position.set(sx, 0.675, frontZ);
      post.material = postMat;
      parts.push(post);
      const cap = MeshBuilder.CreateBox(`${f.id}_gateCap`, { width: 0.22, height: 0.06, depth: 0.22 }, scene);
      cap.parent = root;
      cap.position.set(sx, 1.38, frontZ);
      cap.material = holoMat(scene, mats, PALETTE.cyan, 0.9);
      parts.push(cap);
    }
  }

  // Glowing paw path leading in from the plaza through the open entrance.
  const pawMat = holoMat(scene, mats, PALETTE.cyan, 0.6);
  for (let i = 0; i < 6; i++) {
    const paw = MeshBuilder.CreateDisc(`${f.id}_paw${i}`, { radius: 0.22, tessellation: 10 }, scene);
    paw.parent = root;
    paw.rotation.x = Math.PI / 2;
    paw.position.set(i % 2 === 0 ? -0.35 : 0.35, 0.06, frontZ - 0.8 - i * 1.1);
    paw.material = pawMat;
    parts.push(paw);
  }

  for (let i = 0; i < PET_PARK_ROSTER.length; i++) {
    const pet = PET_PARK_ROSTER[i]!;
    // Every pet faces the plaza centre. Canon face-along-−Z means a mesh at
    // world (x, z) looks at the origin with world yaw atan2(x, z) (facingIn's
    // forward (−sin y, −cos y) solved for forward ∝ (−x, −z)); subtract the
    // park root's own yaw to express that as the local ry the parent applies.
    const world = Vector3.TransformCoordinates(
      new Vector3(pet.x, 0, pet.z),
      root.computeWorldMatrix(true)
    );
    const faceCentre = Math.atan2(world.x, world.z) - root.rotation.y;
    const mesh = await loadVillageProp(
      scene,
      `/assets/village/${pet.file}`,
      `${f.id}_${pet.key}`,
      { axis: "height", metres: pet.height },
      pet.modelYaw
    );
    if (mesh) {
      mesh.parent = root;
      mesh.position.set(pet.x, 0, pet.z);
      mesh.rotation.y = faceCentre;
      parts.push(mesh);
    } else {
      const body = MeshBuilder.CreateCapsule(
        `${f.id}_pet${i}`,
        { height: 0.7, radius: 0.2, tessellation: 8, capSubdivisions: 2 },
        scene
      );
      body.parent = root;
      body.rotation.z = Math.PI / 2;
      body.rotation.y = faceCentre;
      body.position.set(pet.x, 0.45, pet.z);
      body.material = holoMat(scene, mats, pet.fallback, 0.9);
      parts.push(body);
    }
  }

  root.freezeWorldMatrix();
  for (const m of parts) m.freezeWorldMatrix();
}

/**
 * Practice Booth: open-air kiosk with the shape-shifting holo training dummy
 * (doc 01; concept `arena/A4_target_dummy.png`).
 *
 * The dummy pulses through the four life-stage holograms — the visual promise
 * of "practice phase-matching without a queue". It is the only animated
 * facility fixture, so it does NOT get frozen.
 */
async function buildPracticeBooth(
  scene: Scene,
  mats: Mats,
  root: TransformNode,
  f: Facility
): Promise<Ticker> {
  const parts: Mesh[] = [];

  const pad = MeshBuilder.CreateCylinder(`${f.id}_pad`, { diameter: f.width * 0.75, height: 0.16, tessellation: 24 }, scene);
  pad.parent = root;
  pad.position.y = 0.08;
  pad.material = mats.metal;
  parts.push(pad);

  const emitter = MeshBuilder.CreateTorus(`${f.id}_emitter`, { diameter: f.width * 0.72, thickness: 0.07, tessellation: 40 }, scene);
  emitter.parent = root;
  emitter.position.y = 0.2;
  emitter.material = holoMat(scene, mats, PALETTE.violet);
  parts.push(emitter);

  // The shelter structure — authored pavilion (thin charcoal roof on slim
  // posts), with the old post-and-slab primitives as the fallback. Either way
  // it reads "kiosk", not "building".
  const pavilion = await loadVillageProp(
    scene,
    "/assets/village/pavilion.glb",
    `${f.id}_pavilion`,
    { axis: "width", metres: PAVILION_WIDTH, limits: { height: 5.5, depth: 8 } },
    PAVILION_MODEL_YAW
  );
  if (pavilion) {
    pavilion.parent = root;
    // Same footprint the primitive canopy covered: centred on x, tucked to the
    // back edge of the lot so the open side faces the plaza.
    pavilion.position.set(0, 0, f.depth / 2 - 1.6);
    // Baked at p95 linear 0.093 — under the 0.12 dark bound
    // (check-kit-module.mjs). ×1.7 lands ~0.16, brushed-metal territory
    // alongside the hvac's 0.19: still charcoal, no longer a silhouette hole.
    if (pavilion.material instanceof PBRMaterial) {
      pavilion.material.albedoColor = pavilion.material.albedoColor.scale(1.7);
    }
    parts.push(pavilion);
  } else {
    for (let i = 0; i < 2; i++) {
      const post = MeshBuilder.CreateCylinder(`${f.id}_post${i}`, { diameter: 0.16, height: 3.4, tessellation: 8 }, scene);
      post.parent = root;
      post.position.set(i === 0 ? -f.width / 2 + 0.6 : f.width / 2 - 0.6, 1.7, f.depth / 2 - 0.6);
      post.material = mats.metal;
      parts.push(post);
    }
    const canopy = MeshBuilder.CreateBox(`${f.id}_canopy`, { width: f.width, height: 0.18, depth: f.depth * 0.6 }, scene);
    canopy.parent = root;
    canopy.position.set(0, 3.45, f.depth / 2 - 1.6);
    canopy.material = mats.shell;
    parts.push(canopy);
  }

  // A4's emitter drum under the hologram — unlike the figures this is a real
  // prop, so its bake stays and it joins the solid set. Dead centre on the pad.
  const projector = await loadVillageProp(
    scene,
    "/assets/village/projector.glb",
    `${f.id}_projector`,
    { axis: "height", metres: PROJECTOR_HEIGHT, limits: { width: 1.6, depth: 1.6 } },
    0
  );
  const padTop = 0.16;
  let lensY = padTop;
  if (projector) {
    projector.parent = root;
    projector.position.set(0, padTop, 0);
    parts.push(projector);
    // Sole-baked, so full height is 2x the bounding half-extent.
    lensY = padTop + projector.getBoundingInfo().boundingBox.extendSize.y * 2;
  }

  root.freezeWorldMatrix();
  for (const m of parts) m.freezeWorldMatrix();

  // The dummy itself — animated, deliberately not frozen. Authored silhouette
  // (V6) with the bake discarded: the booth has always cast a violet hologram,
  // now it casts one shaped like a person instead of a pill.
  const figure = await loadVillageProp(
    scene,
    "/assets/village/dummy_figure.glb",
    `${f.id}_dummy`,
    { axis: "height", metres: DUMMY_HEIGHT, limits: { width: 1.4, depth: 1.2 } },
    DUMMY_MODEL_YAW
  );
  figure?.material?.dispose(true, true);
  const dummy =
    figure ??
    MeshBuilder.CreateCapsule(
      `${f.id}_dummy`,
      { height: 1.9, radius: 0.34, tessellation: 12, capSubdivisions: 4 },
      scene
    );
  dummy.parent = root;
  // Authored mesh is sole-baked — feet park on the projector lens and stay
  // there under the stage scaling. The capsule keeps its centre origin.
  dummy.position.set(0, figure ? lensY : 1.15, 0);
  const dummyMat = new StandardMaterial(`${f.id}_dummyMat`, scene);
  dummyMat.disableLighting = true;
  dummyMat.emissiveColor = PALETTE.violet.clone();
  dummyMat.diffuseColor = Color3.Black();
  dummyMat.specularColor = Color3.Black();
  dummyMat.alpha = 0.55;
  dummyMat.backFaceCulling = false;
  dummy.material = dummyMat;

  // Four life-stage silhouettes on a slow cycle: the Regressor's age mechanic,
  // previewed. Scale-only for now; authored stage meshes replace this in M3.
  //
  // Driven by the scene's own elapsed clock (passed in by the caller), never by
  // `Date.now()` — a wall-clock animation resumes mid-stride after a tab is
  // backgrounded, and diverges between the two mirrored arenas in doc 04.
  const STAGE_HEIGHTS = [0.55, 0.75, 0.92, 1.0];
  const STAGE_SECONDS = 3;

  return {
    tick: (t: number) => {
      const h = STAGE_HEIGHTS[Math.floor(t / STAGE_SECONDS) % STAGE_HEIGHTS.length];
      dummy.scaling.set(h, h, h);
      // Sole-baked figure scales about its feet — height is constant. The
      // capsule scales about its centre, so it re-seats every stage.
      dummy.position.y = figure ? lensY : 1.15 * h;
      dummy.rotation.y = t * 0.4;
      dummyMat.alpha = 0.42 + (Math.sin(t * 3) * 0.5 + 0.5) * 0.22;
    },
  };
}

// ---------------------------------------------------------------------------
// Plaza props — instanced
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plaza prop scale targets (metres) — drive ONE axis, preserve model proportions.
// See assets/work/village/README.md Step 5. Tripo normalises into a unit box;
// forcing old primitive box dims would shear the authored meshes.
// ---------------------------------------------------------------------------

/** Near-cubic authored planter (~1.2 × 1.15 × 1.2). Was a 2.6 × 0.55 slab. */
const PLANTER_WIDTH = 1.2;
const PLANTER_HEIGHT = 1.15;
const TREE_HEIGHT = 5.0;
/**
 * Tree base sits at the planter soil line. Authored planter is ~1.15 m tall;
 * a slight sink keeps the trunk emerging from the soil rather than floating.
 */
const TREE_SOIL_Y = PLANTER_HEIGHT * 0.92;
const BENCH_HEIGHT = 0.45;

/**
 * Model-local yaw baked into each prop so placeMany's `ry` is pure layout
 * facing. Tripo pose is arbitrary per asset — calibrate here if something
 * walks/sits sideways (same pattern as FREUD_MODEL_YAW).
 */
const TREE_MODEL_YAW = 0;
const PLANTER_MODEL_YAW = 0;
/** Bench long axis is model +X; placeMany already spins seats to face centre. */
const BENCH_MODEL_YAW = 0;
/**
 * Cafe pair: chair sits toward +Z in the unit box. Facility local −Z faces
 * the plaza, so zero yaw puts the chair on the storefront side of the table.
 */
const CAFE_MODEL_YAW = 0;
/** Crowd pedestrians — hero-scale civilians, a shade under Freud's 1.8 m. */
const VILLAGER_HEIGHT = 1.72;
/**
 * The villager set ships +Z-forward like the shop NPC set (screenshot-
 * calibrated: at 0 the whole crowd turns its back on the plaza) — π bakes it
 * to the face-along-−Z canon so `ry` is pure layout.
 */
const VILLAGER_MODEL_YAW = Math.PI;

/**
 * Practice-booth pavilion (tripo, villagers batch): thin charcoal roof slab on
 * two posts, driven by width across the booth. Caps per the kit lesson — a
 * cube-proportioned comeback would balloon a 9 m span into a 9 m tall hangar.
 */
const PAVILION_WIDTH = 9;
/** Ships long-axis-on-Z; π/2 lays the roof span across the booth's width. */
const PAVILION_MODEL_YAW = Math.PI / 2;

/**
 * V6 set (docs/design-prompts.md): the two humanoid fixtures, authored for
 * silhouette only — the tripo bake is discarded and engine holo/emissive
 * materials keep the "holographic projections by design" canon.
 */
const MANNEQUIN_HEIGHT = 1.8;
const MANNEQUIN_MODEL_YAW = Math.PI;
/**
 * A4 emitter drum under the practice hologram — a real prop, bake kept.
 * Height-driven: the generation came back 1.3:1 wide-to-tall against a prompt
 * demanding "much wider than tall" (aspect never transfers from text), so the
 * knee-height spec is the axis that holds and diameter follows.
 */
const PROJECTOR_HEIGHT = 0.5;
const DUMMY_HEIGHT = 1.9;
const DUMMY_MODEL_YAW = Math.PI;

/**
 * Plaza light bollard (concept `assets/work/village/bollard.png` → tripo):
 * slim charcoal post with a frosted slot + ring lens. Height-driven; the
 * width/depth caps reject a generation that came back squat — the fallback
 * cylinder is closer to canon than a fat bollard.
 */
const BOLLARD_HEIGHT = 0.92;
const BOLLARD_MODEL_YAW = 0;

/** Low metal park fence — length-on-Z unit box, same face yaw as kit railings. */
const PET_FENCE_MODEL_YAW = -Math.PI / 2;
/** Waist-high metal fence (doc 01 "low fences"). */
const PET_FENCE_HEIGHT = 0.95;
/**
 * Gate post pair driven by width so the entrance is walkable. Tripo's unit-box
 * aspect makes height follow (~2.2 m posts with cyan caps).
 */
const PET_GATE_WIDTH = 3.0;
/** Clear gap in the front fence (slightly wider than the gate footprint). */
const PET_ENTRANCE_GAP = 3.4;


/**
 * Trees, planters, benches and bollards.
 *
 * All of it is hardware instancing: one source mesh per prop type, N instances.
 * Twenty-four props across four types = FOUR draw calls and four copies of
 * vertex data. Authoring these as twenty-four separate meshes would be
 * twenty-four draw calls in the scene with the least gameplay in the game.
 *
 * Authored glbs replace the primitive stand-ins when present; each prop falls
 * back independently so an empty `public/assets/village/` still renders.
 */
async function buildPlazaProps(scene: Scene, mats: Mats): Promise<void> {
  // ---- Source meshes (authored, with primitive fallback) ----------------
  // Names are deliberate: the shadow-caster denylist is a regex on mesh.name
  // (`rim|win|strip|…`). Imported tripo UUIDs would match nothing useful and
  // a careless rename can silently stop a prop casting.
  const planterAuthored = await loadVillageProp(
    scene,
    "/assets/village/planter.glb",
    "planter",
    { axis: "width", metres: PLANTER_WIDTH },
    PLANTER_MODEL_YAW
  );
  // tree.glb is trunk + canopy as one mesh — collapses the old two-source path.
  const treeAuthored = await loadVillageProp(
    scene,
    "/assets/village/tree.glb",
    "plazaTree",
    { axis: "height", metres: TREE_HEIGHT },
    TREE_MODEL_YAW
  );
  const benchAuthored = await loadVillageProp(
    scene,
    "/assets/village/bench.glb",
    "bench",
    { axis: "height", metres: BENCH_HEIGHT },
    BENCH_MODEL_YAW
  );

  // Authored light-pillar bollard (concept → tripo); the bare emissive
  // cylinder remains as the fallback below.
  const bollardAuthored = await loadVillageProp(
    scene,
    "/assets/village/bollard.glb",
    "bollard",
    { axis: "height", metres: BOLLARD_HEIGHT, limits: { width: 0.5, depth: 0.5 } },
    BOLLARD_MODEL_YAW
  );

  // ---- Placement --------------------------------------------------------
  // Six planted trees on a hexagon inside the plaza rim, offset off the axes so
  // they never block the sightline from the plaza centre to a storefront.
  // Authored meshes are baked sole-on-ground (y=0 = bottom); primitives still
  // use centre-origin, so their placement y is half-height as before.
  const planters: Placement[] = [];
  const trees: Placement[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const r = PLAZA_RADIUS * 0.68;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    planters.push({ x, y: planterAuthored ? 0 : PLANTER_HEIGHT / 2, z, ry: a });
    trees.push({ x, y: TREE_SOIL_Y, z, ry: a });
  }

  if (planterAuthored) {
    placeMany(planterAuthored, planters);
  } else {
    const planterSrc = MeshBuilder.CreateBox(
      "planter",
      { width: PLANTER_WIDTH, height: PLANTER_HEIGHT, depth: PLANTER_WIDTH },
      scene
    );
    planterSrc.material = mats.shell;
    placeMany(planterSrc, planters);
  }

  if (treeAuthored) {
    placeMany(treeAuthored, trees);
  } else {
    // Primitive stand-in still splits trunk + canopy. Raised for the taller
    // planter so the trunk emerges from the soil line, not the pavement.
    const trunkSrc = MeshBuilder.CreateCylinder(
      "trunk",
      { diameterTop: 0.16, diameterBottom: 0.22, height: 2.4, tessellation: 8 },
      scene
    );
    trunkSrc.material = mats.foliage;
    // Ovoid baked into the geometry, not into `scaling`: instances do not
    // inherit their source's scale, so a scaled source would give six spherical
    // canopies and one squashed one.
    const canopySrc = MeshBuilder.CreateSphere(
      "canopy",
      { diameterX: 2.8, diameterY: 3.5, diameterZ: 2.8, segments: 8 },
      scene
    );
    canopySrc.material = mats.foliage;

    const trunks: Placement[] = [];
    const canopies: Placement[] = [];
    for (const t of trees) {
      // Trunk centre: soil + half height; canopy floats above.
      trunks.push({ x: t.x, y: TREE_SOIL_Y + 1.2, z: t.z });
      canopies.push({ x: t.x, y: TREE_SOIL_Y + 2.95, z: t.z, ry: t.ry });
    }
    placeMany(trunkSrc, trunks);
    placeMany(canopySrc, canopies);
  }

  // Benches face the plaza centre, between the trees.
  const benches: Placement[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = PLAZA_RADIUS * 0.82;
    benches.push({
      x: Math.sin(a) * r,
      y: benchAuthored ? 0 : BENCH_HEIGHT / 2,
      z: Math.cos(a) * r,
      ry: a + Math.PI / 2,
    });
  }
  if (benchAuthored) {
    placeMany(benchAuthored, benches);
  } else {
    const benchSrc = MeshBuilder.CreateBox(
      "bench",
      { width: 2.2, height: BENCH_HEIGHT, depth: 0.6 },
      scene
    );
    benchSrc.material = mats.shell;
    placeMany(benchSrc, benches);
  }

  // Bollards ring the plaza rim — the emissive dotted line in V1. The authored
  // body is matte (kit lesson: modules stay unlit, colour is engine emissive),
  // so a thin holo ring collar rides just under each cap to restore the glow —
  // from the rooftop orbit it reads as V1's dotted line. `ry` turns the frosted
  // front slot toward the plaza centre, same convention as facingIn.
  const bollards: Placement[] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const r = PLAZA_RADIUS + 0.6;
    bollards.push({
      x: Math.sin(a) * r,
      y: bollardAuthored ? 0 : 0.45,
      z: Math.cos(a) * r,
      ry: a,
    });
  }
  if (bollardAuthored) {
    placeMany(bollardAuthored, bollards);
    // Collar sized off the measured body so an off-proportion generation still
    // gets a lens that pokes just proud of the shaft instead of hiding inside.
    const bodyW = Math.max(meshExtent(bollardAuthored, "x"), meshExtent(bollardAuthored, "z"));
    // "strip" puts the ring on the shadow denylist (emissive, never a caster)
    // and the name misses SOLID_NAME's ^bollard, so no duplicate collider.
    const lensSrc = MeshBuilder.CreateCylinder(
      "lensStripBollard",
      { diameter: bodyW * 1.04, height: 0.045, tessellation: 12 },
      scene
    );
    lensSrc.material = holoMat(scene, mats, PALETTE.cyan.scale(0.8));
    placeMany(
      lensSrc,
      bollards.map((p) => ({ ...p, y: BOLLARD_HEIGHT * 0.87 }))
    );
  } else {
    const bollardSrc = MeshBuilder.CreateCylinder(
      "bollard",
      { diameter: 0.18, height: 0.9, tessellation: 8 },
      scene
    );
    bollardSrc.material = holoMat(scene, mats, PALETTE.cyan.scale(0.8));
    placeMany(bollardSrc, bollards);
  }
}

interface Placement {
  x: number;
  y: number;
  z: number;
  ry?: number;
}

/**
 * Place N copies of a mesh as one instanced batch.
 *
 * The FIRST placement moves the source mesh itself; the rest become instances
 * of it. That ordering matters. The tempting alternative — build the source at
 * the origin, instance everything, then `setEnabled(false)` the source to hide
 * it — is a trap: an InstancedMesh renders through its source mesh's draw call,
 * so disabling the source is a coin flip on whether the whole batch vanishes.
 * Making the source one of the visible props sidesteps the question entirely
 * and costs one fewer mesh.
 *
 * Optional `parent` keeps facility-local props (café seats) under their
 * facade root without converting to world space by hand.
 */
function placeMany(src: Mesh, placements: Placement[], parent?: TransformNode): AbstractMesh[] {
  const out: AbstractMesh[] = [];

  placements.forEach((p, i) => {
    const mesh: AbstractMesh = i === 0 ? src : src.createInstance(`${src.name}${i}`);
    if (parent) mesh.parent = parent;
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.ry ?? 0;
    out.push(mesh);
  });

  // Freeze AFTER positioning — freezing first bakes in the origin transform.
  for (const m of out) m.freezeWorldMatrix();
  return out;
}

/** Which bbox axis to drive when normalising a tripo unit-box prop. */
interface PropDrive {
  /** `depth` is for cantilever pieces (awning) whose player-facing scale is the projection from the wall. */
  axis: "height" | "width" | "depth";
  metres: number;
  /**
   * Upper bounds (metres) on the axes the drive does NOT set.
   *
   * The drive normalises one axis and the generated model's own proportions
   * decide the other two — deliberately, because forcing a full W×H×D would
   * shear it. The failure mode that buys is silent: a module whose proportions
   * came back wrong ships at the wrong shape, at the right height. That is how
   * the sign bracket reached 2.05 m tall against a 0.50 m authoring target
   * (`docs/design-prompts.md` "Authoring scale targets") and the awning reached
   * 1.03 m thick against 0.25 m — a slim bracket and a thin cantilever became
   * two big flat slabs on the facade.
   *
   * Caps are silhouette-breaking multiples of the target, not the target itself:
   * a coping 40 % thicker than specced still reads as coping, one four times
   * thicker does not. Tiled axes are deliberately uncapped — `dressFacade` tiles
   * by measured width, so a narrower parapet cap self-adapts and is not a bug.
   * Over a cap, the load is rejected and the caller keeps its procedural
   * stand-in, which is the correct shape by construction.
   */
  limits?: { width?: number; height?: number; depth?: number };
}

/**
 * Load a single-mesh village prop and bake it ready for `placeMany`.
 *
 * Returns null on failure so callers can fall back to the primitive stand-in
 * (same pattern as `buildFreud`). The bake is the whole point: InstancedMesh
 * does not inherit the source's scaling vector (see canopy comment above), so
 * every normalisation must land in the vertex buffer, not on `mesh.scaling`.
 */
export async function loadVillageProp(
  scene: Scene,
  url: string,
  name: string,
  drive: PropDrive,
  modelYaw = 0
): Promise<Mesh | null> {
  let result: Awaited<ReturnType<typeof ImportMeshAsync>> | undefined;
  try {
    result = await trackLoad(ImportMeshAsync(url, scene));
    // Each glb is one mesh under a loader root — hand the Mesh to placeMany,
    // never the TransformNode root.
    const geo = result.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    if (!geo) throw new Error(`no geometry mesh in ${url}`);

    geo.name = name;

    // Statues do not animate — drop the rig BEFORE anything is baked.
    //
    // Five of the park pets now ship as rigged, animated models (the follower
    // needs the rig; the park does not), and this function's whole method is
    // to bake the hierarchy into the vertices and then dispose the loader's
    // transform nodes — which for a skinned mesh means disposing the joints
    // out from under a skeleton the mesh still points at, leaving it to be
    // deformed by bones that no longer exist. Detaching first makes the mesh a
    // plain static one at its bind pose, which is exactly what a statue is.
    geo.skeleton = null;

    // ...and the clips with it. The glTF loader starts the first animation
    // group it finds, so importing rigged pets as statues left the hub playing
    // a walk cycle per park pet against joints this function is about to
    // dispose — invisible, since the mesh no longer follows the rig, and
    // billed every frame regardless. Disposing the skeletons too keeps the
    // "diorama is cheap" promise the freezeWorldMatrix pass below makes.
    for (const g of result.animationGroups) g.dispose();
    for (const sk of result.skeletons) sk.dispose();

    // Collapse the loader hierarchy (RH→LH root scale lives on the parent)
    // into vertices so the mesh is free-standing at identity.
    geo.bakeTransformIntoVertices(geo.computeWorldMatrix(true).clone());
    geo.parent = null;
    geo.position.setAll(0);
    geo.rotation.setAll(0);
    geo.scaling.setAll(1);
    geo.rotationQuaternion = null;

    for (const m of result.meshes) {
      if (m !== geo) m.dispose(false, false);
    }
    for (const t of result.transformNodes) t.dispose();

    // Model-local yaw before measuring: "width" must be the axis the player sees
    // after the pose correction (corgi in particular is camera-facing).
    if (modelYaw !== 0) {
      geo.rotation.y = modelYaw;
      geo.bakeCurrentTransformIntoVertices();
      geo.rotation.setAll(0);
    }

    // Baking rewrites the VERTICES but leaves the cached bounding info alone,
    // so every measurement below must follow an explicit refresh. Without the
    // first one, the width drive read the sign bracket's pre-yaw x-extent
    // (0.087 m — the panel's thin side) instead of its post-yaw 1.0 m, scaled
    // it 2.5/0.087 = 11x past target, and the proportion guard then rejected
    // it — stranding a 28 m black monolith at the plaza origin.
    geo.refreshBoundingInfo();
    const bounds = geo.getHierarchyBoundingVectors(true);
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    if (sizeX <= 1e-6 || sizeY <= 1e-6 || sizeZ <= 1e-6) {
      throw new Error(`degenerate bbox in ${url}`);
    }
    const s =
      drive.axis === "height"
        ? drive.metres / sizeY
        : drive.axis === "width"
          ? drive.metres / sizeX
          : drive.metres / sizeZ;

    // Uniform scale, then sole on the ground — same sit-down as buildFreudAuthored,
    // but baked so all N instances share it.
    geo.bakeTransformIntoVertices(Matrix.Scaling(s, s, s));
    geo.refreshBoundingInfo();
    const after = geo.getHierarchyBoundingVectors(true);
    geo.bakeTransformIntoVertices(Matrix.Translation(0, -after.min.y, 0));
    geo.refreshBoundingInfo();
    geo.name = name;

    // Proportion guard — see `PropDrive.limits`. Checked AFTER the bake, because
    // the drive is what turns a unit box into metres, and throwing here takes the
    // same fallback path as a missing file.
    if (drive.limits) {
      const b = geo.getHierarchyBoundingVectors(true);
      const got = {
        width: b.max.x - b.min.x,
        height: b.max.y - b.min.y,
        depth: b.max.z - b.min.z,
      };
      for (const axis of ["width", "height", "depth"] as const) {
        const cap = drive.limits[axis];
        if (cap !== undefined && got[axis] > cap) {
          throw new Error(
            `off-spec proportions: ${got[axis].toFixed(2)} m on ${axis} exceeds the ` +
              `${cap.toFixed(2)} m cap after driving ${drive.axis} to ${drive.metres} m ` +
              `(docs/design-prompts.md authoring targets)`
          );
        }
      }
    }

    return geo;
  } catch (err) {
    // A prop can be rejected AFTER a successful import (degenerate bbox,
    // off-spec proportions) — by then the loader's meshes are already in the
    // scene, unplaced at the origin. Dispose them, or every rejection leaks a
    // full-size mesh into the middle of the plaza.
    for (const m of result?.meshes ?? []) {
      if (!m.isDisposed()) m.dispose(false, true);
    }
    for (const t of result?.transformNodes ?? []) {
      if (!t.isDisposed()) t.dispose();
    }
    console.info(`[village] ${name} glb unavailable or rejected, using primitive:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Facade kit — nine architectural modules, one load each, instanced across
// every building that needs them. See assets/work/village/README.md phase 2.
// ---------------------------------------------------------------------------

/**
 * Source meshes for the facade kit. Null entry = glb failed; callers keep the
 * procedural stand-in for that piece so deleting public/assets/village/kit/
 * still leaves a working hub.
 *
 * Names are deliberate: the shadow-caster denylist matches `win` inside
 * "window_bay", so the bay is `storefrontBay`. Check every new name against
 * the `noCast` regex in `createVillageHub` before committing it (includes
 * glyph/banner/flag/signPost/upperLight for flat facade quads).
 */
interface VillageKit {
  storefrontBay: Mesh | null;
  entrance: Mesh | null;
  parapetCap: Mesh | null;
  awning: Mesh | null;
  signBracket: Mesh | null;
  stair: Mesh | null;
  railing: Mesh | null;
  hvac: Mesh | null;
  pilaster: Mesh | null;
}

/** World-space placements collected while building facilities, consumed once. */
interface KitPlacements {
  storefrontBay: Placement[];
  entrance: Placement[];
  parapetCap: Placement[];
  awning: Placement[];
  signBracket: Placement[];
  stair: Placement[];
  railing: Placement[];
  hvac: Placement[];
  pilaster: Placement[];
}

function emptyKitPlacements(): KitPlacements {
  return {
    storefrontBay: [],
    entrance: [],
    parapetCap: [],
    awning: [],
    signBracket: [],
    stair: [],
    railing: [],
    hvac: [],
    pilaster: [],
  };
}

/**
 * Tripo unit-boxes put the wide face of wall modules on Z. −π/2 yaws that onto
 * facility-local +X so width is the axis the player reads across a shopfront.
 * Depth then lands on Z (plaza = −Z after root facing).
 */
const KIT_FACE_YAW = -Math.PI / 2;

/**
 * Albedo tint per kit module — the fix for the "white plates" read.
 *
 * V5 asked for "a slim matte-charcoal frame" and a "muted charcoal and off-white
 * palette, one module in pale marble" (`docs/design-prompts.md`). What came back
 * is near-white plaster on every large module: measured 95th-percentile linear
 * albedo is 0.93 on the awning, 0.68 on the window bay, 0.60 on the parapet cap.
 * Brick shells sit at ~0.10 and `VILLAGE_DAY.shell` at 0.30, so the kit was
 * three to nine times the albedo of the wall it mounts on. Under a 2.6-intensity
 * sun those surfaces clip to white and clear `bloomThreshold`, which is why
 * authored trim read as glowing plates stuck onto dark buildings.
 *
 * Each factor lands that measured white on 0.30 linear — `VILLAGE_DAY.shell`, so
 * kit trim and the procedural parapet box that carries it match, still ~3x the
 * brick so trim reads AS trim, and below the Hall's 0.52 marble so the Hall stays
 * "the one pale material in the block" (`palette.ts`).
 *
 * The factor corrects in BOTH directions, because a value target has two bounds.
 * The regenerated awning and sign overshot: asked for "matte dark charcoal", the
 * generator produced 0.14 and 0.08 linear — the sign darker than the brick wall it
 * mounts on, so a 2.5 x 2.1 m blank panel read as a black hole in the facade
 * instead of a white plate on it. Same defect, opposite sign. They are scaled UP
 * to the same 0.30.
 *
 * Absent = deliberately untinted:
 *  - railing, hvac: baked at 0.11 / 0.19 already, which is the brushed dark metal
 *    V5 asked for. Scaling those down would crush them to black.
 *  - pilaster: pale marble is what module 9 is FOR. Its 0.56 bake is already
 *    within a hair of `mats.marble`, so the Hall frontage reads as one material.
 *
 * A multiply is the whole mechanism: `albedoColor` scales `albedoTexture` in
 * linear space, so the bake's own light/dark detail survives and the shared KTX2
 * texture is never touched.
 *
 * `tools/check-kit-module.mjs <glb> <axis> <metres> [--yaw]` prints the measured
 * p95 and the factor that lands it on 0.30 — re-run it for any module regenerated
 * from here, and DELETE the entry rather than stacking a tint on a fixed bake.
 */
const KIT_ALBEDO_TINT: Record<string, number> = {
  storefrontBay: 0.44,
  entrance: 0.49,
  parapetCap: 0.50,
  stairFlight: 0.67,
  // Scaled up, not down — see above. 0.143 x 2.10 and 0.082 x 3.66 both land 0.30.
  awning: 2.10,
  signBracket: 3.66,
};

/**
 * Scale a loaded module's baked albedo into the village's charcoal range.
 *
 * Silent no-op when the module failed to load or has no tint entry, so the table
 * above stays the single place that decides which modules are charcoal.
 */
function tintKitModule(mesh: Mesh | null, key: string): void {
  if (!mesh) return;
  const factor = KIT_ALBEDO_TINT[key];
  if (factor === undefined) return;
  const mat = mesh.material;
  if (!(mat instanceof PBRMaterial)) return;
  mat.albedoColor = mat.albedoColor.scale(factor);
}

/**
 * Load all nine kit modules once. Failures are independent — a missing awning
 * does not poison the bay load.
 */
async function loadVillageKit(scene: Scene): Promise<VillageKit> {
  const [
    storefrontBay,
    entrance,
    parapetCap,
    awning,
    signBracket,
    stair,
    railing,
    hvac,
    pilaster,
  ] = await Promise.all([
    // Depth caps below are the projection from the wall: a frame that juts too far
    // stops reading as a frame and starts reading as a tunnel.
    loadVillageProp(
      scene,
      "/assets/village/kit/window_bay.glb",
      "storefrontBay",
      { axis: "height", metres: 4.2, limits: { depth: 0.6 } }, // target 0.25, ships 0.35
      KIT_FACE_YAW
    ),
    loadVillageProp(
      scene,
      "/assets/village/kit/entrance.glb",
      "entrance",
      { axis: "height", metres: 3.2, limits: { depth: 0.6 } }, // target 0.30, ships 0.22
      KIT_FACE_YAW
    ),
    loadVillageProp(
      scene,
      "/assets/village/kit/parapet.glb",
      "parapetCap",
      // Width uncapped: dressFacade tiles by measured width, so a narrow cap just
      // repeats more often. Target 4.0, ships 1.63 — nine caps per facade, not four.
      { axis: "height", metres: 0.45, limits: { depth: 0.9 } }, // target 0.50, ships 0.23
      KIT_FACE_YAW
    ),
    // Depth drive: cantilever from the wall is the player-facing scale. Yaw first
    // so the short horizontal axis is Z (projection) and the long one is width.
    loadVillageProp(
      scene,
      "/assets/village/kit/awning.glb",
      "awning",
      // Thickness is the one that matters, and the bound is the scene's, not the
      // spec's: the awning sits at y 3.9 and the sign bracket hangs at 4.75, so
      // anything over ~0.85 thick eats the bracket. The v1 module was 1.03 and did
      // exactly that; the charcoal regeneration is 0.63 (a slab plus its fascia).
      { axis: "depth", metres: 2.6, limits: { height: 0.8, width: 6.5 } },
      KIT_FACE_YAW
    ),
    loadVillageProp(
      scene,
      "/assets/village/kit/sign.glb",
      "signBracket",
      // NOT capped at the 0.50 m authoring target, because that target is wrong:
      // `mountFacilitySignage` hangs a 1.45 m glyph from 0.225 to 1.675 m above the
      // bracket's sole, so the panel has to be ~1.7 m tall to back it at all. Both
      // generations are ~2.05, which is why nobody noticed. The cap is only a
      // runaway guard; keeping the panel under the parapet is a placement job, done
      // by the bracketY clamp in `buildFacility`.
      { axis: "width", metres: 2.5, limits: { height: 2.4, depth: 0.8 } },
      KIT_FACE_YAW
    ),
    // Stair: height matches queue-terminal roofY (7 + 0.45). Run stays on model
    // +Z after face-yaw so it climbs the plaza-facing left edge into the deck.
    loadVillageProp(
      scene,
      "/assets/village/kit/stair.glb",
      "stairFlight",
      // Targets 2.4 wide × 7.7 deep; ships 4.35 × 9.00 — a broad municipal flight
      // rather than the specced service stair, but still a stair.
      { axis: "height", metres: 7.45, limits: { width: 5.0, depth: 10.0 } },
      KIT_FACE_YAW
    ),
    loadVillageProp(
      scene,
      "/assets/village/kit/railing.glb",
      "roofRail",
      // Depth target 0.08 counted the tubing only and ignored the base plinth V5
      // draws, so the 0.32 m the module ships is the spec being wrong, not the mesh.
      { axis: "height", metres: 1.05, limits: { depth: 0.6 } },
      KIT_FACE_YAW
    ),
    // NOTE: driven to 1.2 m wide against a 2.5 m authoring target — the roof
    // cluster is deliberately half-size so it reads as plant, not as a storey.
    // Depth then follows the model: target 1.8, ships 3.08.
    loadVillageProp(scene, "/assets/village/kit/hvac.glb", "hvacUnit", {
      axis: "width",
      metres: 1.2,
      limits: { depth: 3.5 },
    }),
    loadVillageProp(scene, "/assets/village/kit/pilaster.glb", "marblePilaster", {
      axis: "height",
      metres: 6.0,
      limits: { width: 1.6, depth: 1.6 }, // target 0.8 square, ships 1.20
    }),
  ]);

  // Charcoal pass before anything instances these — see KIT_ALBEDO_TINT. Runs on
  // the source mesh's material, which every InstancedMesh renders through, so one
  // assignment per module covers the whole block.
  tintKitModule(storefrontBay, "storefrontBay");
  tintKitModule(entrance, "entrance");
  tintKitModule(parapetCap, "parapetCap");
  tintKitModule(stair, "stairFlight");
  tintKitModule(awning, "awning");
  tintKitModule(signBracket, "signBracket");

  return {
    storefrontBay,
    entrance,
    parapetCap,
    awning,
    signBracket,
    stair,
    railing,
    hvac,
    pilaster,
  };
}

/** Baked axis length after loadVillageProp normalisation. */
function meshExtent(m: Mesh, axis: "x" | "y" | "z"): number {
  const b = m.getHierarchyBoundingVectors(true);
  if (axis === "x") return b.max.x - b.min.x;
  if (axis === "y") return b.max.y - b.min.y;
  return b.max.z - b.min.z;
}

/**
 * Facility-local → world placement. Kit instances cannot share a facility
 * parent (each root has a different bearing), so placeMany runs in world space
 * after every facility has contributed its local offsets.
 */
function kitWorldPlacement(root: TransformNode, local: Placement): Placement {
  const v = Vector3.TransformCoordinates(
    new Vector3(local.x, local.y, local.z),
    Matrix.RotationY(root.rotation.y)
  );
  return {
    x: root.position.x + v.x,
    y: root.position.y + v.y,
    z: root.position.z + v.z,
    ry: root.rotation.y + (local.ry ?? 0),
  };
}

function pushKit(list: Placement[], root: TransformNode, local: Placement): void {
  list.push(kitWorldPlacement(root, local));
}

/** Instance every kit source that has at least one placement. */
function placeVillageKit(kit: VillageKit, placements: KitPlacements): void {
  const entries: Array<[Mesh | null, Placement[]]> = [
    [kit.storefrontBay, placements.storefrontBay],
    [kit.entrance, placements.entrance],
    [kit.parapetCap, placements.parapetCap],
    [kit.awning, placements.awning],
    [kit.signBracket, placements.signBracket],
    [kit.stair, placements.stair],
    [kit.railing, placements.railing],
    [kit.hvac, placements.hvac],
    [kit.pilaster, placements.pilaster],
  ];
  for (const [src, list] of entries) {
    if (!src) continue;
    if (list.length === 0) {
      // Loaded but unused — hide the source so it does not sit at the origin.
      src.setEnabled(false);
      continue;
    }
    placeMany(src, list);
  }
}

// ---------------------------------------------------------------------------
// Crowd
// ---------------------------------------------------------------------------

export interface Ticker {
  tick(t: number): void;
}

/**
 * Hub population.
 *
 * `HUB.maxPlayers` is 12 and the starter hero is one of them, so eleven
 * civilians stand here — three authored pedestrian models instanced across
 * eleven spots (was: one black capsule × 11). The point of holding the full
 * population count in the scene from day one survives the upgrade: when real
 * skinned heroes replace these, the draw-call and memory jump is measured
 * against a hub that already assumed a crowd — rather than discovered in M5.
 *
 * See `07-open-design-issues.md#p-2-hub-population-cap`: doc 01 says ~30
 * players, the budget says 12. Twelve is what is on screen until that is
 * resolved.
 */
async function buildCrowd(scene: Scene, mats: Mats): Promise<Ticker[]> {
  // Hand-placed clusters, not a ring: people gather at doorways and benches.
  // Fixed positions keep the hub identical across loads (no RNG in the scene),
  // which is what makes a screenshot diff a usable review tool.
  // Three spots moved when the capsules became people: a silhouette that
  // half-sank into a planter box read as "next to the tree", a body with legs
  // reads as standing IN the planter. Everyone now clears the planter hexagon
  // (r 10.2) and the bench ends by at least a shoulder width.
  const spots: Array<[number, number]> = [
    [-6.2, -7.4],
    [-3.9, -9.9],
    [-7.4, -6.2],
    [4.1, 10.4],
    [6.4, 8.4],
    [11.5, 2.2],
    [10.2, -4.6],
    [-1.8, -12.0],
    [2.4, -12.2],
    [-11.8, 3.4],
    [7.2, -9.8],
  ];

  // Three authored pedestrians (tripo text_to_model, villagers set — see
  // assets/work/village/README.md) dealt round-robin so neighbouring spots
  // never show the same person twice. Any variant that fails to load just
  // thins the rotation; all three failing falls back to the old capsule.
  const variants = (
    await Promise.all(
      (["a", "b", "c"] as const).map((k) =>
        loadVillageProp(
          scene,
          `/assets/village/villagers/villager_${k}.glb`,
          `villager_${k}`,
          { axis: "height", metres: VILLAGER_HEIGHT, limits: { width: 1.6, depth: 1.6 } },
          VILLAGER_MODEL_YAW
        )
      )
    )
  ).filter((m): m is Mesh => m !== null);

  // Face roughly toward the plaza centre, with a per-person offset so the group
  // does not read as a firing squad. Authored meshes are baked sole-on-ground
  // (y=0 = bottom); the capsule keeps its centre-origin half-height.
  const facing = (x: number, z: number, i: number) =>
    Math.atan2(-x, -z) + Math.PI + (i % 3) * 0.4 - 0.4;

  let villagers: AbstractMesh[];
  if (variants.length > 0) {
    const perVariant: Placement[][] = variants.map(() => []);
    spots.forEach(([x, z], i) => {
      perVariant[i % variants.length]!.push({ x, y: 0, z, ry: facing(x, z, i) });
    });
    villagers = variants.flatMap((v, vi) => placeMany(v, perVariant[vi]!));
  } else {
    const src = MeshBuilder.CreateCapsule(
      "villager",
      { height: 1.75, radius: 0.26, tessellation: 8, capSubdivisions: 3 },
      scene
    );
    src.material = mats.suit;
    // The capsule is radially symmetric, so the +PI face convention is moot —
    // keep the historic ry so the screenshot diff stays byte-stable.
    villagers = placeMany(
      src,
      spots.map(([x, z], i) => ({ x, y: 0.9, z, ry: Math.atan2(-x, -z) + (i % 3) * 0.4 - 0.4 }))
    );
  }

  // Every pedestrian gets the same small "Villager" caption, dimmer than the
  // attendants' accent tags: it says "no function here" at a glance. One
  // shared material/texture for all eleven. The attendants' function tags
  // live in buildShopNpcs.
  const tagMats = new Map<string, StandardMaterial>();
  villagers.forEach((v, i) => {
    buildNameTag(
      scene,
      `villager${i}`,
      "Villager",
      PALETTE.cyan.scale(0.55),
      new Vector3(v.position.x, VILLAGER_HEIGHT + 0.28, v.position.z),
      tagMats
    );
  });

  // These DO animate, so undo the freeze `placeMany` applied. Sway is
  // deliberately tiny and phase-offset — the only thing worse than a static
  // crowd is twelve people breathing in perfect unison.
  return villagers.map((v, i) => {
    v.unfreezeWorldMatrix();
    const baseY = v.position.y;
    const phase = i * 1.37;
    return {
      tick: (t: number) => {
        v.position.y = baseY + Math.sin(t * 0.9 + phase) * 0.012;
        v.rotation.z = Math.sin(t * 0.6 + phase) * 0.01;
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Shop NPCs — one attendant per facility, standing beside the door
// ---------------------------------------------------------------------------

/**
 * Yaw of the tripo NPC glbs' forward axis relative to "faces -Z at rotation 0"
 * (same calibration pattern as FREUD_MODEL_YAW — fix HERE if they face the
 * wall, in multiples of PI/2). One constant for the set: all seven come from
 * the same generator run, so they share a facing convention — which turned out
 * to be +Z (screenshot-calibrated 2026-07-30: at yaw 0 every attendant greeted
 * their own shopfront).
 */
const NPC_MODEL_YAW = Math.PI;

/**
 * Which facility gets which attendant glb, and which side of the doorway they
 * stand on (facility-local +x; sides alternate so neighbouring shops do not
 * mirror each other). Coffee shop is forced to +x — the pavement seating rows
 * at x ∈ {-4, 0, 4} leave that side's doorway gap the clearest.
 */
const SHOP_NPCS: Array<{ facility: FacilityId; file: string; side: 1 | -1 }> = [
  { facility: "outfitter", file: "npc_outfitter.glb", side: 1 },
  { facility: "style-lab", file: "npc_style_lab.glb", side: -1 },
  { facility: "pet-park", file: "npc_pet_park.glb", side: 1 },
  { facility: "queue-terminal", file: "npc_queue_terminal.glb", side: -1 },
  { facility: "hall-of-minds", file: "npc_hall_of_minds.glb", side: 1 },
  { facility: "practice-booth", file: "npc_practice_booth.glb", side: -1 },
  { facility: "coffee-shop", file: "npc_coffee_shop.glb", side: 1 },
];

/**
 * One attendant per facility, standing beside the entrance.
 *
 * Placement is facility-local, converted through `kitWorldPlacement` off the
 * already-built facility roots — NOT parented to them (the roots are frozen,
 * and these meshes sway, so they own their world matrix; same reasoning as the
 * kit instances). Enclosed buildings offset past the kit entrance frame's half
 * width so the attendant flanks the door instead of blocking it; the open-air
 * pair (pet park, practice booth) has no door, so they flank the front-centre
 * approach path instead.
 *
 * Each mesh is named `npc_<facilityId>` and tagged `metadata.shopNpc` — that
 * pair is the hook the interaction layer uses (the plaza tap handler in
 * createVillageHub opens the facility's panel; a proximity prompt + dialog
 * can still join later): look NPCs up by name or filter meshes on the
 * metadata key. Nothing else should need to change here when the rest land.
 *
 * A failed load skips that attendant (loadVillageProp already logged it) — an
 * absent shopkeeper is not worth a capsule stand-in next to a finished facade.
 */
async function buildShopNpcs(scene: Scene, kit: VillageKit): Promise<Ticker[]> {
  // Kit entrance frames are all instanced from one source; measure it once.
  // 1.25 m matches the procedural doorway stand-in when the kit is absent.
  const doorHalfW = kit.entrance ? meshExtent(kit.entrance, "x") / 2 : 1.25;

  const tickers: Ticker[] = [];
  await Promise.all(
    SHOP_NPCS.map(async (spec, i) => {
      const f = FACILITIES.find((x) => x.id === spec.facility);
      const root = scene.getTransformNodeByName(`facility_${spec.facility}`);
      if (!f || !root) return;

      const mesh = await loadVillageProp(
        scene,
        `/assets/village/npcs/${spec.file}`,
        `npc_${spec.facility}`,
        // Human scale, with the guard loose enough for a held prop or a wide
        // stance but tight against an off-spec generation.
        { axis: "height", metres: 1.78, limits: { width: 2.4, depth: 2.4 } },
        NPC_MODEL_YAW
      );
      if (!mesh) return;

      // Beside the door: clear of the entrance frame (or of the open-air
      // centre approach), a step out from the facade onto the pavement, turned
      // a few degrees toward the doorway centre-line to read as "attending
      // this shop" rather than as one more plaza wanderer.
      const clearance = (f.openAir ? 0.7 : doorHalfW) + 0.95;
      const p = kitWorldPlacement(root, {
        x: spec.side * clearance,
        y: 0,
        z: -(f.depth / 2 + 1.0),
        ry: spec.side * 0.28,
      });
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.y = p.ry ?? 0;
      mesh.metadata = { shopNpc: spec.facility };

      // Small floating function tag over the attendant's head, tinted with the
      // facility accent so tag and storefront read as one system.
      buildNameTag(scene, spec.facility, f.label, f.accent, new Vector3(p.x, 2.08, p.z));

      // Same idle sway as the crowd — static shopkeepers read as mannequins.
      // Phase runs off the roster index so the seven never breathe in unison.
      const baseY = mesh.position.y;
      const phase = i * 1.91;
      tickers.push({
        tick: (t: number) => {
          mesh.position.y = baseY + Math.sin(t * 0.8 + phase) * 0.012;
          mesh.rotation.z = Math.sin(t * 0.55 + phase) * 0.01;
        },
      });
    })
  );
  return tickers;
}

// ---------------------------------------------------------------------------
// Unclaimed loot cache — a per-player pickup beside the queue terminal
// ---------------------------------------------------------------------------

/** Loot-gold emissive for the cache tag, matching the loot panel's reveal. */
const CACHE_TAG_ACCENT = Color3.FromHexString("#ffd97a");

/**
 * The consolation-prize marker. A lost fight still grants a cache (the server
 * pays tier 0 on defeat), and the defeat overlay's "Later" button lets the
 * player walk away without opening it — so when the hub loads with unopened
 * boxes in the ledger, ONE cache waits in the world beside the queue-terminal
 * attendant, where the player last queued. Tapping it opens the loot
 * inventory (`openLootInventory`); when the last box is rolled the panel
 * pings back through `setCacheOpenedListener` and the prop vanishes.
 *
 * Inherently LOCAL: the check reads this client's own /api/economy and the
 * prop renders only here — it is deliberately NOT part of village presence
 * (other players must not see your unclaimed loot). Fire-and-forget like the
 * arena's spawnArenaLootBox: any failure (logged out, fetch error, missing
 * glb, missing attendant) leaves the hub box-less rather than breaking the
 * scene. Runs on every hub build, so returning from a fight re-checks.
 *
 * The caller builds this AFTER finishVillageRender and the collider sweep:
 * the bob/spin would out-date a frozen shadow anyway, and a pickup must not
 * block the hero.
 */
function buildUnclaimedLootBox(scene: Scene, tickers: Ticker[]): void {
  void (async () => {
    let unopened = 0;
    try {
      unopened = (await getEconomy()).lootBoxes.length;
    } catch {
      return; // no session or the ledger is unreachable — no marker
    }
    if (unopened === 0 || scene.isDisposed) return;

    // Beside the attendant: step from the shop root THROUGH the NPC and stop
    // 1.8 m past it — the free flank off the doorway line, on the pavement.
    const npc = scene.getMeshByName("npc_queue-terminal");
    const root = scene.getTransformNodeByName("facility_queue-terminal");
    if (!npc || !root) return;
    const dir = npc.getAbsolutePosition().subtract(root.getAbsolutePosition());
    dir.y = 0;
    dir.normalize();
    const spot = npc.getAbsolutePosition().add(dir.scale(1.8));

    const box = await loadVillageProp(
      scene,
      "/assets/village/loot_box.glb",
      "unclaimedCache",
      // A hand-carried cache, not a crate: under a metre, kept compact by the
      // same proportion guard the other plaza props pass.
      { axis: "height", metres: 0.9, limits: { width: 1.4, depth: 1.4 } }
    );
    if (!box) return;
    if (scene.isDisposed) {
      box.dispose();
      return;
    }
    // loadVillageProp bakes sole-on-ground, so y = 0 sits it on the pavement.
    box.position.set(spot.x, 0, spot.z);
    const baseYaw = Math.atan2(-dir.x, -dir.z); // eye-keyhole front toward the NPC
    box.rotation.y = baseYaw;
    box.isPickable = true;

    // The function tag, same sanctioned pattern as the NPC nameplates.
    buildNameTag(scene, "unclaimedCache", "UNCLAIMED CACHE", CACHE_TAG_ACCENT, new Vector3(spot.x, 1.5, spot.z));
    const tag = scene.getMeshByName("labelGlyph_unclaimedCache");

    // A pickup reads as interactive when it moves: slow spin + bob. The tick
    // outlives the box (one no-op closure per frame after a claim) — cheaper
    // than splicing the ticker list mid-scene.
    tickers.push({
      tick: (t: number) => {
        if (box.isDisposed()) return;
        box.rotation.y = baseYaw + t * 0.5;
        box.position.y = 0.08 + Math.sin(t * 1.4) * 0.05;
      },
    });

    // Vanish once the ledger is empty.
    const onCacheOpened = (): void => {
      void getEconomy()
        .then((eco) => {
          if (eco.lootBoxes.length > 0 || box.isDisposed()) return;
          box.dispose();
          tag?.dispose();
        })
        .catch(() => undefined); // the box simply stays until the next hub load
    };

    // main.ts disposes the old scene BEFORE building the next, so clearing on
    // dispose can never race a newer hub's registration.
    setCacheOpenedListener(onCacheOpened);
    scene.onDisposeObservable.add(() => setCacheOpenedListener(null));
  })();
}

// ---------------------------------------------------------------------------
// Freud — the starter hero, standing in the plaza
// ---------------------------------------------------------------------------

/**
 * Where Freud spawns and faces: a few steps out the residential door — home —
 * facing the plaza, as if he just stepped outside. Derived from the facility
 * ring (bearing 330°, front face on RING_RADIUS = 23): door at
 * (-11.5, 19.92), spawn 5.5 m plaza-ward along the inward normal. Yaw is
 * empirical (verified by screenshot, both sides): the wrapper faces
 * -(sin ry, cos ry), so plaza-ward from bearing 330° is ry = −30°, NOT the
 * bearing−180° a forward = (sin, cos) reading suggests. The 5.5 m matters:
 * the third-person camera starts behind him, and any closer to the door the
 * boot frame is shot from INSIDE the residential shell. Entering the village
 * and returning from a boss fight both rebuild the hub scene from scratch, so
 * this single constant is the spawn point for both paths.
 */
export const FREUD_SPOT = { x: -8.75, z: 15.16, ry: -Math.PI / 6 };

/**
 * Yaw of the glb's own forward axis relative to "faces -Z at rotation 0"
 * (which is how the primitive stand-in was built). Tripo does not document
 * which axis its characters face and the bbox is symmetric both ways, so this
 * is a visually calibrated constant: if the model walks sideways or backwards,
 * fix it HERE, in one place, in multiples of PI/2.
 */
const FREUD_MODEL_YAW = 0;

/**
 * Articulated limb pivots — shoulder pivots for arms, hip pivots for legs,
 * each with the limb mesh hanging as a child. `rotation.x` swings the limb
 * fore/aft (positive = toward -Z, the facing direction).
 *
 * The primitive stand-in provides these natively (its limbs are separate
 * meshes). The fused Tripo glb gets them from `autoRigHumanoid`, which skins a
 * minimal procedural skeleton onto the static mesh. Future hero models must
 * still ship with a real rig — see docs/asset-pipeline-notes.md "Rig &
 * animation spec"; the auto-rig is the floor, not the target.
 */
interface HeroLimbs {
  armL: TransformNode;
  armR: TransformNode;
  legL: TransformNode;
  legR: TransformNode;
}

/**
 * Which gesture a cast plays — the skill-bar slot kind, passed through 1:1:
 * palette (1-5) plays `OverhandThrow`, defense (E) and ultimate
 * (F) both play `cast_e` (E as a torso overlay, F as a full-body takeover), chain (R) sits
 * into Meditate.
 */
type CastKind = BarSlotDef["kind"];

/** One-shot flags set by the UI layer, consumed by the hero controller. */
interface HeroFx {
  /** Set on skill cast; the controller plays the matching gesture and clears it. */
  cast: CastKind | null;
  /**
   * Where the cast was aimed (the bar's `target` hook), or null when the
   * scene has nothing to aim at (the village square). Set with `cast`; the
   * controller holds the combat stance on it (COMBAT_FACE_S).
   */
  focus?: (() => Vector3) | null;
}

/**
 * Clip-driven animation for a properly rigged model (mesh2motion rig +
 * animation library). The controller feeds it locomotion state each tick and
 * fires jump/cast/hit one-shots; the animator owns clip weights and cadence.
 */
interface HeroAnimator {
  /** `backward`: stepping away from what the hero faces — the walk clip plays in reverse. */
  update(dt: number, state: { speed: number; moving: boolean; backward?: boolean }): void;
  /** Launch half of the jump (`jump_start`); the controller owns the arc. */
  triggerJump(): void;
  /** Touchdown half (`jump_land`) — the controller fires it when the arc ends. */
  triggerLand(): void;
  triggerCast(kind: CastKind): void;
  /** Hit reaction — nothing damages the hero in the hub yet; the arena will. */
  triggerHit(): void;
  /**
   * True while a full-body one-shot (jump, cast, hit) owns the pose.
   *
   * The ground magnet in `buildFreudRigged` reads this: those clips are NOT
   * ground-referenced — a backflip tucks, an Extinction leap folds — so the
   * lowest vertex of the mesh stops being "the soles" and the servo must not
   * chase it. See the freeze there for what happens when it does.
   */
  busy(): boolean;
  /**
   * True only once locomotion clips own the pose again — i.e. no full-body
   * one-shot is up AND the idle/walk/run weights have blended back in.
   *
   * `busy()` alone is not enough for the ground magnet: touchdown clears the
   * launch clip immediately, but the skeleton keeps holding the last airborne
   * frame until either `jump_land` or the locomotion weights take over
   * (~0.3 s). A bounds measurement in that window can read a knee as the
   * lowest vertex.
   */
  poseSettled(): boolean;
  /**
   * True while the `jump_land` touchdown clip owns the pose. Unlike the other
   * one-shots, the landing recovery is grounded — feet planted throughout —
   * so the ground magnet may keep servoing during it. Without this the rigs
   * whose jump pair was rebased onto a raised stance (Pavlov's) hang in the
   * air for the whole recovery and then pop down.
   */
  landingRecovery(): boolean;
}

/**
 * How cast clips play on the shared hub hero stack.
 *
 * - `hub` (default): upper-body overlays for basic/palette/defense so Freud
 *   keeps running while he casts — right for the social plaza.
 * - `fight`: full-body takeovers at the arena speeds from `arenaHero.ts` —
 *   right for the practice pit / boss fight attack read.
 */
export type HeroCastStyle = "hub" | "fight";

export interface BuildFreudOptions {
  /** Cast playback policy. Defaults to `"hub"`. */
  castStyle?: HeroCastStyle;
  /**
   * Which hero body to load (`/assets/heroes/<id>.glb`). Defaults to Freud.
   * Freud's companions (notebook drone + pipe smoke) are his alone — other
   * heroes get the bare rig. Mesh names keep the `freud_` prefix regardless:
   * it is the hub's "local hero" marker (shadow denylist, collider skip).
   */
  heroId?: string;
}

/** What the scene needs to drive a hero: its transform + per-frame dressing. */
export interface HeroHandle {
  /** Unit-scale wrapper the controller moves. Children carry any model scale. */
  node: TransformNode;
  /**
   * Body-language node between the wrapper and the model. The wrapper owns
   * position + facing yaw; the pose owns lean/sway/breath. Split so the
   * controller can pitch and roll the BODY without the pivot fighting the
   * facing math — pose rotations are in the hero's own frame, pivoting at the
   * feet (wrapper origin). The Tripo glb ships without a skeleton, so this
   * whole-body motion IS the walk/idle animation until a rig lands.
   */
  pose: TransformNode;
  /** Present when the model has articulated limbs (stand-in yes, fused glb no). */
  limbs?: HeroLimbs;
  /** Present when the glb shipped with animation clips — the preferred tier. */
  animator?: HeroAnimator;
  /**
   * Cast playback policy. The controller uses this to skip the pose-node
   * cast lunge when clips already plant the whole body (`"fight"`).
   */
  castStyle: HeroCastStyle;
  /** UI → controller channel for gesture triggers. */
  fx: HeroFx;
  /** Companion animation (drone orbit) — position/facing belong to the controller. */
  tick: (t: number) => void;
}

/**
 * Freud, "The Analyst" — first hero, DPS, base 100 (doc 03 §4).
 *
 * Two paths:
 *  1. `/assets/heroes/freud.glb` — the tripo-generated model from the F1
 *     concept views (`assets/work/freud/README.md`), decimated to hero budget.
 *  2. If the glb is missing or fails to parse, the primitive stand-in below —
 *     so the scene never hard-depends on an asset that is still iterating.
 *
 * Both paths get the same companions (notebook drone + pipe smoke): the
 * generation views had the drone deliberately painted out, so it is engine
 * dressing, not model geometry — which is what we want anyway, because it
 * orbits. Both return the same shape: a unit-scale wrapper node, so drone,
 * smoke and blob-shadow offsets are in metres regardless of the glb's
 * internal normalisation scale.
 */
export async function buildFreud(
  scene: Scene,
  mats: Mats,
  opts: BuildFreudOptions = {}
): Promise<HeroHandle> {
  try {
    return await buildFreudAuthored(scene, mats, opts);
  } catch (err) {
    console.info("[freud] glb unavailable, using primitive stand-in:", err);
    return buildFreudStandIn(scene, mats, opts);
  }
}

async function buildFreudAuthored(
  scene: Scene,
  mats: Mats,
  opts: BuildFreudOptions
): Promise<HeroHandle> {
  const heroId = opts.heroId ?? "freud";
  // A hero with no shipped glb borrows Freud's body, as in the arena
  // (arenaHero.ts). `heroId` still decides height and companions below, so the
  // borrower gets the bare rig: no drone, no pipe.
  const modelId = MODELED_HEROES.has(heroId) ? heroId : "freud";
  const result = await trackLoad(ImportMeshAsync(`/assets/heroes/${modelId}.glb`, scene));

  // A glb that ships with clips takes the rigged path: real skeleton, real
  // walk/run/jump/cast animation. The bake-and-auto-rig path below stays as
  // the fallback for static single-mesh drops.
  if (result.animationGroups.length > 0) {
    return buildFreudRigged(scene, mats, result, opts);
  }

  // One geometry mesh under a loader root — same shape as the village props.
  const geo = result.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  if (!geo) throw new Error("no geometry mesh in freud.glb");
  // Named so the shadow denylist matches — tripo names nodes after task UUIDs.
  geo.name = "freud_body";

  const wrapper = new TransformNode("freud", scene);
  wrapper.position.set(FREUD_SPOT.x, 0, FREUD_SPOT.z);
  wrapper.rotation.y = FREUD_SPOT.ry;

  const pose = new TransformNode("freud_pose", scene);
  pose.parent = wrapper;

  // Bake the loader hierarchy (RH->LH flip included) AND the canon-scale
  // normalisation into the vertices: 1.8 m tall, soles at y 0, centred on x/z,
  // facing -Z, mesh at identity under `pose`. The auto-rig depends on this —
  // its bone pivots and skin-weight regions are authored in that standing
  // frame, and baking is what makes vertex coordinates BE that frame.
  // (refreshBoundingInfo after every bake: baking does not update the cached
  // bounds — the sign-bracket monolith bug, same trap.)
  geo.bakeTransformIntoVertices(geo.computeWorldMatrix(true).clone());
  geo.parent = null;
  geo.position.setAll(0);
  geo.rotation.setAll(0);
  geo.scaling.setAll(1);
  geo.rotationQuaternion = null;
  if (FREUD_MODEL_YAW !== 0) {
    geo.rotation.y = FREUD_MODEL_YAW;
    geo.bakeCurrentTransformIntoVertices();
    geo.rotation.setAll(0);
  }
  geo.refreshBoundingInfo();
  const b0 = geo.getHierarchyBoundingVectors(true);
  const s = heroHeightM(heroId) / (b0.max.y - b0.min.y);
  geo.bakeTransformIntoVertices(Matrix.Scaling(s, s, s));
  geo.refreshBoundingInfo();
  const b1 = geo.getHierarchyBoundingVectors(true);
  geo.bakeTransformIntoVertices(
    Matrix.Translation(-(b1.min.x + b1.max.x) / 2, -b1.min.y, -(b1.min.z + b1.max.z) / 2)
  );
  geo.refreshBoundingInfo();
  geo.parent = pose;

  for (const m of result.meshes) {
    if (m !== geo) m.dispose(false, false);
  }
  for (const t of result.transformNodes) t.dispose();

  const limbs = autoRigHumanoid(scene, geo, pose);

  let tick: (t: number) => void = () => {};
  if (heroId === "freud") {
    // Pipe smoke: the pipe is model geometry, so the emitter is an offset guess
    // anchored to the right hand's neighbourhood. Refine when the rig lands.
    // Parented to the POSE so the smoke leans with the body it is attached to.
    const emitter = MeshBuilder.CreateBox("freud_smokeAnchor", { size: 0.02 }, scene);
    emitter.parent = pose;
    emitter.position.set(-0.34, 1.03, -0.2);
    emitter.isVisible = false;
    attachPipeSmoke(scene, emitter);
    tick = buildDrone(scene, mats, wrapper).tick;
  }
  return {
    node: wrapper,
    pose,
    limbs,
    castStyle: opts.castStyle ?? "hub",
    fx: { cast: null },
    tick,
  };
}

/**
 * The rigged path: the mesh2motion export — a 38-joint UE-named skeleton
 * (pelvis/spine/clavicle/finger chains) with thirteen clips baked in-place:
 * idle/walk/run loops, the cast/cast_e/cast_r/ult/hit one-shots, and
 * death/sleep/shield_break/sword_a/sword_c spares for future features. No
 * root motion — translation stays with the controller, doc 06's server tick
 * will own it the same way.
 *
 * Unlike the static path this must NOT bake vertices or prune transform
 * nodes: the joints ARE transform nodes and the mesh must stay in bind space.
 * Normalisation happens on the loader root instead, which scales the joint
 * hierarchy along with the skin — the standard glTF workflow.
 */
function buildFreudRigged(
  scene: Scene,
  mats: Mats,
  result: Awaited<ReturnType<typeof ImportMeshAsync>>,
  opts: BuildFreudOptions
): HeroHandle {
  const root = result.meshes[0];
  for (const m of result.meshes) {
    m.name = `freud_${m.name}`;
    if (m.getTotalVertices() > 0) {
      // A skinned pose can leave the bind-space bounding box (arms thrown
      // forward in a cast); never let the culler blink the hero out.
      m.alwaysSelectAsActiveMesh = true;
    }
  }

  const wrapper = new TransformNode("freud", scene);
  wrapper.position.set(FREUD_SPOT.x, 0, FREUD_SPOT.z);
  wrapper.rotation.y = FREUD_SPOT.ry;
  const pose = new TransformNode("freud_pose", scene);
  pose.parent = wrapper;

  // Canon scale on the ROOT, multiplicatively (the RH->LH flip lives there).
  const bounds = root.getHierarchyBoundingVectors();
  const s = heroHeightM(opts.heroId ?? "freud") / (bounds.max.y - bounds.min.y);
  root.scaling.scaleInPlace(s);
  root.rotationQuaternion = null;
  root.rotation.y = FREUD_MODEL_YAW;
  root.position.set(0, -bounds.min.y * s, 0);
  root.parent = pose;

  if ((opts.heroId ?? "freud") === "freud") {
    const emitter = MeshBuilder.CreateBox("freud_smokeAnchor", { size: 0.02 }, scene);
    emitter.parent = pose;
    emitter.position.set(-0.34, 1.03, -0.2);
    emitter.isVisible = false;
    attachPipeSmoke(scene, emitter);
  }

  const castStyle = opts.castStyle ?? "hub";
  const animator = createHeroAnimator(scene, result.animationGroups, castStyle);

  // Ground magnet. The height normalisation above used the BIND pose's
  // bounds, but each clip holds the hips at its own mocap height — idle
  // floated a few cm and the run crouch dipped the feet ~10 cm under the
  // pavement, and no single offset serves both. So: every 200 ms, CPU-apply
  // the skeleton to the bounds (refreshBoundingInfo(true) — too costly per
  // frame, cheap at 5 Hz) and servo the model root softly toward sole
  // contact, with a small deadband so stride bounce still breathes. Measured
  // relative to the WRAPPER so the jump arc passes straight through it.
  //
  // ★ FROZEN DURING ONE-SHOTS (2026-08-04). The servo assumes the mesh's
  // lowest vertex IS the soles, which is only true for locomotion. Pavlov's
  // second rig jumps with a BACKFLIP and ults with a tucked leap: mid-clip the
  // lowest vertex is a knee or a shoulder, tens of centimetres above where the
  // feet would be, so the servo read a large positive error and drove the
  // model DOWN ~0.04 m per tick for the whole arc — then had to crawl back out
  // at the same rate afterwards, which is exactly the "sinks below the ground
  // for a second after landing" this fixes. `animator.busy()` is true for the
  // whole of any full-body takeover, so the servo simply holds its last good
  // offset until the feet mean something again.
  //
  // ★ AND HELD THROUGH THE RECOVERY BLEND (2026-08-04). Touchdown clears the
  // takeover instantly, but the skeleton keeps the last mid-backflip frame
  // until idle/walk weights slew back from zero (~0.3 s). The old gate could
  // tick inside that window and take its full-residual step from an inverted
  // pose — one hard shove DOWN per jump, recovered at only ~0.2 m/s, so
  // spamming jump walked Pavlov underground. Gate on `poseSettled()` (no
  // takeover AND locomotion weights recovered), not `busy()` alone.
  const body = result.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  if (body) {
    let sinceMs = 0;
    // First measurement snaps the full error (the bind-pose normalisation is
    // off by most of a metre for this rig); later ones ease, so clip-to-clip
    // height differences settle without visible popping.
    let snapped = false;
    /** A one-shot was running at the last tick — see the residual clear below. */
    let wasBusy = false;
    scene.onAfterRenderObservable.add(() => {
      sinceMs += scene.getEngine().getDeltaTime();
      if (sinceMs < 200) return;
      sinceMs = 0;
      // Hold — do NOT accumulate — while a one-shot owns the pose OR the
      // locomotion blend is still recovering from one. Measuring in either
      // window reads a mid-somersault pose (see the ★ notes above). The one
      // exception is the `jump_land` recovery: that clip is grounded (feet
      // planted throughout), so the servo keeps chasing during it — otherwise
      // a rig whose jump pair was rebased onto a raised stance (Pavlov's)
      // hangs in the air for the whole recovery, then pops down.
      if (!animator.poseSettled()) {
        if (animator.landingRecovery()) {
          body.refreshBoundingInfo(true, false);
          const landErr = body.getBoundingInfo().boundingBox.minimumWorld.y - wrapper.absolutePosition.y;
          if (Math.abs(landErr) > 0.004) {
            root.position.y -= Math.sign(landErr) * Math.min(0.12, Math.abs(landErr) * 0.5);
          }
        }
        wasBusy = true;
        return;
      }
      body.refreshBoundingInfo(true, false);
      const err = body.getBoundingInfo().boundingBox.minimumWorld.y - wrapper.absolutePosition.y;
      if (!snapped) {
        snapped = true;
        root.position.y -= err;
      } else if (wasBusy) {
        // First grounded tick after a one-shot. Clear the WHOLE residual in a
        // single step rather than easing: the clip just ended, so a correction
        // now is hidden by the pose change, and the ordinary slew would
        // otherwise leave the landing pose parked a couple of centimetres
        // proud of the pavement inside the deadband.
        wasBusy = false;
        root.position.y -= err;
      } else if (Math.abs(err) > 0.005) {
        // 5 mm deadband, not 2 cm: Pavlov's idle stance sits ~2 cm above his
        // locomotion stance (the retargeted clips were rebased per pose), and
        // the old deadband parked exactly that error as a visible hover.
        root.position.y -= Math.sign(err) * Math.min(0.06, Math.abs(err) * 0.5);
      }
    });
  }
  const tick =
    (opts.heroId ?? "freud") === "freud"
      ? buildDrone(scene, mats, wrapper).tick
      : (): void => {};
  return { node: wrapper, pose, animator, castStyle, fx: { cast: null }, tick };
}

/**
 * Clip playback policy, in one place.
 *
 * Locomotion is a three-way weight blend (idle/walk/run) driven by smoothed
 * speed, with clip playback rate scaled against the speed the clip was
 * authored for — rate-matching is what stops feet skating over the ground.
 * The rest are one-shots in two flavours. UPPER-BODY overlays — the palette
 * cast (`OverhandThrow`) and the E Defense Mechanism (`cast_e`) — play only
 * on spine-and-above bones so Freud can keep running while he casts.
 * FULL-BODY takeovers — the R meditate (`cast_r`), the F ult, the hit
 * reaction (`hit`) and the jump pair when a rig ships one — drop the
 * locomotion weights to zero for their duration; a seated pose or a knockback
 * reads wrong as a torso overlay over running legs.
 *
 * Bindings: palette 1-5 → `OverhandThrow` (upper overlay); `cast_e` covers
 * BOTH E and F. E overlays it so a defense can be thrown mid-stride, F takes
 * the whole body and plays it slower, because a 60 s-cooldown ultimate wants
 * the full-frame read. That is also why F stops the overlays first: sharing a
 * clip means E's overlay and F's takeover would otherwise drive the same bones
 * from two animatables at once.
 *
 * Upper/lower classification walks each animated joint up the hierarchy and
 * reads the rig's bone names (both the current UE-style set — spine/neck/
 * head/clavicle/arm/hand vs pelvis/thigh/calf/foot/ball — and the retired
 * Mixamo vocabulary). The height heuristic below them is a fallback for the
 * old Tripo rig's opaque `Limb` chains: a chain is upper iff its ROOT sits
 * above y 1.15 in the 1.8 m standing frame — chain root, not joint, because
 * hanging hands reach y 0.75, lower than the hips.
 *
 * `castStyle: "fight"` (practice pit) swaps the cast policy for the arena's
 * full-body takeovers and fixed speed ratios from `arenaHero.ts`, so the
 * attack read matches the boss fight while the hub keeps run-and-cast overlays.
 */
function createHeroAnimator(
  scene: Scene,
  groups: AnimationGroup[],
  castStyle: HeroCastStyle = "hub"
): HeroAnimator {
  // Exact clip names first (the mesh2motion set is renamed to this vocabulary
  // at build time — assets/work/freud/README.md), substrings second so an
  // older Tripo glb (idle/walk/run/jump/shoot) still animates. Exact-first
  // matters: a bare `includes("cast")` would happily grab `cast_heavy`.
  const find = (...keys: string[]): AnimationGroup | null => {
    for (const k of keys) {
      const g = groups.find((g) => g.name.toLowerCase() === k);
      if (g) return g;
    }
    for (const k of keys) {
      const g = groups.find((g) => g.name.toLowerCase().includes(k));
      if (g) return g;
    }
    return null;
  };
  const idle = find("idle"); // the Greeting loop — standing plays it in full
  const walk = find("walk");
  const run = find("run", "sprint");
  // Every shipped rig now carries the retargeted jump pair (Freud since the
  // m2m set; Pavlov + Skinner since the 2026-08-06 transplant).
  const jumpStart = find("jump_start", "jump"); // launch + rise
  const jumpLand = find("jump_land"); // touchdown recovery
  // Palette 1-5: OverhandThrow (restored under that name from m2m-final;
  // freud_cast overwrote the old cast_e slot with the long E/F track).
  const shoot = find("overhandthrow", "overhand", "cast", "shoot");
  const castE = find("cast_e", "throw"); // E Defense Mechanism AND F Dream Analysis
  const castR = find("cast_r", "meditate"); // R Free Association — meditate
  // Dedicated ultimate clip when the rig ships one (Pavlov's second rig does).
  // "cast_f" only — "ult" would repoint Freud's F off the cast_e it is tuned
  // for, since his glb carries a clip by that name.
  const castF = find("cast_f");
  const hit = find("hit", "knockback"); // got attacked
  // Also in the glb, unmapped until a feature needs them: death, sleep,
  // shield_break, sword_a, sword_c, ult, and the retired palette `cast`.

  // The loader autoplays the first group; all playback belongs to us.
  for (const g of groups) g.stop();
  const startLoop = (g: AnimationGroup | null, w: number): void => {
    if (!g) return;
    g.start(true);
    g.setWeightForAllAnimatables(w);
  };
  startLoop(idle, 1);
  startLoop(walk, 0);
  startLoop(run, 0);
  // Backpedal: the walk clip played in reverse (combat stance, COMBAT_FACE_S).
  // A copy of its own rather than a sign flip on `walk`, so going forward
  // again never jumps the forward gait's phase.
  const walkBack = walk ? walk.clone(`${walk.name}_back`, (t) => t) : null;
  if (walkBack) {
    walkBack.start(true, -1);
    walkBack.setWeightForAllAnimatables(0);
  }

  // Idle cadence: greet, then REST. The Greeting loop doesn't repeat back to
  // back — each cycle ends with ~3 s frozen on its boundary frame (the
  // neutral stance), so standing reads as a man at rest who occasionally
  // gestures, not one waving on a metronome. speedRatio 0 (not stop/pause)
  // keeps the animatable alive through the gap, so the walk/run weight
  // blending stays seamless if he moves off mid-rest.
  const IDLE_REST_S = 3;
  let idleRest = 0;
  idle?.onAnimationGroupLoopObservable.add(() => {
    idleRest = IDLE_REST_S;
    idle.speedRatio = 0;
  });
  // NO syncAllAnimationsWith between walk and run. Sync slaves the run cycle
  // to the walk clip's clock, and their cycle lengths differ (~2.4 s vs
  // ~1.3 s) — the run legs played at half speed under a 6.2 m/s glide, which
  // read as ballet. Each clip keeps its own clock; the overlap band below is
  // kept narrow so unsynced-phase blending is only ever a transient.

  /** Seconds a group runs at speedRatio 1 — Babylon's glTF importer is 60 fps. */
  const clipSeconds = (g: AnimationGroup): number => (g.to - g.from) / 60;
  /** Slow a fixed ratio down when the clip is too short to read. See arenaHero. */
  const MIN_CAST_S = 0.5;
  const readable = (g: AnimationGroup | null, ratio: number): number =>
    g ? Math.min(ratio, Math.max(0.5, clipSeconds(g) / MIN_CAST_S)) : ratio;

  // Upper-body subgroups of the cast clips (see doc comment).
  const isUpper = (node: Node): boolean => {
    for (let n: Node | null = node; n; n = n.parent) {
      if (/spine|neck|head|shoulder|clavicle|arm|hand/i.test(n.name)) return true;
      if (/hips|pelvis|leg|thigh|calf|foot|ball|toe/i.test(n.name)) return false;
      if (/limb/i.test(n.name) && !(n.parent && /limb/i.test(n.parent.name))) {
        return n instanceof TransformNode && n.getAbsolutePosition().y > 1.15;
      }
    }
    return false;
  };
  const upperOverlay = (src: AnimationGroup | null, name: string): AnimationGroup => {
    const overlay = new AnimationGroup(name, scene);
    if (src) {
      // Force world matrices once so chain-root heights are measurable.
      for (const ta of src.targetedAnimations) {
        const t = ta.target as Node;
        if (t instanceof TransformNode) t.computeWorldMatrix(true);
      }
      for (const ta of src.targetedAnimations) {
        const t = ta.target as Node;
        if (t instanceof TransformNode && isUpper(t)) {
          overlay.addTargetedAnimation(ta.animation, ta.target);
        }
      }
    }
    overlay.onAnimationGroupEndObservable.add(() => {
      overlay.setWeightForAllAnimatables(0);
    });
    return overlay;
  };
  const castUpper = upperOverlay(shoot, "freud_castUpper");
  const castEUpper = upperOverlay(castE, "freud_castEUpper");

  let wIdle = 1;
  let wWalk = 0;
  let wRun = 0;
  let wBack = 0;
  // One full-body takeover at a time (jump / ult / hit / fight-style cast):
  // locomotion weights drop to zero while `takenOver` is up, and the clip's
  // end observer clears it. Fight style also full-bodies the throw clip
  // (basic/palette), so `shoot` joins the one-shot set only then.
  let takenOver = false;
  /** The takeover currently up is `jump_land` — grounded, magnet-safe. */
  let landing = false;
  // Moving-state snapshot, fed by update() every frame. A jump taken (or
  // landed) on the move cuts straight back to locomotion at touchdown —
  // holding the full landing recovery mid-run froze the legs into a
  // full-body crouch while the body kept gliding. A standing jump still
  // plays the whole pair; recovery only reads right when the feet stay put.
  let lastMoving = false;
  let jumpedMoving = false;
  // ⚠️ EVERY clip `fullBody` can be called with must be in here. The list is
  // both the "stop the siblings" set and the set that gets the end observer
  // which releases the takeover — a clip missing from it plays once and then
  // pins `takenOver` true forever at weight 1, freezing the rig on its last
  // frame (locomotion is held at zero weight while the flag is up). That is
  // exactly what Pavlov's Extinction did: `castF` is the only clip no other
  // hero reaches, so it was the only omission the village never surfaced.
  const fullBodyClips: (AnimationGroup | null)[] =
    castStyle === "fight"
      ? [jumpStart, jumpLand, castR, castE, castF, hit, shoot]
      : [jumpStart, jumpLand, castR, castE, castF, hit];
  const fullBody = (g: AnimationGroup, speed: number): void => {
    // Kill any live overlay first. F's takeover plays the same clip E overlays,
    // so without this the two drive the shared spine/arm bones from separate
    // animatables at different speeds and the arms judder between them.
    castUpper.stop();
    castEUpper.stop();
    // Stop sibling one-shots so a new cast/hit doesn't leave two full-body
    // groups fighting over the same bones (arenaHero does the same).
    for (const other of fullBodyClips) {
      if (other && other !== g) {
        other.stop();
        other.setWeightForAllAnimatables(0);
      }
    }
    g.stop();
    g.start(false, speed);
    g.setWeightForAllAnimatables(1);
    // Any new takeover displaces a running landing recovery; triggerLand
    // re-raises the flag right after its own fullBody call.
    landing = false;
    // ⚠️ AFTER every stop(), never before. Babylon's AnimationGroup.stop()
    // notifies onAnimationGroupEndObservable on a group that was running, and
    // our handler clears `takenOver` — so raising the flag first meant any cast
    // that interrupted a live one-shot (or re-fired the same clip) ended up
    // with the flag DOWN, letting idle blend back to full weight underneath the
    // new clip and washing the cast out to a half-pose. It also made busy() and
    // poseSettled() lie for the whole cast.
    takenOver = true;
  };
  for (const g of fullBodyClips) {
    g?.onAnimationGroupEndObservable.add(() => {
      takenOver = false;
      g.setWeightForAllAnimatables(0);
    });
  }
  jumpLand?.onAnimationGroupEndObservable.add(() => {
    landing = false;
  });
  // jump_land starts off a HELD pose (the launch clip's last airborne frame).
  // Without per-animation blending the weight-1 swap snaps into the clip's
  // opening crouch in one frame, and at the compressed recovery speed the
  // hips-back absorb reads as the hero flashing backwards on touchdown.
  // Blending eases the swap and the plunge from wherever the bones are.
  if (jumpLand) {
    for (const ta of jumpLand.targetedAnimations) {
      ta.animation.enableBlending = true;
      ta.animation.blendingSpeed = 0.12;
    }
  }

  return {
    update(dt, { speed, moving, backward = false }) {
      lastMoving = moving;
      // Tick the idle rest gap down; the greeting resumes when it expires.
      if (idle && idleRest > 0) {
        idleRest -= dt;
        if (idleRest <= 0) idle.speedRatio = 1;
      }
      // Clip banding, matched to the INPUT bands rather than biomechanics:
      // plain WASD (up to WALK_SPEED) is a WALK — it plays the walking clip,
      // over-cranked and accepting some foot glide, because a run cycle on an
      // un-sprinting input read wrong. Shift/full-tilt crossfades to the run
      // clip. NATURAL speeds are per clip SOURCE (mesh2motion library: the
      // formal walk is a 1.67 s cycle, the sprint a brisk 0.83 s); the caps
      // below keep either cycle from strobing at the game's raid speeds.
      const WALK_NATURAL = 1.4; // m/s at which the walk clip's feet grip
      const RUN_NATURAL = 4.5; // m/s at which the sprint clip's feet grip
      let tIdle = 1;
      let tWalk = 0;
      let tRun = 0;
      if (moving && speed > 0.05) {
        if (speed < 0.8) {
          tWalk = speed / 0.8;
          tIdle = 1 - tWalk;
        } else if (speed <= WALK_SPEED) {
          tWalk = 1;
          tIdle = 0;
        } else {
          tRun = Math.min(1, (speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED));
          tWalk = 1 - tRun;
          tIdle = 0;
        }
      }
      // Backpedalling hands the walk share to the reversed copy (never a run).
      let tBack = 0;
      if (backward && walkBack) {
        tBack = tWalk + tRun;
        tWalk = 0;
        tRun = 0;
      }
      if (takenOver) {
        tIdle = 0;
        tWalk = 0;
        tRun = 0;
        tBack = 0;
      }
      const k = Math.min(1, dt * 9);
      wIdle += (tIdle - wIdle) * k;
      wWalk += (tWalk - wWalk) * k;
      wRun += (tRun - wRun) * k;
      wBack += (tBack - wBack) * k;
      idle?.setWeightForAllAnimatables(wIdle);
      walk?.setWeightForAllAnimatables(wWalk);
      run?.setWeightForAllAnimatables(wRun);
      walkBack?.setWeightForAllAnimatables(wBack);
      if (walkBack) walkBack.speedRatio = -Math.min(1.9, Math.max(0.8, speed / WALK_NATURAL));
      // Hard caps: past these, a 60 fps gait cycle alternates legs every
      // handful of frames and the eye reads flicker, not hustle. The walk
      // cycle is longer than the run's, so it tolerates more over-crank
      // before strobing — 1.9x is a brisk march, which is the right read for
      // covering 3.4 m/s on a walking gait.
      if (walk) walk.speedRatio = Math.min(1.9, Math.max(0.8, speed / WALK_NATURAL));
      if (run) run.speedRatio = Math.min(1.5, Math.max(0.8, speed / RUN_NATURAL));
    },
    triggerJump() {
      if (!jumpStart) return;
      jumpedMoving = lastMoving;
      // Fit the launch clip to the ballistic arc — ~0.66 s
      // (2·JUMP_SPEED/JUMP_GRAVITY) — so it completes right at touchdown
      // instead of being force-cut partway through. The old 0.9 s target cut
      // Pavlov's 1.67 s clip at ~73%, which read as a mid-air snap.
      fullBody(jumpStart, Math.min(2.6, Math.max(1, clipSeconds(jumpStart) / 0.66)));
    },
    triggerLand() {
      // Stop the launch clip FIRST, and unconditionally: a rig with no
      // `jump_land` would otherwise keep it running full-body on the ground
      // after touchdown — which is also the window in which the ground magnet
      // used to read a mid-air pose and sink the model.
      if (jumpStart) {
        jumpStart.stop();
        jumpStart.setWeightForAllAnimatables(0);
        takenOver = false;
      }
      // A jump on the move skips the recovery clip entirely — the launch stop
      // above already released the takeover, so walk/run blend straight back
      // in and the gait never breaks. `lastMoving` too, not just the snapshot:
      // a standing jump steered mid-air lands rolling, and recovery over a
      // moving body is the same glide this exists to kill.
      if (jumpedMoving || lastMoving) return;
      if (!jumpLand) return;
      // Landing recovery, compressed to a beat so control feel doesn't read
      // as sluggish — locomotion blends back in right after. The magnet keeps
      // servoing through this clip (see `landingRecovery`).
      fullBody(jumpLand, Math.min(2.8, Math.max(1, clipSeconds(jumpLand) / 0.6)));
      landing = true;
    },
    triggerCast(kind) {
      // Fight style mirrors arenaHero.cast — full-body takeovers at fixed
      // speed ratios so practice-pit attacks match the boss-fight read.
      if (castStyle === "fight") {
        // `readable` floors a very short clip's wall time — Pavlov's second rig
        // answers E and R with the same 0.46 s hook, and 0.46 s at 1.6x is a
        // twitch. Mirrors arenaHero.ts so the pit and the fight look alike.
        if (kind === "ultimate" && castF) {
          fullBody(castF, readable(castF, 1.0));
          return;
        }
        if (kind === "ultimate" && castE) {
          fullBody(castE, readable(castE, 0.9));
          return;
        }
        if (kind === "chain" && castR) {
          fullBody(castR, readable(castR, 0.6));
          return;
        }
        if (kind === "defense" && castE) {
          fullBody(castE, readable(castE, 1.6));
          return;
        }
        if (shoot) fullBody(shoot, readable(shoot, 1.0)); // basic + palette
        return;
      }

      // Hub style: cast playback is deliberately half the old speed (≈2× wall
      // time) — earlier compressions read as a flinch, not a cast. Caps allow
      // slowdown below 1.0 so longer source clips can play near natural rate.
      //
      // F takes the DEDICATED ult clip when the rig ships one — Pavlov's 2 s
      // cast_f. Without this the hub fell through to the branch below and
      // played his 0.46 s defense hook for Extinction, so the same button read
      // as a twitch in the village and as a full takeover in the pit.
      if (kind === "ultimate" && castF) {
        fullBody(castF, readable(castF, 1.0));
        return;
      }
      // Otherwise F runs the E clip full-body: a 60 s-cooldown payoff deserves
      // the full-frame read. Clip ≈5.4 s → target wall ≈5.2 s (was ~2.6 s).
      if (kind === "ultimate" && castE) {
        fullBody(castE, Math.min(1.2, Math.max(0.5, clipSeconds(castE) / 5.2)));
        return;
      }
      // R sits into Meditate — a seated pose can only be a full-body
      // takeover; overlaid on running legs it reads as levitation. Half speed
      // so the settle reads as a deliberate free-association beat.
      if (kind === "chain" && castR) {
        fullBody(castR, 0.5);
        return;
      }
      // E and the palette both go out as upper-body overlays so Freud keeps
      // running while he casts. Palette OverhandThrow (≈1.33 s) → ~2.6 s wall
      // (slowed); E (≈5.38 s) → ~2.6 s of its cooldown.
      const overlay = kind === "defense" && castEUpper.targetedAnimations.length ? castEUpper : castUpper;
      const src = overlay === castEUpper ? castE : shoot;
      if (overlay.targetedAnimations.length === 0) return;
      overlay.stop();
      overlay.start(false, src ? Math.min(1.4, Math.max(0.5, clipSeconds(src) / 2.6)) : 0.5);
      // Outweigh the locomotion clips on the shared upper-body bones (weights
      // are normalised across animatables, so 3:1 ≈ 75% cast).
      overlay.setWeightForAllAnimatables(3);
    },
    triggerHit() {
      if (!hit) return;
      // Knockback interrupts: full-body, at clip speed — 0.83 s of stagger.
      fullBody(hit, 1);
    },
    busy: () => takenOver,
    // 0.85, not 1.0: the slew is exponential (k = dt·9), so the weights only
    // ever approach 1 — by 0.85 the pose is visually locomotion and the feet
    // are back where the bounds probe expects them.
    poseSettled: () => !takenOver && wIdle + wWalk + wRun > 0.85,
    landingRecovery: () => landing,
  };
}

/**
 * Procedural auto-rig for an UNRIGGED humanoid mesh.
 *
 * The Tripo glbs ship as one fused mesh with no skeleton, which left the hero
 * tilting like a statue while he walked. Until models arrive rigged (now the
 * delivery default — docs/asset-pipeline-notes.md "Rig & animation spec"),
 * this builds the minimum skeleton that makes locomotion read: two leg bones
 * hinged at the hips, two arm bones hinged at the shoulders, and a static
 * hips bone holding everything else.
 *
 * Skin weights are cut by REGION with smoothstep falloff, not by mesh
 * topology: below the hip line is leg (split left/right across a narrow blend
 * band at x=0 — the coat's centre seam shares both legs, so the hem walks with
 * the stride the way a skirt-weighted rig does); outboard of the torso between
 * waist and shoulder is arm. The falloffs are what keep a fused coat from
 * shearing at the cuts. Region constants were measured from the actual mesh
 * (vertex-band probe, 2026-07-30): hands reach |x| 0.40 at y 0.75-0.95, torso
 * proper stays inside |x| 0.24, shoulders top out at 1.58.
 *
 * Each bone is driven through a linked TransformNode parented under `pose`,
 * so the controller animates the authored model and the primitive stand-in
 * through the same HeroLimbs interface, with the same code.
 */
function autoRigHumanoid(scene: Scene, geo: Mesh, pose: TransformNode): HeroLimbs {
  const HIP_Y = 0.95; // top of the leg region; also the leg bones' hinge height
  const LEG_FADE = 0.4; // metres over which leg weight ramps in below the hip
  const LEG_SPLIT = 0.16; // width of the left/right blend band astride x=0
  const ARM_X = 0.24; // |x| where torso ends and arm influence starts
  const ARM_FADE = 0.07; // metres over which arm weight ramps in outboard
  const SHOULDER_Y = 1.5; // arm bones' hinge height

  const skeleton = new Skeleton("freud_rig", "freud_rig", scene);
  const hips = new Bone("hips", skeleton, null, Matrix.Identity());
  const link = (name: string, x: number, y: number): TransformNode => {
    const bone = new Bone(name, skeleton, hips, Matrix.Translation(x, y, 0));
    const pivot = new TransformNode(`freud_${name}Pivot`, scene);
    pivot.parent = pose;
    pivot.position.set(x, y, 0);
    bone.linkTransformNode(pivot);
    return pivot;
  };
  // Index order matters: weights below refer to bones by skeleton position.
  const legL = link("legL", -0.1, HIP_Y); // 1
  const legR = link("legR", 0.1, HIP_Y); // 2
  const armL = link("armL", -ARM_X - 0.02, SHOULDER_Y); // 3
  const armR = link("armR", ARM_X + 0.02, SHOULDER_Y); // 4

  const pos = geo.getVerticesData("position");
  if (!pos) return { armL, armR, legL, legR };
  const n = pos.length / 3;
  const indices = new Float32Array(n * 4);
  const weights = new Float32Array(n * 4);
  const smooth = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    // Arm influence: outboard of the torso, between waist and shoulder. The
    // upper fade stops the shoulder itself from swinging; the lower one keeps
    // the coat hem out of the arms' hands.
    const wArm =
      smooth((Math.abs(x) - ARM_X) / ARM_FADE) *
      smooth((1.52 - y) / 0.15) *
      smooth((y - 0.6) / 0.12);
    // Leg influence: everything below the hip line that the arms did not claim.
    const wLeg = smooth((HIP_Y - y) / LEG_FADE) * (1 - wArm);
    const left = smooth(0.5 - x / LEG_SPLIT);
    const o = i * 4;
    indices[o] = 0;
    weights[o] = Math.max(0, 1 - wLeg - wArm);
    indices[o + 1] = 1;
    weights[o + 1] = wLeg * left;
    indices[o + 2] = 2;
    weights[o + 2] = wLeg * (1 - left);
    indices[o + 3] = x < 0 ? 3 : 4;
    weights[o + 3] = wArm;
  }
  geo.setVerticesData("matricesIndices", indices, false, 4);
  geo.setVerticesData("matricesWeights", weights, false, 4);
  geo.skeleton = skeleton;
  return { armL, armR, legL, legR };
}

/**
 * The primitive stand-in, built against `F1_turnaround.png` / F1b. Kept as the
 * fallback (and as the scale reference the authored model is normalised to):
 * charcoal overcoat over black three-piece, gray-white beard, cyan lapel trim,
 * AR monocle over the RIGHT eye only (F1 is canon; F2's goggles are a known
 * concept defect), briar pipe, 1.8 m silhouette.
 */
function buildFreudStandIn(scene: Scene, mats: Mats, opts: BuildFreudOptions = {}): HeroHandle {
  const root = new TransformNode("freud", scene);
  root.position.set(FREUD_SPOT.x, 0, FREUD_SPOT.z);
  root.rotation.y = FREUD_SPOT.ry;

  const pose = new TransformNode("freud_pose", scene);
  pose.parent = root;

  const trim = holoMat(scene, mats, PALETTE.cyan, 0.95);

  const part = (mesh: Mesh, y: number, matOverride?: PBRMaterial | StandardMaterial): Mesh => {
    mesh.parent = pose;
    mesh.position.y = y;
    if (matOverride) mesh.material = matOverride;
    return mesh;
  };

  // Limb pivot helper: the joint (hip / shoulder) is a TransformNode and the
  // limb mesh hangs below it, so `pivot.rotation.x` swings the limb the way a
  // walk cycle needs — about the joint, not about the limb's own centre.
  const limbPivot = (name: string, x: number, jointY: number, mesh: Mesh): TransformNode => {
    const pivot = new TransformNode(`${name}Pivot`, scene);
    pivot.parent = pose;
    pivot.position.set(x, jointY, 0);
    mesh.parent = pivot;
    return pivot;
  };

  // Legs — black suit trousers, hinged at the hip (0.9 m).
  const legPivots: TransformNode[] = [];
  for (let i = 0; i < 2; i++) {
    const leg = MeshBuilder.CreateCylinder(`freud_leg${i}`, { diameter: 0.17, height: 0.9, tessellation: 10 }, scene);
    leg.material = mats.suit;
    leg.position.y = -0.45; // hangs from the hip: centre is half the length down
    legPivots.push(limbPivot(`freud_leg${i}`, i === 0 ? -0.11 : 0.11, 0.9, leg));
  }

  // Torso — waistcoat + shirt line.
  const torso = MeshBuilder.CreateCapsule(
    "freud_torso",
    { height: 0.95, radius: 0.21, tessellation: 10, capSubdivisions: 3 },
    scene
  );
  part(torso, 1.32, mats.suit);

  // Overcoat — the read at 30 m. Slightly flared, open at the front.
  const coat = MeshBuilder.CreateCylinder(
    "freud_coat",
    { diameterTop: 0.5, diameterBottom: 0.66, height: 1.15, tessellation: 14 },
    scene
  );
  part(coat, 1.15, mats.coat);

  const shoulders = MeshBuilder.CreateBox("freud_shoulders", { width: 0.62, height: 0.14, depth: 0.3 }, scene);
  part(shoulders, 1.66, mats.coat);

  // Cyan circuit trim on both lapels.
  for (let i = 0; i < 2; i++) {
    const lapel = MeshBuilder.CreateBox(`freud_lapel${i}`, { width: 0.03, height: 0.42, depth: 0.03 }, scene);
    part(lapel, 1.45, trim);
    lapel.position.x = i === 0 ? -0.13 : 0.13;
    lapel.position.z = -0.2;
    lapel.rotation.z = i === 0 ? 0.16 : -0.16;
  }

  // Arms — hinged at the shoulder (1.66 m), with the resting outward splay kept
  // on the MESH so the pivot's rotation.x stays a clean fore/aft swing axis.
  const armPivots: TransformNode[] = [];
  for (let i = 0; i < 2; i++) {
    const arm = MeshBuilder.CreateCylinder(`freud_arm${i}`, { diameter: 0.13, height: 0.78, tessellation: 8 }, scene);
    arm.material = mats.coat;
    arm.position.y = -0.32; // shoulder 1.66 minus the old 1.34 centre height
    arm.rotation.z = i === 0 ? 0.07 : -0.07;
    armPivots.push(limbPivot(`freud_arm${i}`, i === 0 ? -0.31 : 0.31, 1.66, arm));
  }

  // Head, hair, beard.
  const head = MeshBuilder.CreateSphere("freud_head", { diameter: 0.29, segments: 12 }, scene);
  part(head, 1.93, mats.skin);

  const hair = MeshBuilder.CreateSphere("freud_hair", { diameter: 0.3, segments: 10 }, scene);
  part(hair, 1.97, mats.hair);
  hair.scaling.set(1, 0.72, 1.02);

  const beard = MeshBuilder.CreateSphere("freud_beard", { diameter: 0.25, segments: 10 }, scene);
  part(beard, 1.85, mats.hair);
  beard.scaling.set(0.9, 0.95, 0.8);
  beard.position.z = -0.05;

  // AR monocle — RIGHT eye only. From the character's own right, so -X in
  // local space with the model facing -Z.
  const monocle = MeshBuilder.CreateTorus("freud_monocle", { diameter: 0.11, thickness: 0.014, tessellation: 16 }, scene);
  part(monocle, 1.96, trim);
  monocle.position.set(-0.06, 1.96, -0.13);
  monocle.rotation.x = Math.PI / 2;

  const lens = MeshBuilder.CreateDisc("freud_lens", { radius: 0.05, tessellation: 16 }, scene);
  part(lens, 1.96, holoMat(scene, mats, PALETTE.cyan.scale(0.7), 0.45));
  lens.position.set(-0.06, 1.96, -0.132);

  // Briar pipe, held at the right hand.
  const pipeStem = MeshBuilder.CreateCylinder("freud_pipeStem", { diameter: 0.018, height: 0.16, tessellation: 6 }, scene);
  part(pipeStem, 1.06, mats.suit);
  pipeStem.position.set(-0.34, 1.06, -0.12);
  pipeStem.rotation.x = Math.PI / 2.4;

  const pipeBowl = MeshBuilder.CreateCylinder("freud_pipeBowl", { diameter: 0.05, height: 0.07, tessellation: 8 }, scene);
  const bowlMat = new PBRMaterial("freud_briar", scene);
  bowlMat.albedoColor = new Color3(0.16, 0.07, 0.04); // briar
  bowlMat.metallic = 0;
  bowlMat.roughness = 0.55;
  part(pipeBowl, 1.03, bowlMat);
  pipeBowl.position.set(-0.34, 1.03, -0.2);

  attachPipeSmoke(scene, pipeBowl);
  const drone = buildDrone(scene, mats, root);
  return {
    node: root,
    pose,
    limbs: { armL: armPivots[0], armR: armPivots[1], legL: legPivots[0], legR: legPivots[1] },
    castStyle: opts.castStyle ?? "hub",
    fx: { cast: null },
    tick: drone.tick,
  };
}

// ---------------------------------------------------------------------------
// Hero voice — cast + idle lines, one pack per hero
// (assets/work/<hero>/voice/README.md is each pack's recipe)
// ---------------------------------------------------------------------------

const VOICE_BASE = "/assets/heroes/voice";

/** One hero's VO pack: where the files live and what plays when. */
interface HeroVoicePack {
  /** URL base the VO stems resolve against (extension: src/core/audio.ts). */
  base: string;
  /** Chat-caption speaker — `<museName> muses: "…"`. */
  museName: string;
  /**
   * Cast line per skill id — each pack ships exactly one line per skill
   * (`manifest.json` is the source of truth for ids and text). Basics are
   * deliberately absent: a line on a 600 ms / 2 s button is chatter, not VO.
   */
  cast: Record<string, string>;
  /** Idle stems, played in rotation. */
  idle: string[];
  /**
   * Chat caption per idle line — the real texts from the pack's
   * manifest.json. Announced locally when the line plays so the musing is
   * readable, not only audible.
   */
  captions: Record<string, string>;
}

const FREUD_VOICE: HeroVoicePack = {
  base: VOICE_BASE,
  museName: "Freud",
  cast: {
    "freud.stage.oral": "cast_oral",
    "freud.stage.anal": "cast_anal",
    "freud.stage.phallic": "cast_phallic",
    "freud.stage.latency": "cast_latency",
    "freud.stage.genital": "cast_genital",
    "freud.defense": "cast_defense",
    "freud.free-association": "cast_free_association",
    "freud.dream-analysis": "cast_dream_analysis",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "Speak freely. The symptom already has.",
    idle_02: "Id wants it now. Superego wants it pure. I want the Mark.",
    idle_03: "Lie still. I'm taking notes… and aim.",
  },
};

/**
 * Pavlov (VoxCPM2 pack — assets/work/pavlov/voice): a designed-then-cloned
 * Russian bass, well below Erikson and Skinner (tools/gen-pavlov-voice.sh).
 * NS/CS share one button (the bell transforms
 * while the boss is CONDITIONED) but are different casts, so CS gets its own
 * line; NS is the silent bell (see `cast` docs).
 */
const PAVLOV_VOICE: HeroVoicePack = {
  base: `${VOICE_BASE}/pavlov`,
  museName: "Pavlov",
  cast: {
    "pavlov.ucs": "cast_ucs",
    "pavlov.cs": "cast_cs",
    "pavlov.spontaneous-recovery": "cast_spontaneous_recovery",
    "pavlov.generalization": "cast_generalization",
    "pavlov.extinction": "cast_extinction",
    "pavlov.discrimination": "cast_discrimination",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "Nobel Prize, 1904, for digestion. The bell came later.",
    idle_02: "My dogs learned faster than you, and they could not read the tooltip.",
    idle_03: "Standing still? Noted: subject is not hungry.",
  },
};

/**
 * Skinner: mid-age American behavioral scientist, dry wit — a designed-then-
 * cloned voice (tools/gen-skinner-voice.sh), deliberately younger than
 * Freud's uncle_fu and unaccented against Pavlov's eric. The basic stays
 * silent like everyone's. The E/R toggles speak the state you SWITCH TO:
 * both start at Positive/Reinforcement, so the base slot ids carry the
 * first-press lines, and the arena's per-face ids (…-positive etc., which
 * name the CURRENT state) carry the line for the flip's destination.
 */
const SKINNER_VOICE: HeroVoicePack = {
  base: `${VOICE_BASE}/skinner`,
  museName: "Skinner",
  cast: {
    "skinner.fixed-ratio": "cast_fixed_ratio",
    "skinner.variable-ratio": "cast_variable_ratio",
    "skinner.fixed-interval": "cast_fixed_interval",
    "skinner.variable-interval": "cast_variable_interval",
    "skinner.contingency": "toggle_negative",
    "skinner.contingency-positive": "toggle_negative",
    "skinner.contingency-negative": "toggle_positive",
    "skinner.consequence": "toggle_punishment",
    "skinner.consequence-reinforcement": "toggle_punishment",
    "skinner.consequence-punishment": "toggle_reinforcement",
    "skinner.shaping": "cast_shaping",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "It's not a cage. It's a chamber with unusually honest feedback.",
    idle_02: "Free will. Adorable. Press your buttons, I'll press mine.",
    idle_03: "My pigeons invented a religion in one afternoon. You people take a whole loading screen.",
  },
};

/**
 * Erikson (VoxCPM2 pack — assets/work/erikson/voice). Keys 1 and 2 speak the
 * crisis and the virtue of the stage they cast, so their entries are keyed
 * per stage (`erikson.stage:5` → "Identity versus role confusion."); callers
 * build the key with `voiceKeyFor`.
 */
const ERIKSON_VOICE: HeroVoicePack = {
  base: `${VOICE_BASE}/erikson`,
  museName: "Erikson",
  cast: {
    ...Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
        [`erikson.stage:${n}`, `stage_${n}`],
        [`erikson.virtue:${n}`, `virtue_${n}`],
      ])
    ),
    "erikson.moratorium": "cast_moratorium",
    "erikson.identity-crisis": "cast_identity_crisis",
    "erikson.life-review": "cast_life_review",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "I named myself Erikson. Erik, son of Erik. Now that is identity formation.",
    idle_02: "Freud stopped at puberty. I kept going. Somebody has to look after the grandparents.",
    idle_03: "No university degree, and still they gave me an office at Harvard. Industry beats inferiority.",
  },
};

/**
 * Ainsworth: a warm alto in her sixties, designed then cloned
 * (tools/gen-ainsworth-voice.sh). Keys 1–4 act out each attachment style's
 * reunion, short enough for the GCD; history and jokes sit on E/R/F, the
 * Proximity Maintenance stance and the idles. The skill ids are the kit's
 * planned ones (shared/heroes/ainsworth.ts is the next step), so they speak as
 * soon as the kit lands.
 */
const AINSWORTH_VOICE: HeroVoicePack = {
  base: `${VOICE_BASE}/ainsworth`,
  museName: "Ainsworth",
  cast: {
    "ainsworth.secure": "cast_secure",
    "ainsworth.avoidant": "cast_avoidant",
    "ainsworth.ambivalent": "cast_ambivalent",
    "ainsworth.disorganized": "cast_disorganized",
    "ainsworth.safe-haven": "cast_safe_haven",
    "ainsworth.strange-situation": "cast_strange_situation",
    "ainsworth.earned-security": "cast_earned_security",
    "ainsworth.proximity-maintenance": "cast_proximity_maintenance",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "Eight episodes, twenty minutes, one stranger. Best twenty minutes in psychology.",
    idle_02: "John Bowlby had the theory. I had the clipboard. And the babies.",
    idle_03: "I was a major in the Canadian army, you know. Toddlers are much harder to command.",
  },
};

/**
 * Piaget: a gentle Swiss-French grandfather, designed then cloned
 * (tools/gen-piaget-voice.sh). Keys 1–4 think like each stage — the infant's
 * "again!", the preoperational fixation, conservation, the hypothetical — and
 * were re-rolled to fit the GCD; jokes and history sit on E/R/F and the idles.
 */
const PIAGET_VOICE: HeroVoicePack = {
  base: `${VOICE_BASE}/piaget`,
  museName: "Piaget",
  cast: {
    "piaget.sensorimotor": "cast_sensorimotor",
    "piaget.preoperational": "cast_preoperational",
    "piaget.concrete": "cast_concrete",
    "piaget.formal": "cast_formal",
    "piaget.accommodation": "cast_accommodation",
    "piaget.object-permanence": "cast_object_permanence",
    "piaget.equilibration": "cast_equilibration",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "I published my first paper at ten. On an albino sparrow. The reviewers did not know I was ten.",
    idle_02: "I studied my own three children. Very cooperative subjects. They never read the consent forms.",
    idle_03: "Every morning I cycle to the university with my pipe, thinking. Mostly about snails.",
  },
};

/**
 * Bandura: a bright Alberta tenor, designed then cloned
 * (tools/gen-bandura-voice.sh). Keys 1–4 hold copies of his model's skills,
 * so their lines are about the COPYING, one per retention slot.
 */
const BANDURA_VOICE: HeroVoicePack = {
  base: `${VOICE_BASE}/bandura`,
  museName: "Bandura",
  cast: {
    "bandura.observe-1": "cast_observe_1",
    "bandura.observe-2": "cast_observe_2",
    "bandura.observe-3": "cast_observe_3",
    "bandura.observe-4": "cast_observe_4",
    "bandura.self-efficacy": "cast_self_efficacy",
    "bandura.bobo-doll": "cast_bobo_doll",
    "bandura.reciprocal-determinism": "cast_reciprocal_determinism",
  },
  idle: ["idle_01", "idle_02", "idle_03"],
  captions: {
    idle_01: "I grew up in a town of four hundred people. Two teachers for the whole high school. We taught ourselves.",
    idle_02: "The Bobo doll got punched a few thousand times for science. He is fine. He bounces back.",
    idle_03: "I took my first psychology course because it fit my car-pool schedule. Best accident of my life.",
  },
};

/** Unknown ids fall back to Freud — same rule `heroById` applies to the rig. */
const VOICE_PACKS: Record<string, HeroVoicePack> = {
  freud: FREUD_VOICE,
  pavlov: PAVLOV_VOICE,
  skinner: SKINNER_VOICE,
  erikson: ERIKSON_VOICE,
  ainsworth: AINSWORTH_VOICE,
  piaget: PIAGET_VOICE,
  bandura: BANDURA_VOICE,
};

/**
 * The voice-line key for a cast. Erikson's keys 1 and 2 speak the stage they
 * cast, so they key on the rotation as it stood BEFORE the press (key 2's
 * matched pair answers the armed stage, which is still `stage` until the cast
 * lands). Every other slot keys on its id.
 */
export function voiceKeyFor(kit: Hero, slotId: string, ps: PsychosocialHudState | null): string {
  if (!kit.psychosocial || !ps) return slotId;
  const entry = kit.palette.find((p) => p.id === slotId);
  const rotates = entry?.effects.some((e) => e.kind === "psychosocial.stage" || e.kind === "psychosocial.virtue");
  return rotates ? `${slotId}:${ps.stage + 1}` : slotId;
}
/**
 * First idle musing after Freud has been truly at rest this long.
 * Shorter than the between-line interval so standing still is rewarded sooner.
 */
const IDLE_VOICE_FIRST_S = 8;
/** Seconds of continuous rest between subsequent idle lines. */
const IDLE_VOICE_AFTER_S = 30;
/**
 * Brief movement / combat-linger flicker shorter than this does NOT reset the
 * idle clock. Without grace, a single WASD tap (or stick noise) zeroed a
 * 29 s wait and made idle VO feel full of "gaps".
 */
const IDLE_BUSY_GRACE_S = 0.55;

// ---------------------------------------------------------------------------
// OST — village hub music (assets/work/village/music → public/assets/village/ost)
// ---------------------------------------------------------------------------

const VILLAGE_OST_BASE = "/assets/village/ost";
/** Firelight 1, Firelight 2, Kinetic Glass, Kinetic Glass Origin, Melody of the Glass City — played in order, then wrap. */
const VILLAGE_OST_TRACKS = [
  "firelight_1",
  "firelight_2",
  "kinetic_glass_loop",
  "kinetic_glass_loop_origin",
  "melody_of_the_glass_city",
] as const;
/** Hub ambient under VO; 0.3 = 30% of full bus. */
const VILLAGE_OST_VOLUME = 0.3;

interface VillageMusic {
  dispose(): void;
}

/**
 * Hub ambient OST: cycles the track list in order, wrapping, at low volume. Same dispose
 * contract as the boss fight music so a V/B scene switch cannot leave a
 * decoder hot or re-fire unlock into the arena.
 *
 * Autoplay: try immediately; on browser block, unlock on first gesture.
 */
function createVillageMusic(): VillageMusic {
  const player = typeof Audio !== "undefined" ? new Audio() : null;
  if (!player) return { dispose: () => {} };

  let disposed = false;
  let trackIx = 0;

  const loadTrack = (i: number): void => {
    const name = VILLAGE_OST_TRACKS[i % VILLAGE_OST_TRACKS.length]!;
    player.src = audioUrl(`${VILLAGE_OST_BASE}/${name}`);
    player.volume = VILLAGE_OST_VOLUME;
    player.loop = false; // advance on end; wrap after the last track
    player.preload = "auto";
  };

  const playCurrent = (): void => {
    if (disposed) return;
    void player.play().catch(() => {});
  };

  loadTrack(trackIx);
  player.addEventListener("ended", () => {
    if (disposed) return;
    trackIx = (trackIx + 1) % VILLAGE_OST_TRACKS.length;
    loadTrack(trackIx);
    playCurrent();
  });

  // System-tab music settings: mute plus an optional single-track loop that
  // replaces the rotation. Applied live; back to Auto resumes the rotation.
  const unbindSettings = bindOstPlayer(player, () => {
    loadTrack(trackIx);
    playCurrent();
  });

  const unlock = (): void => {
    if (disposed) return;
    playCurrent();
  };
  void player.play().catch(() => {
    if (disposed) return;
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unbindSettings();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      try {
        player.volume = 0;
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch {
        // ignore races on a dead element
      }
    },
  };
}

export interface HeroVoice {
  cast(skillId: string): void;
  /** Every frame from the controller: dt in seconds, whether he is at rest. */
  tickIdle(dt: number, idle: boolean): void;
  dispose(): void;
}

/**
 * One shared HTMLAudio element, not Babylon Sound: voice lines are flat
 * UI-adjacent one-shots — no spatialisation, no engine coupling, and the
 * browser's element pipeline handles mp3 decode off the main thread. One
 * element also enforces the right overlap rule for free: a new line replaces
 * whatever was still talking, so a cast interrupts an idle musing instead of
 * doubling over it.
 *
 * Autoplay policy: an idle line can fire before the first user gesture and be
 * rejected — held as `pending` and replayed on the next pointer/key input.
 *
 * Idle scheduling: accumulate rest time; only reset after sustained "busy"
 * (movement / jump / combat linger) longer than IDLE_BUSY_GRACE_S. Cast
 * hard-resets because a skill line owns the channel.
 */
export function createHeroVoice(heroId?: string, volume = 1): HeroVoice {
  const pack = VOICE_PACKS[heroId ?? "freud"] ?? FREUD_VOICE;
  const player = typeof Audio !== "undefined" ? new Audio() : null;
  let disposed = false;
  /** Line swallowed by autoplay policy — retried on the next user gesture. */
  let pending: string | null = null;
  /** Bumped per play() so a stale rejection can't re-queue an old line. */
  let playToken = 0;
  const play = (name: string): void => {
    if (!player || disposed) return;
    // Read at play time, not init: the hero-codex "Voice lines" toggle takes
    // effect immediately, mid-scene, without a reload.
    if (isVoiceMuted()) return;
    // A newer line supersedes anything held back — never both.
    pending = null;
    const token = ++playToken;
    player.volume = volume;
    player.src = audioUrl(`${pack.base}/${name}`);
    void player.play().catch((err: unknown) => {
      // Autoplay block (no gesture yet): hold the line and replay it on the
      // first pointer/key input instead of losing it for a full 30 s cycle.
      // ONLY that case re-queues. An AbortError — this play() interrupted by
      // a newer line loading into the shared element — must not: it made the
      // interrupted line `pending`, and the next click/keydown replayed it
      // over whatever was talking (the "extra voice line on click/move" bug).
      // The token guard drops rejections that resolve after a newer play().
      if (token !== playToken) return;
      if ((err as DOMException | null)?.name === "NotAllowedError") pending = name;
    });
  };
  const unlock = (): void => {
    if (!pending || disposed) return;
    const name = pending;
    pending = null;
    play(name);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  /**
   * Where the idle captions go (main.ts exposes the chat panel) — same call
   * shape as announceWorld() in fight/arenaCombat.ts. ChatPanel.announce()
   * pushes a LOCAL-only [World] line; it never touches the network, so these
   * captions stay single-player, exactly like the VO itself.
   */
  const announceIdle = (text: string): void => {
    const chat = (window as unknown as { psyrena?: { chat?: { announce?: (t: string) => void } } })
      .psyrena?.chat;
    if (chat?.announce) chat.announce(text);
  };

  let idleFor = 0;
  let busyFor = 0;
  /** How many idle lines played during this continuous rest stretch. */
  let linesThisRest = 0;
  // Rotation, not RNG: three lines heard in order repeat far less obviously
  // than three lines drawn at random, and the scene stays deterministic.
  let idleIdx = 0;

  const resetRest = (): void => {
    idleFor = 0;
    busyFor = 0;
    linesThisRest = 0;
  };

  return {
    cast(skillId: string): void {
      const file = pack.cast[skillId];
      if (!file) return;
      play(file);
      // Skill VO owns the channel; next idle must re-earn a full rest window.
      resetRest();
    },
    tickIdle(dt: number, idle: boolean): void {
      if (!idle) {
        busyFor += dt;
        // Only dump progress after sustained activity — not a one-frame bump.
        if (busyFor >= IDLE_BUSY_GRACE_S) resetRest();
        return;
      }
      busyFor = 0;
      idleFor += dt;
      const need = linesThisRest === 0 ? IDLE_VOICE_FIRST_S : IDLE_VOICE_AFTER_S;
      if (idleFor < need) return;
      idleFor = 0;
      linesThisRest++;
      const line = pack.idle[idleIdx % pack.idle.length]!;
      idleIdx++;
      // Muted (hero-codex toggle): no audio, and no caption either — a chat
      // line for a musing nobody heard would read as noise.
      if (isVoiceMuted()) return;
      play(line);
      const caption = pack.captions[line];
      if (caption) announceIdle(`${pack.museName} muses: "${caption}"`);
    },
    dispose(): void {
      // Mute + abort so a scene switch mid-line doesn't leak a syllable
      // into the next scene (same HTMLAudio leak path as the boss OST).
      if (disposed) return;
      disposed = true;
      pending = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
      }
      if (!player) return;
      try {
        player.volume = 0;
        player.pause();
        player.removeAttribute("src");
        player.load();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Hero control — WASD + third-person camera + skill bar
// ---------------------------------------------------------------------------

/** Movement tuning. Metres per second; doc 02 lists movement as raid-standard. */
const WALK_SPEED = 3.4;
const RUN_SPEED = 6.2;
/** Keep the hero on the block: plaza + street, short of the facade ring. */
const WALK_LIMIT = 21.5;

// ---------------------------------------------------------------------------
// Static solidity — 2D push-out colliders
// ---------------------------------------------------------------------------

/**
 * The hub floor is flat and every solid thing on it is static, so solidity is
 * a 2D problem: a few dozen circles and capsules on the ground plane, resolved
 * by push-out after the controller integrates movement. This is deliberately
 * NOT Babylon's `moveWithCollisions` — that walks every mesh's full geometry
 * per frame, and the server-authoritative controller (doc 06) will replace
 * client collision wholesale anyway. Same lifetime as the radial clamp.
 */
interface CircleCollider {
  kind: "circle";
  x: number;
  z: number;
  r: number;
}

/** A capsule around a ground segment — benches, fences, anything elongated. */
interface SegmentCollider {
  kind: "segment";
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
}

export type StaticCollider = CircleCollider | SegmentCollider;

/** Hero body radius. Matches the blob shadow disc, which is the visual promise. */
const HERO_RADIUS = 0.4;

/**
 * Which meshes are solid, by the names this file itself assigns (the same
 * contract the shadow denylist relies on). Flat decals, glyphs, glass and
 * holo dressing stay walk-through on purpose; everything here has a physical
 * body the player would expect to bump into.
 */
const SOLID_NAME =
  /^(planter|bench|bollard|villager|npc_|portalStand|coffee-shop_seat|practice-booth_(post|pavilion|projector)|pet-park_(gate|fencePanel|signPost)|marblePilaster|hall-of-minds_plinth)/;

/**
 * Derive colliders from the meshes already placed in the scene.
 *
 * Runs ONCE after the build, reading world-space bounding boxes (valid — every
 * static mesh froze its world matrix after positioning). Elongated boxes get a
 * capsule along their major axis, everything else a circle, so a bench blocks
 * along its seat without rounding a two-metre no-walk disc onto the plaza.
 */
export function collectStaticColliders(scene: Scene): StaticCollider[] {
  const out: StaticCollider[] = [];
  for (const mesh of scene.meshes) {
    if (!SOLID_NAME.test(mesh.name) || !mesh.isEnabled()) continue;
    const bb = mesh.getBoundingInfo().boundingBox;
    const c = bb.centerWorld;
    const ex = bb.extendSizeWorld.x;
    const ez = bb.extendSizeWorld.z;
    if (ex <= 0 || ez <= 0) continue;
    const minExt = Math.min(ex, ez);
    const maxExt = Math.max(ex, ez);
    if (maxExt > minExt * 1.6) {
      // Elongated: capsule along the major world axis. Half-length shrinks by
      // the radius so the capsule's rounded caps end at the box, not past it.
      const half = maxExt - minExt;
      const alongX = ex >= ez;
      out.push({
        kind: "segment",
        ax: c.x - (alongX ? half : 0),
        az: c.z - (alongX ? 0 : half),
        bx: c.x + (alongX ? half : 0),
        bz: c.z + (alongX ? 0 : half),
        r: minExt,
      });
    } else {
      // Roundish: split the difference between inscribed and circumscribed so
      // square planters neither snag mid-face nor fence off their corners.
      out.push({ kind: "circle", x: c.x, z: c.z, r: (minExt + maxExt) / 2 });
    }
  }
  return out;
}

/**
 * Push the hero out of every collider he overlaps. Two passes settle the
 * corner case where resolving one collider shoves him into a neighbour
 * (bench between two bollards); more passes buy nothing visible.
 */
function resolveStaticColliders(pos: Vector3, colliders: StaticCollider[]): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const col of colliders) {
      let cx: number;
      let cz: number;
      if (col.kind === "segment") {
        // Closest point on the segment to the hero.
        const abx = col.bx - col.ax;
        const abz = col.bz - col.az;
        const len2 = abx * abx + abz * abz;
        const t =
          len2 > 0
            ? Math.max(0, Math.min(1, ((pos.x - col.ax) * abx + (pos.z - col.az) * abz) / len2))
            : 0;
        cx = col.ax + abx * t;
        cz = col.az + abz * t;
      } else {
        cx = col.x;
        cz = col.z;
      }
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const rr = col.r + HERO_RADIUS;
      const d2 = dx * dx + dz * dz;
      // d2 === 0 has no push direction — the next frame's movement resolves it.
      if (d2 >= rr * rr || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const push = (rr - d) / d;
      pos.x += dx * push;
      pos.z += dz * push;
    }
  }
}
/**
 * Jump: launch velocity and gravity for a ~0.75 m arcade hop (~0.65 s airtime).
 * Gravity is deliberately stronger than Earth's — realistic 9.81 makes game
 * jumps float, which is why every action game since Mario runs 1.5-2x.
 */
const JUMP_SPEED = 4.6;
const JUMP_GRAVITY = 14;
/** Cast gesture length in seconds — a beat shorter than the 1.5 s GCD. */
const CAST_GESTURE_S = 0.38;
/**
 * Seconds after the last skill cast during which Freud still counts as "in
 * combat" for voice purposes: idle musings are for standing around, not for
 * the middle of a practice-dummy rotation, and a fight is over when the
 * casting stops for a while — not the instant the last gesture ends. First
 * idle line lands ~this + `IDLE_VOICE_FIRST_S` after the fight.
 */
const COMBAT_LINGER_S = 12;
/**
 * Combat stance: for this long after a cast at a target, the hero keeps facing
 * it (as monsters face him) instead of turning to his movement. Stepping
 * sideways or back walks — back plays the walk in reverse, a little slower —
 * and only moving TOWARD the target may run. The stance ends on its own.
 */
const COMBAT_FACE_S = 3;
const BACKPEDAL_MULT = 0.85;

/**
 * WASD / thumbstick character controller with camera follow.
 *
 * Client-side only and deliberately dumb — no collision, no navmesh, just a
 * radial clamp. This is the M1 "walk around and look at the hub" loop; the
 * server-authoritative version (doc 06: 5 Hz hub tick, client prediction)
 * replaces the guts of this without changing the scene wiring.
 *
 * Camera relationship is WoW-grammar: input moves relative to where the CAMERA
 * faces, drag orbits freely through 360°, the hero turns toward his movement
 * direction rather than the camera's. That grammar is what lets one controller
 * serve both schemes — the thumbstick substitutes for the WASD axes and nothing
 * else about the movement model changes.
 *
 * The keyboard path stays live even on touch, so a tablet with a keyboard, or a
 * phone being driven from a desk, works with either hand.
 */

export function createHeroController(
  scene: Scene,
  camera: ArcRotateCamera,
  hero: HeroHandle,
  mats: Mats,
  colliders: StaticCollider[],
  voice: HeroVoice,
  /**
   * Replaces the hub's radial walk limit + prop push-out, for scenes whose
   * solidity is map data rather than a disc (the survival map: shared boxes
   * the server clamps against too). Mutates the position in place.
   */
  clamp?: (pos: Vector3) => void
): Ticker {
  const node = hero.node;
  const pose = hero.pose;
  const anim = hero.animator;
  // With real clips the whole-body procedural language turns into a garnish:
  // the clips carry the walk bob, breath and limb motion, so the pose node
  // only adds a shave of speed lean and the jump/cast accents on top.
  const bodyAmp = anim ? 0.35 : 1;
  const held = new Set<string>();
  /** Edge-triggered so holding space does not bunny-hop every landing. */
  let jumpQueued = false;
  const down = (e: KeyboardEvent) => {
    if (isTypingInField()) return; // chat and rooms panel own the keyboard; "wasd" is a word
    const k = e.key.toLowerCase();
    if (["w", "a", "s", "d", "shift"].includes(k)) held.add(k);
    if (k === " " && !e.repeat) {
      // Space scrolls the page and activates focused buttons — neither is
      // wanted while it is the jump key.
      e.preventDefault();
      jumpQueued = true;
    }
  };
  const up = (e: KeyboardEvent) => held.delete(e.key.toLowerCase());
  const blur = () => held.clear(); // alt-tab must not leave a key stuck down
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    scene.onDisposeObservable.add(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    });
  }

  // Left-thumb stick. Created here rather than in `createVillageHub` because
  // movement input belongs to the thing that consumes it, and it dies with the
  // scene the same way the action bar does.
  const stick =
    typeof document !== "undefined" && detectControlScheme() === "touch"
      ? new TouchStick(uiScale())
      : null;
  if (stick) scene.onDisposeObservable.add(() => stick.dispose());

  // Touch jump button — parked just right of the stick's resting ring (ring
  // centre ~(92, 92) at scale 1, right edge ~158), so the left thumb reaches
  // it without leaving the stick. Same DOM-overlay reasoning as the stick,
  // same visual language as the action bar. It paints above the stick zone
  // (same z-index, later in the DOM), so its taps never grab the stick.
  if (stick) {
    const scale = uiScale();
    const d = Math.round(46 * scale);
    const jump = document.createElement("button");
    jump.id = "touch-jump"; // panelChrome hides it while a panel is open
    jump.textContent = "JUMP";
    jump.style.cssText = [
      "position:fixed",
      `left:${Math.round(178 * scale)}px`,
      `bottom:${Math.round(44 * scale)}px`,
      `width:${d}px`,
      `height:${d}px`,
      "border-radius:50%",
      "border:1px solid rgba(120,220,255,.4)",
      "background:radial-gradient(circle at 40% 35%,rgba(24,52,74,.85),rgba(6,14,24,.85))",
      "color:#a8f0ff",
      `font:600 ${Math.max(9, Math.round(10 * scale))}px ui-monospace,monospace`,
      "letter-spacing:.06em",
      "z-index:9",
      "touch-action:none",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");
    jump.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      jumpQueued = true;
    });
    document.body.appendChild(jump);
    scene.onDisposeObservable.add(() => jump.remove());
  }

  // Blob shadow — a soft dark disc that follows the hero. The static shadow
  // map can't track him (it renders once), and a second per-frame shadow
  // generator for one character is the wrong trade on this hardware.
  const blob = MeshBuilder.CreateDisc("freud_blob", { radius: 0.55, tessellation: 24 }, scene);
  blob.rotation.x = Math.PI / 2;
  const blobMat = new StandardMaterial("freud_blobMat", scene);
  blobMat.disableLighting = true;
  blobMat.emissiveColor = Color3.Black();
  blobMat.diffuseColor = Color3.Black();
  blobMat.specularColor = Color3.Black();
  blobMat.opacityTexture = createSoftDotTexture(scene);
  blobMat.alpha = 0.55;
  blob.material = blobMat;
  void mats; // reserved for future controller dressing

  let lastT = 0;
  let bobPhase = 0;
  /** Smoothed 0..1 fraction of run speed — the single knob body language runs on. */
  let stride = 0;
  /** Vertical jump state, kept apart from the bob so they compose, not fight. */
  let jumpY = 0;
  let jumpVel = 0;
  /** Smoothed 0 grounded .. 1 airborne — fades bob/swing out over a few frames. */
  let airBlend = 0;
  /** Seconds since the last cast gesture started. */
  let castAge = Infinity;
  let yaw = node.rotation.y;
  /** Combat stance: what to face, and for how much longer. */
  let focus: (() => Vector3) | null = null;
  let focusT = 0;

  return {
    tick: (t: number) => {
      const dt = Math.min(0.1, t - lastT || 0);
      lastT = t;

      // A modal panel over the scene must not leave inputs latched: a WASD
      // key whose keyup goes missing while a panel owns the screen, or a
      // touch-stick drag stranded under a panel overlay, otherwise keeps the
      // hero marching forever. Clearing every tick while one is open also
      // simply stops movement under the modal, which is the expected read.
      if (typeof document !== "undefined" && document.body.dataset.panelOpen) {
        held.clear();
        jumpQueued = false;
        stick?.release();
      }

      let forward = (held.has("w") ? 1 : 0) - (held.has("s") ? 1 : 0);
      let strafe = (held.has("d") ? 1 : 0) - (held.has("a") ? 1 : 0);
      let run = held.has("shift");
      // Digital keys are always "full tilt"; the stick reports how far it is
      // pushed, which is the whole point of an analog input.
      let tilt = 1;

      // The stick wins while it is actually held, so a stray key does not fight
      // a thumb. Releasing it falls straight back to the keyboard axes.
      const axes = stick?.axes;
      if (axes && axes.magnitude > 0) {
        forward = axes.y;
        strafe = axes.x;
        run = axes.run;
        tilt = axes.magnitude;
      }
      const moving = forward !== 0 || strafe !== 0;
      let speedNow = 0;
      // Combat stance: a unit vector at the target, while it lasts.
      focusT -= dt;
      let face: { x: number; z: number } | null = null;
      if (focus && focusT > 0) {
        const p = focus();
        const fx = p.x - node.position.x;
        const fz = p.z - node.position.z;
        const fl = Math.hypot(fx, fz);
        if (fl > 0.5) face = { x: fx / fl, z: fz / fl };
      }
      let backward = false;

      // Idle musings loop only while he is truly at rest: not walking, not
      // mid-hop, and out of combat — `castAge` is seconds since the last skill
      // cast, so a practice rotation keeps him quiet until COMBAT_LINGER_S
      // after the final cast. The controller is the one place that knows all
      // three at once.
      voice.tickIdle(dt, !moving && jumpY === 0 && castAge > COMBAT_LINGER_S);

      if (moving) {
        // Camera-relative move axes, flattened to the ground plane.
        const fwd = camera.getForwardRay().direction;
        const f = new Vector3(fwd.x, 0, fwd.z).normalize();
        const r = Vector3.Cross(Vector3.Up(), f);
        // Normalising discards the stick's magnitude on purpose — `tilt` applies
        // it to SPEED below, so diagonal input is not faster than cardinal.
        const dir = f.scale(forward).add(r.scale(strafe)).normalize();
        // In the stance only a step toward the target may run; sideways and
        // back walk, and back is a backpedal.
        const along = face ? dir.x * face.x + dir.z * face.z : 1;
        if (along < 0.5) run = false;
        backward = along < -0.35;

        // Analog speed curve. Below the sprint threshold, tilt scales across the
        // walk range; past it, speed ramps from walk to run over the remaining
        // travel. Multiplying run speed by tilt directly would snap from 2.9 to
        // 5.3 m/s the instant the threshold is crossed.
        const speed = run
          ? WALK_SPEED +
            (RUN_SPEED - WALK_SPEED) * Math.min(1, (tilt - STICK_RUN_AT) / (1 - STICK_RUN_AT))
          : WALK_SPEED * Math.min(1, tilt / STICK_RUN_AT);
        speedNow = backward ? speed * BACKPEDAL_MULT : speed;
        node.position.addInPlace(dir.scale(speedNow * dt));

        if (clamp) {
          clamp(node.position);
        } else {
          // Radial clamp — the fog wall is not a place to stand.
          const d = Math.hypot(node.position.x, node.position.z);
          if (d > WALK_LIMIT) {
            node.position.x *= WALK_LIMIT / d;
            node.position.z *= WALK_LIMIT / d;
          }

          // Solidity: push out of props, crowd and street furniture. After the
          // clamp so a push never strands him past the walk limit unresolved.
          resolveStaticColliders(node.position, colliders);
        }

        // Face movement (or the target, in the stance). The hero models face -Z at yaw 0, hence the +PI.
        const target = face ? Math.atan2(face.x, face.z) + Math.PI : Math.atan2(dir.x, dir.z) + Math.PI;
        yaw = lerpAngle(yaw, target, Math.min(1, dt * 12));

        // Ease body language in rather than keying it off raw input, so a tap
        // of W reads as a step, not a lurch into a full run lean.
        stride += (speed / RUN_SPEED - stride) * Math.min(1, dt * 8);

        bobPhase += dt * speed * 2.4;
      } else {
        stride += (0 - stride) * Math.min(1, dt * 6);
        if (face) yaw = lerpAngle(yaw, Math.atan2(face.x, face.z) + Math.PI, Math.min(1, dt * 12));
      }
      // Footfall bounce (deeper the faster he goes) or idle breath — either way
      // it is the GROUND component of height; the jump arc stacks on top.
      // Clip-driven models get 0: their bob and breath are baked in the clips.
      const groundY = anim
        ? 0
        : moving
          ? Math.abs(Math.sin(bobPhase)) * 0.05 * (0.5 + 0.5 * stride)
          : Math.sin(t * 0.85) * 0.014 + 0.014;
      node.rotation.y = yaw;

      // ---- Jump ---------------------------------------------------------
      // A fixed-gravity ballistic hop. Ground is y=0 everywhere on the block
      // (the radial clamp keeps him off the stairs), so no ground probe yet —
      // the server-authoritative controller inherits that job with the rest.
      if (jumpQueued) {
        jumpQueued = false;
        if (jumpY === 0) {
          jumpVel = JUMP_SPEED;
          anim?.triggerJump();
        }
      }
      if (jumpVel !== 0 || jumpY > 0) {
        jumpVel -= JUMP_GRAVITY * dt;
        jumpY += jumpVel * dt;
        if (jumpY <= 0) {
          jumpY = 0;
          jumpVel = 0;
          // Touchdown: hand the animator the landing half of the jump. This
          // branch only runs while an arc is in flight, so it fires once.
          anim?.triggerLand();
        }
      }
      airBlend += ((jumpY > 0 ? 1 : 0) - airBlend) * Math.min(1, dt * 12);
      // Bob fades in the air instead of cutting: a landing mid-footfall would
      // otherwise snap the body down by the full bounce amplitude.
      node.position.y = groundY * (1 - airBlend) + jumpY;

      // ---- Cast gesture -------------------------------------------------
      // Half-sine envelope: snaps in, settles out, done before the GCD ends.
      if (hero.fx.cast) {
        const kind = hero.fx.cast;
        hero.fx.cast = null;
        castAge = 0;
        if (hero.fx.focus) {
          focus = hero.fx.focus;
          focusT = COMBAT_FACE_S;
        }
        anim?.triggerCast(kind);
      } else {
        castAge += dt;
      }
      // Hub overlays need a pose-node lunge to plant the lower body; fight
      // style (practice pit) is full-body like the arena, so skip the garnish
      // — stacking it on mocap reads as a double-dip lean.
      const castPulse =
        castAge < CAST_GESTURE_S && hero.castStyle !== "fight"
          ? Math.sin((castAge / CAST_GESTURE_S) * Math.PI)
          : 0;

      // Body language, on the pose node so it composes with facing yaw:
      //  - forward lean grows with speed (model faces -Z, so lean is -pitch);
      //  - stride sway rolls weight foot to foot at half the footfall rate
      //    (sin where the bounce uses |sin| — one roll per left+right pair);
      //  - shoulder yaw works against the roll for a hint of counter-rotation;
      //  - a cast throws the torso forward for one pulse, a jump adds a small
      //    committed lean for the airtime.
      // Locomotion terms are scaled by `stride`, so standing still they hand
      // over to the idle breath: a slow chest rock synced to the breathing bob.
      // (`bodyAmp` shrinks all of this to a garnish when clips are driving;
      // the breath/sway idle terms drop out entirely — the idle clip owns
      // the standing body language.)
      const breathe = anim ? 0 : Math.sin(t * 0.85);
      // Cast lunge stays FULL strength even with clips on hub style: those
      // cast clips play as upper-body-only overlays, so the pose-node push is
      // what plants the lower body into the gesture.
      pose.rotation.x =
        -0.13 * stride * bodyAmp -
        breathe * 0.012 * (1 - stride) -
        0.18 * castPulse -
        0.06 * airBlend * bodyAmp;
      // The oscillating roll/yaw garnish is for clip-less models ONLY: layered
      // over real mocap it beats against the clips' own weight shift and reads
      // as jitter. Clip-driven models keep just the speed lean above.
      pose.rotation.z = anim
        ? 0
        : Math.sin(bobPhase) * 0.055 * stride + Math.sin(t * 0.47) * 0.014 * (1 - stride);
      pose.rotation.y = anim ? 0 : Math.sin(bobPhase) * 0.045 * stride;

      // ---- Limbs (models that have them — see HeroLimbs) ----------------
      // The walk cycle swings legs alternately at the footfall rate and arms
      // opposite their own side's leg. In the air everything tucks; a cast
      // shoves BOTH palms forward (+x on a hanging limb rotates it toward -Z,
      // the facing direction) and suppresses the swing for the pulse.
      if (hero.limbs) {
        const { armL, armR, legL, legR } = hero.limbs;
        const swing = Math.sin(bobPhase) * (0.4 + 0.25 * stride) * stride * (1 - airBlend);
        legL.rotation.x = swing + 0.5 * airBlend;
        legR.rotation.x = -swing + 0.3 * airBlend;
        const armSwing = swing * 0.75 * (1 - castPulse);
        const push = 1.25 * castPulse + 0.35 * airBlend;
        armL.rotation.x = -armSwing + push;
        armR.rotation.x = armSwing + push;
      }

      // Clip-driven path: hand the locomotion state to the animator, which
      // owns idle/walk/run blending, cadence and the jump/cast one-shots.
      anim?.update(dt, { speed: speedNow, moving, backward });

      blob.position.set(node.position.x, 0.02, node.position.z);

      // Camera follows the chest, softly — hard-locking the target makes the
      // walk bob nauseating at close zoom.
      //
      // MUST be setTarget(..., cloneAlphaBetaRadius = true), never `camera.target = v`.
      // The plain setter defaults that flag to FALSE, which runs
      // rebuildAnglesAndRadius(): alpha/beta/radius get re-derived from the
      // camera's CURRENT world position against the new target. The camera then
      // stays where it is while the target walks off — the hero appears unable to
      // move — and worse, once he walks close to the camera's own position the
      // camera->target vector approaches zero, alpha comes back NaN, and the NaN
      // view matrix hangs the tab. Passing true keeps the orbit (alpha/beta/radius)
      // and simply moves it with the target, which is what a follow camera is.
      const goal = node.position.add(new Vector3(0, 1.55, 0));
      camera.setTarget(Vector3.Lerp(camera.target, goal, Math.min(1, dt * 10)), false, false, true);
    },
  };
}

/** Shortest-path angle interpolation — naive lerp spins the long way round. */
function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * The WoW-style test bar, wired to Freud's real kit from `shared/heroes/freud`.
 *
 * Casts do no combat yet — they trigger the cooldown UI, advance the 3-beat
 * cycle readout, and fire a colour-coded particle burst on the hero so a press
 * *feels* like a cast. The moment the Colyseus sim exists, `onCast` posts to
 * the room instead and everything else stays.
 */
/**
 * Cast-burst colours by slot kind — shared by the local bar and the remote
 * cast playback (wireVillagePresence), so a friend's cast sparkles the same
 * colour on your screen as your own does.
 */
const CAST_KIND_COLORS: Record<BarSlotDef["kind"], [Color4, Color4]> = {
  basic: [new Color4(0.85, 0.97, 1.0, 0.9), new Color4(0.55, 0.8, 1.0, 0.55)],
  palette: [new Color4(0.25, 0.9, 1.0, 0.9), new Color4(0.5, 0.75, 1.0, 0.6)],
  defense: [new Color4(0.62, 0.35, 1.0, 0.9), new Color4(0.45, 0.3, 0.9, 0.6)],
  chain: [new Color4(1.0, 0.82, 0.4, 0.9), new Color4(1.0, 0.6, 0.3, 0.6)],
  ultimate: [new Color4(1.0, 0.35, 0.72, 0.95), new Color4(0.7, 0.3, 1.0, 0.7)],
  // Threat red, matching KIND_ACCENT.stance on the bar itself.
  stance: [new Color4(1.0, 0.48, 0.36, 0.9), new Color4(0.9, 0.3, 0.25, 0.6)],
};

/**
 * What `setupSkillBar` hands back, for scenes that need to drive the bar after
 * it is built. The hub ignores it; the practice pit uses all of it.
 */
export interface SkillBarHandle {
  /** Repaint a stance slot's held/dropped state. */
  setToggle(id: string, on: boolean): void;
  /** Force a slot onto a cooldown from outside (Fixation). */
  lockSlot(id: string, ms: number): void;
  /**
   * Swap the transforming palette button between its base and gated faces
   * (Pavlov's NS ⇄ CS — the bell button). No-op unless `mountTransforming` was set. Returns
   * whether the bar is now showing the transformed face.
   */
  setTransformed(on: boolean): boolean;
  /**
   * Repaint Skinner's E/R buttons after an operant flip. A face is an ACTION,
   * not a status readout: each button wears its own axis icon and the word
   * for the state a press will switch TO ("Positive"/"Negative" on E,
   * "Reinforce"/"Punish" on R), so clicking "Positive" always activates
   * Positive. No-op for kits without a reinforcement spec.
   */
  setOperant(state: {
    contingency: "positive" | "negative";
    consequence: "reinforcement" | "punishment";
  }): void;
  /**
   * Repaint Erikson's keys 1/2/LMB and the stage caption from the fight's
   * rotation (`psychosocialChanged`). No-op for kits without one.
   */
  setPsychosocial(state: PsychosocialHudState): void;
  /** The palette entry ids the bar mounted, in slot order — for Fixation. */
  paletteIds: readonly string[];
  /**
   * Whether the threat stance is currently HELD.
   *
   * The bar owns this, not the scene: the village has no fight sim, and a dock
   * button that lit nothing there would be a dead key on the one screen where
   * players are learning the layout. So the bar always paints the button and
   * raises the buff tile, and a scene that HAS a sim reads this back inside
   * `onCast` to drive the mechanical half.
   */
  stanceActive(): boolean;
}

/** Optional wiring for scenes that give the bar something to shoot at. */
export interface SkillBarHooks {
  /**
   * Homing target for cast projectiles.
   *
   * Set → casts auto-aim and `spread` is ignored, exactly as the boss arena
   * does it (`projectiles.ts`: UNTARGETED vs HOMING). The hub leaves it unset
   * because a village square has nothing to aim at, so its casts still fling
   * out on a random spread.
   */
  target?: () => Vector3;
  /**
   * Mount gated/transforming palette entries (Pavlov's CS) as well.
   *
   * Off by default because the hub has no boss, and a button whose gate is a
   * BOSS state can never light up in a village square — mounting it there
   * would be a permanently dark key. A scene running a real fight sim (the
   * practice pit) turns it on and drives the swap from `conditioningChanged`
   * via the handle this function returns.
   */
  mountTransforming?: boolean;
  /**
   * Fired after every cast the bar accepts (cooldown/GCD already passed).
   *
   * `land` registers a callback for the moment the cast's projectile reaches
   * the target — or immediately, for slots that throw nothing (E, R, F). That
   * split is deliberate and mirrors the arena: the caller computes the hit at
   * CAST time, so it captures the beat that was actually up, and shows it at
   * IMPACT time, so the number appears where the projectile hits rather than
   * before it has left the caster.
   */
  onCast?: (slot: BarSlotDef, land: (fn: () => void) => void) => void;
  /**
   * The scene runs a fight sim that OWNS the operant quadrant (drives Skinner's
   * E/R faces through `setOperant` from its `operantChanged`). Without it, the
   * bar flips the faces itself so the buttons aren't dead in the village. Used
   * to be inferred from `onCast`'s presence, but the hub passes `onCast` now
   * (cast announcements for village presence) while still having no sim.
   */
  simDrivesOperant?: boolean;
  /**
   * The scene runs a fight sim that OWNS Erikson's rotation (drives keys
   * 1/2/LMB through `setPsychosocial` from its `psychosocialChanged`).
   * Without it, the bar walks the same state machine itself so the village
   * teaches the same `1-2-1-2` the fight plays.
   */
  simDrivesPsychosocial?: boolean;
}

export function setupSkillBar(
  scene: Scene,
  hero: HeroHandle,
  voice: HeroVoice,
  hooks: SkillBarHooks = {},
  // The KIT the bar mounts — the village passes the profile's selected hero;
  // callers that are Freud by construction (practice booth) take the default.
  kit: Hero = FREUD
): SkillBarHandle | null {
  // The bar is DOM; in headless runs (NullEngine soak test) there is none.
  if (typeof document === "undefined") return null;

  const burst = createCastVfx(scene, hero.node);
  // The big per-skill magic moments (rune circle / shield / streaks / eye for
  // Freud; bowl / bell-rings / clock / dome for Pavlov); the burst above stays
  // as the shared sparkle layer under all of them.
  const skillFx = createHeroSkillVfx(scene, hero.node, kit.id);
  // The travel layer: basics and palette casts fling a projectile out in
  // front, and the ultimate homes onto the target when one exists (the
  // practice dummy, later the boss); E/R stay self-only.
  const projectiles = createCastProjectiles(scene, hero.node);

  // Skill icons: the concept set (assets/concept/<hero>/…) cropped to the
  // tile face and shipped as small webp for the DOM bar — see the "Skill
  // icons" notes in assets/work/*/README.md. Palette ids end in the icon's
  // own name (freud.stage.oral → oral.webp, pavlov.ucs → ucs.webp).
  const ICONS = SKILL_ICON_HEROES.has(kit.id) ? `/assets/ui/skills/${kit.id}` : null;
  /** A skill icon URL, or undefined for a hero whose icon set is not drawn yet. */
  const skillIcon = (name: string): string | undefined => (ICONS ? `${ICONS}/${name}.webp` : undefined);
  const slug = (id: string): string => (id.split(".").pop() ?? id).replace(/-/g, "_");
  const wrapLabel = (name: string): string => {
    const words = name.split(" ");
    if (words.length < 2) return name;
    const mid = Math.ceil(words.length / 2);
    return `${words.slice(0, mid).join(" ")}\n${words.slice(mid).join(" ")}`;
  };

  const touch = detectControlScheme() === "touch";

  // A transforming entry (Pavlov's CS) does not mount in the hub: its gate is
  // a boss state and the village has no boss. A scene that DOES run a fight
  // (the practice pit) asks for it and drives the swap itself. The base the
  // entry rides may be a palette entry or the BASIC attack — CS rides the
  // bell (2026-08-08), so it is the attack button that transforms.
  const transformEntry = kit.palette.find((p) => p.transformsFrom);
  const transformsBasic = transformEntry?.transformsFrom === kit.basic.id;
  const transformBase =
    transformEntry && !transformsBasic
      ? kit.palette.find((p) => p.id === transformEntry.transformsFrom)
      : undefined;
  const hubPalette = kit.palette.filter((p) => !p.transformsFrom);

  // The basic attack. Desktop casts it with LMB (bar row slot); on touch it IS
  // the big bottom-right corner button — same slot id, same cast path, so the
  // two schemes cannot drift. No icon for a stance-readout face (setBeat
  // rewrites the label, and the "LMB" badge is the keybind) — but a
  // TRANSFORMING basic (Pavlov's NS ⇄ CS) wears palette geometry on desktop,
  // icon face included, so the CS swap repaints the same 44 px square.
  const BASIC_ID = kit.basic.id;
  const basicSlot: BarSlotDef = {
    id: BASIC_ID,
    // Shown uppercased as the key badge. Never matches a KeyboardEvent.key,
    // so the keyboard path stays inert — the pointer observable below casts.
    key: "lmb",
    label:
      kit.id === "pavlov"
        ? "NS\nBell"
        : kit.id === "skinner"
          ? "Response\nRate"
          : kit.psychosocial
            ? "Significant\nRelations"
            : kit.id === "ainsworth"
              ? "Sensitivity"
              : wrapLabel(kit.basic.name),
    tooltip: kit.psychosocial
      ? `Add-on attack. Flat ${kit.basic.base} damage, once after each key 1 or key 2. Left click.`
      : kit.beats
        ? "Basic attack. Damage rides the current beat of the cycle. Left click."
        : `Basic attack. Flat ${kit.basic.base} damage. Left click.`,
    // The kit's real basic cooldown — Pavlov's 2 s bell IS his balance
    // (pavlov.ts S5), and the hub bar teaches the arena's rhythm.
    cooldownMs: kit.basic.cooldownMs,
    kind: "basic",
    flat: kit.beats === undefined,
    ...(transformsBasic
      ? { paletteFace: true, icon: skillIcon(slug(BASIC_ID)) }
      : {}),
  };
  const mountTransforming = hooks.mountTransforming === true;
  const slots: BarSlotDef[] = [
    basicSlot,
    // Palette on 1-5. The shared 1.5 s cooldown is a UI stand-in for the GCD;
    // real palette timing is window-based (doc 02) and server-owned.
    ...hubPalette.map((p, i) => ({
      id: p.id,
      key: String(i + 1),
      label: p.name.replace(" Stage", "").split(" — ")[0] ?? p.name,
      tooltip: p.answersTags
        ? `${p.name}. A stage of development: it heals the way a child at this stage thinks. In a fight it also answers the boss's ${p.answersTags.length > 1 ? "forms" : "form"} of that age. The full effect is in the codex and on the arena bar.`
        : p.effects.some((e) => e.kind === "modeling.reproduce")
          ? `${p.name}. In a fight this slot holds a copy of a skill your model cast; press it to reproduce the copy. Here in town it is empty.`
          : p.answersAxis
        ? `${p.name}. Deals ${p.base} damage and places an Analysis Mark. While the boss shapeshifts: the correct answer when it takes the form of ${STAGE_DETAIL[p.id]?.form ?? "this stage"} — outside the transformation no stage is wrong.`
        : kit.psychosocial
          ? p.effects.some((e) => e.kind === "psychosocial.stage")
            ? `${p.name}. Deals ${p.base} damage and casts the current life stage. Then press 2 for its virtue.`
            : `${p.name}. After key 1: deals ${p.base} damage and completes the stage. One add-on basic follows each key.`
          : p.effects.some((e) => e.kind === "ucr.window")
            ? `${p.name}. Deals ${p.base} damage. In a fight, opens the window a bell pairs into.`
            : `${p.name}. Deals ${p.base} damage. ${overTimeText(p)} The full effect is in the codex and on the arena bar.`.replace("  ", " "),
      icon: skillIcon(slug(p.id)),
      cooldownMs: 1_500,
      kind: "palette" as const,
    })),
    // The threat stance on "4" — same slot the arena mounts, so the practice
    // pit is where you learn the button rather than meeting it in a fight.
    ...(kit.threatStance
      ? [
          {
            id: kit.threatStance.id,
            key: stanceKey(hubPalette.length),
            label: wrapLabel(kit.threatStance.name),
            tooltip: `${kit.threatStance.name}. Toggle: while held you bank ${kit.threatStance.multiplier}x threat, so the boss looks at you. Free, no cooldown.`,
            icon: skillIcon(slug(kit.threatStance.id)),
            cooldownMs: 0,
            kind: "stance" as const,
          },
        ]
      : []),
    {
      id: kit.defense.id,
      key: "e",
      // A reinforcement kit's E/R buttons are ACTION faces: each wears the
      // axis word and icon of the state a press will switch TO. Scenes with
      // a sim repaint through `setOperant`; the hub has none, so it wears
      // the faces for the sim's starting state (Positive/Reinforcement →
      // the buttons offer the opposites).
      label: kit.reinforcement ? "Negative" : wrapLabel(kit.defense.name),
      tooltip: `${kit.defense.name}. Heals ${kit.defense.heal ?? 0}${kit.defense.healTarget === "team" ? ", split across the team" : ""}.`,
      icon: kit.reinforcement
        ? skillIcon("contingency_negative")
        : skillIcon(slug(kit.defense.id)),
      cooldownMs: kit.defense.cooldownMs,
      kind: "defense",
    },
    {
      id: kit.chain.id,
      key: "r",
      label: kit.reinforcement ? "Punish" : wrapLabel(kit.chain.name),
      tooltip: `${kit.chain.name}. Deals ${kit.chain.base} damage${reachText(kit.chain)}. ${overTimeText(kit.chain)}`.trim(),
      icon: kit.reinforcement
        ? skillIcon("consequence_punishment")
        : skillIcon(slug(kit.chain.id)),
      cooldownMs: kit.chain.cooldownMs,
      kind: "chain",
    },
    {
      id: kit.ultimate.id,
      key: "f",
      label: wrapLabel(kit.ultimate.name),
      tooltip: kit.psychosocial
        ? `${kit.ultimate.name}. Deals ${kit.ultimate.base} damage plus ${kit.ultimate.perMark} for every virtue banked, up to ${kit.ultimate.maxMarksConsumed}.`
        : `${kit.ultimate.name}. Deals ${kit.ultimate.base} damage plus ${kit.ultimate.perMark} for every Mark consumed, up to ${kit.ultimate.maxMarksConsumed} Marks.`,
      icon: skillIcon(slug(kit.ultimate.id)),
      cooldownMs: kit.ultimate.cooldownMs,
      kind: "ultimate",
    },
  ];

  /**
   * The Id → Ego → Superego cycle is an AUTOMATIC clock (2026-08-02).
   *
   * It has run on casts and on a manual Tab stance; both are wrong. Doc 02's
   * rule is the plain one — "basic attacks cycle automatically" — and the Haste
   * stat is defined as "speeds the 3-beat cycle", which only means something if
   * a period exists to speed. The manual reading also broke the balance model:
   * the boss-math sheet prices every skill at half its casts landing on the
   * payoff beat, and a stance the player holds makes that fraction 1.0.
   *
   * The payoff is still a decision — it is just *when you cast*, not *what
   * stance you sit in*. Period lives in `shared/combat.ts` beside the GCD.
   */
  let beat = 0;
  let beatT = 0;
  /** Threat stance held? Owned here — see `SkillBarHandle.stanceActive`. */
  let stanceOn = false;
  /**
   * The hub's own operant state (Skinner's E/R). Cosmetic, like the stance:
   * scenes with a sim drive the faces through `setOperant`; the village has
   * no sim, so the bar flips them itself in the cast handler below.
   */
  const hubOperant: { contingency: "positive" | "negative"; consequence: "reinforcement" | "punishment" } =
    { contingency: "positive", consequence: "reinforcement" };
  /** The hub's own copy of Erikson's rotation — cosmetic, same as above. */
  const hubPsycho: PsychosocialState | null = kit.psychosocial ? psychosocialStart() : null;
  /** The rotation as last painted (hub copy or the pit's sim) — keys the VO. */
  let lastPsycho: PsychosocialHudState | null = hubPsycho ? { ...hubPsycho } : null;

  // Focus costs and self-buffs feed the player frame (top-left HUD). The
  // defense/chain/ult costs are the kit's real numbers; palette casts get a
  // scaffold cost so the MP bar moves at all — doc 02 has no palette tuning
  // yet. The bar's canCast gate refuses a cast the pool can't cover (same
  // rule as the arena); the server sim will re-check this authoritatively.
  const FOCUS_COST: Record<BarSlotDef["kind"], number> = {
    basic: 0, // auto-attack is the resourceless filler between casts
    palette: 8,
    defense: kit.defense.focusCost ?? 0,
    chain: kit.chain.focusCost ?? 0,
    ultimate: kit.ultimate.focusCost ?? 0,
    stance: 0, // a threat stance is free by definition (ThreatStance.toggle)
  };
  // An entry may price itself (Erikson's keys, `PaletteEntry.focusCost`).
  const slotFocusCost = (slot: BarSlotDef): number =>
    (slot.kind === "palette" ? kit.palette.find((p) => p.id === slot.id)?.focusCost : undefined) ??
    FOCUS_COST[slot.kind];
  // Buff-tile length = the skill's longest timed effect where the kit has one
  // (Pavlov's R vulnerability runs 15 s, his F dome 10 s — the tile must not
  // undersell the window); kits with untimed effects keep the old defaults.
  const longestEffect = (effects: readonly { durationMs?: number }[], fallback: number): number => {
    const max = Math.max(0, ...effects.map((e) => e.durationMs ?? 0));
    return max > 0 ? max : fallback;
  };
  // Popup body for the tile (hover/tap on the HUD buff row) — composed from
  // the kit's own numbers, so it can never drift from the data the way a
  // hand-written string per hero would.
  const describeAbility = (a: {
    heal?: number;
    mitigation?: { magnitude: number; durationMs: number };
    effects: readonly { kind: string; magnitude?: number; durationMs?: number }[];
  }): string => {
    const clauses: string[] = [];
    if (a.heal) clauses.push(`heals ${a.heal}`);
    if (a.mitigation)
      clauses.push(
        `cuts damage taken ${Math.round(a.mitigation.magnitude * 100)}% for ${a.mitigation.durationMs / 1000} s`
      );
    for (const e of a.effects) {
      const pct = Math.round((e.magnitude ?? 0) * 100);
      const secs = (e.durationMs ?? 0) / 1000;
      if (e.kind === "palette.auto-correct")
        clauses.push(`the next ${e.magnitude ?? 3} palette casts auto-correct`);
      else if (e.kind === "vulnerability") clauses.push(`the boss takes +${pct}% for ${secs} s`);
      else if (e.kind === "taunt") clauses.push(`taunts the boss for ${secs} s`);
      else if (e.kind === "zone.extinction") clauses.push(`the boss deals −${pct}% for ${secs} s`);
      else if (e.kind === "shaping.release")
        clauses.push("consumes every banked Approximation, healing its carrier per stack");
      else if (e.kind === "conditioning.reset")
        clauses.push("extinguishes the conditioning loop — the response is unlearned");
      else if (e.kind === "schedule.fixed-ratio") clauses.push("heals the whole team a fixed amount");
      else if (e.kind === "schedule.variable-ratio")
        clauses.push("heals the most-wounded — usually the pellet, sometimes the jackpot");
      else if (e.kind === "schedule.fixed-interval")
        clauses.push("opens a fixed-clock team-heal window");
      else if (e.kind === "schedule.variable-interval")
        clauses.push("opens a random-moment team-heal window");
    }
    if (clauses.length === 0) return "";
    const body = clauses.join("; ");
    return body.charAt(0).toUpperCase() + body.slice(1) + ".";
  };
  const SELF_BUFF: Partial<
    Record<BarSlotDef["kind"], { name: string; durationMs: number; desc?: string }>
  > = {
    defense: {
      name: kit.defense.name,
      durationMs: kit.defense.mitigation?.durationMs ?? 6_000,
      desc: describeAbility(kit.defense),
    },
    chain: {
      name: kit.chain.name,
      durationMs: longestEffect(kit.chain.effects, 8_000),
      desc: describeAbility(kit.chain),
    },
    ultimate: {
      name: kit.ultimate.name,
      durationMs: longestEffect(kit.ultimate.effects, 8_000),
      desc: describeAbility(kit.ultimate),
    },
  };

  const bar = new ActionBar(
    slots,
    (slot) => {
      // A stance is a toggle, not a cast: no projectile, no cast animation, no
      // Focus. The bar flips it and paints it HERE — including in the village,
      // which has no sim — and only then tells the scene, so a scene with a
      // fight can read `stanceActive()` and apply the mechanical half.
      if (slot.kind === "stance") {
        playCastSfx(slot.id);
        stanceOn = !stanceOn;
        bar.setToggle(slot.id, stanceOn);
        if (kit.threatStance) {
          refreshStance({
            name: kit.threatStance.name,
            multiplier: kit.threatStance.multiplier,
            held: stanceOn,
          });
        }
        player.applyBuff({
          id: "bar.threat-stance",
          name: `${kit.threatStance?.name ?? slot.id} — threat x${kit.threatStance?.multiplier ?? 1}`,
          // Held until toggled off; the 1 ms re-apply is the "remove".
          durationMs: stanceOn ? 3_600_000 : 1,
          kind: "buff",
          icon: slot.icon,
          desc: `While held, everything you do generates ×${kit.threatStance?.multiplier ?? 1} threat — the boss keeps its eyes on you. Banked threat does not fade when you drop it.`,
        });
        hooks.onCast?.(slot, () => {});
        return;
      }
      let hubRefund = 0;
      // Keyed before the rotation moves: key 2 speaks the virtue it answers.
      // The same key lights the right stage in Erikson's skill VFX, and the
      // centre banner flashes the stage or virtue.
      const voiceKey = voiceKeyFor(kit, slot.id, lastPsycho);
      stageBannerFor(kit, slot.id, lastPsycho);
      // Erikson in the village: no sim, so the bar walks the rotation itself
      // (shared/fight/psychosocial.ts, the rules the fight runs).
      if (hubPsycho && kit.psychosocial && !hooks.simDrivesPsychosocial) {
        const entry = kit.palette.find((p) => p.id === slot.id);
        if (entry?.effects.some((e) => e.kind === "psychosocial.stage")) castLifeStage(hubPsycho);
        else if (entry?.effects.some((e) => e.kind === "psychosocial.virtue")) {
          // Refunded after this press is paid (below), so the cap cannot eat it.
          if (castVirtue(hubPsycho, kit.psychosocial).matched) hubRefund = kit.psychosocial.pairFocusRefund;
        }
        else if (slot.kind === "basic") castAddon(hubPsycho);
        else if (slot.kind === "ultimate") lifeReview(hubPsycho);
        paintPsychosocial(hubPsycho);
      }
      const [c1, c2] = CAST_KIND_COLORS[slot.kind];
      burst(c1, c2, slot.kind === "ultimate" ? 90 : slot.kind === "basic" ? 14 : 26);

      // Whatever the caller wants run when this cast connects. A slot that
      // throws a projectile hands it to the projectile's onHit; the rest fire
      // it straight away, so E/R/F still report even though nothing flies.
      // Held on an object, not a bare `let`: the assignment happens inside the
      // callback below, which control-flow analysis cannot see, so a plain
      // variable narrows to `null` and the call site becomes uncallable.
      const landed: { fn?: () => void } = {};
      hooks.onCast?.(slot, (fn) => {
        landed.fn = fn;
      });
      // A reinforcement kit's palette and ultimate are HEALS (Skinner's
      // schedules and Shaping): nothing should fly at a target, so they
      // settle in place like E/R and let skillFx carry the moment.
      const healCast =
        !!kit.reinforcement && (slot.kind === "palette" || slot.kind === "ultimate");
      const throws =
        !healCast &&
        (slot.kind === "basic" ||
          slot.kind === "palette" ||
          // The ultimate only flies when there is something to fly AT — in the
          // open village there is no target and it settles straight away.
          (slot.kind === "ultimate" && !!hooks.target));

      if (slot.kind === "basic") {
        // Small and fast: Pavlov's bell, Freud's smoke ring, else a blue bolt.
        projectiles.fire({
          ...basicProjectileStyle(kit.id),
          size: 0.14,
          speed: 14,
          lifeSec: 1.1,
          ...(hooks.target ? { target: hooks.target } : { spread: 0.12 }),
          onHit: () => {
            playImpactSfx(slot.id);
            landed.fn?.();
          },
        });
      } else if (slot.kind === "palette" && throws) {
        // Slower, larger orb in the stage's colour.
        const tint = paletteTint(slot.id);
        projectiles.fire({
          color: tint,
          size: 0.26,
          speed: 6.5,
          lifeSec: 2.2,
          wobble: 0.8,
          ...paletteDressing(slot.id),
          ...(hooks.target ? { target: hooks.target } : { spread: 0.45 }),
          onHit: () => {
            playImpactSfx(slot.id);
            landed.fn?.();
          },
        });
      } else if (slot.kind === "ultimate" && hooks.target && throws) {
        // The ultimate always homes onto the target — the practice dummy
        // here, the boss in the arena. Its damage ticks on impact.
        projectiles.fire({
          color: ultimateTint(kit.id),
          ...ultimateDressing(kit.id),
          size: 0.42,
          speed: 8,
          lifeSec: 3,
          target: hooks.target,
          onHit: landed.fn,
        });
      }
      // Nothing in flight to wait for — settle it now.
      if (!throws) landed.fn?.();
      // The big per-skill magic moments are for skills; the basic attack keeps
      // just the small burst + the throw gesture, or a left-click spam session
      // would strobe rune circles.
      if (slot.kind !== "basic") skillFx.cast(slot.kind, voiceKey);
      // The controller reads this next tick and plays the matching gesture, so
      // a cast moves the BODY as well as the particles: palette (1-5) casts,
      // E and the ult (F) share the second cast clip, R meditates; "basic"
      // takes the palette's OverhandThrow overlay via the animator fallthrough.
      hero.fx.cast = slot.kind;
      hero.fx.focus = hooks.target ?? null;
      voice.cast(voiceKey);
      playCastSfx(slot.id);
      player.spendMana(slotFocusCost(slot));
      if (hubRefund > 0) player.restoreMana(hubRefund);
      // A reinforcement kit's E/R are quadrant toggles, not timed self-buffs —
      // the sim pins the live quadrant to the buff bar itself; a 6 s
      // "Contingency" tile beside it would be a lie about a timer.
      const buff =
        kit.reinforcement && (slot.kind === "defense" || slot.kind === "chain")
          ? undefined
          : SELF_BUFF[slot.kind];
      if (buff) player.applyBuff({ id: slot.id, ...buff, icon: slot.icon, kind: "buff" });
      // Skinner's E/R in the VILLAGE: no sim owns the quadrant here, so the
      // bar flips the faces itself — the stance rule above applied to the
      // other toggle; a button that never flips in the hub looks broken on
      // the one screen where the layout is learned. Scenes with a sim declare
      // `simDrivesOperant` and drive this repaint from `operantChanged` →
      // `setOperant`, so they are excluded or the flip would fire twice.
      if (kit.reinforcement && !hooks.simDrivesOperant && (slot.kind === "defense" || slot.kind === "chain")) {
        if (slot.kind === "defense") {
          hubOperant.contingency = hubOperant.contingency === "positive" ? "negative" : "positive";
        } else {
          hubOperant.consequence =
            hubOperant.consequence === "reinforcement" ? "punishment" : "reinforcement";
        }
        paintOperant(hubOperant);
      }
    },
    {
      layout: touch ? "touch" : "bar",
      // The touch cluster's word for the wheel — Skinner's is "Schedules".
      paletteWord: kit.reinforcement ? "Schedules" : kit.modeling ? "Copies" : undefined,
      // Erikson's 1 and 2 are a rhythm, not a menu — two direct buttons.
      paletteInline: kit.psychosocial !== undefined,
      // Same Focus gate as the arena: an empty pool refuses the press (red
      // flash, no cooldown) instead of casting for free.
      canCast: (slot) => player.mana >= slotFocusCost(slot),
      // Mana is the only reason canCast says no here, so every refusal
      // deserves the "why" popup (arena adds a hero-death guard).
      onRefused: () => showCastWarning("Not enough Focus"),
    }
  );

  if (kit.threatStance) {
    bar.setToggle(kit.threatStance.id, stanceOn);
    refreshStance({
      name: kit.threatStance.name,
      multiplier: kit.threatStance.multiplier,
      held: stanceOn,
    });
  } else {
    // A hero with no stance must not inherit the last one's line.
    refreshStance(null);
  }

  const showBeat = (): void => {
    // Doc 02: beat 3 is the payoff beat and is telegraphed ONE BEAT EARLY, so the
    // cue fires while beat 2 is up. At BEAT_PERIOD_S that is one GCD of warning.
    const beats = kit.beats;
    if (!beats) return; // no cycle, no readout — the pill never mounts
    const next = (beat + 1) % beats.length;
    bar.setBeat(beats[beat]!.name, beats[beat]!.multiplier, (beats[next]?.multiplier ?? 0) >= 1.5);
  };
  showBeat();

  // The beat clock. Runs for as long as the hub scene does — the readout is a
  // metronome the player learns to cast against, in the hub and in the arena.
  scene.onBeforeRenderObservable.add(() => {
    beatT += scene.getEngine().getDeltaTime() / 1000;
    while (beatT >= BEAT_PERIOD_S) {
      beatT -= BEAT_PERIOD_S;
      beat = (beat + 1) % (kit.beats?.length ?? 1);
      showBeat();
    }
  });

  // Left click = basic attack (desktop only): a click fires one swing,
  // holding keeps swinging (governed by the slot cooldown), idle fires
  // nothing; a left-drag orbits the camera instead. HUD presses never land
  // here: the bar is DOM above the canvas, and a click on a button is the
  // button's, not the scene's.
  let liveBasicId = BASIC_ID;
  if (!touch) {
    // Live id, not BASIC_ID: the practice pit renames the basic slot to CS
    // while the boss is CONDITIONED (setTransformed below), and a click must
    // cast whatever face the button is wearing.
    wireBasicAttack(scene, () => bar.cast(liveBasicId));
  }

  // Q cycles the palette in stage order — the doc-02 input scheme puts the
  // palette on Q; 1-5 direct-cast is the raid-keybind version of the same.
  // On touch the same cycle is the wheel, which shows all five at once.
  let qIdx = 0;
  const qHandler = (e: KeyboardEvent) => {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key.toLowerCase() !== "q") return;
    if (isTypingInField()) return;
    if (bar.cast(hubPalette[qIdx % hubPalette.length]!.id)) qIdx++;
  };
  window.addEventListener("keydown", qHandler);

  scene.onDisposeObservable.add(() => {
    window.removeEventListener("keydown", qHandler);
    bar.dispose();
  });

  // The transforming pair, built once so the swap below is a slot replacement
  // and not a rebuild — `ActionBar.replaceSlot` keeps the running cooldown,
  // which is the whole reason a transform is not just two slots.
  const paletteSlotDefFor = (p: PaletteEntry, key: string): BarSlotDef => ({
    id: p.id,
    key,
    label: p.name.replace(" Stage", "").split(" — ")[0] ?? p.name,
    tooltip: `${p.name}. Deals ${p.base} damage.`,
    icon: skillIcon(slug(p.id)),
    cooldownMs: 1_500,
    kind: "palette" as const,
  });
  // The face CS swaps out of and back into: the bell's own slot def when the
  // transform rides the basic (Pavlov), else the base palette entry's def.
  // Same key either way, so the badge and binding never move.
  const transformBaseDef = transformsBasic
    ? basicSlot
    : transformBase
      ? paletteSlotDefFor(
          transformBase,
          String(hubPalette.findIndex((p) => p.id === transformBase.id) + 1)
        )
      : null;
  let transformed = false;

  // Skinner's E/R faces: the same replaceSlot dance the arena does (each face
  // is its own slot def because replaceSlot refuses same-id swaps), so the
  // practice pit's buttons flip exactly as the boss fight's do.
  let eSlotId = kit.defense.id;
  let rSlotId = kit.chain.id;

  // Shared by the handle's `setOperant` (sim scenes) and the hub's own
  // cosmetic flip in the cast handler (no sim — see there).
  const paintOperant = (s: {
    contingency: "positive" | "negative";
    consequence: "reinforcement" | "punishment";
  }): void => {
    const rf = kit.reinforcement;
    if (!rf) return;
    // Action faces: each button offers the OPPOSITE of the live state.
    const eNext = s.contingency === "positive" ? "negative" : "positive";
    const rNext = s.consequence === "reinforcement" ? "punishment" : "reinforcement";
    const eDef: BarSlotDef = {
      id: `${kit.defense.id}-${eNext}`,
      key: "e",
      label: eNext === "positive" ? "Positive" : "Negative",
      tooltip:
        eNext === "negative"
          ? `Switch ${kit.defense.name} to Negative — teammates earn a consequence for every ${rf.negativeCleanSeconds} sec spent taking no damage. Currently Positive: every ${rf.positiveDamagePerProc} damage dealt earns one.`
          : `Switch ${kit.defense.name} to Positive — teammates earn a consequence for every ${rf.positiveDamagePerProc} damage they deal. Currently Negative: every ${rf.negativeCleanSeconds} sec without taking damage earns one.`,
      icon: skillIcon(`contingency_${eNext}`),
      cooldownMs: kit.defense.cooldownMs,
      kind: "defense",
      freeOfGcd: true,
    };
    const rDef: BarSlotDef = {
      id: `${kit.chain.id}-${rNext}`,
      key: "r",
      label: rNext === "reinforcement" ? "Reinforce" : "Punish",
      tooltip:
        rNext === "punishment"
          ? `Switch ${kit.chain.name} to Punishment — every proc grants ${Math.round(rf.procMitigation.magnitude * 100)} percent damage reduction for ${rf.procMitigation.durationMs / 1000} sec. Currently Reinforcement: a proc heals its earner.`
          : `Switch ${kit.chain.name} to Reinforcement — every proc heals its earner. Currently Punishment: a proc grants mitigation instead. Either way procs bank Approximations.`,
      icon: skillIcon(`consequence_${rNext}`),
      cooldownMs: kit.chain.cooldownMs,
      kind: "chain",
      freeOfGcd: true,
    };
    if (eSlotId !== eDef.id && bar.replaceSlot(eSlotId, eDef)) eSlotId = eDef.id;
    if (rSlotId !== rDef.id && bar.replaceSlot(rSlotId, rDef)) rSlotId = rDef.id;
  };

  function paintPsychosocial(st: PsychosocialHudState): void {
    const spec = kit.psychosocial;
    if (!spec) return;
    lastPsycho = { ...st };
    const f = psychosocialFaces(spec, st);
    for (const p of kit.palette) {
      if (p.effects.some((e) => e.kind === "psychosocial.stage")) bar.setLabel(p.id, f.stage, skillIcon(f.stageIcon));
      else if (p.effects.some((e) => e.kind === "psychosocial.virtue")) bar.setLabel(p.id, f.virtue, skillIcon(f.virtueIcon));
    }
    bar.setLabel(BASIC_ID, f.basic);
    bar.setAvailable(BASIC_ID, st.addon);
    bar.setCaption(f.caption);
  }
  if (hubPsycho) paintPsychosocial(hubPsycho);

  return {
    setToggle: (id, on) => bar.setToggle(id, on),
    lockSlot: (id, ms) => bar.lockSlot(id, ms),
    setOperant: paintOperant,
    setPsychosocial: paintPsychosocial,
    setTransformed: (on) => {
      if (!mountTransforming || !transformEntry || !transformBaseDef) return false;
      if (on && !transformed) {
        transformed = Boolean(
          bar.replaceSlot(
            transformBaseDef.id,
            paletteSlotDefFor(transformEntry, transformBaseDef.key)
          )
        );
      } else if (!on && transformed) {
        transformed = !bar.replaceSlot(transformEntry.id, transformBaseDef);
      }
      // Keep the LMB wiring pointed at whatever the basic slot is called now.
      if (transformsBasic) liveBasicId = transformed ? transformEntry.id : BASIC_ID;
      return transformed;
    },
    paletteIds: hubPalette.map((p) => p.id),
    stanceActive: () => stanceOn,
  };
}

/**
 * One reusable burst emitter for cast feedback — second and last particle
 * system in the hub (budget: 40). Colours are set per cast; `manualEmitCount`
 * fires a burst without a persistent emit rate.
 */
function createCastVfx(
  scene: Scene,
  heroNode: TransformNode
): (c1: Color4, c2: Color4, count: number) => void {
  const anchor = MeshBuilder.CreateBox("freud_castAnchor", { size: 0.01 }, scene);
  anchor.parent = heroNode;
  anchor.position.set(0, 1.15, 0);
  anchor.isVisible = false;

  const ps = new ParticleSystem("freud_castBurst", 160, scene);
  ps.particleTexture = createSoftDotTexture(scene);
  ps.emitter = anchor;
  ps.minEmitBox = new Vector3(-0.15, -0.2, -0.15);
  ps.maxEmitBox = new Vector3(0.15, 0.35, 0.15);
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.minSize = 0.06;
  ps.maxSize = 0.24;
  ps.minLifeTime = 0.3;
  ps.maxLifeTime = 0.65;
  ps.emitRate = 0; // manual bursts only
  ps.direction1 = new Vector3(-1, 0.4, -1);
  ps.direction2 = new Vector3(1, 1.6, 1);
  ps.minEmitPower = 0.8;
  ps.maxEmitPower = 2.2;
  ps.gravity = new Vector3(0, -1.2, 0);
  ps.start();

  return (c1, c2, count) => {
    ps.color1 = c1;
    ps.color2 = c2;
    ps.colorDead = new Color4(c2.r * 0.4, c2.g * 0.4, c2.b * 0.4, 0);
    ps.manualEmitCount = count;
  };
}

/**
 * Freud's companion — a glowing magic tome orbiting at shoulder height.
 *
 * Model: concept assets/concept/freud/magic_book.png (civitai gpt-image-2) →
 * Tripo image-to-model → public/assets/heroes/freud_book.glb. The GLB loads
 * async and every hero path here is synchronous, so until it arrives (or if
 * it is missing) the old holo notebook drone stands in — the swap is a
 * setEnabled flip, the orbit never changes.
 */
function buildDrone(scene: Scene, mats: Mats, parent: TransformNode): Ticker {
  const anchor = new TransformNode("freud_companion", scene);
  anchor.parent = parent;

  // Placeholder (and permanent fallback): the original notebook drone.
  const drone = MeshBuilder.CreateBox("freud_drone", { width: 0.2, height: 0.05, depth: 0.15 }, scene);
  drone.parent = anchor;
  drone.material = mats.metal;

  const glow = MeshBuilder.CreateBox("freud_droneGlow", { width: 0.26, height: 0.012, depth: 0.22 }, scene);
  glow.parent = anchor;
  glow.position.y = -0.06;
  glow.material = holoMat(scene, mats, PALETTE.cyan, 0.7);

  void ImportMeshAsync("/assets/heroes/freud_book.glb", scene)
    .then((result) => {
      const book = new TransformNode("freud_book", scene);
      book.parent = anchor;
      for (const m of result.meshes) {
        if (!m.parent) m.parent = book;
        m.isPickable = false;
        // `freud` in the name keeps it off the hub's shadow-caster list.
        if (m.name && !/freud/i.test(m.name)) m.name = `freud_book_${m.name}`;
        // Subtle cyan lift so the runes catch the hub's bloom pass.
        const mat = m.material as PBRMaterial | null;
        if (mat?.getClassName?.() === "PBRMaterial") {
          mat.emissiveColor = new Color3(0.05, 0.14, 0.16);
        }
      }
      // Normalise to companion size (~0.32 m across) and centre on the anchor.
      book.computeWorldMatrix(true);
      const { min, max } = book.getHierarchyBoundingVectors(true);
      const size = max.subtract(min);
      const s = 0.32 / Math.max(size.x, size.y, size.z, 1e-6);
      book.scaling.scaleInPlace(s);
      book.computeWorldMatrix(true);
      const bounds = book.getHierarchyBoundingVectors(true);
      const centreWorld = bounds.max.add(bounds.min).scale(0.5);
      const inv = anchor.getWorldMatrix().clone().invert();
      book.position.subtractInPlace(Vector3.TransformCoordinates(centreWorld, inv));
      // Retire the WHOLE stand-in: the glow plate is part of the drone, and
      // left on it reads as a flat blue slab stuck through the book.
      drone.setEnabled(false);
      glow.setEnabled(false);
    })
    .catch(() => {
      // No book.glb (old build, asset not shipped): the drone stays.
      glow.position.y = -0.035;
      glow.scaling.setAll(0.8);
    });

  return {
    // Figure-of-eight orbit at shoulder height, always facing outward.
    // Positions are in the parent's local space, so if the parent is the glb
    // root (which carries a normalisation scale) the orbit scales with it.
    tick: (t: number) => {
      const a = t * 0.7;
      anchor.position.set(Math.sin(a) * 0.62, 1.72 + Math.sin(a * 2) * 0.07, Math.cos(a) * 0.4);
      anchor.rotation.y = -a;
      anchor.rotation.z = Math.sin(a * 2) * 0.12;
    },
  };
}

/**
 * Holographic pipe smoke — the one particle system in the hub, against a
 * budget of 40. It is here because the holo smoke is Freud's signature
 * silhouette element in every piece of concept art, and because a hub with
 * zero particle systems tells you nothing about whether the particle path
 * actually works on this backend.
 */
function attachPipeSmoke(scene: Scene, emitter: Mesh): void {
  const smoke = new ParticleSystem("freud_smoke", 120, scene);
  smoke.particleTexture = createSoftDotTexture(scene);
  smoke.emitter = emitter;
  smoke.minEmitBox = new Vector3(-0.01, 0.03, -0.01);
  smoke.maxEmitBox = new Vector3(0.01, 0.04, 0.01);
  smoke.color1 = new Color4(0.25, 0.9, 1.0, 0.5);
  smoke.color2 = new Color4(0.45, 0.75, 1.0, 0.32);
  smoke.colorDead = new Color4(0.2, 0.5, 0.7, 0);
  smoke.minSize = 0.05;
  smoke.maxSize = 0.22;
  smoke.minLifeTime = 1.4;
  smoke.maxLifeTime = 2.6;
  smoke.emitRate = 18;
  smoke.blendMode = ParticleSystem.BLENDMODE_ADD;
  smoke.gravity = new Vector3(0, 0.18, 0);
  smoke.direction1 = new Vector3(-0.05, 0.5, -0.05);
  smoke.direction2 = new Vector3(0.05, 0.8, 0.05);
  smoke.minAngularSpeed = -0.6;
  smoke.maxAngularSpeed = 0.6;
  smoke.start();
}

/**
 * A 64x64 radial-gradient dot, generated at runtime.
 *
 * Deliberately NOT a shipped PNG: it is 16 KB of texture memory, it needs no
 * network request, and it keeps the particle path free of an asset dependency
 * while the real KTX2 VFX ramps are still being authored (`assets/concept/
 * freud/F3_vfx_sheet.png`). It is created with the scene, so it dies with it.
 */
function createSoftDotTexture(scene: Scene): DynamicTexture {
  const size = 64;
  const tex = new DynamicTexture("softDot", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  tex.hasAlpha = true;
  markDynamicTextureReady(tex);
  return tex;
}

/** NullEngine never flips isReady on dynamic textures — unblock material compile. */
function markDynamicTextureReady(tex: DynamicTexture): void {
  const internal = tex.getInternalTexture();
  if (internal && !internal.isReady) internal.isReady = true;
}

// ---------------------------------------------------------------------------
// Function glyphs — abstract airport pictograms, no letters/words/numbers.
// WHY DynamicTexture: crisp at any zoom, no download, tintable via emissive.
// ---------------------------------------------------------------------------

/**
 * Shared unlit glyph material for one facility. White texture × accent emissive
 * = glowing icon that matches the building's storefront colour under bloom.
 */
function glyphMat(scene: Scene, mats: Mats, f: Facility): StandardMaterial {
  const existing = mats.glyphs.get(f.id);
  if (existing) return existing;

  const tex = createFacilityGlyphTexture(scene, f.id);
  const m = new StandardMaterial(`glyphMat_${f.id}`, scene);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = f.accent.clone();
  m.emissiveTexture = tex;
  m.opacityTexture = tex;
  // Two-sided: banner read from plaza, and a thin flag still reads if orbiting.
  m.backFaceCulling = false;
  mats.glyphs.set(f.id, m);
  return m;
}

// ---------------------------------------------------------------------------
// Floating name-tags — small text over NPC heads
// ---------------------------------------------------------------------------

/** Name-tag lettering height in metres — deliberately small, a caption not a sign. */
const NAME_TAG_H = 0.16;

/**
 * Tiny floating caption over a character's head: bare glowing letters on a
 * fully transparent DynamicTexture — no plate, no background quad. The one
 * sanctioned in-world text exception (see the module header): it marks the
 * villager's FUNCTION, so the player can tell an attendant from a passer-by.
 *
 * White text × accent `emissiveColor`, the same tinting scheme as the glyphs.
 * Y-billboarded so it reads from any orbit angle — which is also why it is
 * never frozen: a billboard recomputes its world matrix every frame. Named
 * `labelGlyph_*` on purpose: "glyph" lands it on the shadow-caster denylist
 * (a floating quad would print a bar of shadow on the pavement at noon), and
 * the name misses `SOLID_NAME`, so it never becomes a hero collider.
 */
function buildNameTag(
  scene: Scene,
  key: string,
  text: string,
  accent: Color3,
  pos: Vector3,
  sharedMats?: Map<string, StandardMaterial>
): void {
  // Same caption on many heads (crowd): share one texture+material. Separate
  // planes, not instances — billboarding an InstancedMesh is unreliable.
  let m = sharedMats?.get(text);
  if (!m) {
    const w = 768;
    const h = 96;
    const tex = new DynamicTexture(`labelTex_${key}`, { width: w, height: h }, scene, false);
    tex.hasAlpha = true;
    // Baseline 66 centres 56 px capitals on the 96 px canvas; null x centres.
    tex.drawText(
      text,
      null,
      66,
      "600 56px ui-monospace, SFMono-Regular, Menlo, monospace",
      "#ffffff",
      null,
      true
    );
    markDynamicTextureReady(tex);

    m = new StandardMaterial(`labelMat_${key}`, scene);
    m.disableLighting = true;
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.emissiveColor = accent.clone();
    m.emissiveTexture = tex;
    m.opacityTexture = tex;
    m.backFaceCulling = false;
    sharedMats?.set(text, m);
  }

  const plane = MeshBuilder.CreatePlane(
    `labelGlyph_${key}`,
    { width: NAME_TAG_H * (768 / 96), height: NAME_TAG_H },
    scene
  );
  plane.material = m;
  plane.position.copyFrom(pos);
  plane.billboardMode = Mesh.BILLBOARDMODE_Y;
  plane.isPickable = false;
}

// ---------------------------------------------------------------------------
// Local hero name/title tags — the floating captions over the player's avatar
// ---------------------------------------------------------------------------

/** Title-caption plane height in metres — small gilt line above the name tag. */
const TITLE_TAG_H = 0.09;

/** Caption heights over the hero: name low, title just above it (tight stack). */
const NAME_TAG_Y = 1.9;
const TITLE_TAG_Y = 1.99;

/** Gold emissive for the title caption, matching the HUD's gilt (#d8b45a). */
const TITLE_TAG_ACCENT = Color3.FromHexString("#d8b45a");

/**
 * The local player's equipped title. `undefined` until createVillageHub seeds
 * it from the profile on the FIRST build; afterwards setLocalHeroTitle owns
 * it, so an equip (or unequip) survives village ↔ arena scene rebuilds even
 * though the profile snapshot never changes.
 */
let localHeroTitle: string | null | undefined;

/** Live tag context for the CURRENT hub scene; nulled when the scene dies. */
let localHeroTagCtx: { scene: Scene; parent: TransformNode } | null = null;
let localHeroTitleTag: { plane: Mesh; tex: DynamicTexture } | null = null;

/**
 * One billboarded glowing caption plane parented to `parent` — the remote
 * nameplate recipe (white text × accent emissive on a transparent
 * DynamicTexture), unlike buildNameTag which positions in world space for
 * static NPCs. Named `labelGlyph_*`: "glyph" lands on the shadow-caster
 * denylist and the name misses SOLID_NAME, so the tags never cast and never
 * become colliders.
 */
function buildHeroTag(
  scene: Scene,
  key: string,
  accent: Color3,
  height: number,
  parent: TransformNode
): { plane: Mesh; tex: DynamicTexture } {
  const tex = new DynamicTexture(`labelTex_${key}`, { width: 768, height: 96 }, scene, false);
  tex.hasAlpha = true;
  const mat = new StandardMaterial(`labelMat_${key}`, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = accent;
  mat.emissiveTexture = tex;
  mat.opacityTexture = tex;
  mat.backFaceCulling = false;
  const plane = MeshBuilder.CreatePlane(
    `labelGlyph_${key}`,
    { width: height * (768 / 96), height },
    scene
  );
  plane.material = mat;
  plane.parent = parent;
  plane.billboardMode = Mesh.BILLBOARDMODE_Y;
  plane.isPickable = false;
  return { plane, tex };
}

/** (Re)draw a caption texture — same lettering as the remote nameplates. */
function drawHeroTagText(tex: DynamicTexture, text: string, fill = "#ffffff"): void {
  tex.clear();
  tex.drawText(
    text,
    null,
    64,
    "600 44px ui-monospace, SFMono-Regular, Menlo, monospace",
    fill,
    null,
    true
  );
  markDynamicTextureReady(tex);
}

/**
 * Name + title captions over the local hero, parented to his wrapper node so
 * they travel with him. Stack (bottom → top): tinted name, then the small
 * gold title tight above it. The name tag always exists; the title tag is
 * built only when a title is equipped — setLocalHeroTitle creates/redraws/
 * hides it live from then on.
 */
function buildLocalHeroTags(scene: Scene, hero: HeroHandle, profile: Profile): void {
  const name = buildHeroTag(
    scene,
    "heroName",
    Color3.FromHSV(remoteHue(profile.username), 0.4, 1),
    NAME_TAG_H,
    hero.node
  );
  name.plane.position.y = NAME_TAG_Y;
  drawHeroTagText(name.tex, profile.username);

  localHeroTagCtx = { scene, parent: hero.node };
  localHeroTitleTag = null;
  if (localHeroTitle) {
    localHeroTitleTag = buildHeroTag(scene, "heroTitle", TITLE_TAG_ACCENT, TITLE_TAG_H, hero.node);
    localHeroTitleTag.plane.position.y = TITLE_TAG_Y;
    drawHeroTagText(localHeroTitleTag.tex, localHeroTitle, "#e8c56a");
  }
  // The tags die with the scene; drop the live refs so a late setLocalHeroTitle
  // never redraws into a disposed scene (the next build reads the module var).
  scene.onDisposeObservable.add(() => {
    localHeroTagCtx = null;
    localHeroTitleTag = null;
  });
}

/**
 * Set the local hero's floating title caption (equip/unequip from the
 * achievements panel). Always records the value for the next scene build; if
 * the hub is on screen the tag is redrawn live — created lazily when absent,
 * hidden (not disposed) when the title is cleared.
 */
export function setLocalHeroTitle(title: string | null): void {
  localHeroTitle = title;
  if (!localHeroTagCtx) return;
  if (!title) {
    localHeroTitleTag?.plane.setEnabled(false);
    return;
  }
  if (!localHeroTitleTag || localHeroTitleTag.plane.isDisposed()) {
    localHeroTitleTag = buildHeroTag(
      localHeroTagCtx.scene,
      "heroTitle",
      TITLE_TAG_ACCENT,
      TITLE_TAG_H,
      localHeroTagCtx.parent
    );
    localHeroTitleTag.plane.position.y = TITLE_TAG_Y;
  }
  drawHeroTagText(localHeroTitleTag.tex, title, "#e8c56a");
  localHeroTitleTag.plane.setEnabled(true);
}

// ---------------------------------------------------------------------------
// Remote players — live village presence (server/village.mjs, src/net/village)
// ---------------------------------------------------------------------------

/**
 * Beyond this gap an avatar teleports instead of gliding: interpolation is
 * there to hide 200 ms of network jitter, not a respawn across the plaza.
 */
const REMOTE_SNAP_DIST = 5;

/**
 * Fifty remote players share twelve material pairs, not fifty: the username
 * hash picks a hue bucket, and a bucket is ONE compiled StandardMaterial for
 * the body plus one unlit one for the visor/nameplate accent.
 */
const REMOTE_HUE_BUCKETS = 12;

/**
 * Late-bound slot through which the skill bar announces accepted casts to the
 * village presence channel. An object, not a bare callback param: the bar is
 * built before the presence client exists (it needs the profile), so the hub
 * hands the bar `{ fn: null }` and wireVillagePresence fills it in later.
 */
type CastAnnounce = { fn: ((slot: BarSlotDef) => void) | null };

/** A remote player's rigged hero instance + its minimal locomotion animator. */
interface RemoteRig {
  /** Instantiated model root (carries scale + the RH→LH flip), under `pose`. */
  root: TransformNode;
  idle: AnimationGroup | null;
  walk: AnimationGroup | null;
  run: AnimationGroup | null;
  jumpStart: AnimationGroup | null;
  jumpLand: AnimationGroup | null;
  /** Cast one-shots, same clip vocabulary as the local animator's finds. */
  shoot: AnimationGroup | null;
  castE: AnimationGroup | null;
  castR: AnimationGroup | null;
  castF: AnimationGroup | null;
  /** Every cloned group, so leave/dispose can stop the lot. */
  groups: AnimationGroup[];
  wIdle: number;
  wWalk: number;
  wRun: number;
  /** True while a jump one-shot owns the skeleton (loco weights held at 0). */
  takenOver: boolean;
  /** Rising/falling-edge detect on the "jump" action hint. */
  wasAirborne: boolean;
}

interface RemoteAvatar {
  root: TransformNode;
  /** Lean/bob live here so they never fight the facing yaw on the root. */
  pose: TransformNode;
  target: Vector3;
  targetRy: number;
  /** Last server-reported locomotion hint ("idle" | "run" | "jump" | …). */
  action: string;
  bobPhase: number;
  lean: number;
  /** Per-avatar nameplate parts (NOT shared) — disposed on leave. */
  tagMat: StandardMaterial;
  tagTex: DynamicTexture;
  /** Server-reported hero id ("" until a hello/join supplies it). */
  heroId: string;
  /** Capsule/sphere/visor stand-in, disposed the moment the real rig lands. */
  placeholder: Mesh[];
  /** Real hero model, once instantiated (null while loading or over budget). */
  rig: RemoteRig | null;
  /** Guards double-starts: an attach is in flight for this avatar. */
  rigLoading: boolean;
  /**
   * That player's equipped pet, walking at THEIR heel. Cosmetic and
   * village-only (the boss arena deliberately skips remote pets — see
   * fight/arenaCombat.ts wireParty — so a 3-stack fight has three bodies to
   * read, not six). `petId` is what the server last reported, so a wardrobe
   * swap across the wire can dispose and respawn the right one.
   */
  pet: PetHandle | null;
  petId: string | null;
  /** Generation counter — a swap mid-load orphans the older request. */
  petGen: number;
}

/** Deterministic per-player hue: same name, same colour, every session. */
function remoteHue(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) | 0;
  return (Math.abs(h) % REMOTE_HUE_BUCKETS) * (360 / REMOTE_HUE_BUCKETS);
}

/**
 * Join the village session and mirror its roster as real hero rigs.
 *
 * Representation budget: each avatar mounts instantly as a capsule + visor
 * stand-in (~5 meshes, zero downloads), then upgrades in place to the hero
 * model the server reported. Each DISTINCT hero glb downloads and parses once
 * into a shared AssetContainer (three shipped rigs today — unmodeled heroes
 * borrow Freud's, same fallback as the arena) and every player of that hero
 * is an instantiation of it, so fifty freuds cost one download plus cloned
 * skeletons. Rigged upgrades stop at HUB.maxPlayers (budget.ts); players past
 * the cap keep the capsule — presence stays honest even in a packed plaza.
 * Avatar meshes are pickable ONLY through their `metadata.remotePlayer` stamp
 * (the tap handler's player branch keys on it); every other pick in the hub
 * uses its own narrow predicate, so avatars never eat portal/shop taps.
 *
 * The roster heals itself: SSE `hello` (initial AND after every reconnect) is
 * a full replace, `state` batches only move targets — the actual motion runs
 * as an interpolation ticker so 5 Hz updates render as smooth glides. The
 * `action` hint ("idle" | "run" | "jump") plus the glide speed drive a minimal
 * idle/walk/run blend on rigged avatars; capsules keep the bob/lean.
 */
function wireVillagePresence(
  scene: Scene,
  profile: Profile,
  hero: HeroHandle,
  /** The played hero's id — decides which pet this player walks (pets are
   *  hero-exclusive, petFollower.petForHero), declared to the server on join. */
  heroId: string,
  tickers: Ticker[],
  castAnnounce: CastAnnounce
): void {
  const client = new VillageClient();
  const self = profile.username.toLowerCase();
  const avatars = new Map<string, RemoteAvatar>();
  const bodyMats = new Map<number, StandardMaterial>();
  const accentMats = new Map<number, StandardMaterial>();
  let disposed = false;

  const bucketMat = (
    cache: Map<number, StandardMaterial>,
    hue: number,
    make: (m: StandardMaterial, tint: Color3) => void
  ): StandardMaterial => {
    let m = cache.get(hue);
    if (!m) {
      m = new StandardMaterial(`remoteMat_${hue}`, scene);
      make(m, Color3.FromHSV(hue, 0.55, 0.9));
      cache.set(hue, m);
    }
    return m;
  };
  // Lit body: tint in the diffuse so the sun/shade play still reads.
  const bodyMat = (hue: number) =>
    bucketMat(bodyMats, hue, (m, tint) => {
      m.diffuseColor = tint;
      m.specularColor = Color3.Black();
    });
  // Unlit accent: visor + nameplate, same glow language as the shop glyphs.
  const accentMat = (hue: number) =>
    bucketMat(accentMats, hue, (m, tint) => {
      m.disableLighting = true;
      m.diffuseColor = Color3.Black();
      m.specularColor = Color3.Black();
      m.emissiveColor = tint;
    });

  // One shared AssetContainer per DISTINCT hero glb — the whole reason fifty
  // players don't mean fifty downloads. The promise is the cache entry so
  // concurrent joins of the same hero coalesce on one fetch.
  const rigContainers = new Map<string, Promise<AssetContainer | null>>();
  const heroRigContainer = (modelId: string): Promise<AssetContainer | null> => {
    let p = rigContainers.get(modelId);
    if (!p) {
      p = LoadAssetContainerAsync(`/assets/heroes/${modelId}.glb`, scene).catch((err: unknown) => {
        console.warn(`[village] remote rig ${modelId}.glb unavailable, keeping capsules:`, err);
        return null;
      });
      rigContainers.set(modelId, p);
    }
    return p;
  };

  /** Rigged avatars, live or loading — the budget the cap below counts. */
  const riggedCount = (): number => {
    let n = 0;
    for (const a of avatars.values()) if (a.rig || a.rigLoading) n++;
    return n;
  };

  /** Upgrade a capsule avatar to its hero model, in place. Reentrancy-safe: a
   *  leave (or scene teardown) landing mid-await just orphans the instance
   *  work, and the guard re-checks the map identity after every await. */
  const attachRig = (a: RemoteAvatar, username: string): void => {
    if (a.rigLoading || a.rig || disposed) return;
    if (!a.heroId) return; // gap-materialized: wait for hello/join to name the hero
    if (riggedCount() >= HUB.maxPlayers) return; // past budget: capsule is the design
    a.rigLoading = true;
    const modelId = MODELED_HEROES.has(a.heroId) ? a.heroId : "freud";
    void heroRigContainer(modelId).then((container) => {
      const key = username.toLowerCase();
      if (!container || disposed || avatars.get(key) !== a) {
        a.rigLoading = false;
        return;
      }
      const entries = container.instantiateModelsToScene((name) => `remote_${username}_${name}`);
      const root = entries.rootNodes[0] as TransformNode | undefined;
      if (!root) {
        a.rigLoading = false;
        return;
      }
      for (const node of root.getChildMeshes(false)) {
        // Pickable, but only for the player-card tap: the handler's predicate
        // matches solely on the `metadata.remotePlayer` stamp, and every other
        // pick in the hub uses its own narrow predicate — so avatars still
        // can't eat portal/shop taps.
        node.isPickable = true;
        node.metadata = { ...(node.metadata ?? {}), remotePlayer: username };
        // Skinned bounds go stale as clips play; never let culling drop a limb.
        if (node.getTotalVertices() > 0) node.alwaysSelectAsActiveMesh = true;
      }
      // Canon normalisation, same as the arena: height to heroHeightM, soles
      // on y 0, facing -Z at rest (the loader root carries the RH→LH flip).
      const bounds = root.getHierarchyBoundingVectors();
      const s = heroHeightM(modelId) / Math.max(0.01, bounds.max.y - bounds.min.y);
      root.scaling.scaleInPlace(s);
      root.rotationQuaternion = null;
      root.rotation.y = 0;
      root.position.set(0, -bounds.min.y * s, 0);
      root.parent = a.pose;

      // Minimal locomotion animator — clip lookup by name, same vocabulary as
      // every shipped rig (idle/walk/run + the jump pair).
      const groups = entries.animationGroups;
      const find = (...keys: string[]): AnimationGroup | null => {
        for (const k of keys) {
          const g = groups.find((g) => g.name.toLowerCase().endsWith(k));
          if (g) return g;
        }
        for (const k of keys) {
          const g = groups.find((g) => g.name.toLowerCase().includes(k));
          if (g) return g;
        }
        return null;
      };
      for (const g of groups) g.stop();
      const rig: RemoteRig = {
        root,
        idle: find("idle"),
        walk: find("walk"),
        run: find("run", "sprint"),
        jumpStart: find("jump_start", "jump"),
        jumpLand: find("jump_land"),
        // Cast one-shots — the local animator's vocabulary (createHeroAnimator)
        // so a remote cast plays the same gesture the caster sees.
        shoot: find("overhandthrow", "overhand", "cast", "shoot"),
        castE: find("cast_e", "throw"),
        castR: find("cast_r", "meditate"),
        castF: find("cast_f"),
        groups,
        wIdle: 1,
        wWalk: 0,
        wRun: 0,
        takenOver: false,
        wasAirborne: false,
      };
      const loop = (g: AnimationGroup | null, w: number): void => {
        if (!g) return;
        g.start(true);
        g.setWeightForAllAnimatables(w);
      };
      loop(rig.idle, 1);
      loop(rig.walk, 0);
      loop(rig.run, 0);
      // Landing starts off a held airborne pose — blend it or it snaps (the
      // same touchdown flash the local hero fixed with per-anim blending).
      if (rig.jumpLand) {
        for (const ta of rig.jumpLand.targetedAnimations) {
          ta.animation.enableBlending = true;
          ta.animation.blendingSpeed = 0.12;
        }
      }
      // ⚠️ Every clip castOneShot/the jump edges can start must be in here —
      // a one-shot without this release observer pins `takenOver` forever and
      // freezes the rig on its last frame (same rule as the local animator).
      // Set-wrapped: two finds may resolve to the same group on older rigs.
      for (const g of new Set([rig.jumpStart, rig.jumpLand, rig.shoot, rig.castE, rig.castR, rig.castF])) {
        g?.onAnimationGroupEndObservable.add(() => {
          rig.takenOver = false;
          g.setWeightForAllAnimatables(0);
        });
      }

      // Rig landed: retire the stand-in. Bob/lean must not stack on a real
      // walk cycle, so zero the pose offsets they were driving.
      for (const m of a.placeholder) m.dispose();
      a.placeholder = [];
      a.pose.position.y = 0;
      a.pose.rotation.x = 0;
      a.rig = rig;
      a.rigLoading = false;
    });
  };

  /** Remote pets live or loading — the budget the cap below counts. */
  const pettedCount = (): number => {
    let n = 0;
    for (const a of avatars.values()) if (a.pet || a.petId) n++;
    return n;
  };

  /**
   * Spawn (or swap, or clear) a remote player's pet. The pet chases the
   * avatar's root, which the interpolator drives — so it trails a smoothed
   * target, one chase stacked on another, which reads exactly like a pet
   * following someone across the plaza.
   *
   * Budgeted like the rigged upgrades, and for a sharper reason: unlike hero
   * rigs (one shared AssetContainer per hero, instantiated per player) every
   * pet is its own glb import, so a packed plaza of pet owners is a download
   * per pet. Past the cap the player simply walks alone — presence stays
   * honest, the frame budget stays intact.
   */
  const applyPet = (avatar: RemoteAvatar, petId: string | null): void => {
    if (petId === avatar.petId) return;
    if (petId && !avatar.petId && pettedCount() >= HUB.maxPlayers) return;
    avatar.petId = petId;
    const gen = ++avatar.petGen;
    avatar.pet?.dispose();
    avatar.pet = null;
    if (!petId || disposed) return;
    void createPetFollower(scene, { node: avatar.root }, petId).then((pet) => {
      if (!pet) return;
      // Disposed, or another swap landed first — this result belongs to nobody.
      if (disposed || gen !== avatar.petGen) {
        pet.dispose();
        return;
      }
      avatar.pet = pet;
    });
  };


  const addAvatar = (p: VillagePlayer): void => {
    if (disposed) return;
    const key = p.username.toLowerCase();
    if (key === self) return; // the server roster includes you
    const existing = avatars.get(key);
    if (existing) {
      existing.target.set(p.x, p.y, p.z);
      existing.targetRy = p.ry;
      // A gap-materialized avatar (state before join — heroId "") learns its
      // hero the moment the roster names it; upgrade in place.
      if (!existing.heroId && p.hero) {
        existing.heroId = p.hero;
        attachRig(existing, p.username);
      }
      // A re-broadcast join carries the CURRENT pet: the server repeats it
      // when a player swaps pets mid-session, so this is the swap path too.
      if (p.pet !== undefined) applyPet(existing, p.pet ?? null);
      return;
    }

    const hue = remoteHue(p.username);
    const root = new TransformNode(`remote_${p.username}`, scene);
    root.position.set(p.x, p.y, p.z);
    root.rotation.y = p.ry;
    const pose = new TransformNode(`remotePose_${p.username}`, scene);
    pose.parent = root;

    const body = MeshBuilder.CreateCapsule(
      `remoteBody_${p.username}`,
      { height: 1.55, radius: 0.25, tessellation: 8, capSubdivisions: 3 },
      scene
    );
    body.parent = pose;
    body.position.y = 0.85;
    body.material = bodyMat(hue);

    const head = MeshBuilder.CreateSphere(
      `remoteHead_${p.username}`,
      { diameter: 0.34, segments: 8 },
      scene
    );
    head.parent = pose;
    head.position.y = 1.6;
    head.material = bodyMat(hue);

    // The only asymmetry — without it a capsule+sphere has no readable facing.
    const visor = MeshBuilder.CreateBox(
      `remoteVisor_${p.username}`,
      { width: 0.24, height: 0.07, depth: 0.06 },
      scene
    );
    visor.parent = pose;
    visor.position.set(0, 1.62, -0.16); // -Z = forward, same canon as the hero
    visor.material = accentMat(hue);

    // Nameplate: same floating-glowing-caption recipe as buildNameTag, but
    // parented to the avatar so it travels (and the plane is per-player —
    // billboarding shares poorly and each caption is a unique string anyway).
    const tagTex = new DynamicTexture(
      `remoteTagTex_${p.username}`,
      { width: 768, height: 96 },
      scene,
      false
    );
    tagTex.hasAlpha = true;
    tagTex.drawText(
      p.username,
      null,
      64,
      "600 44px ui-monospace, SFMono-Regular, Menlo, monospace",
      "#ffffff",
      null,
      true
    );
    markDynamicTextureReady(tagTex);
    const tagMat = new StandardMaterial(`remoteTagMat_${p.username}`, scene);
    tagMat.disableLighting = true;
    tagMat.diffuseColor = Color3.Black();
    tagMat.specularColor = Color3.Black();
    tagMat.emissiveColor = Color3.FromHSV(hue, 0.4, 1);
    tagMat.emissiveTexture = tagTex;
    tagMat.opacityTexture = tagTex;
    tagMat.backFaceCulling = false;
    const tag = MeshBuilder.CreatePlane(
      `remoteGlyph_${p.username}`,
      { width: NAME_TAG_H * (768 / 96), height: NAME_TAG_H },
      scene
    );
    tag.material = tagMat;
    tag.parent = root;
    tag.position.y = 1.95;
    tag.billboardMode = Mesh.BILLBOARDMODE_Y;

    // Pickable, but tagged: the tap handler's player branch matches ONLY on
    // `metadata.remotePlayer`, so these still can't eat portal/shop taps
    // (those picks use their own narrow predicates).
    for (const m of [body, head, visor, tag]) {
      m.isPickable = true;
      m.metadata = { ...(m.metadata ?? {}), remotePlayer: p.username };
    }

    const avatar: RemoteAvatar = {
      root,
      pose,
      target: new Vector3(p.x, p.y, p.z),
      targetRy: p.ry,
      action: "idle",
      bobPhase: 0,
      lean: 0,
      tagMat,
      tagTex,
      heroId: p.hero ?? "",
      placeholder: [body, head, visor],
      rig: null,
      rigLoading: false,
      pet: null,
      petId: null,
      petGen: 0,
    };
    avatars.set(key, avatar);
    attachRig(avatar, p.username);
    applyPet(avatar, p.pet ?? null);
  };

  const removeAvatar = (username: string): void => {
    const a = avatars.get(username.toLowerCase());
    if (!a) return;
    avatars.delete(username.toLowerCase());
    // The pet keeps its own world position (it is NOT parented to the avatar),
    // so it has to be disposed explicitly or it stands in the plaza forever.
    a.petGen++; // orphan any in-flight load
    a.pet?.dispose();
    // Cloned animation groups are scene-level objects — root.dispose() below
    // does NOT take them, and a leaked group keeps animating freed nodes.
    if (a.rig) for (const g of a.rig.groups) g.dispose();
    a.root.dispose(false); // takes pose/rig (or capsule parts)/tag plane with it
    a.tagMat.dispose();
    a.tagTex.dispose();
  };

  // -------------------------------------------------------------------------
  // Remote casts — a friend's skill press plays on YOUR screen too.
  //
  // The same burst/skill/projectile factories the local bar uses, but ONE
  // shared kit per DISTINCT hero id instead of one per avatar: the pools are
  // fat (orb pools, rune circles, particle systems) and none of the factories
  // expose dispose, so fifty per-player copies would both bloat and leak as
  // players churn. The kit's anchor node re-parents onto whoever cast last, so
  // a running effect follows its caster; two same-hero remotes casting in the
  // same second hand the tail of the first effect to the second — cosmetic,
  // rare, and far cheaper than per-player pools. Kits die with the scene.
  // -------------------------------------------------------------------------
  interface RemoteCastFxKit {
    node: TransformNode;
    burst: (c1: Color4, c2: Color4, count: number) => void;
    skillFx: HeroSkillVfx;
    projectiles: CastProjectiles;
  }
  const castFxKits = new Map<string, RemoteCastFxKit>();
  const castFxFor = (heroId: string): RemoteCastFxKit => {
    const id = heroId || "freud"; // gap-materialized avatars have heroId ""
    let kit = castFxKits.get(id);
    if (!kit) {
      const node = new TransformNode(`remoteCastFx_${id}`, scene);
      kit = {
        node,
        burst: createCastVfx(scene, node),
        skillFx: createHeroSkillVfx(scene, node, id),
        projectiles: createCastProjectiles(scene, node),
      };
      castFxKits.set(id, kit);
    }
    return kit;
  };

  /** Seconds a group runs at speedRatio 1 — the glTF importer bakes 60 fps. */
  const clipSeconds = (g: AnimationGroup): number => (g.to - g.from) / 60;
  /** Floor very short clips to ~0.5 s wall time so a hook reads, not twitches. */
  const readable = (g: AnimationGroup, ratio: number): number =>
    Math.min(ratio, Math.max(0.5, clipSeconds(g) / 0.5));

  /**
   * One-shot a cast gesture on a remote rig — the jump pair's takeover
   * pattern: locomotion weights hold at 0 while `takenOver` is up, and the
   * end observers registered in attachRig release it. Sibling one-shots stop
   * first or two full-body groups fight over the same bones (the local
   * animator's fullBody rule).
   */
  const playRigCast = (rig: RemoteRig, kind: string): void => {
    const pick =
      kind === "ultimate"
        ? (rig.castF ?? rig.castE)
        : kind === "chain"
          ? rig.castR
          : kind === "defense"
            ? rig.castE
            : rig.shoot; // basic + palette both throw
    if (!pick) return;
    for (const other of [rig.jumpStart, rig.jumpLand, rig.shoot, rig.castE, rig.castR, rig.castF]) {
      if (other && other !== pick) {
        other.stop();
        other.setWeightForAllAnimatables(0);
      }
    }
    pick.stop();
    // R sits into Meditate at half speed, same deliberate beat as the local
    // hub read; the rest run near clip speed with the short-clip floor.
    pick.start(false, kind === "chain" ? 0.5 : readable(pick, kind === "defense" ? 1.6 : 1.0));
    pick.setWeightForAllAnimatables(1);
    // AFTER every stop() — stop() fires the end observer, which clears the
    // flag (the local animator learned this the hard way).
    rig.takenOver = true;
  };

  /** Kinds the per-skill magic-moment layer knows (skillFx.cast's domain). */
  const SKILL_FX_KINDS = new Set<string>(["palette", "defense", "chain", "ultimate"]);

  const playRemoteCast = (username: string, id: string, kind: string): void => {
    const a = avatars.get(username.toLowerCase());
    if (!a || kind === "stance") return; // stance is a toggle, nothing visible flies
    const kitDef = heroById(a.heroId || undefined);
    const kit = castFxFor(a.heroId);
    // Follow the caster: identity transform under their pose node puts the
    // kit exactly where hero.node sits for the local caster (feet origin).
    kit.node.parent = a.pose;
    kit.node.position.setAll(0);
    kit.node.rotation.set(0, 0, 0);
    const [c1, c2] = CAST_KIND_COLORS[kind as BarSlotDef["kind"]] ?? CAST_KIND_COLORS.palette;
    kit.burst(c1, c2, kind === "ultimate" ? 90 : kind === "basic" ? 14 : 26);
    // Mirror the local bar's throw rules: reinforcement kits' palette/ult are
    // heals and settle in place; ultimates never fly here (the open village
    // has no target to home on — same as the local bar without hooks.target).
    const healCast = !!kitDef.reinforcement && (kind === "palette" || kind === "ultimate");
    if (kind === "basic") {
      kit.projectiles.fire({
        ...basicProjectileStyle(kitDef.id),
        size: 0.14,
        speed: 14,
        lifeSec: 1.1,
        spread: 0.12,
      });
    } else if (kind === "palette" && !healCast) {
      kit.projectiles.fire({
        color: paletteTint(id),
        size: 0.26,
        speed: 6.5,
        lifeSec: 2.2,
        wobble: 0.8,
        ...paletteDressing(id),
        spread: 0.45,
      });
    }
    // Basic keeps just the small burst + throw gesture, same anti-strobe rule
    // as the local bar. No voice/sfx for remote casts — a full plaza of
    // spatially-unattenuated bark lines would be noise, not presence.
    if (SKILL_FX_KINDS.has(kind)) kit.skillFx.cast(kind as FreudCastKind, id);
    if (a.rig) playRigCast(a.rig, kind);
    lastRemoteCast = { username, id, kind };
  };

  // Publish local casts. The bar already gated cooldown/GCD/Focus, so every
  // call here is a cast that actually happened; the server just fans it out.
  castAnnounce.fn = (slot) => {
    if (slot.kind === "stance") return; // toggle, not a visible cast
    client.sendCast(slot.id, slot.kind);
  };

  let lastRemoteCast: { username: string; id: string; kind: string } | null = null;
  client.onCast = (c) => {
    // Our own echo comes back too (the server broadcasts to every stream in
    // the session) — the local bar already played the real thing.
    if (c.username.toLowerCase() === self) return;
    playRemoteCast(c.username, c.id, c.kind);
  };

  client.onRoster = (players) => {
    // Full replace — anything not in this snapshot left while we were deaf.
    const seen = new Set<string>();
    for (const p of players) {
      addAvatar(p);
      seen.add(p.username.toLowerCase());
    }
    for (const key of [...avatars.keys()]) if (!seen.has(key)) removeAvatar(key);
  };
  client.onJoin = addAvatar;
  client.onLeave = removeAvatar;
  client.onState = (map) => {
    for (const [username, [x, y, z, ry, action]] of Object.entries(map)) {
      const key = username.toLowerCase();
      // A state entry for someone we never saw join (stream gap): materialize
      // them from the position alone — hero id is cosmetic here.
      if (!avatars.has(key)) addAvatar({ username, hero: "", x, y, z, ry });
      const a = avatars.get(key);
      if (!a) continue;
      a.target.set(x, y, z);
      a.targetRy = ry;
      a.action = action;
    }
  };

  // Interpolation: glide toward the last reported pose. k = dt*10 settles in
  // ~100 ms — brisk enough to track 5 Hz updates, soft enough to hide them.
  let lastMoveT = 0;
  tickers.push({
    tick: (t: number) => {
      const dt = Math.min(0.1, t - lastMoveT || 0);
      lastMoveT = t;
      if (dt <= 0) return;
      const k = Math.min(1, dt * 10);
      for (const a of avatars.values()) {
        const dx = a.target.x - a.root.position.x;
        const dy = a.target.y - a.root.position.y;
        const dz = a.target.z - a.root.position.z;
        if (dx * dx + dy * dy + dz * dz > REMOTE_SNAP_DIST * REMOTE_SNAP_DIST) {
          a.root.position.copyFrom(a.target);
          a.root.rotation.y = a.targetRy;
        } else {
          a.root.position.x += dx * k;
          a.root.position.y += dy * k;
          a.root.position.z += dz * k;
          a.root.rotation.y = lerpAngle(a.root.rotation.y, a.targetRy, k);
        }
        const moving = a.action !== "idle" && a.action !== "";
        const rig = a.rig;
        if (rig) {
          // Real rig: idle/walk/run weight blend. The server never says which
          // gait, so infer speed from the glide itself — near steady state the
          // exponential chase moves dist·k per tick, i.e. ~dist·10 per second.
          const speed = moving ? Math.hypot(dx, dz) * 10 : 0;
          // Jump edges: one-shot the launch clip going airborne, the landing
          // clip on touchdown (same halves the local controller plays).
          const airborne = a.action === "jump";
          if (airborne && !rig.wasAirborne && rig.jumpStart) {
            rig.jumpStart.stop();
            rig.jumpStart.start(false, 1.4);
            rig.jumpStart.setWeightForAllAnimatables(1);
            rig.takenOver = true;
          } else if (!airborne && rig.wasAirborne) {
            if (rig.jumpStart) {
              rig.jumpStart.stop();
              rig.jumpStart.setWeightForAllAnimatables(0);
              rig.takenOver = false;
            }
            if (rig.jumpLand) {
              rig.jumpLand.stop();
              rig.jumpLand.start(false, 1.6);
              rig.jumpLand.setWeightForAllAnimatables(1);
              rig.takenOver = true;
            }
          }
          rig.wasAirborne = airborne;

          let tIdle = 1;
          let tWalk = 0;
          let tRun = 0;
          if (moving && speed > 0.05) {
            if (speed <= 3.4) {
              tWalk = 1;
              tIdle = 0;
            } else {
              tRun = Math.min(1, (speed - 3.4) / (6.2 - 3.4));
              tWalk = 1 - tRun;
              tIdle = 0;
            }
          }
          if (rig.takenOver) {
            tIdle = 0;
            tWalk = 0;
            tRun = 0;
          }
          const kb = Math.min(1, dt * 9);
          rig.wIdle += (tIdle - rig.wIdle) * kb;
          rig.wWalk += (tWalk - rig.wWalk) * kb;
          rig.wRun += (tRun - rig.wRun) * kb;
          rig.idle?.setWeightForAllAnimatables(rig.wIdle);
          rig.walk?.setWeightForAllAnimatables(rig.wWalk);
          rig.run?.setWeightForAllAnimatables(rig.wRun);
          if (rig.walk) rig.walk.speedRatio = Math.min(1.9, Math.max(0.8, speed / 1.4));
          if (rig.run) rig.run.speedRatio = Math.min(1.5, Math.max(0.8, speed / 4.5));
        } else {
          // Capsule stand-in: footfall bob + a lean that eases in and out,
          // exactly the controller's trick scaled way down.
          if (moving) a.bobPhase += dt * 9;
          a.lean += ((moving ? 1 : 0) - a.lean) * Math.min(1, dt * 6);
          a.pose.position.y = moving ? Math.abs(Math.sin(a.bobPhase)) * 0.045 : 0;
          a.pose.rotation.x = -0.12 * a.lean;
        }
        // The pet chases the root this tick just moved.
        a.pet?.tick();
      }
    },
  });

  // Local reporter: read the hero wrapper the controller just moved, derive a
  // coarse action, hand it to the client's 200 ms trailing-edge throttle.
  let lastReportT = 0;
  let prevX = hero.node.position.x;
  let prevZ = hero.node.position.z;
  tickers.push({
    tick: (t: number) => {
      const dt = Math.min(0.1, t - lastReportT || 0);
      lastReportT = t;
      if (dt <= 0 || client.sessionId === null) return;
      const pos = hero.node.absolutePosition;
      const speed = Math.hypot(pos.x - prevX, pos.z - prevZ) / dt;
      prevX = pos.x;
      prevZ = pos.z;
      // y > 0.1 clears the walk bob (≤ ~0.06), so it means genuinely airborne.
      const action = pos.y > 0.1 ? "jump" : speed > 0.3 ? "run" : "idle";
      client.sendState(pos.x, pos.y, pos.z, hero.node.rotation.y, action);
    },
  });

  // Debug/e2e hook: remote-avatar visibility is otherwise only provable by
  // reading pixels. tools/mp-e2e.mjs asserts mutual presence through this.
  const presenceDebug = {
    get remoteCount() {
      return avatars.size;
    },
    get remoteNames() {
      return [...avatars.keys()];
    },
    /** Last remote cast this tab played — lets mp-e2e assert VFX sync. */
    get lastRemoteCast() {
      return lastRemoteCast;
    },
  };
  (window as unknown as { psyrenaVillage?: typeof presenceDebug }).psyrenaVillage = presenceDebug;

  scene.onDisposeObservable.add(() => {
    disposed = true;
    // The bar dies with the scene too, but a torn-down client must never see
    // one last cast from a teardown-ordering race.
    castAnnounce.fn = null;
    void client.leave();
    for (const key of [...avatars.keys()]) removeAvatar(key);
    // The shared rig containers hold source meshes/skeletons that were never
    // added to the scene graph — free them explicitly (a late-resolving load
    // lands after `disposed` and drops straight through the attach guard).
    for (const p of rigContainers.values()) {
      void p.then((c) => {
        try {
          c?.dispose();
        } catch {
          /* scene already torn down — nothing left to free */
        }
      });
    }
    const w = window as unknown as { psyrenaVillage?: typeof presenceDebug };
    if (w.psyrenaVillage === presenceDebug) delete w.psyrenaVillage;
  });

  // Declare the equipped pet on join so everyone else's plaza shows it too —
  // the pet lives in client-side wardrobe storage, so the client is the only
  // one who can say. A swap in the Pet Park re-announces (the server repeats
  // the `join` broadcast when the pet actually changed), which is what makes
  // an equip visible to the people standing next to you.
  const offWardrobe = wardrobe.onChange(() => client.setPet(petForHero(heroId)));
  scene.onDisposeObservable.add(offWardrobe);

  client.join({ pet: petForHero(heroId) }).then(
    ({ players }) => client.onRoster?.(players),
    (err: unknown) => {
      // Logged ONCE: the village is a solo scene with presence, not the other
      // way round — offline or logged-out play must work exactly as before.
      console.warn("[village] presence unavailable, continuing solo:", err);
    }
  );
}

function createFacilityGlyphTexture(scene: Scene, id: FacilityId): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture(`glyphTex_${id}`, { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  drawFacilityGlyph(ctx, id, size);
  tex.hasAlpha = true;
  tex.update();
  markDynamicTextureReady(tex);
  return tex;
}

/**
 * Chunky white-on-transparent pictograms. Thin linework dies in fog at 15–25 m,
 * so everything is thick fills / heavy strokes — airport sign, not illustration.
 */
function drawFacilityGlyph(ctx: CanvasRenderingContext2D, id: FacilityId, size: number): void {
  const cx = size / 2;
  const cy = size / 2;
  const s = size * 0.34;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.075;

  switch (id) {
    case "outfitter": {
      // Coat hanger: hook + shoulder bar with upturned tips.
      ctx.lineWidth = size * 0.08;
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.72, s * 0.2, Math.PI * 0.15, Math.PI * 1.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.55);
      ctx.lineTo(cx, cy - s * 0.22);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.95, cy + s * 0.05);
      ctx.quadraticCurveTo(cx, cy + s * 0.42, cx + s * 0.95, cy + s * 0.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.95, cy + s * 0.05);
      ctx.lineTo(cx - s * 0.95, cy - s * 0.18);
      ctx.moveTo(cx + s * 0.95, cy + s * 0.05);
      ctx.lineTo(cx + s * 0.95, cy - s * 0.18);
      ctx.stroke();
      break;
    }
    case "style-lab": {
      // Four-point sparkle / star.
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx + s * 0.28, cy);
      ctx.lineTo(cx, cy + s);
      ctx.lineTo(cx - s * 0.28, cy);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - s, cy);
      ctx.lineTo(cx, cy - s * 0.28);
      ctx.lineTo(cx + s, cy);
      ctx.lineTo(cx, cy + s * 0.28);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "pet-park": {
      // Paw print: main pad + four toes. (Mesh names avoid `paw` for shadows.)
      ctx.beginPath();
      ctx.ellipse(cx, cy + s * 0.35, s * 0.48, s * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      const toes: Array<[number, number]> = [
        [-0.55, -0.35],
        [-0.2, -0.55],
        [0.2, -0.55],
        [0.55, -0.35],
      ];
      for (const [tx, ty] of toes) {
        ctx.beginPath();
        ctx.ellipse(cx + s * tx, cy + s * ty, s * 0.2, s * 0.24, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "hall-of-minds": {
      // Trophy: cup, stem, base, small handles.
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.55, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.55, cy - s * 0.55);
      ctx.lineTo(cx + s * 0.38, cy + s * 0.15);
      ctx.lineTo(cx - s * 0.38, cy + s * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(cx - s * 0.12, cy + s * 0.15, s * 0.24, s * 0.35);
      ctx.fillRect(cx - s * 0.42, cy + s * 0.5, s * 0.84, s * 0.18);
      ctx.lineWidth = size * 0.07;
      ctx.beginPath();
      ctx.arc(cx - s * 0.55, cy - s * 0.2, s * 0.28, Math.PI * 0.55, Math.PI * 1.45);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + s * 0.55, cy - s * 0.2, s * 0.28, -Math.PI * 0.45, Math.PI * 0.45);
      ctx.stroke();
      break;
    }
    case "queue-terminal": {
      // Portal: thick ring with an arrow entering from the left.
      ctx.lineWidth = size * 0.1;
      ctx.beginPath();
      ctx.arc(cx + s * 0.12, cy, s * 0.72, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = size * 0.1;
      ctx.beginPath();
      ctx.moveTo(cx - s * 1.05, cy);
      ctx.lineTo(cx + s * 0.05, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.15, cy - s * 0.35);
      ctx.lineTo(cx + s * 0.25, cy);
      ctx.lineTo(cx - s * 0.15, cy + s * 0.35);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "practice-booth": {
      // Bullseye / concentric target.
      ctx.lineWidth = size * 0.09;
      ctx.beginPath();
      ctx.arc(cx, cy, s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.62, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.28, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "coffee-shop": {
      // Cup body + handle + saucer.
      ctx.fillRect(cx - s * 0.42, cy - s * 0.35, s * 0.84, s * 0.7);
      ctx.beginPath();
      ctx.arc(cx + s * 0.42, cy, s * 0.28, -Math.PI * 0.55, Math.PI * 0.55);
      ctx.lineWidth = size * 0.085;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, cy + s * 0.55, s * 0.7, s * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      // Steam: three short arcs (still chunky, no text).
      ctx.lineWidth = size * 0.055;
      for (const ox of [-0.22, 0, 0.22]) {
        ctx.beginPath();
        ctx.moveTo(cx + s * ox, cy - s * 0.45);
        ctx.quadraticCurveTo(cx + s * (ox + 0.12), cy - s * 0.7, cx + s * ox, cy - s * 0.9);
        ctx.stroke();
      }
      break;
    }
    case "residential": {
      // Simple house outline: roof + body + door cut.
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.95);
      ctx.lineTo(cx + s * 0.95, cy - s * 0.15);
      ctx.lineTo(cx + s * 0.95, cy + s * 0.85);
      ctx.lineTo(cx - s * 0.95, cy + s * 0.85);
      ctx.lineTo(cx - s * 0.95, cy - s * 0.15);
      ctx.closePath();
      ctx.fill();
      // Door as a dark cut — clear the alpha so it reads as an opening.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillRect(cx - s * 0.18, cy + s * 0.15, s * 0.36, s * 0.7);
      ctx.globalCompositeOperation = "source-over";
      break;
    }
  }
}

/**
 * Mount function icons so they read from the plaza.
 *
 * Local −Z is the facade face (root already faces the plaza via facingIn).
 * Every plane uses rotation.y = π so its front faces that −Z side — same
 * convention as the storefront glass. Flat quads are named for the shadow
 * denylist; one material per facility is shared by plate glyphs + banner.
 */
function mountFacilitySignage(
  scene: Scene,
  mats: Mats,
  root: TransformNode,
  f: Facility,
  /**
   * `bracketY` is the sign plate's sole, already clamped under the parapet.
   * `bracket` describes the perpendicular kit plate when it was hung, so the
   * glyph can ride its faces; null = no authored plate, glyph goes flat on
   * the wall above the door instead.
   */
  opts: { glassH: number; bracketY: number; bracket: SignPlateMount | null }
): Mesh[] {
  const mat = glyphMat(scene, mats, f);
  const out: Mesh[] = [];
  const frontFace = -(f.depth / 2);

  if (f.openAir) {
    // Standing post near the plaza edge — no shell to hang a bracket on.
    const post = MeshBuilder.CreateCylinder(
      `${f.id}_signPost`,
      { diameter: 0.14, height: 2.6, tessellation: 8 },
      scene
    );
    post.parent = root;
    post.position.set(f.width * 0.28, 1.3, frontFace - 1.35);
    post.material = mats.metal;
    out.push(post);

    const glyph = MeshBuilder.CreatePlane(`${f.id}_glyph`, { width: 1.35, height: 1.35 }, scene);
    glyph.parent = root;
    glyph.position.set(f.width * 0.28, 2.55, frontFace - 1.35);
    glyph.rotation.y = Math.PI;
    glyph.material = mat;
    out.push(glyph);
    return out;
  }

  // Glyph on the perpendicular kit plate — one plane per face, because the
  // plate between them blocks a single plane from reading in both directions
  // along the ring road. Fallback (no authored plate): flat on the wall above
  // the door, the pre-kit layout.
  if (opts.bracket) {
    const b = opts.bracket;
    for (const side of [-1, 1] as const) {
      const glyph = MeshBuilder.CreatePlane(
        `${f.id}_glyph${side > 0 ? "R" : "L"}`,
        { width: 1.45, height: 1.45 },
        scene
      );
      glyph.parent = root;
      glyph.position.set(b.x + side * (b.halfThickness + 0.02), b.centreY, b.z);
      // Front face (−Z side) onto ±X so each glyph faces away from its plate.
      glyph.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      glyph.material = mat;
      out.push(glyph);
    }
  } else {
    const panel = MeshBuilder.CreatePlane(`${f.id}_glyph`, { width: 1.45, height: 1.45 }, scene);
    panel.parent = root;
    panel.position.set(0, opts.bracketY + 0.75, frontFace - 0.16);
    panel.rotation.y = Math.PI;
    panel.material = mat;
    out.push(panel);
  }

  // Larger plaza read: banner (flat) or flag (slight tilt). Hall gets a flag
  // so the monumental frontage is not just another shop sign.
  const isFlag = f.id === "hall-of-minds" || f.id === "queue-terminal";
  const bannerSize = f.marble ? 2.8 : 2.2;
  const banner = MeshBuilder.CreatePlane(
    `${f.id}_${isFlag ? "flag" : "banner"}`,
    { width: bannerSize, height: bannerSize },
    scene
  );
  banner.parent = root;
  const bannerY = Math.min(f.height - bannerSize * 0.45, opts.glassH + 2.55);
  if (isFlag) {
    banner.position.set(f.width * 0.32, bannerY, frontFace - 0.16);
    banner.rotation.y = Math.PI;
    // Slight hang tilt — still faces plaza, reads as a hanging flag.
    banner.rotation.z = 0.1;
  } else {
    banner.position.set(0, bannerY, frontFace - 0.14);
    banner.rotation.y = Math.PI;
  }
  banner.material = mat;
  out.push(banner);

  return out;
}
