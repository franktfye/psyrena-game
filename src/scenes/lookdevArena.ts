import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

// Tree-shaken shape builders must be imported explicitly.
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/torusBuilder";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/loaders/glTF/2.0";

import { ARENA } from "../core/budget";
// Palette and shader warmup moved to core/ when the village hub landed — both
// scenes need them, and a hub that imports its colours from the arena scene is
// how two scenes quietly become two art directions.
import { PALETTE, VILLAGE } from "../core/palette";
import { warmupShaders } from "../core/warmup";
import { trackLoad } from "../core/loadProgress";
import { applyDuskEnvironment, applyVoidStarSky } from "../core/environment";
import { buildNightmare, type NightmarePhase } from "./nightmareBoss";
import { setupArenaCombat, type ArenaCombat } from "../fight/arenaCombat";
import { isPracticeMode } from "../fight/practice";
import { awaitPartyFightStart } from "../fight/fightReadyGate";
import { arenaRejoin, clearArenaRejoin } from "../fight/rejoin";
import { closeLootPanel, reopenLastLoot } from "../ui/lootPanel";
import { startBossCountdown } from "../ui/bossCountdown";
import { sstep, fbm, createSoftRingTexture } from "../vfx/softSprites";
import { applyPipelineQuality, sceneGlowOptions } from "../core/quality";

export { PALETTE, warmupShaders };

/**
 * M1 lookdev arena.
 *
 * The point of this scene is to answer one question early: does the art
 * direction in doc 01 actually look beautiful in a browser? Build it now, in
 * M1 — not in M5. If it does not look good with one boss stand-in and a floor,
 * fourteen heroes will not rescue it.
 *
 * It doubles as the performance reference implementation. Every constraint in
 * `06-technical-architecture.md#performance-budget` is expressed here in code:
 *
 *  - FIXED arena volume (ARENA.playableExtent). Not authored per boss.
 *  - No geometry beyond ARENA.fogEnd. Fog and skybox do the environment work.
 *  - Emissive + bloom + ACES tonemapping does the "beauty" work, not polycount.
 *  - Shader warmup before first frame, so no first-cast hitch.
 */
