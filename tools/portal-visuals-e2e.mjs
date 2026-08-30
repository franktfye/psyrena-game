/** One-off: frame the post-victory loot box + return portal (dev tool). */
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5199/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--window-size=1280,800",
    "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan",
  ],
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await Promise.all([
    page.waitForSelector("#auth .hero", { timeout: 15_000 }),
    page.click("#auth button.cta"),
  ]);
  await page.click("#auth .hero:not(.locked)");
  await Promise.all([
    page.waitForFunction(() => window.psyrena?.manager, { timeout: 120_000, polling: 500 }),
    page.evaluate(() => {
      [...document.querySelectorAll("#auth button.cta")].find((b) => b.textContent.includes("Enter Psyrena")).click();
    }),
  ]);
  await page.evaluate(() => window.psyrena.go("arena"));
  await page.waitForFunction(() => !!document.getElementById("bossFrame"), { timeout: 180_000, polling: 500 });
  await sleep(12_000);
  await page.evaluate(() => window.psyrenaFight.debugWin());
  await page.waitForFunction(
    () =>
      !!window.psyrena.manager.active?.getMeshByName?.("returnPortalRing") &&
      !!window.psyrena.manager.active?.getTransformNodeByName?.("arenaLootBox"),
    { timeout: 60_000, polling: 500 }
  );
  await page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const cam = s.activeCamera;
    cam.lowerRadiusLimit = 1;
    cam.upperRadiusLimit = 100;
    s.onBeforeRenderObservable.add(() => {
      cam.alpha = -2.2; // look from south-west toward box (2.8,2.2) + portal (5.6,2.2)
      cam.beta = 1.25;
      cam.radius = 11;
      cam.target.x = 4.2;
      cam.target.y = 1.0;
      cam.target.z = 2.2;
    });
  });
  await sleep(1_500);
  await page.screenshot({ path: "/tmp/psyrena-loot-e2e/portal-framed.png" });
  console.log("shot saved");
} finally {
  await browser.close();
}
