/**
 * Browser E2E for the gear/pet progression UI (dev tool, not shipped).
 *
 * Drives the real client against a running vite dev server and verifies the
 * docs/09 surfaces on BOTH form factors:
 *  - Equipment panel: five armor slots + the SET BONUS tile; forging all
 *    five to Emergent flips the set readout to +5% damage (server round-trip)
 *  - Pet Park: shard counter, unowned silhouettes with adopt-progress
 *    buttons, the hero-exclusive tile, and a live pet UPGRADE (Druzhok on
 *    Pavlov: Level up · 200 ◈ → the level pip fills)
 *  - Loot: a fight-result box minted via the API opens with the Imaginz
 *    reveal AND the shard line; the Pet Park counter then reflects it
 *  - Mobile (844×390 landscape, coarse pointer): both panels go full-bleed with no
 *    horizontal scroll, per the panels' shared small-screen treatment
 *
 * Run: E2E_URL=http://localhost:5341/ node tools/gear-pet-panels-e2e.mjs
 * (SwiftShader works but is slow; pass CHROME_GPU=1 on a real GPU box.)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5173/";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/psyrena-gearpet-e2e";
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

  // ---- auth: login → hero picker (Pavlov — Druzhok's hero) → enter --------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await Promise.all([
    page.waitForSelector("#auth .hero", { timeout: 15_000 }),
    page.click("#auth button.cta"),
  ]);
  const pickedPavlov = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#auth .hero:not(.locked)")];
    const pavlov = tiles.find((t) => /pavlov/i.test(t.textContent ?? ""));
    (pavlov ?? tiles[0])?.click();
    return !!pavlov;
  });
  await Promise.all([
    page.waitForFunction(() => window.psyrena?.manager, { timeout: 120_000, polling: 500 }),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("#auth button.cta")].find((b) =>
        b.textContent.includes("Enter Psyrena")
      );
      btn.click();
    }),
  ]);
  console.log(`… logged in as ${pickedPavlov ? "Pavlov" : "first unlocked hero"}, village up`);
  await sleep(2000); // village settle + economy/loadout sync

  // ==== 1. Equipment panel: slots + set tile, forge to a full Emergent set ==
  await page.click('[aria-label="Gear (G)"]');
  await page.waitForSelector("#gear .slot", { timeout: 10_000 });
  await sleep(600); // ledger fetch
  const slotCount = await page.$$eval("#gear .slot", (n) => n.length);
  if (slotCount !== 6) fail(`expected 5 armor slots + set tile = 6, got ${slotCount}`);
  const setBefore = await page.evaluate(
    () => [...document.querySelectorAll("#gear .slot")].at(-1)?.textContent ?? ""
  );
  if (!/Set Bonus/i.test(setBefore)) fail(`last tile is not the set readout: "${setBefore}"`);
  if (!/\+0% damage/.test(setBefore)) fail(`fresh account set bonus should read +0%: "${setBefore}"`);
  await page.screenshot({ path: `${SHOTS}/desktop-gear-fresh.png` });

  // Forge each armor slot once (200 ◈ × 5 of the 10k seed) → Emergent set.
  for (let i = 0; i < 5; i++) {
    const clicked = await page.evaluate((idx) => {
      const slot = document.querySelectorAll("#gear .slot")[idx];
      const btn = slot?.querySelector("button.up:not(:disabled)");
      if (!btn) return false;
      btn.click();
      return true;
    }, i);
    if (!clicked) fail(`slot ${i} had no live Forge button`);
    await sleep(500); // round-trip + in-place re-render
  }
  await page.waitForFunction(
    () => /\+5% damage/.test([...document.querySelectorAll("#gear .slot")].at(-1)?.textContent ?? ""),
    { timeout: 8_000 }
  ).catch(() => fail("set tile never flipped to +5% after forging all five slots"));
  console.log("… gear: 5 slots forged, set bonus reads +5% (Emergent set)");
  await page.screenshot({ path: `${SHOTS}/desktop-gear-emergent.png` });
  await page.keyboard.press("Escape");

  // ==== 2. Pet Park: shards, silhouettes, live Druzhok upgrade ==============
  await page.click('[aria-label="Pets — Pet Park"]');
  await page.waitForSelector("#pet-park .pet", { timeout: 10_000 });
  await sleep(700); // loadout sync
  const park = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("#pet-park .pet")];
    return {
      shards: document.querySelector("#pet-park .shards")?.textContent ?? "",
      unowned: tiles.filter((t) => t.classList.contains("unowned")).length,
      adoptLabels: tiles.map((t) => t.querySelector(".act.adopt")?.textContent ?? "").filter(Boolean),
      druzhok: tiles.find((t) => /druzhok/i.test(t.textContent ?? ""))?.textContent ?? "",
    };
  });
  if (!/✦ 0/.test(park.shards)) fail(`fresh account shard chip should read ✦ 0: "${park.shards}"`);
  if (park.unowned !== 6) fail(`expected 6 unowned pool silhouettes, got ${park.unowned}`);
  if (!park.adoptLabels.every((l) => /0\/60 ✦/.test(l))) {
    fail(`adopt buttons should show 0/60 ✦ progress: ${JSON.stringify(park.adoptLabels)}`);
  }
  await page.screenshot({ path: `${SHOTS}/desktop-petpark-fresh.png` });

  if (pickedPavlov) {
    if (!/Level up · 200/.test(park.druzhok)) {
      fail(`Druzhok on Pavlov should offer Level up · 200 ◈: "${park.druzhok}"`);
    }
    const upgraded = await page.evaluate(() => {
      const tile = [...document.querySelectorAll("#pet-park .pet")].find((t) =>
        /druzhok/i.test(t.textContent ?? "")
      );
      const btn = tile?.querySelector("button.act:not(:disabled)");
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!upgraded) fail("Druzhok's upgrade button was not clickable");
    await page.waitForFunction(
      () => {
        const tile = [...document.querySelectorAll("#pet-park .pet")].find((t) =>
          /druzhok/i.test(t.textContent ?? "")
        );
        return /●○○/.test(tile?.querySelector(".lv")?.textContent ?? "");
      },
      { timeout: 8_000 }
    ).catch(() => fail("Druzhok's level pip never filled after the upgrade"));
    console.log("… pet park: shards ✦ 0, six silhouettes, Druzhok upgraded to level 1");
    await page.screenshot({ path: `${SHOTS}/desktop-petpark-upgraded.png` });
  }
  await page.keyboard.press("Escape");

  // ==== 3. Loot: mint a standard-win box via the API, open it ==============
  const minted = await page.evaluate(async () => {
    const res = await fetch("/api/fight/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        win: true, difficulty: "standard", durationMs: 300_000,
        dps: 250, healing: 900, damageTaken: 400,
      }),
    });
    return res.json();
  });
  if (!minted.lootBox) fail(`fight result minted no loot box: ${JSON.stringify(minted)}`);
  await page.click('[aria-label="Gear (G)"]');
  await page.waitForSelector("#gear .caches", { timeout: 10_000 }).catch(() => fail("Caches button never appeared"));
  await page.click("#gear .caches");
  await page.waitForSelector("#loot .row button.mini", { timeout: 10_000 });
  await page.click("#loot .row button.mini");
  await page.waitForSelector("#loot .reveal", { timeout: 10_000 });
  const reveal = await page.$eval("#loot .row", (n) => n.textContent ?? "");
  if (!/\+\d/.test(reveal)) fail(`no Imaginz reveal: "${reveal}"`);
  if (!/pet shards/.test(reveal)) fail(`no shard line in the reveal: "${reveal}"`);
  console.log(`… loot: cache opened — "${reveal.replaceAll("\n", " ").trim()}"`);
  await page.screenshot({ path: `${SHOTS}/desktop-loot-reveal.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Pet Park now shows the shards the cache paid.
  await page.click('[aria-label="Pets — Pet Park"]');
  await page.waitForFunction(
    () => /✦ [1-9]/.test(document.querySelector("#pet-park .shards")?.textContent ?? ""),
    { timeout: 8_000 }
  ).catch(() => fail("shard chip never picked up the cache's shards"));
  await page.keyboard.press("Escape");

  // ==== 4. Mobile (844×390 landscape, coarse pointer): full-bleed, no sideways scroll =
  // A FRESH page rather than a mid-session viewport flip: the dock and HUD
  // size themselves off the control scheme detected at build time, so a live
  // resize tests a hybrid no real device produces. Same browser = same
  // session cookie; the auth flow replays against the already-picked hero.
  const mob = await browser.newPage();
  await mob.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  const mobErrors = [];
  mob.on("pageerror", (e) => mobErrors.push(String(e)));
  await mob.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await mob.waitForSelector('input[placeholder="username"], #auth button.cta', { timeout: 30_000 });
  if (await mob.$('input[placeholder="username"]')) {
    await mob.type('input[placeholder="username"]', USER);
    await mob.type('input[placeholder="password"]', PW);
    await Promise.all([
      mob.waitForSelector("#auth .hero", { timeout: 15_000 }),
      mob.click("#auth button.cta"),
    ]);
    await mob.evaluate(() => {
      const tiles = [...document.querySelectorAll("#auth .hero:not(.locked)")];
      (tiles.find((t) => /pavlov/i.test(t.textContent ?? "")) ?? tiles[0])?.click();
    });
  }
  await Promise.all([
    mob.waitForFunction(() => window.psyrena?.manager, { timeout: 120_000, polling: 500 }),
    mob.evaluate(() => {
      const btn = [...document.querySelectorAll("#auth button.cta")].find((b) =>
        b.textContent.includes("Enter Psyrena")
      );
      btn?.click();
    }),
  ]);
  await sleep(2000);
  for (const [label, selector, shot] of [
    ["gear", '[aria-label="Gear (G)"]', "mobile-gear.png"],
    ["pet park", '[aria-label="Pets — Pet Park"]', "mobile-petpark.png"],
  ]) {
    await mob.tap(selector).catch(() => mob.click(selector));
    const panelId = label === "gear" ? "#gear" : "#pet-park";
    await mob.waitForSelector(`${panelId} .card`, { timeout: 10_000 });
    await sleep(600);
    const m = await mob.evaluate((id) => {
      const card = document.querySelector(`${id} .card`);
      const r = card.getBoundingClientRect();
      return {
        w: r.width, h: r.height,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    }, panelId);
    if (Math.abs(m.w - m.vw) > 2 || Math.abs(m.h - m.vh) > 2) {
      fail(`${label} card is not full-bleed on mobile: ${m.w}×${m.h} in ${m.vw}×${m.vh}`);
    }
    if (m.overflowX) fail(`${label} panel causes horizontal scroll on mobile`);
    await mob.screenshot({ path: `${SHOTS}/${shot}` });
    await mob.keyboard.press("Escape");
  }
  const mobReal = mobErrors.filter((e) => !/ResizeObserver|AbortError/.test(e));
  if (mobReal.length) fail(`mobile page errors: ${mobReal.join(" | ")}`);
  console.log("… mobile: both panels full-bleed at 844×390 landscape, no horizontal scroll");
  await mob.close();

  const realErrors = pageErrors.filter((e) => !/ResizeObserver|AbortError/.test(e));
  if (realErrors.length) fail(`page errors: ${realErrors.join(" | ")}`);

  console.log(process.exitCode ? "\nGEAR/PET PANELS E2E: FAILURES ABOVE" : "\nGEAR/PET PANELS E2E: ALL CHECKS PASSED");
} finally {
  await browser.close();
}