export async function createLookdevArena(engine: AbstractEngine, heroId?: string): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = PALETTE.void;

  // ---- Atmosphere -------------------------------------------------------
  // VOID, not horizon. The fight rock floats in space: stars (LDR skybox,
  // ~9 KB KTX2) fill every direction, and fog only softens distance on the
  // rock itself — never paints a ground plane into the sky.
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = PALETTE.fog;
  scene.fogStart = ARENA.fogStart;
  scene.fogEnd = ARENA.fogEnd;

  // Dusk IBL for PBR fill (invisible — no dusk skybox). Stars are the visible
  // 360° backdrop. Applied before materials so shader warmup compiles the
  // REFLECTION variant once (villageHub precedent).
  await applyDuskEnvironment(scene, 0.55);
  await applyVoidStarSky(scene);
  const blackHole = buildBlackHole(scene);

  // Shared layout radii — floor disc, light ring, and spawn pads all hang off these.
  const FLOOR_R = ARENA.playableExtent * 0.45;
  // Spawn pads sit outside the light circle (see buildFloatingOfficeProps).
  const SPAWN_R = FLOOR_R + 3.6;

  // ---- Camera -----------------------------------------------------------
  // Orbit the boss centre. Zoom tops out at the spawn ring so you can't pull
  // past the pads into empty void; pitch stops at the horizon so the view
  // never goes under the floor.
  const camera = new ArcRotateCamera(
    "lookdev",
    -Math.PI / 2,
    Math.PI / 3.1,
    22,
    new Vector3(0, 1.5, 0),
    scene
  );
  camera.lowerRadiusLimit = 8;
  // Slightly past the pad centres so the full spawn rock still fits in frame.
  camera.upperRadiusLimit = SPAWN_R + 1.2;
  // beta = π/2 is horizontal; anything larger looks up from below the ground.
  camera.upperBetaLimit = Math.PI / 2 - 0.02;
  camera.lowerBetaLimit = 0.15; // don't slam into top-down
  camera.minZ = 0.5;
  camera.maxZ = ARENA.cameraFar; // beyond this, nothing exists
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0; // keep locked on the boss centre
  camera.attachControl(true);

  // ---- Lighting ---------------------------------------------------------
  // Two lights. A stylised emissive-led look does not need more, and every
  // extra real-time light multiplies shader permutations and draw cost.
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.35;
  ambient.diffuse = PALETTE.cyan.scale(0.4);
  ambient.groundColor = PALETTE.violet.scale(0.25);

  const key = new DirectionalLight("key", new Vector3(-0.4, -1, 0.6), scene);
  key.intensity = 1.6;
  key.diffuse = new Color3(0.75, 0.85, 1.0);

  // ---- Floor ------------------------------------------------------------
  // Round playable disc — clean cut under the cyan light ring (no square
  // corners past the circle of light). Parquet + mandala stay low-contrast
  // so telegraphs read (doc 06). FLOOR_R defined above with the camera limits.
  const floor = MeshBuilder.CreateDisc(
    "floor",
    { radius: FLOOR_R, tessellation: 96 },
    scene
  );
  floor.rotation.x = Math.PI / 2;
  const floorMat = new PBRMaterial("floorMat", scene);
  // TWO-ARG Texture — multi-arg breaks standalone KTX2 in this project.
  const parquet = new Texture("/assets/arena/parquet_albedo.ktx2", scene);
  parquet.uScale = 5;
  parquet.vScale = 5;
  floorMat.albedoTexture = parquet;
  floorMat.albedoColor = new Color3(0.55, 0.58, 0.65); // dim the bake
  floorMat.metallic = 0.35;
  floorMat.roughness = 0.42;
  floorMat.environmentIntensity = 0.45;
  floor.material = floorMat;
  floor.receiveShadows = true;
  floor.freezeWorldMatrix();

  // Mandala decal — same disc family, inset so the rim stays clean parquet.
  // Dim at rest; when the boss activates it breathes brighter until defeat.
  const mandala = MeshBuilder.CreateDisc(
    "floorMandala",
    { radius: FLOOR_R * 0.94, tessellation: 96 },
    scene
  );
  mandala.rotation.x = Math.PI / 2;
  mandala.position.y = 0.015;
  const mandalaMat = new StandardMaterial("floorMandalaMat", scene);
  mandalaMat.disableLighting = true;
  mandalaMat.diffuseColor = Color3.Black();
  const mandalaTex = new Texture("/assets/arena/mandala_emissive.ktx2", scene);
  mandalaMat.emissiveTexture = mandalaTex;
  mandalaMat.opacityTexture = mandalaTex;
  mandalaMat.opacityTexture.getAlphaFromRGB = true;
  /** Idle / defeated: barely readable underfoot. */
  const MANDALA_IDLE = 0.08;
  /** Active fight: breathe between these scales of cyan. LO drops below the
   *  idle floor and HI clears the bloom threshold, so the floor visibly
   *  lights up and dims back down. (Tuned against the REAL palette — these
   *  scales were previously authored while a reference-aliasing bug in the
   *  spawn-pad pulse was draining PALETTE.cyan to black, so anything read as
   *  "dim". With cyan restored, 0.4 already blooms hard.) */
  const MANDALA_PULSE_LO = 0.04;
  const MANDALA_PULSE_HI = 0.42;
  mandalaMat.emissiveColor = PALETTE.cyan.scale(MANDALA_IDLE);
  mandalaMat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  mandalaMat.backFaceCulling = false;
  mandala.material = mandalaMat;
  mandala.isPickable = false;
  mandala.freezeWorldMatrix();
  // 0 = idle dim, 1 = fully into the fight pulse. Eased on phase changes.
  let mandalaLive = 0;
  let mandalaTarget = 0;

  // ---- Holo ring (circle of light) — sits on the disc rim --------------------
  const holo = new StandardMaterial("holo", scene);
  holo.disableLighting = true;
  holo.emissiveColor = PALETTE.cyan;
  holo.alpha = 0.55;

  const grid = MeshBuilder.CreateTorus(
    "grid",
    { diameter: FLOOR_R * 2, thickness: 0.07, tessellation: 96 },
    scene
  );
  grid.position.y = 0.03;
  grid.material = holo;
  grid.freezeWorldMatrix();

  const bossMat = new PBRMaterial("bossMat", scene);
  bossMat.albedoColor = new Color3(0.06, 0.07, 0.12);
  bossMat.metallic = 0.9;
  bossMat.roughness = 0.22;
  bossMat.emissiveColor = PALETTE.violet.scale(0.55);

  const boss = MeshBuilder.CreateSphere("bossStandIn", { diameter: 4.5, segments: 24 }, scene);
  boss.position.y = 2.6;
  boss.material = bossMat;

  // The real boss — NIGHTMARE (docs/04-bosses.md Boss 5). Null when the
  // processed asset set is absent, in which case the sphere stand-in above
  // stays exactly as it always was.
  const nightmare = await buildNightmare(scene, ARENA.playableExtent);
  if (nightmare) {
    boss.dispose();
  }

  // Telegraph ring — the raid-vocabulary primitive from doc 02. Emissive +
  // additive is the entire effect; no texture, no particle system.
  const telegraphMat = new StandardMaterial("telegraphMat", scene);
  telegraphMat.disableLighting = true;
  telegraphMat.emissiveColor = PALETTE.warn;
  telegraphMat.alpha = 0.4;

  const telegraph = MeshBuilder.CreateDisc("telegraph", { radius: 5, tessellation: 64 }, scene);
  telegraph.rotation.x = Math.PI / 2;
  telegraph.position.y = 0.03;
  telegraph.material = telegraphMat;
  // With the real boss in, the demo telegraph disc retires — the boss module
  // drives its own P4 pulse ring, and a permanently pulsing decal under a
  // scripted fight reads as a bug.
  if (nightmare) telegraph.dispose();

  // Phase → arena ring tint + mandala glow state.
  // Mandala: idle/dead = dim; p1–p4 = pulsing bright (breathes in the tick).
  if (nightmare) {
    const ringTint: Record<NightmarePhase, Color3> = {
      idle: PALETTE.cyan.scale(0.5),
      p1: PALETTE.cyan,
      p2: VILLAGE.magenta,
      p3: PALETTE.violet,
      p4: PALETTE.warn,
      dead: new Color3(0.12, 0.1, 0.14),
    };
    nightmare.onPhase = (phase) => {
      holo.emissiveColor = ringTint[phase].clone();
      mandalaTarget = phase === "idle" || phase === "dead" ? 0 : 1;
    };
  }

  // The fight itself: player hero, action bar, boss HP, phase script, threat.
  // Takes over the boss's phase timing (setControlled inside), so it must be
  // wired AFTER the ring-tint onPhase above — it chains that handler.
  const combat = nightmare ? await setupArenaCombat(scene, nightmare, camera, heroId) : null;

  // Pre-activation countdown: the sim starts ticking its idleS the moment
  // setupArenaCombat returns, so the overlay counts down on the same
  // render-loop dt and fades out exactly as the boss engages.
  // A rejoin lands mid-fight: there is no countdown left to show.
  const rejoin = arenaRejoin();
  if (combat && !rejoin) startBossCountdown(scene, engine);

  // Fight-end drops: arenaCombat reports each attempt and handles the DOM
  // overlays; the scene's part is the 3D loot box next to the dead boss
  // (victory with a server-awarded cache only) and the return portal beside
  // it (every victory — a cacheless practice win still needs a way home;
  // defeat routes back to the village on its own). Once per arena visit.
  let lootBoxSpawned = false;
  let portalSpawned = false;
  if (combat) {
    combat.onFightEnd = (result, win) => {
      if (!win) return;
      if (!portalSpawned) {
        portalSpawned = true;
        spawnReturnPortal(scene, engine, combat);
      }
      if (!lootBoxSpawned && result?.lootBox) {
        lootBoxSpawned = true;
        spawnArenaLootBox(scene);
      }
    };
  }

  // Furniture free-floats around the boss; spawn rocks sit outside the round
  // floor and connect via short bridges (A1/A3 concept, Grok → Tripo props).
  const floaters = await buildFloatingOfficeProps(scene, FLOOR_R);

  // ---- Post pipeline ----------------------------------------------------
  // This is where "beautiful" actually comes from for this art direction.
  // Same device-tier trims as the village hub (see the note there): drop
  // MSAA and quarter the glow buffers so iOS doesn't kill the GL context;
  // the low tier goes without glow, bloom, grain and aberration.
  const glowOptions = sceneGlowOptions();
  const glow = glowOptions ? new GlowLayer("glow", scene, glowOptions) : null;
  // Slightly hotter bloom so the distant black-hole rings smear softly.
  if (glow) glow.intensity = 0.85;

  const pipeline = new DefaultRenderingPipeline("post", true, scene, [camera]);
  pipeline.fxaaEnabled = true;

  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.48;
  pipeline.bloomWeight = 0.72;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;

  // ACES tonemapping is what stops neon-on-black from clipping into flat white.
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 1.15;
  pipeline.imageProcessing.contrast = 1.25;

  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 2.2;
  pipeline.imageProcessing.vignetteColor = new Color4(0.02, 0.04, 0.09, 1);

  // Subtle grain + chromatic aberration read as "AR visor" rather than "cheap".
  // Keep both LOW: they fight the VFX readability rule in doc 05.
  pipeline.grainEnabled = true;
  pipeline.grain.intensity = 6;
  pipeline.grain.animated = true;

  pipeline.chromaticAberrationEnabled = true;
  pipeline.chromaticAberration.aberrationAmount = 8;

  applyPipelineQuality(pipeline);

  // ---- Motion -----------------------------------------------------------
  let t = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    t += dt;
    blackHole.tick(t, dt);
    for (const f of floaters) f.tick(t);

    // Mandala: ease toward active/idle, then breathe while the fight is live.
    mandalaLive += (mandalaTarget - mandalaLive) * Math.min(1, dt * 1.2);
    if (mandalaLive < 0.02) {
      mandalaMat.emissiveColor.copyFrom(PALETTE.cyan.scale(MANDALA_IDLE));
    } else {
      // Swell — lighter then darker until defeat fades it out.
      const breath =
        0.5 + 0.5 * Math.sin(t * 1.9); // 0..1, ~3.3 s full cycle
      const scale =
        MANDALA_IDLE +
        mandalaLive *
          (MANDALA_PULSE_LO + (MANDALA_PULSE_HI - MANDALA_PULSE_LO) * breath - MANDALA_IDLE);
      mandalaMat.emissiveColor.copyFrom(PALETTE.cyan.scale(scale));
    }

    if (nightmare) {
      nightmare.tick(t, dt);
      combat?.tick(t, dt);
      return;
    }
    // Stand-in boss: treat as "activated" after a short idle for lookdev.
    if (t > 8) mandalaTarget = 1;
    boss.position.y = 2.6 + Math.sin(t * 0.8) * 0.35;
    boss.rotation.y = t * 0.25;
    const pulse = 0.28 + (Math.sin(t * 2.2) * 0.5 + 0.5) * 0.3;
    telegraphMat.alpha = pulse;
    telegraph.scaling.setAll(0.85 + (Math.sin(t * 2.2) * 0.5 + 0.5) * 0.25);
  });

  // ---- Shader warmup ----------------------------------------------------
  await warmupShaders(scene);

  // ---- Party ready barrier ----------------------------------------------
  // Everything above is loaded and compiled, so THIS player could start —
  // now hold the factory until the whole party can. The countdown and the
  // sim clock both ride the scene's render observables, which stay silent
  // until this factory returns, so the boss engages simultaneously for
  // everyone. Practice runs (and solo players, via the server's `solo`
  // answer) skip the wait.
  if (combat && rejoin) {
    // Back into a fight already under way: no barrier to wait at, but the
    // party's presence session still has to be joined to see the teammates.
    clearArenaRejoin();
    // Only a `room:` session is a party fight (a solo one may still carry the room it was launched from).
    if (rejoin.key.startsWith("room:") && rejoin.roomId !== null) combat.wireParty(rejoin.roomId);
  } else if (combat && !isPracticeMode()) {
    const bootMsg = document.getElementById("boot-msg");
    const roomId = await awaitPartyFightStart((msg) => {
      if (bootMsg) bootMsg.textContent = msg;
    });
    // A real party: join its arena presence session so the teammates who just
    // cleared the same barrier are actually VISIBLE in this fight. Solo runs
    // get null and stay solo.
    if (roomId !== null) combat.wireParty(roomId);
  }

  return scene;
}

