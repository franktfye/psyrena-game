import * as THREE from 'three';

import { decodeSurfaces, type DecodedSurface, type EncodedNode } from './surfaceCodec';
import {
  buildFreudRig, captureRest, decodeSkin, poseIdle, poseWalk,
  type FreudRig, type FreudSkin, type RestPose,
} from './freudRig';

/**
 * FREUD — a stylized old-man game character, reconstructed as code-only TypeScript from a GLB
 * measurement instrument (a Tripo T-pose export: one merged mesh, 26,538 vertices, skinCount 1,
 * animationCount 0 -- the skin is NOT carried over; this phase builds the surface only, rigging is a
 * later phase).
 *
 * WHAT THIS FILE IS. The whole figure is one GLB node (a single-region-merged-asset), served entirely
 * by the encoded implicit surfaces in surfaceData.ts: a signed-distance field splatted from the
 * node's own point cloud against its NORMAL attribute, contoured by Surface Nets at a measured 2.0 mm
 * cell, then encoded at 9.09 bytes per vertex (see surfaceCodec.ts for the stream layout). Nothing is
 * fetched at runtime -- no .glb, no .bin, no texture image. Vertex colours are the GLB's embedded
 * baseColorTexture sampled per vertex and decoded sRGB -> linear; roughness/metalness are the GLB's
 * declared factors times the metallicRoughnessTexture, carried as measured medians.
 *
 * WHAT IT IS NOT. The cross-section loft exists (crossSections.ts, 133 rings at a measured 4-spoke
 * budget -- the source mesh is sparse, so the loft is a coarse floor only) but is not wired as a
 * fallback here. Rigging and animation live in freudRig.ts: a 21-joint skeleton measured off this
 * surface, geodesic-baked weights (skinData*.ts), a Fourier-fit walk and a gentle idle, exposed
 * through userData.rig / userData.tick and the showcase's animation controls.
 */

export type FreudOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Render the surface as wireframe. Useful when reviewing the contour rather than the bake. */
  wireframe?: boolean;
};

export type FreudQuality = 'high' | 'medium' | 'low';

function readFreudQuality(): FreudQuality {
  if (typeof window === 'undefined') return 'high';
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get('quality') ?? params.get('lod') ?? '').toLowerCase();
  if (raw === 'medium' || raw === 'x2') return 'medium';
  if (raw === 'low' || raw === 'x3') return 'low';
  return 'high';
}

const FREUD_QUALITY = readFreudQuality();

type FreudSurfaceData = {
  SURFACE_LEVEL: string;
  SURFACE_NODES: readonly EncodedNode[];
  SURFACE_STREAM: string;
};

type FreudSkinData = {
  SKIN_VERTEX_COUNT: number;
  SKIN_STREAM: string;
};

/**
 * Keep the three encoded levels in separate Vite chunks. High (2.0 mm cell) is the default; Medium is
 * 4.0 mm and Low is 6.0 mm, so choosing one avoids downloading and parsing the high-resolution stream.
 * Each level has its own baked geodesic skinning stream -- the weights are per-vertex, so they are
 * not portable across levels.
 */
function loadFreudSurfaceData(): Promise<FreudSurfaceData> {
  if (FREUD_QUALITY === 'medium') return import('./surfaceDataMedium');
  if (FREUD_QUALITY === 'low') return import('./surfaceDataLow');
  return import('./surfaceData');
}

function loadFreudSkinData(): Promise<FreudSkinData> {
  if (FREUD_QUALITY === 'medium') return import('./skinDataMedium');
  if (FREUD_QUALITY === 'low') return import('./skinDataLow');
  return import('./skinData');
}

let decodedSurfaces: DecodedSurface[] | null = null;
let decodedSkin: FreudSkin | null = null;
let decodePromise: Promise<void> | null = null;

export function prewarmFreud(): Promise<void> {
  decodePromise ??= (async () => {
    /**
     * NOTHING IS FETCHED. The surfaces arrive inside the bundle as an encoded stream and are rebuilt
     * here; decoding ~430k vertices takes long enough to drop a frame, so it stays async and every
     * caller already handles the promise. The skin weights are baked offline (see freudRig.ts) and
     * decode alongside.
     */
    const [surfaceData, skinData] = await Promise.all([loadFreudSurfaceData(), loadFreudSkinData()]);
    decodedSurfaces = decodeSurfaces(surfaceData.SURFACE_STREAM, surfaceData.SURFACE_NODES);
    decodedSkin = decodeSkin(skinData.SKIN_STREAM, skinData.SKIN_VERTEX_COUNT);
  })();
  return decodePromise;
}

