/**
 * Browser smoke test for Pavlov as a playable hero (dev tool, not shipped).
 *
 * Drives the real client against a running vite dev server and verifies the
 * wiring the headless sim cannot see:
 *  - the hero picker offers Pavlov unlocked, and entering as him boots the hub
 *  - the hub HUD wears his portrait and the bar wears HIS kit (NS bell, UCS)
 *  - the arena mounts his kit, casts reach the sim (threat moves on key "1")
 *  - key "4" toggles Discrimination (stance buff tile appears and clears)
 *
 * The conditioning loop itself is covered by tools/sim-check.mjs scenario 5 —
 * this test is about the profile → registry → bar → sim plumbing.
 *
 * Run: npx vite --port 5199 &  then  E2E_URL=http://localhost:5199/ CHROME_GPU=1 node tools/pavlov-smoke-e2e.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5199/";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/psyrena-pavlov-e2e";
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

let page;
try {
  page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warn") console.log(`[page ${m.type()}]`, m.text());
  });

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ---- auth: login → pick PAVLOV → enter -----------------------------------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await page.click("#auth button.cta");
  // The one-page intro guide sits between login and the picker every time
  // (authFlow.ts, 2026-08-07) — click its Continue to reach the hero tiles.
  await page.waitForFunction(
    () => {
      if (document.querySelector("#auth .hero")) return true;
      const go = [...document.querySelectorAll("#auth button.cta")].find((b) =>
        /continue/i.test(b.textContent ?? "")
      );
      if (go) go.click();
      return false;
    },
    { timeout: 20_000, polling: 500 }
  );
  const pavlovTile = await page.evaluateHandle(() => {
    const tiles = [...document.querySelectorAll("#auth .hero")];
    return tiles.find((t) => t.textContent?.includes("Pavlov")) ?? null;
  });
  const tileState = await page.evaluate((el) => (el ? { locked: el.classList.contains("locked") } : null), pavlovTile);
  if (!tileState) fail("no Pavlov tile in the hero picker");
  else if (tileState.locked) fail("Pavlov tile is LOCKED — server unlock sweep did not run");
  await pavlovTile.asElement().click();
  await sleep(300);
  const enter = await page.evaluateHandle(() => {
    return [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent ?? "")) ?? null;
  });
  await enter.asElement().click();

  // ---- village: boot done, HIS portrait, HIS bar ---------------------------
  await page.waitForFunction(() => window.psyrena?.profile !== undefined, { timeout: 240_000 });
  const profileHero = await page.evaluate(() => window.psyrena.profile.selectedHero);
  if (profileHero !== "pavlov") fail(`entered as ${profileHero}, expected pavlov`);
  // The basic button's face is the live beat readout (setBeat rewrites it),
  // so the stable fingerprints of Pavlov's bar are the skill slots.
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("UCS")),
    { timeout: 60_000 }
  );
  const hubBar = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    return {
      ucs: texts.some((t) => t.includes("UCS")),
      generalization: texts.some((t) => t.includes("Generalization")),
      extinction: texts.some((t) => t.includes("Extinction")),
      freudStages: texts.some((t) => t.includes("Oral")),
    };
  });
  if (!hubBar.ucs || !hubBar.generalization || !hubBar.extinction) {
    fail(`hub bar is missing Pavlov slots: ${JSON.stringify(hubBar)}`);
  }
  if (hubBar.freudStages) fail("hub bar still shows Freud's stages while Pavlov is selected");
  const portrait = await page.evaluate(
    () => [...document.querySelectorAll("img")].some((i) => i.src.includes("pavlov_concept"))
  );
  if (!portrait) fail("HUD portrait is not pavlov_concept.webp");
  await page.screenshot({ path: `${SHOTS}/1-village-pavlov-bar.png` });
  console.log("village: Pavlov bar + portrait OK");

  // ---- arena: kit mounted, casts reach the sim, Tab stance -----------------
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" })));
  await page.waitForFunction(() => window.psyrenaFight !== undefined, { timeout: 120_000 });
  // Ride out the idle warm-up until the fight engages.
  await page.waitForFunction(() => window.psyrenaFight.snapshot().phase !== "idle", { timeout: 60_000 });
  const playerRow = await page.evaluate(
    () => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer)
  );
  if (!playerRow || playerRow.name !== "Pavlov") fail(`arena player is ${playerRow?.name}, expected Pavlov`);

  // Cast, then WAIT FOR THE THREAT TO MOVE rather than sleeping a fixed
  // 1700 ms. A UCS only banks threat when its projectile lands, and under
  // software GL (no CHROME_GPU) the flight takes several seconds — the fixed
  // sleep made this read as "casts not reaching the sim" when the cast was
  // simply still in the air.
  const threatBefore = playerRow.value;
  const playerThreat = () =>
    page.evaluate(() => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer)?.value ?? 0);
  let threatAfter = threatBefore;
  for (let i = 0; i < 6 && threatAfter <= threatBefore; i++) {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })));
    for (let w = 0; w < 10 && threatAfter <= threatBefore; w++) {
      await sleep(700);
      threatAfter = await playerThreat();
    }
  }
  if (!(threatAfter > threatBefore)) fail("UCS casts on key 1 banked no threat — casts not reaching the sim");
  console.log(`arena: UCS casts landed (threat ${Math.round(threatBefore)} → ${Math.round(threatAfter)})`);

  const stanceTile = () =>
    page.evaluate(() => {
      const now = performance.now();
      return window.psyrena.player.buffs.some((b) => b.until > now && /Discrimination/.test(b.name));
    });
  // Discrimination moved off Tab onto a real dock slot bound to "4"
  // (2026-08-04) — Tab is the browser's focus-walk key and a canvas game
  // fighting the page for it lost the press whenever anything else took focus.
  const stanceSlot = await page.evaluate(() =>
    [...document.querySelectorAll("#action-bar button")].some((b) =>
      /Discrimination/.test(b.textContent ?? "")
    )
  );
  if (!stanceSlot) fail("Discrimination is not mounted as a bar slot");
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "4" })));
  await sleep(300);
  if (!(await stanceTile())) fail('key "4" did not raise the Discrimination stance tile');
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "4" })));
  await sleep(300);
  if (await stanceTile()) fail('second "4" did not drop the Discrimination stance tile');
  console.log('arena: Discrimination mounted on the dock and toggles on "4"');

  // The bell is FLAT now: its button is a plain "NS Bell" face, not the
  // cycling stance readout Freud's wears, and the beat moved to a pill.
  const basicFace = await page.evaluate(() => {
    const b = [...document.querySelectorAll("#action-bar button")].find((el) =>
      /LMB/.test(el.textContent ?? "")
    );
    return (b?.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  if (/Orienting|Arousal|Anticipation|Attack ×/.test(basicFace)) {
    fail(`the flat bell button still wears the beat readout: "${basicFace}"`);
  }
  console.log(`arena: bell button is a plain face — "${basicFace}"`);
  await page.screenshot({ path: `${SHOTS}/2-arena-pavlov.png` });

  const fatal = pageErrors.filter((e) => !/ResizeObserver/.test(e));
  if (fatal.length) fail(`page errors: ${fatal.join(" | ")}`);
  console.log(process.exitCode ? "SMOKE TEST FAILED" : "PAVLOV SMOKE TEST: ALL CHECKS PASSED");
} catch (e) {
  process.exitCode = 1;
  console.error("DRIVER ERROR:", e.message);
  if (page) {
    await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
    const state = await page
      .evaluate(() => ({
        boot: document.getElementById("boot")?.className ?? "(no #boot)",
        auth: Boolean(document.getElementById("auth")),
        profile: window.psyrena?.profile?.selectedHero ?? null,
        buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, 30),
      }))
      .catch(() => null);
    console.error("PAGE STATE:", JSON.stringify(state, null, 1));
  }
} finally {
  await browser.close();
}
