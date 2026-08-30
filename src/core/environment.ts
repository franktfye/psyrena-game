import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { EquiRectangularCubeTexture } from "@babylonjs/core/Materials/Textures/equiRectangularCubeTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

import { trackLoad } from "./loadProgress";

/**
 * Image-based lighting + painted 360° skyboxes.
 *
 * IBL probes (`day.hdr` / `dusk.hdr`) stay small. The visible sky is a
 * Grok-painted equirect PNG converted at load time to a **cubemap**
 * (`EquiRectangularCubeTexture`) and sampled with `SKYBOX_MODE` — the same
 * path as `createDefaultSkybox`.
 *
 * Why cubemap, not FIXED_EQUIRECTANGULAR on the box:
 *   Equirect sampling on a skybox cube has a permanent U=0/1 meridian. Edge
 *   blending the PNG helps but mip filtering still draws a hairline. A real
 *   cubemap has no azimuth wrap — each face is continuous with its neighbours
 *   at the edges, so the join line goes away.
 */

/** Load equirect PNG → GPU cubemap (size = face resolution). */
function loadEquirectCube(
  url: string,
  scene: Scene,
  faceSize: number
): Promise<EquiRectangularCubeTexture> {
  return trackLoad(
    Promise.race([
    new Promise<EquiRectangularCubeTexture>((resolve, reject) => {
      const tex = new EquiRectangularCubeTexture(
        url,
        scene,
        faceSize,
        false, // generate mips
        true, // gammaSpace — StandardMaterial skybox expects gamma
        () => resolve(tex),
        (message, exception) =>
          reject(new Error(message ?? (exception ? String(exception) : "cube sky load failed"))),
        true // supersample input for cleaner face edges
      );
    }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${url} cube convert timed out`)), 20_000)
      ),
    ])
  );
}

/**
 * Official createDefaultSkybox pattern: cube mesh + cubemap reflectionTexture
 * in SKYBOX_MODE + infiniteDistance + ignoreCameraMaxZ.
 */
function buildCubeSkyBox(scene: Scene, name: string, cube: BaseTexture): AbstractMesh {
  // Force skybox projection (EquiRectangularCubeTexture defaults may differ).
  cube.coordinatesMode = Texture.SKYBOX_MODE;

  const box = CreateBox(name, { size: 1000 }, scene) as Mesh;
  const mat = new StandardMaterial(`${name}Mat`, scene);
  mat.backFaceCulling = false;
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.reflectionTexture = cube;
  mat.fogEnabled = false;
  box.material = mat;

  box.infiniteDistance = true;
  box.ignoreCameraMaxZ = true;
  box.isPickable = false;
  box.receiveShadows = false;
  box.applyFog = false;
  box.alwaysSelectAsActiveMesh = true;

  return box;
}

/** Daylight hub: day IBL probe + Grok-painted ocean/sky panorama. */
export async function applyDayEnvironment(scene: Scene, intensity = 1): Promise<void> {
  try {
    const env = await trackLoad(
      Promise.race([
        new Promise<HDRCubeTexture>((resolve, reject) => {
          const tex = new HDRCubeTexture(
            "/env/day.hdr",
            scene,
            128,
            false,
            true,
            false,
            true,
            () => resolve(tex),
            (message) => reject(new Error(message ?? "unknown"))
          );
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("day.hdr load timed out after 15s")), 15_000)
        ),
      ])
    );
    scene.environmentTexture = env;
    scene.environmentIntensity = intensity;
  } catch (err) {
    console.warn("[env] day.hdr unavailable, continuing without IBL:", err);
    scene.environmentTexture?.dispose();
    scene.environmentTexture = null;
  }

  try {
    // 512² faces: looked-at sky; still far cheaper than shipping 6 authored faces.
    const cube = await loadEquirectCube("/env/village_sky.png", scene, 512);
    buildCubeSkyBox(scene, "skyBox", cube);
    console.info("[env] village sky cubemap ready");
  } catch (err) {
    console.warn("[env] village sky panorama unavailable:", err);
  }
}

/** Dusk IBL probe only. */
export async function applyDuskEnvironment(scene: Scene, intensity = 1): Promise<void> {
  try {
    await trackLoad(
      new Promise<void>((resolve, reject) => {
        const env = new HDRCubeTexture(
          "/env/dusk.hdr",
          scene,
          128,
          false,
          true,
          false,
          true,
          () => resolve(),
          (message) => reject(new Error(message ?? "unknown"))
        );
        scene.environmentTexture = env;
        scene.environmentIntensity = intensity;
      })
    );
  } catch (err) {
    console.warn("[env] dusk.hdr unavailable, continuing without IBL:", err);
    scene.environmentTexture?.dispose();
    scene.environmentTexture = null;
  }
}

/** Boss void: Grok-painted starfield/nebula as cubemap (no horizon). */
export async function applyVoidStarSky(scene: Scene): Promise<AbstractMesh | null> {
  try {
    const cube = await loadEquirectCube("/env/void_sky.png", scene, 512);
    const mesh = buildCubeSkyBox(scene, "voidSkyBox", cube);
    console.info("[env] void sky cubemap ready");
    return mesh;
  } catch (err) {
    console.warn("[env] void sky panorama unavailable:", err);
    return null;
  }
}