// ---------------------------------------------------------------------------
// Floating therapy-office islands (A1 / A3 concept → Grok → Tripo)
// ---------------------------------------------------------------------------

interface Floater {
  tick(t: number): void;
}

/**
 * Load a prop glb, normalise height, sole on y=0 local.
 * Returns null when the asset is missing so lookdev degrades cleanly.
 */
async function loadArenaProp(
  scene: Scene,
  url: string,
  name: string,
  targetHeight: number
): Promise<TransformNode | null> {
  try {
    const result = await trackLoad(ImportMeshAsync(url, scene));
    const root = result.meshes[0] as TransformNode;
    root.name = name;
    for (const m of result.meshes) {
      m.isPickable = false;
      m.receiveShadows = false;
      // Ember self-light so near-black wood still reads in the void.
      const mat = m.material;
      if (mat instanceof PBRMaterial && mat.albedoTexture) {
        mat.emissiveTexture = mat.albedoTexture;
        mat.emissiveColor = new Color3(0.12, 0.1, 0.14);
      }
    }
    const { min, max } = (root as AbstractMesh).getHierarchyBoundingVectors(true);
    const h = max.y - min.y || 1;
    const s = targetHeight / h;
    root.scaling.scaleInPlace(s);
    root.position.set(
      -((min.x + max.x) * 0.5) * s,
      -min.y * s,
      -((min.z + max.z) * 0.5) * s
    );
    return root;
  } catch (err) {
    console.info(`[arena] prop unavailable ${url}:`, err);
    return null;
  }
}

