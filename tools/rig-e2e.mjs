/**
 * Remote-rig E2E: boots frank (skinner) and jung (pavlov) into the village and
 * asserts each sees the OTHER as an instantiated hero rig (remote_<user>_*
 * meshes present, capsule stand-in remoteBody_<user> retired), then separates
 * them and screenshots both views.
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

async function bootVillagePage(username, password) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${username} pageerror]`, String(e).slice(0, 160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', username);
  await page.type('input[placeholder="password"]', password);
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
  return page;
}

const rigState = (page, other) =>
  page.evaluate((name) => {
    const scene = window.psyrena?.manager?.active;
    if (!scene) return null;
    const meshes = scene.meshes.map((m) => m.name);
    return {
      rigMeshes: meshes.filter((n) => n.startsWith(`remote_${name}_`)).length,
      capsule: meshes.filter((n) => n === `remoteBody_${name}`).length,
      remoteCount: window.psyrenaVillage?.remoteCount ?? -1,
    };
  }, other);

console.log("… booting frank (skinner) into the village");
const pageFrank = await bootVillagePage("frank", PW);
console.log("… booting jung (pavlov) into the village");
const pageJung = await bootVillagePage("jung", "psyrena123");

// Rig upgrade is async (shared container download + instantiate) — poll.
let frankSees = null;
let jungSees = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  frankSees = await rigState(pageFrank, "jung");
  jungSees = await rigState(pageJung, "frank");
  if (frankSees?.rigMeshes > 0 && jungSees?.rigMeshes > 0) break;
}
console.log("  frank's view of jung:", JSON.stringify(frankSees));
console.log("  jung's view of frank:", JSON.stringify(jungSees));
check(frankSees?.rigMeshes > 0, "frank sees jung as an instantiated hero rig");
check(frankSees?.capsule === 0, "jung's capsule stand-in retired in frank's scene");
check(jungSees?.rigMeshes > 0, "jung sees frank as an instantiated hero rig");
check(jungSees?.capsule === 0, "frank's capsule stand-in retired in jung's scene");

// Separate them: walk frank forward ~3 s so the pair is readable on screen.
await pageFrank.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
});
await sleep(3000);
await pageFrank.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "w" }));
});
await sleep(1500); // let jung's interpolation settle + walk anim blend out
await pageFrank.screenshot({ path: "/tmp/psyrena-rig-frank.png" });
await pageJung.screenshot({ path: "/tmp/psyrena-rig-jung.png" });
console.log("screenshots: /tmp/psyrena-rig-frank.png /tmp/psyrena-rig-jung.png");

await browser.close();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
