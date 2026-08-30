// Scratch driver: walk the hero, release, and sample the pet's playing clips
// + skinned height every ~120 ms across the stop edge — proves the idle starts
// immediately (no mid-stride freeze) and the size does not pop (corgi).
//   PSYRENA_URL=http://127.0.0.1:5199/ node petstop.mjs <outdir> <pet...>
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUTDIR = process.argv[2] ?? "/tmp/petstop";
const PETS = process.argv.length > 3 ? process.argv.slice(3) : ["corgi", "husky", "dino", "robot"];
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";
mkdirSync(OUTDIR, { recursive: true });

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
    "--window-size=1600,900",
  ],
});

for (const pet of PETS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const logs = [];
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate((p) => {
    localStorage.setItem(
      "psyrena_wardrobe:frank",
      JSON.stringify({ skin: "default", pet: p, petChosen: true })
    );
  }, pet);
  await page.evaluate((h) => (window.__hero = h), pet === "druzhok" ? "pavlov" : "freud");
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
    () => [...document.querySelectorAll("#auth .hero")].some((t) => new RegExp(window.__hero ?? "freud", "i").test(t.textContent)),
    { timeout: 30000 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth .hero")].find((t) => new RegExp(window.__hero ?? "freud", "i").test(t.textContent)).click();
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
    { timeout: 300000, polling: 500 }
  );
  await page.waitForFunction(
    (p) => {
      const s = window.psyrena.manager.active;
      const n = s.transformNodes.find((n) => n.name === `pet_${p}`);
      return n && n.getChildMeshes().length > 0;
    },
    { timeout: 60000, polling: 500 },
    pet
  );

  // Sampler installed in-page: records once per rendered frame.
  await page.evaluate((p) => {
    const s = window.psyrena.manager.active;
    const petNode = s.transformNodes.find((n) => n.name === `pet_${p}`);
    window.__samples = [];
    window.__t0 = performance.now();
    s.onBeforeRenderObservable.add(() => {
      const meshes = petNode.getChildMeshes().filter((m) => m.isEnabled() && m.getTotalVertices() > 0);
      let minY = Infinity,
        maxY = -Infinity;
      for (const m of meshes) {
        m.refreshBoundingInfo({ applySkeleton: true });
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        minY = Math.min(minY, bb.minimumWorld.y);
        maxY = Math.max(maxY, bb.maximumWorld.y);
      }
      window.__samples.push({
        t: Math.round(performance.now() - window.__t0),
        h: +(maxY - minY).toFixed(3),
        clips: s.animationGroups
          .filter((g) => g.isPlaying)
          .map((g) => g.name + (g.animatables?.some((a) => a.paused) ? "(paused)" : ""))
          .join("+"),
      });
    });
  }, pet);

  await page.focus("canvas");
  await page.keyboard.down("w");
  await new Promise((r) => setTimeout(r, 2200));
  await page.evaluate(() => (window.__stopAt = performance.now() - window.__t0));
  await page.keyboard.up("w");
  await new Promise((r) => setTimeout(r, 2600));

  const data = await page.evaluate(() => ({ stopAt: Math.round(window.__stopAt), n: window.__samples.length }));
  const samples = await page.evaluate(() => window.__samples);
  // Thin the log: every ~8th frame while walking, every frame near the stop.
  const around = samples.filter(
    (s, i) => i % 12 === 0 || (s.t > data.stopAt - 150 && s.t < data.stopAt + 700 && i % 2 === 0)
  );
  console.log(`=== ${pet} (W released at t=${data.stopAt}ms) ===`);
  for (const s of around) console.log(`  t=${String(s.t).padStart(5)} h=${s.h} [${s.clips}]`);
  const noise = logs.slice(0, 3);
  if (noise.length) console.log(pet, "console:", noise.join(" | "));
  await page.close();
}
await browser.close();
console.log("done");