/**
 * The post-fight loot cache — public/assets/village/loot_box.glb, dropped on
 * the disc beside the boss's arena-centre position when a fight is won.
 *
 * Fire-and-forget like the hub's freud_book: async load, normalise to ~1 m,
 * no stand-in — on failure we log and the arena simply stays box-less. The
 * front (eye-keyhole side) faces the arena centre. Picking the box collects
 * it: the loot panel opens with the fight's result and the box disappears —
 * one cache per kill, not a re-openable prop.
 */
function spawnArenaLootBox(scene: Scene): void {
  const POS = new Vector3(2.8, 0, 2.2); // on the disc, off the boss's centre
  let root: TransformNode | null = null;

  scene.onPointerObservable.add((pi) => {
    if (pi.type !== PointerEventTypes.POINTERPICK) return;
    const picked = pi.pickInfo?.pickedMesh;
    if (root && picked && picked.isDescendantOf(root)) {
      reopenLastLoot();
      root.dispose(false, true); // collected — the box is gone
      root = null;
    }
  });

  void ImportMeshAsync("/assets/village/loot_box.glb", scene)
    .then((result) => {
      root = new TransformNode("arenaLootBox", scene);
      for (const m of result.meshes) {
        if (!m.parent) m.parent = root;
        m.isPickable = true;
        m.receiveShadows = false;
      }
      const { min, max } = (result.meshes[0] as AbstractMesh).getHierarchyBoundingVectors(true);
      const h = max.y - min.y || 1;
      const s = 1.0 / h; // ~1 m tall
      root.scaling.scaleInPlace(s);
      root.position.set(
        POS.x - ((min.x + max.x) * 0.5) * s,
        -min.y * s, // sole on the disc
        POS.z - ((min.z + max.z) * 0.5) * s
      );
      // Yaw the local +Z (the eye-keyhole front) onto the arena centre.
      root.rotation.y = Math.atan2(-POS.x, -POS.z);
    })
    .catch((err) => {
      console.info("[arena] loot box unavailable:", err);
    });
}

/**
 * The way home after a kill — a cyan ring standing in a column of light,
 * dropped on the disc beside the loot cache once the boss is dead. Same
 * interaction contract as the practice booth's exit portal so touch and
 * keyboard behave identically: tap it (tap-vs-drag gated — the ArcRotate
 * camera owns drags) or just walk into it. Deliberately NOT the hub's
 * black-hole portal look — that one means "queue for the boss", this one
 * means "go back" (practiceBooth.ts precedent).
 */
function spawnReturnPortal(scene: Scene, engine: AbstractEngine, combat: ArenaCombat): void {
  // Past the loot cache (2.8, 0, 2.2) on the same side of the boss — beside
  // it, but NOT between the south spawn and the cache: the first placement
  // tried mirroring across the boss axis, and the walk-in trigger sat right
  // on the spawn→cache path, teleporting players home before they could
  // collect. Far enough from the cache (2.8 m > the 1.6 m trigger) that
  // walking up to the box never fires the portal, and a thumb-tap can't miss.
  const POS = new Vector3(5.6, 0, 2.2);

  // Emissive kept WELL under the bloom threshold (0.48) — at full PALETTE
  // cyan the glow layer + bloom clip the ring into a white blob (verified on
  // screenshot); ~0.5 reads as the same soft glow as the spawn-pad glyphs.
  const glowMat = (name: string, scale: number, alpha: number): StandardMaterial => {
    const m = new StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor = PALETTE.cyan.scale(scale);
    m.alpha = alpha;
    return m;
  };

  const ring = MeshBuilder.CreateTorus(
    "returnPortalRing",
    { diameter: 2.4, thickness: 0.14, tessellation: 48 },
    scene
  );
  ring.position.set(POS.x, 1.5, POS.z);
  ring.rotation.x = Math.PI / 2;
  ring.material = glowMat("returnPortalRingMat", 0.55, 0.8);
  ring.isPickable = false;

  const column = MeshBuilder.CreateCylinder(
    "returnPortalFx",
    { diameter: 2.1, height: 3.0, tessellation: 24 },
    scene
  );
  column.position.set(POS.x, 1.5, POS.z);
  column.material = glowMat("returnPortalFxMat", 0.4, 0.14);
  column.isPickable = false;

  const base = MeshBuilder.CreateCylinder(
    "returnPortalBase",
    { diameter: 2.6, height: 0.12, tessellation: 32 },
    scene
  );
  base.position.set(POS.x, 0.06, POS.z);
  base.material = glowMat("returnPortalBaseMat", 0.45, 0.4);
  base.isPickable = false;

  // Invisible pick proxy — a thin torus is miserable to tap on a phone. It is
  // reached through an explicit scene.pick predicate (default picking skips
  // isVisible=false meshes), same trick as the booth's exitPortalPick.
  const pick = MeshBuilder.CreateCylinder(
    "returnPortalPick",
    { diameter: 2.6, height: 3.2, tessellation: 12 },
    scene
  );
  pick.position.set(POS.x, 1.6, POS.z);
  pick.isVisible = false;
  pick.isPickable = true;

  let leaving = false;
  const leave = (): void => {
    if (leaving) return;
    leaving = true;
    // The victory panel may still be up (player tapped the cache, then left
    // without closing) — a DOM overlay survives the scene switch, and a stale
    // VICTORY card floating in the village is exactly the popup this portal
    // exists to retire.
    closeLootPanel();
    // Deferred out of the frame ON PURPOSE: go() disposes the live scene
    // synchronously, and the proximity trigger below runs inside
    // onBeforeRenderObservable (practiceBooth.ts leave() precedent).
    queueMicrotask(() => {
      const psy = (window as unknown as { psyrena?: { go?: (id: string) => Promise<void> } })
        .psyrena;
      void psy?.go?.("village");
    });
  };

  // Tap-vs-drag gate — the ArcRotateCamera owns drags for the orbit, so only
  // a short, still press counts as a tap (hub portal / booth precedent).
  let pressX = 0;
  let pressY = 0;
  let pressAt = 0;
  scene.onPointerObservable.add((pi) => {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      pressX = scene.pointerX;
      pressY = scene.pointerY;
      pressAt = performance.now();
      return;
    }
    if (pi.type !== PointerEventTypes.POINTERUP) return;
    const dx = scene.pointerX - pressX;
    const dy = scene.pointerY - pressY;
    if (dx * dx + dy * dy > 12 * 12 || performance.now() - pressAt > 500) return;
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === pick);
    if (hit?.hit) leave();
  });

  // Spin + pulse, and the walk-in trigger — scheme-agnostic by construction.
  let t = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    t += dt;
    ring.rotation.y = t * 0.6;
    const pulse = 0.8 + Math.sin(t * 2.4) * 0.2;
    column.scaling.x = pulse;
    column.scaling.z = pulse;
    if (!leaving && Vector3.Distance(combat.heroPosition(), POS) < 1.6) leave();
  });
}

