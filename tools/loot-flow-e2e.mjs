/**
 * Browser E2E for the fight-over flows (dev tool, not shipped).
 *
 * Drives the real client against a running vite dev server and verifies:
 *  - damage-taken floats appear over heroes (.psy-dmg.taken)
 *  - player death = death pose + spectate (fight continues, casts inert)
 *  - party defeat routes back to the village, THEN pops the DEFEAT overlay
 *  - the fight OST plays Heartbeat Siege 1 even with a System-tab track pick
 *  - victory stays in the arena with NO overlay: the 3D loot box and the
 *    return portal spawn beside the dead boss instead
 *  - clicking the box collects it: loot panel opens, box disappears
 *  - walking into the return portal routes home: village up, no stale popup,
 *    the unclaimed-cache prop by the queue terminal covers uncollected loot,
 *    and the village OST resumes the player's chosen track
 *
 * Uses window.psyrenaFight.debugKillPlayer/debugLose/debugWin — the same
 * introspection object the other drivers use — so the 5-minute kill and the
 * 8-minute enrage never gate the test.
 *
 * Run: E2E_URL=http://localhost:5199/ node tools/loot-flow-e2e.mjs
 * (SwiftShader works but is slow; on a real GPU box pass CHROME_GPU=1 to use
 *  the Vulkan path — this test builds four scenes.)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5173/";
const SHOTS = "/tmp/psyrena-loot-e2e";
mkdirSync(SHOTS, { recursive: true });

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gpuArgs = process.env.CHROME_GPU
  ? ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan"]
  : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--window-size=1280,800", ...gpuArgs],
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ---- auth: login → hero picker → enter ----------------------------------
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
      const btn = [...document.querySelectorAll("#auth button.cta")].find((b) =>
        b.textContent.includes("Enter Psyrena")
      );
      btn.click();
    }),
  ]);
  console.log("… logged in, village up");

  const enterArena = async () => {
    await page.evaluate(() => window.psyrena.go("arena"));
    await page.waitForFunction(() => !!document.getElementById("bossFrame"), {
      timeout: 180_000,
      polling: 500,
    });
    await sleep(12_000); // 10 s idle + engage
    const phase = await page.evaluate(() => window.psyrenaFight.snapshot().phase);
    if (phase === "idle") fail(`fight never engaged (phase ${phase})`);
    console.log(`… arena engaged (phase ${phase})`);
  };

  // ==== 1. damage-taken floats over heroes ==================================
  await enterArena();
  const sawTaken = await page.waitForFunction(
    () => !!document.querySelector(".psy-dmg.taken"),
    { timeout: 15_000, polling: 100 }
  ).then(() => true).catch(() => false);
  if (!sawTaken) fail("no damage-taken float appeared during P1 (boss hits the player every 2 s)");
  else console.log("… damage-taken floats live");

  // ==== 2. player death = the wipe (solo fight, no allies) ==================
  // debugKillPlayer drops the ONLY combatant, so death and defeat are one
  // moment now: the death pose plays, then the defeat flow routes home.
  await page.evaluate(() => window.psyrenaFight.debugKillPlayer());
  await sleep(2_200); // death clip plays out
  const afterDeath = await page.evaluate(() => {
    const s = window.psyrenaFight.snapshot();
    return {
      playerAlive: s.threat.find((r) => r.isPlayer)?.alive,
      phase: s.phase,
      bossHp: s.hp,
    };
  });
  if (afterDeath.playerAlive !== false) fail("player not dead after debugKillPlayer");
  // A party wipe does NOT flip the boss phase — "dead" means the BOSS died
  // (bossFight.defeat() only sets `over` and emits fightEnd). The routing
  // check in step 3 is what verifies the loss actually resolved.
  if (afterDeath.phase === "idle") {
    fail(`fight should have been live when the player fell (phase ${afterDeath.phase})`);
  }
  await page.screenshot({ path: `${SHOTS}/death-pose.png` });
  console.log("… player death verified (death-pose.png); solo death is the wipe");

  // ==== 3. defeat → village + DEFEAT overlay ================================
  await page.waitForFunction(
    () =>
      !document.getElementById("bossFrame") &&
      document.querySelector("#loot h1.loss")?.textContent === "DEFEAT",
    { timeout: 180_000, polling: 500 }
  );
  console.log("… defeat: back in the village with the DEFEAT overlay up");
  await page.screenshot({ path: `${SHOTS}/defeat-town.png` });
  await page.click("#loot .close");
  await sleep(500);

  // ==== 4. victory → stay in arena, NO overlay, box + portal spawn ==========
  // Pick a village track first: the fight OST must ignore it (always Siege 1
  // then 2), and the village must resume it on the way home.
  await page.evaluate(() => {
    localStorage.setItem("psyrena.musicTrack", "firelight_1");
    performance.clearResourceTimings();
  });
  await enterArena();
  const arenaOst = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(".mp3"))
  );
  if (!arenaOst.some((n) => n.includes("siege_loop_1"))) {
    fail(`fight OST should open on siege_loop_1 despite the track pick (got ${arenaOst.join(", ")})`);
  } else console.log("… fight OST locked to Heartbeat Siege (override ignored)");
  await page.evaluate(() => window.psyrenaFight.debugWin());
  await page.waitForFunction(
    () => !!window.psyrena.manager.active?.getMeshByName?.("returnPortalRing"),
    { timeout: 60_000, polling: 250 }
  ).catch(() => fail("return portal never spawned after victory"));
  await page.waitForFunction(
    () => !!window.psyrena.manager.active?.getTransformNodeByName?.("arenaLootBox"),
    { timeout: 60_000, polling: 500 }
  ).catch(() => fail("3D loot box never spawned after victory"));
  await sleep(1_500); // give a wrongly-surviving overlay time to pop
  const afterWin = await page.evaluate(() => ({
    inArena: !!document.getElementById("bossFrame"),
    overlay: !!document.querySelector("#loot"),
  }));
  if (!afterWin.inArena) fail("victory should stay in the arena");
  if (afterWin.overlay) fail("victory must NOT auto-open the loot overlay — the 3D box is the flow");
  console.log("… victory: no overlay, loot box + return portal on the disc");
  await page.screenshot({ path: `${SHOTS}/victory.png` });

  // ==== 5. click the box → panel reopens, box disappears ====================
  // Do it the way a player would: walk up to the cache, then click it. The
  // spawn pad is ~18 m south of the box — from there it's a few pixels tall.
  await page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const cam = s.activeCamera;
    const b = s.getTransformNodeByName("arenaLootBox").getAbsolutePosition();
    const h = s.getTransformNodeByName("arenaHero").position;
    // Face the camera (and therefore W-movement) at the box — memory formula.
    cam.alpha = Math.atan2(-(b.z - h.z), -(b.x - h.x));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "shift" }));
  });
  await sleep(2_900); // sprint ~6.2 m/s → stop a couple of metres short
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "w" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "shift" }));
  });
  await sleep(700);
  const spot = await page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const engine = s.getEngine();
    const canvas = engine.getRenderingCanvas();
    const rect = canvas.getBoundingClientRect();
    const sx = engine.getRenderWidth() / rect.width;
    const sy = engine.getRenderHeight() / rect.height;
    const node = s.getTransformNodeByName("arenaLootBox");
    if (!node) return null;
    // Project the box centre (Vector3/Matrix statics via constructors — the
    // page has no BABYLON global, ES modules).
    const pos = node.getAbsolutePosition().clone();
    pos.y += 0.5;
    const V3 = pos.constructor;
    const M = s.getTransformMatrix().constructor;
    const w = engine.getRenderWidth();
    const hgt = engine.getRenderHeight();
    s.updateTransformMatrix();
    const p = V3.Project(pos, M.Identity(), s.getTransformMatrix(), s.activeCamera.viewport.toGlobal(w, hgt));
    const px = (p.x / w) * rect.width;
    const py = (p.y / hgt) * rect.height;
    // Probe around the projected point for a pixel that actually picks the box.
    const underBox = (m) => {
      for (let n = m; n; n = n.parent) if (n.name === "arenaLootBox") return true;
      return false;
    };
    for (let r = 0; r <= 60; r += 6) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        const cx = px + Math.cos(a) * r;
        const cy = py + Math.sin(a) * r;
        if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) continue;
        const hit = s.pick(cx * sx, cy * sy);
        if (hit?.hit && hit.pickedMesh && underBox(hit.pickedMesh)) {
          return { x: rect.left + cx, y: rect.top + cy };
        }
        if (r === 0) break;
      }
    }
    return null;
  });
  if (!spot) fail("could not find the loot box on screen to click");
  else {
    await page.mouse.click(spot.x, spot.y);
    await sleep(1_000);
    const collected = await page.evaluate(() => ({
      panel: !!document.querySelector("#loot"),
      boxGone: !window.psyrena.manager.active?.getTransformNodeByName?.("arenaLootBox"),
    }));
    if (!collected.panel) fail("clicking the box did not open the loot panel");
    if (!collected.boxGone) fail("loot box still in the scene after collecting");
    console.log("… box clicked: loot panel open, box gone");
    await page.screenshot({ path: `${SHOTS}/collected.png` });
  }

  // ==== 6. walk into the return portal → village, no popup, cache by NPC ====
  // Close the panel WITHOUT opening the cache row: the ledger keeps the box
  // unopened, so the hub's unclaimed-cache prop must pick it up.
  await page.evaluate(() => document.querySelector("#loot .close")?.click());
  await sleep(400);
  await page.evaluate(() => {
    performance.clearResourceTimings();
    const s = window.psyrena.manager.active;
    const h = s.getTransformNodeByName("arenaHero").position;
    // Portal centre — past the loot cache, same side of the boss.
    const tx = 5.6, tz = 2.2;
    s.activeCamera.alpha = Math.atan2(-(tz - h.z), -(tx - h.x));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" }));
  });
  const reachedVillage = await page.waitForFunction(
    () => !document.getElementById("bossFrame"),
    { timeout: 30_000, polling: 250 }
  ).then(() => true).catch(() => false);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "w" })));
  if (!reachedVillage) fail("walking into the return portal never left the arena");
  await page.waitForFunction(
    () => !!window.psyrena.manager.active?.getNodeByName?.("unclaimedCache"),
    { timeout: 120_000, polling: 500 }
  ).catch(() => fail("unclaimed-cache prop missing by the queue terminal after leaving loot behind"));
  await sleep(1_000);
  const home = await page.evaluate(() => ({
    overlay: !!document.querySelector("#loot"),
    ost: performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n.includes(".mp3")),
  }));
  if (home.overlay) fail("no popup may ride the portal into the village");
  if (!home.ost.some((n) => n.includes("firelight_1"))) {
    fail(`village should resume the chosen track firelight_1 (got ${home.ost.join(", ")})`);
  }
  console.log("… portal walk-in: village up, no popup, cache waiting by the NPC, chosen OST resumed");
  await page.screenshot({ path: `${SHOTS}/portal-home.png` });

  if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(" | ")}`);
  if (process.exitCode !== 1) console.log(`\nLOOT-FLOW E2E PASSED — screenshots in ${SHOTS}`);
} finally {
  await browser.close();
}
