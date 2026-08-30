// Temporary verification driver — screenshots the hub and reports console output.
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.argv[2] ?? "http://127.0.0.1:5173/";
const OUT = process.argv[3] ?? "/tmp/hub.png";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-webgpu",
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
page.on("requestfailed", (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) logs.push(`[HTTP ${r.status()}] ${r.url()}`); });

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

// Account gate (src/ui/authFlow.ts): log in with the seeded dev account if the
// form shows (a live session cookie skips it), then click Enter Psyrena.
try {
  await page.waitForSelector("#auth", { timeout: 20000 });
  const login = await page.$('#auth input[placeholder="username"]');
  if (login) {
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
  const findEnter = () =>
    [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent));
  await page.waitForFunction(findEnter, { timeout: 30000 });
  await page.evaluate(findEnter).then(() =>
    page.evaluate(() => {
      [...document.querySelectorAll("#auth button.cta")]
        .find((b) => /enter/i.test(b.textContent))
        .click();
    })
  );
  // The auth overlay removes itself once the profile resolves; main.ts then
  // clears boot "done" (it was set to hide the boot text behind the forms)
  // and re-adds it only after the scene is built. Wait out both edges so the
  // boot wait below can't pass on the stale pre-auth "done".
  await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
  await page
    .waitForFunction(() => !document.getElementById("boot")?.classList.contains("done"), {
      timeout: 10000,
    })
    .catch(() => {});
} catch (e) {
  logs.push(`[auth] ${e.message}`);
}

// The boot overlay gets class "done" only after the scene is built.
let booted = false;
try {
  await page.waitForFunction(
    () => document.getElementById("boot")?.classList.contains("done"),
    { timeout: 90000 }
  );
  booted = true;
} catch {}

const bootMsg = await page.evaluate(
  () => document.getElementById("boot-msg")?.textContent ?? "(none)"
);
const info = await page.evaluate(() => {
  const w = window;
  const s = w.psyrena?.manager?.active;
  return {
    hasPsyrena: !!w.psyrena,
    meshes: s?.meshes?.length ?? -1,
    lights: s?.lights?.length ?? -1,
    clearColor: s ? `${s.clearColor.r.toFixed(2)},${s.clearColor.g.toFixed(2)},${s.clearColor.b.toFixed(2)}` : "n/a",
    fogEnd: s?.fogEnd ?? -1,
    hasEnvTexture: !!s?.environmentTexture,
    hasSkybox: !!s?.getMeshByName?.("skyBox"),
  };
});

// Pull the camera back so the whole ring is in frame.
await page.evaluate(() => {
  const s = window.psyrena?.manager?.active;
  const c = s?.activeCamera;
  if (c) { c.radius = 46; c.beta = 1.02; c.alpha = Math.PI * 0.78; }
});
await new Promise((r) => setTimeout(r, 4000)); // software GL is slow
await page.screenshot({ path: OUT });

console.log(JSON.stringify({ url: URL, booted, bootMsg, ...info }, null, 2));
const diag = await page.evaluate(() => {
  const s = window.psyrena.manager.active;
  const mats = s.materials.map(m => m.name);
  const tex = s.textures.map(t => ({ n: t.name?.split("/").pop() ?? "?", w: t.getSize?.().width ?? 0, h: t.getSize?.().height ?? 0 }));
  const big = tex.filter(t => t.w >= 512).sort((a,b) => b.w*b.h - a.w*a.h).slice(0, 12);
  return {
    brickMats: mats.filter(n => /brick|ground_/.test(n)),
    textureCount: tex.length,
    biggest: big,
    shellMat: s.getMeshByName("outfitter_shell")?.material?.name ?? "none",
    groundMat: s.getMeshByName("plazaGround")?.material?.name ?? "none",
    roadMat: s.getMeshByName("plazaRoad")?.material?.name ?? "none",
  };
});
const fmt = await page.evaluate(() => {
  const eng = window.psyrena.engine;
  const cache = eng.getLoadedTexturesCache();
  const COMPRESSED = new Set([36492, 33779, 33777, 33776, 37496, 37492]); // BC7,BC3,BC1x2,ETC2
  const tally = {};
  let compressedBytes = 0, uncompressedBytes = 0;
  for (const t of cache) {
    const k = String(t.format);
    tally[k] = (tally[k] ?? 0) + 1;
    let px = t.width * t.height * (t.generateMipMaps ? 4/3 : 1) * (t.isCube ? 6 : 1);
    if (COMPRESSED.has(t.format)) compressedBytes += px * 1; else uncompressedBytes += px * 4;
  }
  return {
    formatTally: tally,
    anyCompressed: [...COMPRESSED].some(f => tally[String(f)]),
    compressedMB: +(compressedBytes/1048576).toFixed(1),
    uncompressedMB: +(uncompressedBytes/1048576).toFixed(1),
    caps: {
      s3tc: !!eng.getCaps().s3tc, bptc: !!eng.getCaps().bptc,
      etc2: !!eng.getCaps().etc2, astc: !!eng.getCaps().astc,
    },
  };
});
console.log("--- texture formats ---");
console.log(JSON.stringify(fmt, null, 2));
console.log("--- diagnostics ---");
console.log(JSON.stringify(diag, null, 2));
console.log("--- console ---");
console.log(logs.slice(0, 40).join("\n") || "(silent)");

await browser.close();
