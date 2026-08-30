/**
 * Arena + practice-pit boot E2E after the meshopt/progress/ready-gate work:
 *  1. frank (solo, NOT practice) switches village → arena: exercises the
 *     fight-ready gate's solo path, the meshopt'd boss/hero glbs, and the
 *     boot progress bar (sampled while the scene factory runs).
 *  2. then arena → practice booth: the third scene boots too.
 */
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.E2E_URL ?? "http://localhost:5199";
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--mute-audio",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
});

const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console]", m.text().slice(0, 200));
});
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
await page.type('input[placeholder="username"]', USER);
await page.type('input[placeholder="password"]', PW);
await page.click("#auth button.cta");
await page.waitForFunction(
  () =>
    [...document.querySelectorAll("#auth button.cta")].some((b) =>
      b.textContent.includes("Continue")
    ),
  { timeout: 15_000, polling: 200 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")]
    .find((b) => b.textContent.includes("Continue"))
    .click();
});
await page.waitForSelector("#auth .hero", { timeout: 15_000 });
await Promise.all([
  page.waitForFunction(() => window.psyrena?.manager?.active, { timeout: 300_000, polling: 500 }),
  page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => b.textContent.includes("Enter Psyrena"))
      .click();
  }),
]);
console.log("… village booted; switching to arena (ranked-solo path)");

// Sample the boot bar while the arena factory runs.
await page.evaluate(() => {
  window.__barSamples = [];
  window.__barTimer = setInterval(() => {
    const fill = document.querySelector("#boot-bar i");
    const boot = document.getElementById("boot");
    if (fill && boot && !boot.classList.contains("done")) {
      window.__barSamples.push(fill.style.width || "0%");
    }
  }, 200);
  localStorage.removeItem("psyrena_practice"); // ranked path — gate runs, server says solo
  window.psyrena.go("arena");
});
await page.waitForFunction(
  () =>
    document.getElementById("boot")?.classList.contains("done") &&
    window.psyrena?.manager?.active?.getMeshByName("floor"),
  { timeout: 300_000, polling: 500 }
);
const arena = await page.evaluate(() => {
  clearInterval(window.__barTimer);
  const scene = window.psyrena.manager.active;
  return {
    fight: !!window.psyrenaFight,
    bossMeshes: scene.meshes.filter((m) => m.name.toLowerCase().includes("nightmare")).length,
    heroMesh: !!scene.getTransformNodeByName("arenaHero"),
    barSamples: window.__barSamples.length,
    barMax: Math.max(0, ...window.__barSamples.map((w) => parseInt(w) || 0)),
    bootMsg: document.getElementById("boot-msg")?.textContent,
  };
});
console.log("  arena:", JSON.stringify(arena));
check(arena.fight, "arena combat wired (window.psyrenaFight present)");
check(arena.bossMeshes > 0, `NIGHTMARE meshopt glbs loaded (${arena.bossMeshes} meshes)`);
check(arena.heroMesh, "player hero rig present");
check(arena.barMax > 0, `boot progress bar moved (peak ${arena.barMax}%, ${arena.barSamples} samples)`);
await sleep(2000);
await page.screenshot({ path: "/tmp/psyrena-arena.png" });

console.log("… switching to practice booth");
await page.evaluate(() => {
  window.__barSamples = [];
  window.__barTimer = setInterval(() => {
    const fill = document.querySelector("#boot-bar i");
    const boot = document.getElementById("boot");
    if (fill && boot && !boot.classList.contains("done")) {
      window.__barSamples.push(fill.style.width || "0%");
    }
  }, 200);
  window.psyrena.go("practice");
});
await page.waitForFunction(
  () => {
    const boot = document.getElementById("boot");
    return boot?.classList.contains("done") && document.body.dataset.scene === "practice";
  },
  { timeout: 300_000, polling: 500 }
);
const practice = await page.evaluate(() => {
  clearInterval(window.__barTimer);
  return {
    barMax: Math.max(0, ...window.__barSamples.map((w) => parseInt(w) || 0)),
    samples: window.__barSamples.length,
  };
});
console.log("  practice:", JSON.stringify(practice));
check(practice.barMax > 0, `practice pit progress bar moved (peak ${practice.barMax}%)`);
await page.screenshot({ path: "/tmp/psyrena-practice.png" });

await browser.close();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