/**
 * Mindscape set dressing + spawn pads (A1/A3 concept).
 *
 *  1. Furniture free-floats and *orbits the boss* over the round floor.
 *  2. Spawn rocks sit **outside** the light circle, linked by short bridges
 *     so the disc still reads as one connected platform.
 */
async function buildFloatingOfficeProps(
  scene: Scene,
  floorR: number
): Promise<Floater[]> {
  const floaters: Floater[] = [];

  // ---- Furniture: orbit the boss (origin) --------------------------------
  // Stay inside the round floor so pieces read as fight set dressing.
  const furniture: {
    file: string;
    name: string;
    height: number;
    radius: number;
    baseY: number;
    orbitSpeed: number;
    phase: number;
    spin: number;
  }[] = [
    {
      file: "couch",
      name: "floatCouch",
      height: 1.2,
      radius: floorR * 0.48,
      baseY: 1.6,
      orbitSpeed: 0.09,
      phase: 0.0,
      spin: 0.05,
    },
    {
      file: "bookshelf",
      name: "floatBookshelf",
      height: 2.3,
      radius: floorR * 0.58,
      baseY: 2.8,
      orbitSpeed: -0.065,
      phase: 1.6,
      spin: -0.03,
    },
    {
      file: "desk",
      name: "floatDesk",
      height: 1.05,
      radius: floorR * 0.52,
      baseY: 2.1,
      orbitSpeed: 0.075,
      phase: 3.1,
      spin: 0.04,
    },
    {
      file: "clock",
      name: "floatClock",
      height: 2.5,
      radius: floorR * 0.62,
      baseY: 1.9,
      orbitSpeed: -0.05,
      phase: 4.5,
      spin: 0.02,
    },
  ];

  for (const s of furniture) {
    const root = new TransformNode(s.name, scene);
    const prop = await loadArenaProp(
      scene,
      `/assets/arena/props/${s.file}.glb`,
      `${s.name}_mesh`,
      s.height
    );
    if (prop) prop.parent = root;

    root.rotation.x = Math.sin(s.phase) * 0.5 * 0.12;
    root.rotation.z = Math.cos(s.phase) * 0.5 * 0.1;

    floaters.push({
      tick(t: number) {
        const ang = s.phase + t * s.orbitSpeed;
        const bob = Math.sin(t * 0.55 + s.phase) * 0.4;
        const r = s.radius + Math.sin(t * 0.2 + s.phase * 1.7) * 0.5;
        root.position.set(Math.cos(ang) * r, s.baseY + bob, Math.sin(ang) * r);
        root.rotation.y = ang + Math.PI * 0.5 + t * s.spin;
      },
    });
  }

  // ---- Spawn rocks: outside the light circle, bridged in -----------------
  // Portal-slab bake (assets/work/arena/spawn_portal, Civitai gpt-image-2,
  // 2026-08-06): dark chiselled stone with a glowing runic vortex pooled in
  // the middle — the pad reads as the mysterious portal the hero lands
  // through. CreateBox maps the full texture onto every face; the bake's
  // edges are near-black stone, so the thin sides read as plain dark rock.
  const spawnTex = new Texture("/assets/arena/spawn_portal.ktx2", scene);
  const spawnMat = new PBRMaterial("spawnPadMat", scene);
  spawnMat.albedoTexture = spawnTex;
  spawnMat.albedoColor = new Color3(0.85, 0.87, 0.95);
  spawnMat.metallic = 0.4;
  spawnMat.roughness = 0.7;
  // The emissive is the texture's own glow rings; 0.7 keeps the cyan under
  // the bloom threshold so the swirl glows instead of clipping to white.
  spawnMat.emissiveTexture = spawnTex;
  spawnMat.emissiveColor = new Color3(0.7, 0.7, 0.75);
  spawnMat.environmentIntensity = 0.4;

  const bridgeMat = new PBRMaterial("spawnBridgeMat", scene);
  bridgeMat.albedoColor = new Color3(0.05, 0.055, 0.08);
  bridgeMat.metallic = 0.45;
  bridgeMat.roughness = 0.55;
  bridgeMat.emissiveColor = PALETTE.cyan.scale(0.04);
  bridgeMat.environmentIntensity = 0.4;

  const spawnRimMat = new StandardMaterial("spawnRimMat", scene);
  spawnRimMat.disableLighting = true;
  // MUST clone: the tick below writes into this colour every frame, and a
  // direct reference would drain the shared PALETTE.cyan to black (which is
  // exactly what blacked out the floor mandala + holo ring for weeks).
  spawnRimMat.emissiveColor = PALETTE.cyan.clone();
  spawnRimMat.alpha = 0.75;

  const spawnGlyphMat = new StandardMaterial("spawnGlyphMat", scene);
  spawnGlyphMat.disableLighting = true;
  spawnGlyphMat.emissiveColor = PALETTE.cyan.scale(0.85);
  spawnGlyphMat.alpha = 0.5;

  const spawnPoints: Vector3[] = [];
  const SPAWN_COUNT = 5;
  // Pads sit outside the light ring; bridges span the gap.
  // SPAWN_R = floorR + 3.6 matches the camera upperRadiusLimit above.
  const SPAWN_R = floorR + 3.6;
  const BRIDGE_INNER = floorR - 0.15; // tuck under the ring slightly
  const BRIDGE_OUTER = SPAWN_R - 1.1;

  for (let i = 0; i < SPAWN_COUNT; i++) {
    const a = (i / SPAWN_COUNT) * Math.PI * 2 - Math.PI * 0.5;
    const x = Math.cos(a) * SPAWN_R;
    const z = Math.sin(a) * SPAWN_R;
    spawnPoints.push(new Vector3(x, 0, z));

    // Bridge spoke: rock plank from disc rim out to the pad.
    const bridgeLen = BRIDGE_OUTER - BRIDGE_INNER;
    const midR = (BRIDGE_INNER + BRIDGE_OUTER) * 0.5;
    const bridge = MeshBuilder.CreateBox(
      `spawnBridge${i}`,
      { width: bridgeLen, height: 0.38, depth: 1.55 },
      scene
    );
    bridge.position.set(Math.cos(a) * midR, 0.12, Math.sin(a) * midR);
    // Local +X → radial (cos a, 0, sin a) when yaw = -a.
    bridge.rotation.y = -a;
    bridge.material = bridgeMat;
    bridge.isPickable = false;
    bridge.receiveShadows = true;
    bridge.freezeWorldMatrix();

    // Thin cyan edge on the bridge so the connection reads as part of the ring.
    const bridgeTrim = MeshBuilder.CreateBox(
      `spawnBridgeTrim${i}`,
      { width: bridgeLen * 0.98, height: 0.04, depth: 1.62 },
      scene
    );
    bridgeTrim.position.set(Math.cos(a) * midR, 0.32, Math.sin(a) * midR);
    bridgeTrim.rotation.y = -a;
    bridgeTrim.material = spawnRimMat;
    bridgeTrim.isPickable = false;
    bridgeTrim.freezeWorldMatrix();

    const pad = MeshBuilder.CreateBox(
      `spawnPad${i}`,
      { width: 2.9 + (i % 2) * 0.3, height: 0.55, depth: 2.5 },
      scene
    );
    pad.position.set(x, 0.2, z);
    pad.rotation.y = -a; // long axis radial, pad faces the circle
    pad.rotation.x = ((i % 3) - 1) * 0.03;
    pad.rotation.z = ((i % 2) * 2 - 1) * 0.025;
    pad.material = spawnMat;
    pad.isPickable = false;
    pad.receiveShadows = true;
    pad.freezeWorldMatrix();

    const rim = MeshBuilder.CreateTorus(
      `spawnRim${i}`,
      { diameter: 2.5, thickness: 0.06, tessellation: 40 },
      scene
    );
    rim.position.set(x, 0.5, z);
    rim.material = spawnRimMat;
    rim.isPickable = false;
    rim.freezeWorldMatrix();

    const beacon = MeshBuilder.CreateCylinder(
      `spawnBeacon${i}`,
      { height: 0.9, diameterTop: 0.08, diameterBottom: 0.18, tessellation: 10 },
      scene
    );
    beacon.position.set(x, 0.95, z);
    beacon.material = spawnGlyphMat;
    beacon.isPickable = false;
    beacon.freezeWorldMatrix();
  }

  floaters.push({
    tick(t: number) {
      const pulse = 0.45 + (Math.sin(t * 1.8) * 0.5 + 0.5) * 0.45;
      spawnRimMat.emissiveColor.copyFromFloats(
        PALETTE.cyan.r * pulse,
        PALETTE.cyan.g * pulse,
        PALETTE.cyan.b * pulse
      );
      spawnGlyphMat.emissiveColor.copyFromFloats(
        PALETTE.cyan.r * pulse * 0.9,
        PALETTE.cyan.g * pulse * 0.9,
        PALETTE.cyan.b * pulse * 0.9
      );
    },
  });

  (scene as Scene & { spawnPoints?: Vector3[] }).spawnPoints = spawnPoints;

  return floaters;
}

