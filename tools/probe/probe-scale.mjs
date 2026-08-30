// Scratch driver: replicate petFollower.loadModel's measure-then-stop sequence
// for both Druzhok models and report the scale each would get, plus the walk
// bbox over a full cycle.
//   node probe-scale.mjs
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
  const out = {};
  for (const file of ["pet_druzhok_idle.glb", "pet_druzhok_walk.glb"]) {
    const res = await BABYLON.SceneLoader.ImportMeshAsync("", "/assets/village/", file, scene);
    const loaded = res.meshes[0];
    // Exactly loadModel's sequence: measure FIRST, stop clips after.
    const b = loaded.getHierarchyBoundingVectors();
    const hAtMeasure = b.max.y - b.min.y;
    const rec = {
      hAtMeasure: +hAtMeasure.toFixed(4),
      scaleApplied: +(0.62 / Math.max(1e-3, hAtMeasure)).toFixed(4),
      groups: res.animationGroups.map((g) => `${g.name}${g.isPlaying ? " (playing)" : ""}`),
    };
    // Now sample the walk cycle: play and measure each sampled frame.
    const g = res.animationGroups[0];
    if (g) {
      g.stop();
      let mn = Infinity, mx = -Infinity, mnLow = Infinity, mxLow = -Infinity;
      g.start(false, 1.0);
      for (let t = 0; t <= 1.001; t += 0.05) {
        g.goToFrame(g.from + (g.to - g.from) * Math.min(1, t));
        scene.render(); // force skeleton eval
        const bb = loaded.getHierarchyBoundingVectors();
        const h = bb.max.y - bb.min.y;
        mn = Math.min(mn, h); mx = Math.max(mx, h);
        mnLow = Math.min(mnLow, bb.min.y); mxLow = Math.max(mxLow, bb.min.y);
      }
      g.stop();
      rec.cycleHeight = { min: +mn.toFixed(4), max: +mx.toFixed(4) };
      rec.cycleMinY = { min: +mnLow.toFixed(4), max: +mxLow.toFixed(4) };
    }
    for (const m of res.meshes) m.dispose();
    out[file] = rec;
  }
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
