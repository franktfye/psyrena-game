/**
 * Scene-walk smoke test for the mobile performance work (dev tool, not shipped).
 * Backs rule 8 in CLAUDE.md ("Mobile-first performance rules").
 *
 * Logs in, boots the village, then visits arena -> practice -> village through
 * window.psyrena.go, and prints one JSON line per scene: boot ok, mesh and
 * particle-system counts, render scaling, console errors/warnings, and the
 * bytes that came over the wire (Content-Length, so compressed responses count
 * at their compressed size; browser-cache and service-worker hits excluded).
 * Ends with a reload ("village-revisit", wireMB reset) — the returning-player
 * and hero-switch cost. Exits non-zero if a scene fails to boot or throws.
 *
 * Always the WebGL2 path (WebGPU disabled): that is what every iPhone takes
 * (core/engine.ts) and it is the branch a desktop dev box never exercises.
 *
 * Point it at a PRODUCTION build, not the dev server — bundle and compression
 * changes only show up there:
 *   npm run build -- --outDir /tmp/psy/dist
 *   PORT=8799 PSYRENA_STATIC=/tmp/psy/dist PSYRENA_DB=/tmp/psy/test.db \
 *     PSYRENA_DEV_SEED=1 node server/index.mjs
 *   node tools/mobile-scenes-e2e.mjs [--mobile] [--tag name]
 *
 * --mobile emulates a landscape Android phone (DPR 3, touch, mobile UA), which
 * flips detectControlScheme() to touch and isMemoryConstrainedDevice() via UA.
 * Pin a quality tier with E2E_URL=http://127.0.0.1:8799/?quality=low — without
 * it, SwiftShader's frame rate trips the adaptive step-down (core/quality.ts)
 * and later scenes build a tier lower, which is itself worth exercising.
 * Screenshots: /tmp/psyrena-e2e/<tag>-<scene>.png
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:8799/";
// Dev-fixture credentials (server/app.mjs seeds these under PSYRENA_DEV_SEED).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";
const MOBILE = process.argv.includes("--mobile");
const tagAt = process.argv.indexOf("--tag");
const TAG = tagAt > 0 ? process.argv[tagAt + 1] : MOBILE ? "mobile" : "desktop";
const SHOTS = "/tmp/psyrena-e2e";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-features=WebGPU",
  ],
});
const page = await browser.newPage();
if (MOBILE) {
  await page.emulate({
    viewport: { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  });
} else {
  await page.setViewport({ width: 1280, height: 720 });
}

const errors = [];
let wireBytes = 0;
let swHits = 0;
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warn") errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("response", (r) => {
  // /api/me answers 401 before login by design.
  if (r.status() >= 400 && !r.url().endsWith("/api/me")) errors.push(`[HTTP ${r.status()}] ${r.url()}`);
  // Cache hits fire `response` too; only bytes that crossed the network count.
  if (r.fromServiceWorker()) swHits++;
  else if (!r.fromCache()) wireBytes += Number(r.headers()["content-length"] ?? 0);
});

const t0 = Date.now();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#auth", { timeout: 30000 });
if (await page.$('#auth input[placeholder="username"]')) {
  await page.type('#auth input[placeholder="username"]', USER);
  await page.type('#auth input[type="password"]', PW);
  await page.click("#auth button.cta");
}
// Click through the intro guide / notices to "Enter Psyrena".
await page.waitForFunction(
  () => {
    const btns = [...document.querySelectorAll("#auth button.cta")];
    btns.find((b) => /continue|got it/i.test(b.textContent))?.click();
    const enter = btns.find((b) => /enter/i.test(b.textContent));
    enter?.click();
    return !!enter;
  },
  { timeout: 60000, polling: 500 }
);
await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 60000 });

let failed = false;
const report = async (scene) => {
  const bootStart = Date.now();
  const ok = await page
    .waitForFunction(() => window.psyrena && document.getElementById("boot")?.classList.contains("done"), {
      timeout: 240000,
      polling: 500,
    })
    .then(() => true, () => false);
  const bootSecs = (Date.now() - bootStart) / 1000;
  await sleep(5000); // let particles/animation settle before the screenshot
  const info = await page.evaluate(() => {
    const s = window.psyrena?.manager?.active;
    return {
      msg: document.getElementById("boot-msg")?.textContent,
      meshes: s?.meshes?.length ?? -1,
      particleSystems: s?.particleSystems?.length ?? -1,
      scaling: window.psyrena?.engine?.getHardwareScalingLevel?.(),
      tier: window.psyrena?.quality?.(),
      glowLayers: s?.effectLayers?.length ?? -1,
      // The DefaultRenderingPipeline attaches to the camera, not the scene.
      postProcesses: (s?.activeCamera?._postProcesses ?? []).filter(Boolean).length,
    };
  });
  await page.screenshot({ path: `${SHOTS}/${TAG}-${scene}.png` });
  const errs = errors.splice(0).filter((e) => !/WebGPU Context Provider|status of 401/.test(e));
  if (!ok || errs.some((e) => e.startsWith("[pageerror]"))) failed = true;
  console.log(
    JSON.stringify({ scene, ok, bootSecs: +bootSecs.toFixed(1), wireMB: +(wireBytes / 1048576).toFixed(1), swHits, ...info, errors: errs })
  );
};

await report("village");
for (const id of ["arena", "practice", "village"]) {
  await page.evaluate((id) => void window.psyrena.go(id), id);
  await sleep(500);
  await report(id);
}
// Warm revisit: what a returning player pays. Reloading is also exactly what
// "Switch Character" does (ui/leftDock.ts), so this is the hero-switch cost.
const coldMB = wireBytes / 1048576;
wireBytes = 0;
swHits = 0;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => {
    const btns = [...document.querySelectorAll("#auth button.cta")];
    btns.find((b) => /continue|got it/i.test(b.textContent))?.click();
    btns.find((b) => /enter/i.test(b.textContent))?.click();
    return !document.getElementById("auth");
  },
  { timeout: 60000, polling: 500 }
);
await report("village-revisit");
wireBytes += coldMB * 1048576;
console.log(JSON.stringify({ totalSecs: Math.round((Date.now() - t0) / 1000), wireMB: +(wireBytes / 1048576).toFixed(1) }));
await browser.close();
if (failed) {
  console.error("FAIL: a scene did not boot or threw — see errors above");
  process.exitCode = 1;
}