/**
 * Animated black hole for the void arena — pure Babylon mesh/material work.
 *
 * Accuracy cues (cheap read of real BH silhouette):
 *  1. Pure-black event horizon (no emissive wash)
 *  2. Thin bright photon ring just outside the horizon
 *  3. Accretion disc with a HOLE (ISCO) so the sphere shows through — flattened
 *     torus + radial DynamicTexture (hot inner, Doppler crescent, violet outer)
 *  4. Soft outer haze, counter-rotating
 *
 * Partial-render fix: flat discs were frustum-culled when the camera orbit
 * left their bounding box. Every piece is `alwaysSelectAsActiveMesh` +
 * `ignoreCameraMaxZ` so orbit never chews the disc into a half-moon.
 */
function buildBlackHole(scene: Scene): { tick: (t: number, dt: number) => void } {
  const root = new TransformNode("blackHole", scene);
  // Far sky backdrop — ~2× previous distance so it no longer crowds the boss.
  // ignoreCameraMaxZ on children keeps it drawn past the arena far plane.
  root.position.set(-48, 42, -88);

  /** Horizon radius — twice the old prop (was 7 m). Photon ring ≈ 1.5×. */
  const RS = 14;
  const PHOTON_R = RS * 1.55;
  const DISC_INNER = PHOTON_R * 1.15;
  const DISC_OUTER = RS * 4.6;

  const mark = (m: Mesh): void => {
    m.parent = root;
    m.isPickable = false;
    m.receiveShadows = false;
    m.applyFog = false;
    // Critical: large flat props fail frustum tests as the camera orbits.
    m.alwaysSelectAsActiveMesh = true;
    m.ignoreCameraMaxZ = true;
    // Never freeze — root precesses every frame.
  };

  // --- 1. Event horizon: pure black, swallows light -----------------------
  const horizon = MeshBuilder.CreateSphere(
    "bhHorizon",
    { diameter: RS * 2, segments: 32 },
    scene
  );
  mark(horizon);
  const horizonMat = new StandardMaterial("bhHorizonMat", scene);
  horizonMat.disableLighting = true;
  horizonMat.diffuseColor = Color3.Black();
  horizonMat.emissiveColor = Color3.Black();
  horizonMat.specularColor = Color3.Black();
  // Keep depth so the disc hole correctly reveals this sphere.
  horizon.material = horizonMat;
  horizon.renderingGroupId = 1;

  // --- 2. Photon ring — soft gradient sprite, not a torus -------------------
  // A torus has a hard geometric silhouette no matter how dim the emissive;
  // a flat disc with a gaussian ring texture has no edge for bloom to bite on.
  const discTilt = Math.PI / 2.4;
  const photon = MeshBuilder.CreateDisc(
    "bhPhoton",
    { radius: PHOTON_R * 2.3, tessellation: 64, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  mark(photon);
  photon.rotation.x = discTilt;
  photon.position.y = 0.12;
  const photonMat = new StandardMaterial("bhPhotonMat", scene);
  photonMat.disableLighting = true;
  photonMat.backFaceCulling = false;
  // Below 1.0 so bloom smears a soft glow instead of clipping to white.
  photonMat.emissiveColor = new Color3(0.9, 0.76, 0.58);
  photonMat.diffuseColor = Color3.Black();
  photonMat.specularColor = Color3.Black();
  const photonTex = createSoftRingTexture(scene, "bhPhotonTex", 128, 1 / 2.3, 0.05, 0.1, 0.15);
  photonMat.emissiveTexture = photonTex;
  photonMat.opacityTexture = photonTex;
  photonMat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  photonMat.alpha = 0.8;
  photon.material = photonMat;
  photon.renderingGroupId = 1;
  photon.alphaIndex = 4;

  // Secondary lensing echo — wider, wispier violet veil.
  const photon2 = MeshBuilder.CreateDisc(
    "bhPhoton2",
    { radius: PHOTON_R * 2.8, tessellation: 64, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  mark(photon2);
  photon2.rotation.x = discTilt;
  photon2.position.y = 0.18;
  const photon2Mat = new StandardMaterial("bhPhoton2Mat", scene);
  photon2Mat.disableLighting = true;
  photon2Mat.backFaceCulling = false;
  photon2Mat.emissiveColor = new Color3(0.68, 0.36, 0.85);
  photon2Mat.diffuseColor = Color3.Black();
  const photon2Tex = createSoftRingTexture(scene, "bhPhoton2Tex", 128, 1.12 / 2.8, 0.09, 0.18, 0.3);
  photon2Mat.emissiveTexture = photon2Tex;
  photon2Mat.opacityTexture = photon2Tex;
  photon2Mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  photon2Mat.alpha = 0.5;
  photon2.material = photon2Mat;
  photon2.renderingGroupId = 1;
  photon2.alphaIndex = 5;

  // --- 3. Accretion disc: soft radial glow + transparent ISCO -------------
  const disc = MeshBuilder.CreateDisc(
    "bhDisc",
    { radius: DISC_OUTER, tessellation: 80, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  mark(disc);
  disc.rotation.x = discTilt;
  const discMat = new StandardMaterial("bhDiscMat", scene);
  discMat.disableLighting = true;
  discMat.backFaceCulling = false;
  discMat.diffuseColor = Color3.Black();
  discMat.specularColor = Color3.Black();
  const discTex = createAccretionTexture(scene, 256);
  discMat.emissiveTexture = discTex;
  discMat.opacityTexture = discTex;
  // Keep the bake under bloom-clip range — a glowing veil, not a searchlight.
  discMat.emissiveColor = new Color3(0.8, 0.7, 0.9);
  disc.material = discMat;
  disc.renderingGroupId = 1;
  disc.alphaIndex = 2;
  discMat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;

  // Hot inner ISCO band — same soft-ring-sprite treatment as the photon ring
  // (the old squashed torus kept a hard silhouette even at low alpha).
  const inner = MeshBuilder.CreateDisc(
    "bhInner",
    { radius: DISC_INNER * 1.7, tessellation: 64, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  mark(inner);
  inner.rotation.x = discTilt;
  inner.position.y = 0.06;
  const innerMat = new StandardMaterial("bhInnerMat", scene);
  innerMat.disableLighting = true;
  innerMat.backFaceCulling = false;
  innerMat.diffuseColor = Color3.Black();
  innerMat.emissiveColor = new Color3(0.95, 0.72, 0.46);
  const innerTex = createSoftRingTexture(scene, "bhInnerTex", 128, 0.58, 0.1, 0.22, 0.35);
  innerMat.emissiveTexture = innerTex;
  innerMat.opacityTexture = innerTex;
  innerMat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  innerMat.alpha = 0.7;
  inner.material = innerMat;
  inner.renderingGroupId = 1;
  inner.alphaIndex = 3;

  // --- 4. Outer haze — big soft lensing bloom shell -----------------------
  const haze = MeshBuilder.CreateDisc(
    "bhHaze",
    { radius: DISC_OUTER * 1.45, tessellation: 48, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  mark(haze);
  haze.rotation.x = discTilt;
  haze.position.y = -0.12;
  const hazeMat = new StandardMaterial("bhHazeMat", scene);
  hazeMat.disableLighting = true;
  hazeMat.backFaceCulling = false;
  hazeMat.disableDepthWrite = true; // soft stack, no hard silhouette edge
  hazeMat.diffuseColor = Color3.Black();
  hazeMat.emissiveColor = new Color3(0.75, 0.35, 1.1);
  // An untextured disc is a uniform fill with a razor rim — the wide-sigma
  // ring bake fades it out both toward the centre and the edge.
  const hazeTex = createSoftRingTexture(scene, "bhHazeTex", 128, 0.42, 0.3, 0.3, 0.3);
  hazeMat.emissiveTexture = hazeTex;
  hazeMat.opacityTexture = hazeTex;
  hazeMat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  hazeMat.alpha = 0.3;
  haze.material = hazeMat;
  haze.renderingGroupId = 0;
  haze.alphaIndex = 1;

  // Second softer veil for a more diffuse glow.
  const haze2 = MeshBuilder.CreateDisc(
    "bhHaze2",
    { radius: DISC_OUTER * 1.85, tessellation: 40, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );
  mark(haze2);
  haze2.rotation.x = discTilt;
  haze2.position.y = -0.2;
  const haze2Mat = new StandardMaterial("bhHaze2Mat", scene);
  haze2Mat.disableLighting = true;
  haze2Mat.backFaceCulling = false;
  haze2Mat.disableDepthWrite = true;
  haze2Mat.diffuseColor = Color3.Black();
  haze2Mat.emissiveColor = new Color3(0.55, 0.25, 0.9);
  const haze2Tex = createSoftRingTexture(scene, "bhHaze2Tex", 128, 0.4, 0.3, 0.32, 0.45);
  haze2Mat.emissiveTexture = haze2Tex;
  haze2Mat.opacityTexture = haze2Tex;
  haze2Mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  haze2Mat.alpha = 0.16;
  haze2.material = haze2Mat;
  haze2.renderingGroupId = 0;
  haze2.alphaIndex = 0;

  // alwaysSelectAsActiveMesh is the real culling fix; inflate spheres too.
  const boundR = DISC_OUTER * 1.4;
  for (const m of root.getChildMeshes(false)) {
    m.refreshBoundingInfo(false, false);
    const bi = m.getBoundingInfo();
    bi.boundingSphere.radius = Math.max(bi.boundingSphere.radius, boundR);
    bi.boundingSphere.radiusWorld = Math.max(bi.boundingSphere.radiusWorld, boundR);
  }

  let spin = 0;
  let precess = 0;

  return {
    tick(t: number, dt: number) {
      spin += dt;
      precess += dt * 0.05;
      // Keplerian-ish differential rotation: inner faster. (Slower than the
      // old torus days — the wispy ring textures make the motion visible.)
      disc.rotation.y = spin * 0.22;
      inner.rotation.y = -spin * 0.16;
      haze.rotation.y = -spin * 0.04;
      photon.rotation.y = spin * 0.03;
      photon2.rotation.y = -spin * 0.02;
      // Slow precession of the whole system (inclined disc wobble).
      root.rotation.y = precess;
      root.rotation.z = Math.sin(t * 0.09) * 0.06;
      root.position.y = 42 + Math.sin(t * 0.07) * 1.6;
      // Photon-ring pulse — gentle swell around the soft base levels set at
      // build time; peaks stay ~1.0 so bloom smears a glow instead of clipping.
      const breath = 0.85 + (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.25;
      photonMat.emissiveColor.set(0.9 * breath, 0.76 * breath, 0.58 * breath);
      photon2Mat.emissiveColor.set(0.68 * breath, 0.36 * breath, 0.85 * breath);
      const hot = 0.8 + (Math.sin(t * 2.2 + 0.7) * 0.5 + 0.5) * 0.25;
      innerMat.emissiveColor.set(0.95 * hot, 0.72 * hot, 0.46 * hot);
      discMat.emissiveColor.set(0.72 + 0.1 * breath, 0.62 + 0.08 * breath, 0.8 + 0.1 * breath);
      const veil = 0.22 + (Math.sin(t * 0.9) * 0.5 + 0.5) * 0.14;
      hazeMat.alpha = veil;
      haze2Mat.alpha = veil * 0.55;
    },
  };
}

/**
 * Radial accretion-disc texture: feathered core, hot ISCO region, Doppler
 * crescent, violet falloff — with noise wisps so the body reads as gas cloud
 * rather than painted bands. 256² DynamicTexture — drawn once, tiny VRAM.
 */
function createAccretionTexture(scene: Scene, size: number): DynamicTexture {
  const tex = new DynamicTexture(
    "bhAccretionTex",
    { width: size, height: size },
    scene,
    false
  );
  const ctx = tex.getContext();
  // Seed opaque buffer then write pixels (ICanvas has get/putImageData, not create).
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 at centre → 1 at edge
      const ang = Math.atan2(dy, dx);
      const i = (y * size + x) * 4;

      // Feathered hole and a wide outer falloff — no hard radius anywhere.
      let a = sstep(0.2, 0.4, r) * (1 - sstep(0.5, 0.98, r));
      // Gas wisps: noise breaks the smooth ramps into cloud body.
      a *= 0.5 + 0.6 * fbm(dx * 5.5 + 3.7, dy * 5.5 - 1.3);

      // Temperature by radius: white-hot → orange → magenta → violet
      const t = Math.min(1, Math.max(0, (r - 0.25) / 0.6));
      let cr: number, cg: number, cb: number;
      if (t < 0.25) {
        const u = t / 0.25;
        cr = 255;
        cg = 245 - u * 80;
        cb = 220 - u * 140;
      } else if (t < 0.55) {
        const u = (t - 0.25) / 0.3;
        cr = 255;
        cg = 165 - u * 90;
        cb = 80 - u * 20;
      } else {
        const u = (t - 0.55) / 0.45;
        cr = 220 - u * 100;
        cg = 75 - u * 40;
        cb = 140 + u * 40;
      }

      // Doppler / beaming: one side brighter (approaching limb) — gentle.
      const beam = 0.7 + 0.3 * Math.max(0, Math.cos(ang - 0.4));
      cr = Math.min(255, cr * beam * 1.05);
      cg = Math.min(255, cg * beam);
      cb = Math.min(255, cb * (0.85 + 0.15 * beam));

      // Mild spiral density for "flow" when spinning.
      const spiral = 0.9 + 0.1 * Math.sin(ang * 3 - r * 10);
      a *= spiral;
      a = Math.min(1, Math.max(0, a));

      data[i] = cr | 0;
      data[i + 1] = cg | 0;
      data[i + 2] = cb | 0;
      data[i + 3] = (a * 255) | 0;
    }
  }

  ctx.putImageData(img, 0, 0);
  tex.hasAlpha = true;
  tex.update(true);
  return tex;
}
