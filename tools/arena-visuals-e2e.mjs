// Temporary verification driver — boss arena: spawn-pad portal texture, boss
// fog/vortex, and the hero jump arc. Screenshots + a jump height trace.
// Usage: node arena-verify.mjs [outPrefix]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const PREFIX = process.argv[2] ?? "/tmp/arena";
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/?gfx=webgl2";

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
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// ---- auth + hero pick (frank / dev creds, first hero offered) --------------
try {
  await page.waitForSelector("#auth", { timeout: 20000 });
  const login = await page.$('#auth input[placeholder="username"]');
  if (login) {
    await page.type('#auth input[placeholder="username"]', USER);
    await page.type('#auth input[type="password"]', PW);
    await page.click("#auth button.cta");
  }
  const findEnter = () =>
    [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent));
  await page.waitForFunction(findEnter, { timeout: 30000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => /enter/i.test(b.textContent))
      .click();
  });
  await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
} catch (e) {
  logs.push(`[auth] ${e.message}`);
}

await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 180000 }
);

// ---- village → arena -------------------------------------------------------
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" })));
await page.waitForFunction(
  () => window.psyrena?.manager?.active?.getMeshByName?.("floor"),
  { timeout: 120000 }
);
// Boss + textures settled.
await page.waitForFunction(
  () => window.psyrena.manager.active.getTransformNodeByName("nightmare_root"),
  { timeout: 60000 }
);
await page
  .waitForFunction(
    () => window.psyrena.manager.active.textures.every((t) => t.isReady()),
    { timeout: 120000 }
  )
  .catch(() => logs.push("[warn] textures not all ready"));
// Past the 10 s engage countdown — the giant number overlay ruins the shots.
await page
  .waitForFunction(() => window.psyrenaFight?.snapshot?.().phase === "p1", { timeout: 60000 })
  .catch(() => logs.push("[warn] p1 never reached"));
await new Promise((r) => setTimeout(r, 4000)); // let particles reach steady state

// Per-frame camera override (the arena follow-cam re-drives it every frame).
const aimCam = (alpha, beta, radius, tx, ty, tz) =>
  page.evaluate(
    ({ alpha, beta, radius, tx, ty, tz }) => {
      const scene = window.psyrena.manager.active;
      const cam = scene.activeCamera;
      cam.lowerRadiusLimit = 0.5;
      cam.upperRadiusLimit = 200;
      cam.upperBetaLimit = Math.PI;
      if (window.__camHook) scene.onBeforeRenderObservable.remove(window.__camHook);
      window.__camHook = scene.onBeforeRenderObservable.add(() => {
        cam.alpha = alpha;
        cam.beta = beta;
        cam.radius = radius;
        cam.target.x = tx;
        cam.target.y = ty;
        cam.target.z = tz;
      });
    },
    { alpha, beta, radius, tx, ty, tz }
  );

// 1. Spawn pad close-up — south pad, looking down at the portal slab. Aim at
// the real mesh so the shot survives layout-radius changes.
const pad = await page.evaluate(() => {
  const m = window.psyrena.manager.active.getMeshByName("spawnPad0");
  return m ? { x: m.position.x, y: m.position.y, z: m.position.z } : null;
});
if (pad) {
  await aimCam(Math.PI / 2, 0.45, 6.5, pad.x, pad.y, pad.z);
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${PREFIX}_spawnpad.png` });
} else {
  console.log("WARN: spawnPad0 not found");
}

// 2. Boss wide — fog + vortex at the centre.
await aimCam(Math.PI / 2, 1.05, 14, 0, 2, 0);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${PREFIX}_boss.png` });

// 3. Boss feet close-up — the vortex + tightened smoke.
await aimCam(Math.PI / 2, 0.9, 7.5, 0, 0.6, 0);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${PREFIX}_vortex.png` });

// ---- jump trace ------------------------------------------------------------
const jump = await page.evaluate(async () => {
  const scene = window.psyrena.manager.active;
  const hero = scene.getTransformNodeByName("arenaHero");
  if (!hero) return { error: "no arenaHero node" };
  const y0 = hero.position.y;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
  const trace = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 1200) {
    trace.push(+(hero.position.y - y0).toFixed(3));
    await new Promise((r) => setTimeout(r, 50));
  }
  return { y0: +y0.toFixed(3), peak: Math.max(...trace), end: trace[trace.length - 1], trace };
});
console.log("JUMP:", JSON.stringify(jump));

// Mid-air screenshot for the anim read.
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })));
await new Promise((r) => setTimeout(r, 280));
await page.screenshot({ path: `${PREFIX}_jump.png` });

console.log(
  "LOGS:",
  logs
    .filter((l) => /error|fail|warn/i.test(l))
    .slice(0, 20)
    .join("\n") || "(clean)"
);
await browser.close();
