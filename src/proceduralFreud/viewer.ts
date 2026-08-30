/**
 * Entry for public/freud-procedural.html — a scratch lookdev page, NOT part of
 * the app build. Renders the procedurally generated + procedurally animated
 * Freud (createFreudModel.ts) in a minimal three.js scene with orbit controls.
 *
 * The game itself is BabylonJS; three is a dev-only dependency used only here.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

import {
  createFreudModel, createFreudLookDevLights, prewarmFreud,
} from './createFreudModel';
import type { FreudRig } from './freudRig';

type AnimationController = {
  actions: readonly { id: string; label: string; loop: boolean }[];
  readonly active: string;
  play(name: string): void;
  stop(): void;
  subscribe(listener: (name: string) => void): () => void;
};

const params = new URLSearchParams(window.location.search);
const frozenAnim = params.get('anim');
const frozenPhase = Number.parseFloat(params.get('phase') ?? '0');
const quality = params.get('quality') ?? 'high';

const statusEl = document.getElementById('status')!;
const infoEl = document.getElementById('info')!;
const say = (t: string): void => { statusEl.textContent = t; };

// ---------------------------------------------------------------------------
// Scene

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b10);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(1.4, 1.1, 2.1);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;

scene.add(createFreudLookDevLights());

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(6, 64),
  new THREE.MeshStandardMaterial({ color: 0x17171f, roughness: 1, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(4, 8, 0x3a3a55, 0x23233a);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.6;
grid.position.y = 0.002;
scene.add(grid);

// ---------------------------------------------------------------------------
// Model

say('decoding surfaces…');

// Prewarm first so createFreudModel attaches meshes + rig synchronously.
await prewarmFreud();
const model = createFreudModel();
scene.add(model);

const rig = model.userData.rig as FreudRig | undefined;
const tick = model.userData.tick as (dt: number) => void;
const controller = (model.userData.sculptRuntime as { animationController: AnimationController })
  .animationController;

let vertexCount = 0;
let triangleCount = 0;
model.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (mesh.isMesh && mesh.userData?.sdfSurface) {
    vertexCount += mesh.geometry.attributes.position.count;
    triangleCount += (mesh.geometry.index?.count ?? 0) / 3;
  }
});
const jointCount = rig?.bones.size ?? 0;

infoEl.textContent =
  `quality: ${quality}\n` +
  `vertices: ${vertexCount.toLocaleString('en-US')}\n` +
  `triangles: ${triangleCount.toLocaleString('en-US')}\n` +
  `rig joints: ${jointCount}\n` +
  `walk: 1.46 Hz Fourier gait · idle: 0.18 Hz breathing`;

// ---------------------------------------------------------------------------
// Animation state (viewer-side phase estimate for the status line)

const WALK_HZ = 0.62 * Math.sqrt(0.30 / 0.88) / (0.72 * (0.30 / 0.88));
const IDLE_HZ = 0.18;
let speed = 1;
let animName = controller.active;
let phaseEstimate = frozenAnim ? (Number.isFinite(frozenPhase) ? frozenPhase : 0) : 0;
// 'frozen' (the ?anim=&phase= capture hook) keeps the URL phase in the status line.
controller.subscribe((name) => { animName = name; if (name !== 'frozen') phaseEstimate = 0; });

function refreshStatus(): void {
  const label = animName === 'frozen'
    ? `frozen ${frozenAnim} @ phase ${phaseEstimate}`
    : `${animName} @ phase ${phaseEstimate.toFixed(2)}`;
  say(`${label} · ${vertexCount.toLocaleString('en-US')} verts · ${jointCount} joints · ${quality}`);
}
refreshStatus();

// ---------------------------------------------------------------------------
// Reference GLB side-by-side (bonus comparison)

let glbRoot: THREE.Object3D | null = null;
let glbLoading = false;
async function toggleGlb(button: HTMLButtonElement): Promise<void> {
  if (glbRoot) {
    glbRoot.visible = !glbRoot.visible;
    button.classList.toggle('on', glbRoot.visible);
    return;
  }
  if (glbLoading) return;
  glbLoading = true;
  say('loading reference freud.glb…');
  try {
    const ktx2 = new KTX2Loader()
      .setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/')
      .detectSupport(renderer);
    const loader = new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .setKTX2Loader(ktx2);
    const gltf = await loader.loadAsync('/assets/heroes/freud.glb');
    glbRoot = gltf.scene;
    glbRoot.name = 'freud-glb-reference';
    // Same-height comparison: scale the hero GLB to the procedural figure's 1.003 m.
    const box = new THREE.Box3().setFromObject(glbRoot);
    const nativeH = Math.max(0.001, box.max.y - box.min.y);
    glbRoot.scale.setScalar(1.003 / nativeH);
    glbRoot.position.set(0.55, -box.min.y * (1.003 / nativeH), 0);
    scene.add(glbRoot);
    button.classList.add('on');
    refreshStatus();
  } catch (error) {
    say('GLB compare failed: ' + (error as Error).message);
  } finally {
    glbLoading = false;
  }
}

// ---------------------------------------------------------------------------
// UI wiring

const animButtons: Record<string, HTMLButtonElement> = {
  idle: document.getElementById('a-idle') as HTMLButtonElement,
  walk: document.getElementById('a-walk') as HTMLButtonElement,
  stop: document.getElementById('a-stop') as HTMLButtonElement,
};
animButtons.idle.onclick = () => controller.play('idle');
animButtons.walk.onclick = () => controller.play('walk');
animButtons.stop.onclick = () => controller.stop();
controller.subscribe((name) => {
  animButtons.idle.classList.toggle('on', name === 'idle');
  animButtons.walk.classList.toggle('on', name === 'walk');
});

for (const q of ['high', 'medium', 'low']) {
  const button = document.getElementById('q-' + q) as HTMLButtonElement;
  button.classList.toggle('on', q === quality);
  button.onclick = () => {
    if (q === quality) return;
    const next = new URLSearchParams(window.location.search);
    next.set('quality', q);
    window.location.search = next.toString();
  };
}

const speedEl = document.getElementById('speed') as HTMLInputElement;
const speedVal = document.getElementById('speed-v')!;
speedEl.oninput = () => {
  speed = Number(speedEl.value);
  speedVal.textContent = speed.toFixed(2);
};

(document.getElementById('glb') as HTMLButtonElement).onclick = (ev) => {
  void toggleGlb(ev.currentTarget as HTMLButtonElement);
};

// ---------------------------------------------------------------------------
// Loop

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  tick(dt * speed);
  if (animName === 'walk') phaseEstimate = (phaseEstimate + dt * speed * WALK_HZ) % 1;
  else if (animName === 'idle') phaseEstimate = (phaseEstimate + dt * speed * IDLE_HZ) % 1;
  controls.update();
  renderer.render(scene, camera);
});
setInterval(refreshStatus, 250);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Capture hook for the puppeteer driver (tools scratch shots).
(window as unknown as { freudViewer: unknown }).freudViewer = {
  ready: true,
  model,
  controller,
  vertexCount,
  jointCount,
};