function surfaceMeshes(options: FreudOptions): THREE.Mesh[] {
  if (!decodedSurfaces) return [];
  return decodedSurfaces.map((surface) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(surface.colour, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(surface.index, 1));
    // Normals are not carried in the stream -- they follow from the rebuilt triangles.
    geometry.computeVertexNormals();
    // `color` must stay white or it tints the bake; roughness and metalness are the GLB's own
    // measured medians for this node, read back out of the emitted material record.
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: new THREE.Color(1, 1, 1),
      roughness: surface.material?.roughnessMedian ?? 0.9,
      metalness: surface.material?.metalnessMedian ?? 0.0,
      side: surface.material?.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      wireframe: options.wireframe ?? false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = surface.region;
    mesh.userData.region = surface.region;
    mesh.userData.moduleNode = surface.node;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.userData.sdfSurface = {
      method: 'signed distance field from the GLB point cloud, contoured with Surface Nets',
      cellMillimetres: surface.cellMillimetres,
      vertices: surface.position.length / 3,
      triangles: surface.index.length / 3,
    };
    return mesh;
  });
}

export function createFreudModel(options: FreudOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'freud-procedural';
  /**
   * The GLB's long horizontal axis is Z (the T-pose arm span: figure size is 0.227 x 1.000 x 0.417 m),
   * so the source faces +-X. Rotating -pi/2 about Y lays the span along X and puts the FACE toward
   * +Z, the showcase's front -- confirmed against the captured az=0 view (monocle and beard read
   * front-on there; +pi/2 presented the figure's back). The rig in freudRig.ts works in the source
   * frame and this rotation carries the animated result to world unchanged.
   */
  root.rotation.y = -Math.PI / 2;

  /**
   * ANIMATION -- the one part the GLB could not supply under the pipeline contract: its 53-joint
   * skin is not copied, so the skeleton, weights and poses are computed in freudRig.ts from the
   * built model's own measurements. The rig is bound when the surfaces land: the weights are baked
   * offline and decode in milliseconds, so unlike the girl-character there is no expensive first-play
   * weight computation to defer.
   *
   * `tick` is registered up front and not on first play because the viewer collects tickers ONCE,
   * when it starts; registering later would leave the model frozen.
   */
  let rig: FreudRig | null = null;
  let rest: RestPose | null = null;
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  /**
   * `?anim=walk|idle&phase=0..1` freezes a single pose at build time. This is the deterministic-capture
   * hook the gait-phase screenshots use: capture mode strips `tick`, so the pose must be applied here,
   * once, and `active` is parked on 'frozen' so the idle never overwrites it.
   */
  const frozenAnim = params.get('anim');
  const frozenPhase = Number.parseFloat(params.get('phase') ?? '0');
  let active = 'idle';
  let phase = 0;
  const listeners = new Set<(name: string) => void>();
  const notify = (): void => { for (const l of listeners) l(active); };
  const applyRestLike = (): void => {
    if (!rig || !rest) return;
    for (const [boneName, bone] of rig.bones) {
      const q = rest.get(boneName);
      if (q) bone.quaternion.copy(q);
    }
    rig.root.position.y = (rig.root.userData.restY as number | undefined) ?? rig.root.position.y;
    rig.root.updateMatrixWorld(true);
  };
  const animationController = {
    actions: [
      { id: 'walk', label: 'Walk', loop: true },
      { id: 'idle', label: 'Idle', loop: true },
    ] as const,
    get active(): string { return active; },
    play(name: string): void {
      if (!rig) return;
      active = name;
      phase = 0;
      notify();
    },
    stop(): void {
      active = 'idle';
      phase = 0;
      applyRestLike();
      notify();
    },
    subscribe(listener: (name: string) => void): () => void {
      listeners.add(listener);
      listener(active);
      return () => listeners.delete(listener);
    },
  };

  /**
   * Cycles per second. The girl-character strolls at 0.62 m/s over a 0.72 m stride (0.86 Hz) on
   * 0.88 m legs; this figure's legs measure 0.30 m (hip joint y 0.30), and Froude scaling -- walk
   * speed goes with the square root of leg length -- gives 0.62*sqrt(0.30/0.88) = 0.36 m/s over a
   * stride of 0.72*(0.30/0.88) = 0.25 m, i.e. 1.46 Hz.
   */
  const WALK_HZ = 0.62 * Math.sqrt(0.30 / 0.88) / (0.72 * (0.30 / 0.88));
  root.userData.tick = (dt: number): void => {
    if (!rig || !rest) return;
    if (active === 'walk') {
      phase = (phase + dt * WALK_HZ) % 1;
      poseWalk(rig, rest, phase);
    } else if (active === 'idle') {
      phase = (phase + dt * 0.18) % 1;
      poseIdle(rig, rest, phase);
    }
    // 'frozen' (the capture hook) intentionally does nothing: the pose applied at build time stays.
  };

  const attach = (): void => {
    for (const mesh of surfaceMeshes(options)) root.add(mesh);
    if (decodedSkin) {
      rig = buildFreudRig(root, decodedSkin);
      if (rig) {
        rest = captureRest(rig);
        root.userData.rig = rig;
        if (frozenAnim === 'walk') {
          active = 'frozen';
          poseWalk(rig, rest, Number.isFinite(frozenPhase) ? frozenPhase : 0);
        } else if (frozenAnim === 'idle') {
          active = 'frozen';
          poseIdle(rig, rest, Number.isFinite(frozenPhase) ? frozenPhase : 0);
        }
      }
    }
  };
  if (decodedSurfaces) attach();
  else {
    void prewarmFreud().then(attach).catch((error: unknown) => {
      // Say so rather than rendering an empty stage: this demo has no loft fallback wired yet.
      console.error('[freud] implicit surfaces unavailable; demo will be empty:', error);
    });
  }

  /**
   * Three measured display-quality levels, each a complete Surface Nets reconstruction with its own
   * baked skin stream. Switching reloads with `?quality=` (the viewer handles the navigation).
   *
   *     mode    vertices    triangles
   *     High    428,110     866,148
   *     Medium  144,338     291,824
   *     Low      65,735     133,900
   */
  const detailLevels = {
    current: FREUD_QUALITY,
    options: [
      { id: 'high', label: 'High',
        note: '866K triangles · 2.0 mm cell · geodesic-skinned walk + idle' },
      { id: 'medium', label: 'Medium',
        note: '292K triangles · 4.0 mm cell · geodesic-skinned walk + idle' },
      { id: 'low', label: 'Low',
        note: '134K triangles · 6.0 mm cell · geodesic-skinned walk + idle' },
    ],
  } as const;

  root.userData.sculptRuntime = {
    animationController,
    detailLevels,
    regions: ['figure'],
    figureHeight: 1.003,
    provenance:
      'surface: SDF splat of the GLB node 53 point cloud, Surface Nets at a 2.0 mm cell; rig: 21 '
      + 'joints measured off the built surface, geodesic voxel skinning baked offline, Fourier-fit '
      + 'sagittal gait verified by forward kinematics -- the GLB skin is not copied',
    limitations: [
      'the source mesh is sparse (26,538 vertices), so the SDF surface carries documented dimpling '
        + 'and small holes; the skinning seals a one-voxel shell over them before voxel binding',
      'arms hang inside wide coat sleeves, so shoulder swing is clamped to a few degrees -- beyond '
        + 'that the 2 mm sleeve surface folds under linear blend skinning',
      'the coat is a stiff shell: the walk bends hips and knees below the hem, but the coat itself '
        + 'rides the pelvis rather than draping over each leg',
    ],
  };
  return root;
}

export function createFreudLookDevLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'freud-lookdev';
  lights.add(new THREE.HemisphereLight(0xf2f4f8, 0x14100e, 0.58));
  const key = new THREE.DirectionalLight(0xfff4e8, 0.62);
  key.position.set(1.6, 3.0, 2.6);
  key.castShadow = true;
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.42);
  fill.position.set(-2.2, 1.4, 1.2);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xffd9a8, 0.26);
  rim.position.set(-0.8, 2.0, -3.0);
  lights.add(rim);
  return lights;
}
