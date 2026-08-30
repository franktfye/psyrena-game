// Scratch driver: high-precision bounds + head/tail world Z via anim-probe.html.
//   node probe-measure.mjs <glbUrlPath>
import puppeteer from "puppeteer-core";

const FILE = process.argv[2];
const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5199";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`${BASE}/anim-probe.html?file=${encodeURIComponent(FILE)}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__READY__, { timeout: 60000 });
const info = await page.evaluate(() => {
  const scene = BABYLON.Engine.Instances[0].scenes[0];
  const root = scene.meshes.find((m) => m.name === "__root__") ?? scene.meshes[0];
  const b = root.getHierarchyBoundingVectors(true);
  const out = {
    bounds: { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } },
    size: { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z },
    joints: {},
    clips: scene.animationGroups.map((g) => g.name),
  };
  for (const tn of [...scene.transformNodes, ...scene.meshes]) {
    const n = tn.name.toLowerCase();
    if (n.includes("head") || n.includes("tail") || n.includes("neck") || n.includes("hips")) {
      tn.computeWorldMatrix(true);
      const p = tn.getAbsolutePosition();
      out.joints[tn.name] = { x: p.x, y: p.y, z: p.z };
    }
  }
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
