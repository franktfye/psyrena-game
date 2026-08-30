// Scratch driver: TRUE skinned bounds (CPU-applied skeleton) of Druzhok's
// idle at rest vs walk over the cycle — bounding-info bboxes are
// pose-independent for skinned meshes, so this is the only honest measure.
//   node probe-skinned.mjs
import puppeteer from "puppeteer-core";

const BASE = process.env.PROBE_BASE ?? "http://127.0.0.1:5199";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`${BASE}/anim-probe.html?file=/assets/village/pet_druzhok_idle.glb`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__READY__, { timeout: 60000 });

const info = await page.evaluate(async () => {
  const scene = BABYLON.Engine.Instances[0].scenes[0];
  const measure = (meshes) => {
    let min = null, max = null;
    for (const m of meshes) {
      if (!m.getTotalVertices?.() || !m.getTotalVertices()) continue;
      m.refreshBoundingInfo(true); // applySkeleton: CPU-skin the positions
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      const mn = bb.minimumWorld, mx = bb.maximumWorld;
      if (!min) { min = { x: mn.x, y: mn.y, z: mn.z }; max = { x: mx.x, y: mx.y, z: mx.z }; }
      else {
        min.x = Math.min(min.x, mn.x); min.y = Math.min(min.y, mn.y); min.z = Math.min(min.z, mn.z);
        max.x = Math.max(max.x, mx.x); max.y = Math.max(max.y, mx.y); max.z = Math.max(max.z, mx.z);
      }
    }
    return { h: +(max.y - min.y).toFixed(4), l: +(max.z - min.z).toFixed(4), w: +(max.x - min.x).toFixed(4), minY: +min.y.toFixed(4), maxY: +max.y.toFixed(4) };
  };

  const out = {};
  {
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", "/assets/village/", "pet_druzhok_idle.glb", scene);
    scene.render();
    out.idle_rest = measure(res.meshes);
    for (const m of res.meshes) m.dispose();
  }
  {
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", "/assets/village/", "pet_druzhok_walk.glb", scene);
    for (const g of res.animationGroups) g.stop();
    scene.render();
    out.walk_rest = measure(res.meshes);
    const g = res.animationGroups[0];
    const samples = [];
    let agg = null;
    g.start(true, 1.0);
    for (let t = 0; t < 1.0; t += 0.1) {
      g.goToFrame(g.from + (g.to - g.from) * t);
      scene.render();
      const m = measure(res.meshes);
      samples.push({ t: +t.toFixed(1), ...m });
      if (!agg) agg = { hMin: m.h, hMax: m.h, minYmin: m.minY, minYmax: m.minY, maxYmin: m.maxY, maxYmax: m.maxY };
      else {
        agg.hMin = Math.min(agg.hMin, m.h); agg.hMax = Math.max(agg.hMax, m.h);
        agg.minYmin = Math.min(agg.minYmin, m.minY); agg.minYmax = Math.max(agg.minYmax, m.minY);
        agg.maxYmin = Math.min(agg.maxYmin, m.maxY); agg.maxYmax = Math.max(agg.maxYmax, m.maxY);
      }
    }
    g.stop();
    out.walk_cycle = agg;
    out.walk_samples = samples;
    for (const m of res.meshes) m.dispose();
  }
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
