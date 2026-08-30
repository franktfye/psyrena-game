// Scratch driver: watch ONE pet's idle cycle for 24 s and print which clip
// owns each 2 s sample, so the alternation can be seen rather than assumed.
//   PSYRENA_URL=http://127.0.0.1:5199/ node petidle.mjs dino
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const PET = process.argv[2] ?? "dino";
// Real GPU by default: the idle cycle is a wall-clock hold, and under
// SwiftShader's ~2 fps the follower's dt is capped at 0.1 s, so its
// accumulators run ~5x slow and a 5 s hold measures as ~25 s.
const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5199/";

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
    `--use-angle=${process.env.ANGLE ?? "gl-egl"}`,
    "--window-size=800,600",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });
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
 * Only the clips that drive THIS pet: the hero owns groups called `idle` and
 * `walk` too, so name alone cannot tell them apart — ownership is decided by
 * whether the animated target sits under the pet's node.
 */
const own = (pet) => {
  const s = window.psyrena.manager.active;
  const node = s.transformNodes.find((t) => t.name === `pet_${pet}`);
  const under = (n) => {
    for (let c = n; c; c = c.parent) if (c === node) return true;
    return false;
  };
  const mine = s.animationGroups.filter((g) =>
    g.targetedAnimations.some((ta) => ta.target && under(ta.target))
  );
  return {
    roster: mine.map((g) => g.name),
    playing: mine.filter((g) => g.isPlaying).map((g) => g.name),
    dist: +node.getAbsolutePosition().subtract(s.activeCamera.target).length().toFixed(2),
  };
};

const first = await page.evaluate(own, PET);
console.log(`${PET} clips on the pet:`, JSON.stringify(first.roster));
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const o = await page.evaluate(own, PET);
  console.log(`  t=${((i + 1) * 2).toString().padStart(2)}s  playing=${JSON.stringify(o.playing)}`);
}
if (logs.length) console.log(logs.slice(0, 5).join("\n"));
await browser.close();
