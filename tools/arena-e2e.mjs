/**
 * Browser E2E for the boss fight (dev tool, not shipped).
 * Drives the real client in headless Chromium against the running vite dev
 * server (localhost:5173): logs in, enters the arena, and verifies the fight
 * loop end-to-end — world-chat phase warnings, auto-aimed casts moving boss
 * HP, buff indicators, the threat table, and the P2 answer mechanic.
 *
 * Run: node tools/arena-e2e.mjs   (needs `npm run dev` already serving)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5173/";
// Overridable: a fresh worktree DB re-seeds frank with the dev default.
const PASS = process.env.E2E_FRANK_PASS ?? PW;
const SHOTS = "/tmp/psyrena-e2e";
mkdirSync(SHOTS, { recursive: true });

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--mute-audio",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("requestfailed", (r) => console.log("  [net] failed:", r.url().slice(0, 120)));
  // The fight is the SERVER's for a ranked run; the remote driver says so out
  // loud when it cannot open or keep the session, and that line is the first
  // thing to look at when the assertions below start missing buffs.
  page.on("console", (m) => {
    if (m.text().includes("[fight]")) console.log("  [fight]", m.text().slice(0, 160));
  });
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`  [net] ${r.status()}:`, r.url().slice(0, 120));
  });

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ---- auth: login → hero picker → enter ----------------------------------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PASS);
  await page.click("#auth button.cta");
  // The intro guide (WELCOME TO PSYRENA … Continue) sits between login and
  // the picker — authFlow.ts runAuthFlow.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#auth button.cta")].some((b) =>
        b.textContent.includes("Continue")
      ),
    { timeout: 20_000, polling: 200 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => b.textContent.includes("Continue"))
      .click();
  });
  await page.waitForSelector("#auth .hero", { timeout: 20_000 });
  await page.click("#auth .hero:not(.locked)");
  await Promise.all([
    page.waitForFunction(() => window.psyrena?.manager, { timeout: 60_000, polling: 500 }),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("#auth button.cta")].find((b) =>
        b.textContent.includes("Enter Psyrena")
      );
      btn.click();
    }),
  ]);
  console.log("… logged in, village up — switching to arena");
  await page.evaluate(() => window.psyrena.go("arena"));

  // ---- arena: fight boots ---------------------------------------------------
  await page.waitForFunction(
    () => !!document.getElementById("bossFrame"),
    { timeout: 90_000, polling: 500 }
  );
  console.log("… boss frame visible");

  const hpText = () => page.evaluate(() => document.getElementById("bossFrameHp")?.textContent ?? "");
  const bossHpK = async () => {
    const m = /([\d.]+)k/.exec(await hpText());
    return m ? Number(m[1]) : null;
  };
  const buffNames = () => page.evaluate(() => window.psyrena.player.buffs.map((b) => b.name));

  // Idle is 8 s, then P1. Give the fight a moment to engage and be announced.
  await sleep(11_000);
  const hp0 = await bossHpK();
  console.log(`… engaged; boss HP ${hp0}k (${await hpText()})`);
  if (hp0 === null || hp0 > 90) fail(`unexpected boss HP readout: ${await hpText()}`);

  // Cast palette (key 1) + E/R/F — assert each buff right after its cast, the
  // short ones expire before a late read would see them.
  await page.keyboard.press("1");
  await sleep(1_700);
  await page.keyboard.press("e");
  await sleep(800);
  let buffs = await buffNames();
  if (!buffs.some((b) => b.includes("Defense Mechanism"))) fail("E buff indicator missing");
  else console.log("… E buff live:", buffs.find((b) => b.includes("Defense Mechanism")));
  await sleep(1_000);
  await page.keyboard.press("r");
  await sleep(800);
  buffs = await buffNames();
  if (!buffs.some((b) => b.includes("Free Association"))) fail("R buff indicator missing");
  else console.log("… R buff live");
  await sleep(1_000);
  await page.keyboard.press("f");
  await sleep(800);
  buffs = await buffNames();
  if (!buffs.some((b) => b.includes("Dream Analysis"))) fail("F buff indicator missing");
  else console.log("… F buff live");
  await sleep(1_000);
  await page.keyboard.press("1");
  await page.mouse.click(640, 400); // LMB basic attack (tap)
  await sleep(2_500);

  const hp1 = await bossHpK();
  console.log(`… after casts, boss HP ${hp1}k`);
  if (!(hp1 !== null && hp0 !== null && hp1 < hp0)) fail("boss HP did not drop across casts");

  // Threat table: solo fight — the player is the only row. A ranked run is
  // the SERVER's fight now, and it names its actors after ACCOUNTS ("frank"),
  // because a party has to be able to tell three players apart; the offline
  // sim still names its single row after the hero. Either is the player.
  const threatOk = await page.evaluate(() => {
    const el = document.getElementById("bossFrame");
    return (
      el &&
      (el.textContent.includes("frank") || el.textContent.includes("Freud")) &&
      !el.textContent.includes("Piaget")
    );
  });
  if (!threatOk) fail("threat table should list the player and no sim allies");
  await page.screenshot({ path: `${SHOTS}/p1.png` });
  console.log("… P1 verified (screenshot p1.png) — waiting for the P2 warning");

  // P1 lasts 60 s: warning at ~55 s after phase start, P2 at ~60 s.
  await page.waitForFunction(
    () => document.body.textContent.includes("in 5 seconds"),
    { timeout: 70_000, polling: 500 }
  );
  console.log("… 5-second phase warning fired");
  await page.waitForFunction(
    () => document.body.textContent.includes("Shapeshift —"),
    { timeout: 15_000, polling: 500 }
  );
  console.log("… P2 Shapeshift announced");
  await sleep(1_500);
  await page.screenshot({ path: `${SHOTS}/p2.png` });

  // Answer the current form WRONG on purpose to prove Fixation fires. The
  // wrong key must differ from the right answer: key 5 unless we're ON stage
  // 4 (then key 1 is wrong).
  const snapBefore5 = await page.evaluate(() => window.psyrenaFight?.snapshot());
  const wrongKey = snapBefore5.p2Stage === 4 ? "1" : "5";
  console.log(`… pre-cast state: phase=${snapBefore5.phase} p2Stage=${snapBefore5.p2Stage} — wrong key ${wrongKey}`);
  await page.keyboard.press(wrongKey);
  await sleep(300);
  const snapAfter5 = await page.evaluate(() => window.psyrenaFight?.snapshot());
  console.log(`… post-cast state: phase=${snapAfter5.phase} p2Stage=${snapAfter5.p2Stage} marks=${snapAfter5.marks}`);
  await sleep(700);
  const debuff = (await buffNames()).find((b) => b.includes("Fixation"));
  if (!debuff) fail("wrong P2 answer produced no Fixation debuff");
  else console.log("… Fixation debuff live:", debuff);
  await page.screenshot({ path: `${SHOTS}/p2-fixation.png` });

  // Answer correctly: read the live stage and press its matching palette key.
  // Stages flip every 6 s and software rendering makes every step slow, so
  // retry with a fresh read until one lands before the phase ends.
  await sleep(1_600); // let the fixation-era GCD clear
  let wounds = null;
  for (let attempt = 0; attempt < 4 && !wounds; attempt++) {
    const stageNow = await page.evaluate(() => window.psyrenaFight?.snapshot()?.p2Stage ?? -1);
    if (stageNow < 0) break; // P2 ended
    const key = String(stageNow + 1);
    console.log(`… answering live stage ${stageNow} with key ${key}`);
    await page.keyboard.press(key);
    await sleep(2_200);
    const ft = await page.evaluate(() => document.getElementById("bossFrame").textContent);
    wounds = /Wounds ×\d/.exec(ft)?.[0] ?? null;
    if (!wounds) await sleep(1_600); // GCD before retry
  }
  if (!wounds) fail("correct P2 answer granted no wound stack");
  else console.log("… wound stack live:", wounds);

  // Full announcement history: open the chat panel (lobby view shows the last
  // 50 world lines) and read the whole feed.
  await page.keyboard.press("Enter");
  await sleep(600);
  const feed = await page.evaluate(() => document.body.textContent);
  for (const want of ["engaged", "in 5 seconds", "Shapeshift", "misreads the form"]) {
    if (!feed.includes(want)) fail(`announcement missing from world feed: "${want}"`);
  }
  await page.keyboard.press("Escape");

  if (pageErrors.length > 0) {
    console.log("page errors:", pageErrors.slice(0, 8));
    fail(`${pageErrors.length} page error(s)`);
  }
  if (process.exitCode !== 1) console.log("\nE2E PASSED — screenshots in", SHOTS);
} finally {
  await browser.close();
}
