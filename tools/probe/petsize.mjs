// Scratch driver: measure a pet's skinned bounding box at rest vs across its
// walk frames, to quantify the rest-pose/clip-pose size mismatch.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petsize.mjs pet_corgi.glb
import puppeteer from "puppeteer-core";

const FILE = process.argv[2] ?? "pet_corgi.glb";
const URL = (process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/").replace(/\/$/, "");

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
    "--window-size=900,900",
  ],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${URL}/tools/probe/petprobe.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.probeReady === true, { timeout: 60000 });

const out = await page.evaluate(async (file) => {
  const clips = await window.probeLoad(file, 0);
  const s = window.__scene ?? null;
  // probeLoad keeps its state private; reach the loaded model via the scene
  // hanging off the engine list in the page module — instead just re-measure
  // through Babylon's per-mesh API on all meshes under probe_root.
  const scene = window.probeSceneRef();
  const root = scene.transformNodes.find((n) => n.name === "probe_root");
  const meshes = root.getChildMeshes().filter((m) => m.getTotalVertices?.() > 0);
  const skel = scene.skeletons[scene.skeletons.length - 1] ?? null;
  const groups = scene.animationGroups;
  const measure = () => {
    skel?.computeAbsoluteMatrices(true);
    skel?.prepare(true);
    let min = null,
      max = null;
    for (const m of meshes) {
      m.refreshBoundingInfo({ applySkeleton: true });
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      const mn = bb.minimumWorld,
        mx = bb.maximumWorld;
      if (!min) {
        min = { x: mn.x, y: mn.y, z: mn.z };
        max = { x: mx.x, y: mx.y, z: mx.z };
      } else
        for (const k of ["x", "y", "z"]) {
          min[k] = Math.min(min[k], mn[k]);
          max[k] = Math.max(max[k], mx[k]);
        }
    }
    return {
      h: +(max.y - min.y).toFixed(4),
      lx: +(max.x - min.x).toFixed(4),
      lz: +(max.z - min.z).toFixed(4),
    };
  };
  const result = { clips, rest: null, frames: {} };
  for (const g of groups) g.stop();
  skel?.returnToRest();
  result.rest = measure();
  for (const g of groups) {
    g.start(false);
    g.pause();
    const frames = [];
    for (let i = 0; i <= 10; i++) {
      const f = g.from + ((g.to - g.from) * i) / 10;
      g.goToFrame(f);
      frames.push({ f: +f.toFixed(1), ...measure() });
    }
    g.stop();
    result.frames[g.name] = frames;
  }
  return result;
}, FILE);
console.log(JSON.stringify(out, null, 1));
await browser.close();
