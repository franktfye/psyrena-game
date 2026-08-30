// Scratch driver: frame the Pet Park diorama and report each statue's size.
// The park loads the same rigged GLBs the follower does, through the baking
// path in loadVillageProp — this is what checks the bake survived the rig.
//   PSYRENA_URL=http://127.0.0.1:5199/ node parkshot.mjs /tmp/park.png
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUT = process.argv[2] ?? "/tmp/park.png";
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
    "--window-size=1600,900",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") logs.push(`[error] ${m.text()}`);
});
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

const KEYS = ["robot", "corgi", "husky", "blackcat", "dino", "unicorn", "druzhok"];
const info = await page.evaluate((keys) => {
  const s = window.psyrena.manager.active;
  const out = [];
  let min = null;
  let max = null;
  for (const k of keys) {
    const m = s.meshes.find((x) => x.name.endsWith(`_${k}`) && x.getTotalVertices?.() > 0);
    if (!m) {
      out.push({ k, missing: true });
      continue;
    }
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    const mn = bb.minimumWorld;
    const mx = bb.maximumWorld;
    out.push({
      k,
      h: +(mx.y - mn.y).toFixed(3),
      minY: +mn.y.toFixed(3),
      verts: m.getTotalVertices(),
      skeleton: !!m.skeleton,
    });
    if (!min) {
      min = { x: mn.x, y: mn.y, z: mn.z };
      max = { x: mx.x, y: mx.y, z: mx.z };
    } else
      for (const c of ["x", "y", "z"]) {
        min[c] = Math.min(min[c], mn[c]);
        max[c] = Math.max(max[c], mx[c]);
      }
  }
  // Frame the whole diorama. Re-applied every frame: the hub drives the camera
  // off the hero, so a one-shot assignment is overwritten before it renders.
  const c = s.activeCamera;
  c.upperBetaLimit = null;
  c.lowerRadiusLimit = null;
  c.upperRadiusLimit = null;
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const r = Math.max(9, Math.hypot(max.x - min.x, max.z - min.z) * 0.85);
  // Top-down, fixed azimuth: +X is screen-right, -Z is screen-down. Every
  // statue should face the plaza centre (world origin).
  s.onBeforeRenderObservable.add(() => {
    c.target.set(cx, 0.35, cz);
    c.alpha = -Math.PI / 2;
    c.beta = 0.02;
    c.radius = r;
  });
  return {
    pets: out,
    centre: { x: +cx.toFixed(2), z: +cz.toFixed(2) },
    playing: s.animationGroups.filter((g) => g.isPlaying).map((g) => g.name),
  };
}, KEYS);

console.log("park statues:");
for (const p of info.pets) console.log("  " + JSON.stringify(p));
console.log("playing groups in hub:", JSON.stringify(info.playing));
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: OUT });
if (logs.length) console.log(logs.slice(0, 8).join("\n"));
await browser.close();
