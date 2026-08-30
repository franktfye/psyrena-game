// Scratch driver: measure the pet's HEEL GAP at real framerate, to check the
// walk/run threshold (RUN_M) against the gaps the chase actually settles at.
//
//   PSYRENA_URL=http://127.0.0.1:5199/ node petgap.mjs unicorn
//
// The SwiftShader rig runs at ~2 fps, where the follower's dt is capped at 0.1
// and the chase closes ~89 % of any gap per frame — so the gap it reports is
// not the one a player sees. This one wants a real GPU; it prints the renderer
// string and the measured fps so a software fallback is obvious rather than
// silently producing the same wrong answer.
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const PET = process.argv[2] ?? "unicorn";
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";
const ANGLE = process.env.ANGLE ?? "gl-egl";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--use-gl=angle",
    `--use-angle=${ANGLE}`,
    "--window-size=1280,720",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate((pet) => {
  localStorage.setItem(
    "psyrena_wardrobe:frank",
    JSON.stringify({ skin: "default", pet, petChosen: true })
  );
}, PET);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

const renderer = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log("renderer:", renderer);

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
  { timeout: 60000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth .hero")].find((t) => /pavlov/i.test(t.textContent)).click();
});
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
  { timeout: 60000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click();
});
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 300000, polling: 1000 }
);
await page
  .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), {
    timeout: 180000,
    polling: 1000,
  })
  .catch(() => logs.push("[warn] textures not all ready"));
await page.waitForFunction(
  (pet) => {
    const s = window.psyrena.manager.active;
    const n = s.transformNodes.find((t) => t.name === `pet_${pet}`);
    return n && n.getChildMeshes().length > 0;
  },
  { timeout: 60000, polling: 1000 },
  PET
);

/**
 * Sample the gap every frame for `ms`, so the answer is the distribution the
 * threshold actually sees rather than one instant that may be mid-correction.
 */
const sample = async (ms) =>
  page.evaluate(
    (pet, ms) =>
      new Promise((resolve) => {
        const s = window.psyrena.manager.active;
        const node = s.transformNodes.find((t) => t.name === `pet_${pet}`);
        const hero = s.transformNodes.find((t) => t.name === "freud");
        const gaps = [];
        const clips = new Set();
        const speeds = [];
        let frames = 0;
        let stalled = 0;
        let prev = { x: hero.position.x, z: hero.position.z, t: performance.now() };
        const t0 = performance.now();
        const under = (n) => {
          for (let c = n; c; c = c.parent) if (c === node) return true;
          return false;
        };
        const obs = s.onBeforeRenderObservable.add(() => {
          frames++;
          // The hub is full of walls the hero jams against while a key is
          // held; those frames are him standing still, and folding them into
          // the median reports a chase gap that no chase produced.
          const now = performance.now();
          const dt = (now - prev.t) / 1000;
          const heroSpeed = dt > 0 ? Math.hypot(hero.position.x - prev.x, hero.position.z - prev.z) / dt : 0;
          prev = { x: hero.position.x, z: hero.position.z, t: now };
          const ry = hero.rotation.y;
          const tx = hero.position.x + Math.sin(ry) * 0.95 + Math.cos(ry) * 0.75;
          const tz = hero.position.z + Math.cos(ry) * 0.95 - Math.sin(ry) * 0.75;
          if (heroSpeed > 1) {
            speeds.push(heroSpeed);
            gaps.push(Math.hypot(tx - node.position.x, tz - node.position.z));
            for (const g of s.animationGroups)
              if (g.isPlaying && g.targetedAnimations.some((ta) => ta.target && under(ta.target)))
                clips.add(g.name);
          } else stalled++;
          if (performance.now() - t0 >= ms) {
            s.onBeforeRenderObservable.remove(obs);
            const sorted = gaps.slice().sort((a, b) => a - b);
            const secs = (performance.now() - t0) / 1000;
            const mid = (a) => (a.length ? +a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : null);
            resolve({
              fps: +(frames / secs).toFixed(1),
              moving: gaps.length,
              stalled,
              heroSpeed: mid(speeds),
              gapMin: sorted.length ? +sorted[0].toFixed(3) : null,
              gapMedian: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(3) : null,
              gapMax: sorted.length ? +sorted[sorted.length - 1].toFixed(3) : null,
              clips: [...clips],
            });
          }
        });
      }),
    PET,
    ms
  );

/** Drop the hero on open plaza facing `ry`, so a held key buys real distance. */
const reset = (ry) =>
  page.evaluate((ry) => {
    const s = window.psyrena.manager.active;
    const h = s.transformNodes.find((t) => t.name === "freud");
    h.position.x = 0;
    h.position.z = 6;
    h.rotation.y = ry;
  }, ry);

console.log("idle       ", JSON.stringify(await sample(2500)));

await page.focus("canvas");
// Each phase restarts from the same open spot: holding a key for 8 s straight
// walks him into the plaza furniture, and a hero pinned against a bench is not
// a chase.
for (const [label, sprint, ry] of [
  ["walk (W)   ", false, Math.PI],
  ["sprint (⇧W)", true, Math.PI],
  ["walk again ", false, Math.PI],
]) {
  await reset(ry);
  await new Promise((r) => setTimeout(r, 400));
  if (sprint) await page.keyboard.down("Shift");
  await page.keyboard.down("w");
  await new Promise((r) => setTimeout(r, 1500)); // reach steady state
  console.log(label, JSON.stringify(await sample(2500)));
  await page.keyboard.up("w");
  if (sprint) await page.keyboard.up("Shift");
  await new Promise((r) => setTimeout(r, 800));
}

if (logs.length) console.log(logs.slice(0, 5).join("\n"));
await browser.close();
