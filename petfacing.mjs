// Scratch driver: for each pet, equip it via localStorage, walk the hero, and
// screenshot the pet top-down + chase mid-walk and at heel, to measure the
// facing offset of each rigged re-export.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petfacing.mjs <outdir> [pet ...]
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const OUTDIR = process.argv[2] ?? "/tmp/petfacing";
const ONLY = process.argv.slice(3);
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";
const PETS = ONLY.length ? ONLY : ["robot", "corgi", "husky", "blackcat", "dino", "unicorn"];
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
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Equip this pet for the account before login reads the wardrobe key.
  await page.evaluate((p) => {
    localStorage.setItem(
      "psyrena_wardrobe:frank",
      JSON.stringify({ skin: "default", pet: p, petChosen: true })
    );
  }, pet);

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
    () => [...document.querySelectorAll("#auth .hero")].some((t) => /freud/i.test(t.textContent)),
    { timeout: 30000 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth .hero")].find((t) => /freud/i.test(t.textContent)).click();
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
  await page
    .waitForFunction(() => window.psyrena.manager.active.textures.every((t) => t.isReady()), {
      timeout: 60000,
      polling: 500,
    })
    .catch(() => logs.push("[warn] textures not all ready"));

  // Camera rig: fixed alpha/beta so every shot has the same screen orientation.
  // MODE 0 = top-down over the pet (world +X is screen-right, world +Z is
  // screen-DOWN at alpha=-PI/2, beta~0.02). MODE 1 = chase view over hero+pet.
  await page.evaluate((p) => {
    const s = window.psyrena.manager.active;
    const petNode = s.transformNodes.find((n) => n.name === `pet_${p}`);
    const c = s.activeCamera;
    c.upperBetaLimit = null;
    c.lowerBetaLimit = null;
    c.lowerRadiusLimit = null;
    c.upperRadiusLimit = null;
    window.__camMode = 0;
    s.onBeforeRenderObservable.add(() => {
      const pos = petNode.getAbsolutePosition();
      if (window.__camMode === 0) {
        c.alpha = -Math.PI / 2;
        c.beta = 0.02;
        c.radius = 4.5;
        c.target.set(pos.x, pos.y, pos.z);
      } else {
        c.alpha = 0.9;
        c.beta = 1.2;
        c.radius = 5.0;
        c.target.set(pos.x, pos.y + 0.35, pos.z);
      }
    });
  }, pet);

  // Walk forward long enough for the gait to engage and facing to settle.
  await page.focus("canvas");
  await page.keyboard.down("w");
  await new Promise((r) => setTimeout(r, 2200));

  const mid = await page.evaluate((p) => {
    const s = window.psyrena.manager.active;
    const petNode = s.transformNodes.find((n) => n.name === `pet_${p}`);
    const hero = s.transformNodes.find((n) => n.name === "heroRoot") ?? null;
    const heroRy = window.psyrena.player?.node?.rotation.y ?? hero?.rotation.y ?? null;
    const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return {
      petRy: +norm(petNode.rotation.y).toFixed(3),
      heroRy: heroRy === null ? null : +norm(heroRy).toFixed(3),
      children: petNode.getChildren().map((k) => `${k.name}${k.isEnabled?.() ? "" : " (off)"}`),
      clips: s.animationGroups.filter((g) => g.isPlaying).map((g) => g.name),
    };
  }, pet);
  await page.screenshot({ path: `${OUTDIR}/${pet}-walk-top.png` });
  await page.evaluate(() => (window.__camMode = 1));
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: `${OUTDIR}/${pet}-walk-chase.png` });
  await page.keyboard.up("w");

  // Settle at heel, idle engaged.
  await new Promise((r) => setTimeout(r, 3500));
  await page.evaluate(() => (window.__camMode = 0));
  await new Promise((r) => setTimeout(r, 350));
  const idle = await page.evaluate((p) => {
    const s = window.psyrena.manager.active;
    const petNode = s.transformNodes.find((n) => n.name === `pet_${p}`);
    const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return {
      petRy: +norm(petNode.rotation.y).toFixed(3),
      clips: s.animationGroups.filter((g) => g.isPlaying).map((g) => g.name),
    };
  }, pet);
  await page.screenshot({ path: `${OUTDIR}/${pet}-idle-top.png` });

  console.log(pet, "walk:", JSON.stringify(mid), "idle:", JSON.stringify(idle));
  const noise = logs.filter((l) => !/^\[log\]|^\[debug\]|^\[info\]/.test(l)).slice(0, 5);
  if (noise.length) console.log(pet, "console:", noise.join(" | "));
  await page.close();
}
await browser.close();
console.log("done ->", OUTDIR);
