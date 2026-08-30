// Scratch driver: evaluate expressions in the anim-probe page after load.
//   node probe-eval.mjs <glbUrlPath>
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
  const out = { nodes: [], bounds: null };
  for (const tn of [...scene.transformNodes, ...scene.meshes]) {
    tn.computeWorldMatrix(true);
    const p = tn.getAbsolutePosition();
    out.nodes.push({ name: tn.name, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) });
  }
  const root = scene.meshes.find((m) => m.name === "__root__") ?? scene.meshes[0];
  const b = root.getHierarchyBoundingVectors(true);
  out.bounds = { min: { x: +b.min.x.toFixed(3), y: +b.min.y.toFixed(3), z: +b.min.z.toFixed(3) }, max: { x: +b.max.x.toFixed(3), y: +b.max.y.toFixed(3), z: +b.max.z.toFixed(3) } };
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
