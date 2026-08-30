// Scratch driver: walk the hero and screenshot/measure Druzhok mid-stride.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petwalk.mjs <out.png>
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUT = process.argv[2] ?? "/tmp/petwalk.png";
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1600,900",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

await page.waitForSelector("#auth", { timeout: 20000 });
if (await page.$('#auth input[placeholder="username"]')) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}
// Intro guide sits between login and the picker - click Continue through it.
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("#auth button.cta")];
  btns.find((b) => /continue/i.test(b.textContent))?.click();
  return btns.some((b) => /enter/i.test(b.textContent));
}, { timeout: 30000, polling: 300 });
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth .hero")].some((t) => /pavlov/i.test(t.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth .hero")].find((t) => /pavlov/i.test(t.textContent)).click();
});
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click();
});
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 300000, polling: 1000 }
);
await page
  .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), {
    timeout: 120000,
    polling: 1000,
  })
  .catch(() => logs.push("[warn] textures not all ready"));
await page.waitForFunction(
  () => {
    const s = window.psyrena.manager.active;
    const pet = s.transformNodes.find((n) => n.name === "pet_druzhok");
    return pet && pet.getChildMeshes().length > 0;
  },
  { timeout: 60000, polling: 1000 }
);

// Chase-cam that follows the pet every frame.
await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const pet = s.transformNodes.find((n) => n.name === "pet_druzhok");
  const c = s.activeCamera;
  s.onBeforeRenderObservable.add(() => {
    const p = pet.getAbsolutePosition();
    c.alpha = 0.9;
    c.beta = 1.2;
    c.radius = 4.0;
    c.target.set(p.x, p.y + 0.35, p.z);
  });
});

// Walk forward: hold W, let the dog break into its walk model + clip.
await page.focus("canvas");
await page.keyboard.down("w");
await new Promise((r) => setTimeout(r, 2500));

const mid = await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const pet = s.transformNodes.find((n) => n.name === "pet_druzhok");
  const kids = pet.getChildren();
  const enabledRoot = kids.find((k) => k.isEnabled?.());
  let bounds = null;
  if (enabledRoot?.getChildMeshes) {
    let min = null, max = null;
    for (const m of enabledRoot.getChildMeshes()) {
      if (!m.getTotalVertices?.() || !m.getTotalVertices()) continue;
      m.refreshBoundingInfo(true);
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      const mn = bb.minimumWorld, mx = bb.maximumWorld;
      if (!min) { min = { x: mn.x, y: mn.y, z: mn.z }; max = { x: mx.x, y: mx.y, z: mx.z }; }
      else {
        for (const k of ["x", "y", "z"]) { min[k] = Math.min(min[k], mn[k]); max[k] = Math.max(max[k], mx[k]); }
      }
    }
    if (min) bounds = { h: +(max.y - min.y).toFixed(3), minY: +min.y.toFixed(3), maxY: +max.y.toFixed(3) };
  }
  const walkAnim = s.animationGroups.find((g) => g.name === "walk");
  return {
    enabledModels: kids.filter((k) => k.isEnabled?.()).length,
    walkPlaying: walkAnim?.isPlaying ?? false,
    petY: +pet.position.y.toFixed(3),
    bounds,
  };
});
console.log("mid-walk:", JSON.stringify(mid));
await page.screenshot({ path: OUT });
await page.keyboard.up("w");

// Let him settle back to heel, then measure the idle side of the swap.
await new Promise((r) => setTimeout(r, 4000));
const rest = await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const pet = s.transformNodes.find((n) => n.name === "pet_druzhok");
  const enabledRoot = pet.getChildren().find((k) => k.isEnabled?.());
  let min = null, max = null;
  for (const m of enabledRoot.getChildMeshes()) {
    if (!m.getTotalVertices?.() || !m.getTotalVertices()) continue;
    m.refreshBoundingInfo(true);
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    const mn = bb.minimumWorld, mx = bb.maximumWorld;
    if (!min) { min = { x: mn.x, y: mn.y, z: mn.z }; max = { x: mx.x, y: mx.y, z: mx.z }; }
    else {
      for (const k of ["x", "y", "z"]) { min[k] = Math.min(min[k], mn[k]); max[k] = Math.max(max[k], mx[k]); }
    }
  }
  return { h: +(max.y - min.y).toFixed(3), minY: +min.y.toFixed(3) };
});
console.log("at heel:", JSON.stringify(rest));
await page.screenshot({ path: OUT.replace(/\.png$/, "-heel.png") });
console.log(OUT);
console.log(logs.filter((l) => !/^\[log\]|^\[debug\]/.test(l)).slice(0, 10).join("\n") || "(clean)");
await browser.close();
