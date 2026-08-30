/**
 * Browser smoke test for Skinner as a playable healer (dev tool, not shipped).
 *
 * Drives the real client against a running vite dev server and verifies the
 * wiring the headless sim cannot see:
 *  - the picker offers Skinner as a Healer (unlocked via the first-clear
 *    grant, exercised over the API first), and entering as him boots the hub
 *  - the hub bar wears HIS kit (four schedules + toggles + Shaping), the HUD
 *    wears his portrait, skinner.glb loads, and his VO pack actually fetches
 *    (idle line + cast line — the "immediately after cast" requirement)
 *  - the arena mounts the kit: FR overheal converts to Amp, E/R repaint
 *    their quadrant faces, basics bank threat, Response Strength and Shaping
 *    raise buff tiles, and no /assets/ui request 404s (icon audit)
 *  - the touch layout stacks the four schedules like Freud's palette
 *
 * The operant engine itself is covered by tools/sim-check.mjs scenarios 6-7 —
 * this test is about profile → registry → bar → sim → HUD plumbing.
 *
 * Run: PSYRENA_DB=/tmp/rolequeue.db npx vite --port 5297 &
 *      E2E_URL=http://localhost:5297/ CHROME_GPU=1 node tools/skinner-smoke-e2e.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5297/";
const API = URL.replace(/\/$/, "");
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/psyrena-skinner-e2e";
mkdirSync(SHOTS, { recursive: true });

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API pre-step: make sure frank owns Skinner (the first-clear grant) ----
{
  const login = await fetch(`${API}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "frank", password: PW }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  await fetch(`${API}/api/fight/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ win: true, difficulty: "standard", durationMs: 60_000, dps: 100, healing: 0, damageTaken: 0 }),
  });
}

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
  const voiceFetches = [];
  const assetFails = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/assets/heroes/voice/skinner/") && (r.status() === 200 || r.status() === 206)) {
      voiceFetches.push(u.split("/").pop());
    }
    if (u.includes("/assets/") && r.status() >= 400) assetFails.push(`${r.status} ${u}`);
  });

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ---- auth: login → pick SKINNER (Healer, unlocked) → enter ---------------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await Promise.all([
    page.waitForSelector("#auth .hero", { timeout: 15_000 }),
    page.click("#auth button.cta"),
  ]);
  const tileInfo = await page.evaluate(() => {
    const t = [...document.querySelectorAll("#auth .hero")].find((x) => x.textContent?.includes("Skinner"));
    return t ? { locked: t.classList.contains("locked"), text: t.textContent ?? "" } : null;
  });
  if (!tileInfo) fail("no Skinner tile in the hero picker");
  else {
    if (tileInfo.locked) fail("Skinner tile is LOCKED after the first-clear grant");
    if (!/healer/i.test(tileInfo.text)) fail(`Skinner tile does not read Healer: "${tileInfo.text}"`);
  }
  const skinnerTile = await page.evaluateHandle(
    () => [...document.querySelectorAll("#auth .hero")].find((x) => x.textContent?.includes("Skinner")) ?? null
  );
  await skinnerTile.asElement().click();
  await sleep(300);
  const enter = await page.evaluateHandle(
    () => [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent ?? "")) ?? null
  );
  await enter.asElement().click();

  // ---- village: HIS bar, portrait, model, voice ----------------------------
  await page.waitForFunction(() => window.psyrena?.profile !== undefined, { timeout: 240_000 });
  const profileHero = await page.evaluate(() => window.psyrena.profile.selectedHero);
  if (profileHero !== "skinner") fail(`entered as ${profileHero}, expected skinner`);
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Fixed Ratio")),
    { timeout: 60_000 }
  );
  const hubBar = await page.evaluate(() => {
    const texts = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    const has = (s) => texts.some((t) => t.includes(s));
    return {
      fr: has("Fixed Ratio"), vr: has("Variable Ratio"), fi: has("Fixed Interval"),
      vi: has("Variable Interval"), e: has("Negative"), r: has("Punish"),
      f: has("Shaping"), freud: has("Oral"), pavlov: has("UCS"),
    };
  });
  if (!hubBar.fr || !hubBar.vr || !hubBar.fi || !hubBar.vi || !hubBar.e || !hubBar.r || !hubBar.f) {
    fail(`hub bar is missing Skinner slots: ${JSON.stringify(hubBar)}`);
  }
  if (hubBar.freud || hubBar.pavlov) fail("hub bar shows another hero's kit while Skinner is selected");
  const portrait = await page.evaluate(
    () => [...document.querySelectorAll("img")].some((i) => i.src.includes("skinner_concept"))
  );
  if (!portrait) fail("HUD portrait is not skinner_concept.webp");
  const iconFaces = await page.evaluate(() =>
    [...document.querySelectorAll("[data-slot-icon]")].filter((el) =>
      (el.style.background ?? "").includes("/assets/ui/skills/skinner/")
    ).length
  );
  if (iconFaces < 5) fail(`only ${iconFaces} bar faces wear skinner icons`);
  console.log(`village: Skinner bar + portrait + ${iconFaces} icon faces OK`);

  // Cast VO must land ON the press: key "1" is Fixed Ratio in the hub too.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })));
  await sleep(2_500);
  if (!voiceFetches.some((f) => f?.startsWith("cast_fixed_ratio"))) {
    fail(`FR cast fetched no cast_fixed_ratio VO (got: ${voiceFetches.join(", ") || "none"})`);
  }
  // Idle VO: first musing arrives after ~8 s of standing still.
  const idleDeadline = Date.now() + 45_000;
  while (Date.now() < idleDeadline && !voiceFetches.some((f) => f?.startsWith("idle_"))) await sleep(1_000);
  if (!voiceFetches.some((f) => f?.startsWith("idle_"))) fail("no idle VO fetched after 45 s at rest");
  console.log(`village: VO fetches — ${[...new Set(voiceFetches)].join(", ")}`);
  await page.screenshot({ path: `${SHOTS}/1-village-skinner-bar.png` });

  // ---- arena ---------------------------------------------------------------
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" })));
  await page.waitForFunction(() => window.psyrenaFight !== undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.psyrenaFight.snapshot().phase !== "idle", { timeout: 60_000 });
  const playerRow = await page.evaluate(() => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer));
  if (!playerRow || playerRow.name !== "Skinner") fail(`arena player is ${playerRow?.name}, expected Skinner`);

  // FR on a healthy bar → overheal → Team Amp: the healer's damage window.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })));
  let amp = 0;
  for (let w = 0; w < 10 && amp <= 0; w++) {
    await sleep(400);
    amp = await page.evaluate(() => window.psyrenaFight.snapshot().amp);
  }
  if (!(amp > 0)) fail("FR overheal produced no Team Amp");
  else console.log(`arena: FR overheal → Amp ${(amp * 100).toFixed(1)}%`);

  // E/R are ACTION faces: each button wears its own axis icon and the word
  // for the state a press will switch TO, so clicking "Positive" activates
  // Positive. The sim opens Positive/Reinforcement, so the bar opens
  // offering Negative and Punish.
  const barText = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#action-bar button")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ")).join(" | ")
    );
  const axisFace = (name) =>
    page.evaluate(
      (n) =>
        [...document.querySelectorAll("[data-slot-icon]")].filter((el) =>
          (el.style.background ?? "").includes(`/assets/ui/skills/skinner/${n}.webp`)
        ).length,
      name
    );
  if (!/Negative/.test(await barText()) || !/Punish/.test(await barText())) {
    fail("bar does not open offering Negative (E) and Punish (R)");
  }
  if ((await axisFace("contingency_negative")) !== 1 || (await axisFace("consequence_punishment")) !== 1) {
    fail("E/R do not open wearing their own axis action icons");
  }
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" })));
  await sleep(400);
  // Pressing E while it offers Negative activates Negative; the face now
  // offers Positive with the contingency axis's OWN icon (not R's, and not a
  // shared combo face).
  if (!/Positive/.test(await barText())) fail("after activating Negative, E does not offer Positive");
  if ((await axisFace("contingency_positive")) !== 1) {
    fail("E's face is not the contingency_positive action icon");
  }
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })));
  await sleep(400);
  if (!/Reinforce/.test(await barText())) fail("after activating Punish, R does not offer Reinforce");
  if ((await axisFace("consequence_reinforcement")) !== 1) {
    fail("R's face is not the consequence_reinforcement action icon");
  }
  const live = await page.evaluate(() => window.psyrenaFight.operant?.() ?? null);
  if (live && (live.contingency !== "negative" || live.consequence !== "punishment")) {
    fail(`sim state after E+R presses is ${JSON.stringify(live)}, expected negative/punishment`);
  }
  // Restore — each toggle sits on a 500 ms cooldown, so pace the presses.
  await sleep(600);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" })));
  await sleep(600);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })));
  await sleep(300);
  if ((await axisFace("contingency_negative")) !== 1 || (await axisFace("consequence_punishment")) !== 1) {
    fail("E/R faces did not restore to offering Negative/Punish");
  }
  console.log("arena: E/R action faces offer the flip and repaint per axis");

  // Basics bank threat (the click path — LMB never maps to a keydown).
  const threatBefore = await page.evaluate(
    () => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer)?.value ?? 0
  );
  const basicBtn = await page.evaluateHandle(
    () => [...document.querySelectorAll("#action-bar button")].find((b) => /Response/.test(b.textContent ?? "")) ?? null
  );
  if (!basicBtn.asElement()) fail("no Response Rate button on the arena bar");
  let threatAfter = threatBefore;
  for (let i = 0; i < 8 && threatAfter <= threatBefore; i++) {
    await basicBtn.asElement()?.click();
    for (let w = 0; w < 8 && threatAfter <= threatBefore; w++) {
      await sleep(600);
      threatAfter = await page.evaluate(
        () => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer)?.value ?? 0
      );
    }
  }
  if (!(threatAfter > threatBefore)) fail("Response Rate basics banked no threat");
  else console.log(`arena: basics landed (threat ${Math.round(threatBefore)} → ${Math.round(threatAfter)})`);

  // Response Strength: let the boss chip the bar, then feed pellets until the
  // tile shows — effective healing only, so it NEEDS the damage first.
  const hasBuff = (re) =>
    page.evaluate((src) => {
      const now = performance.now();
      return window.psyrena.player.buffs.some((b) => b.until > now && new RegExp(src).test(b.name));
    }, re.source);
  const rsDeadline = Date.now() + 60_000;
  while (Date.now() < rsDeadline && !(await hasBuff(/Response Strength/))) {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" })));
    await sleep(3_200);
  }
  if (!(await hasBuff(/Response Strength/))) fail("no Response Strength tile after a minute of pellets under fire");
  else console.log("arena: Response Strength tile up");

  // Shaping raises its own tile (and heals — covered by the sim scenarios).
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
  await sleep(600);
  if (!(await hasBuff(/Shaping/))) fail("Shaping cast raised no tile");
  await page.screenshot({ path: `${SHOTS}/2-arena-skinner.png` });

  // ---- practice booth: the same action-face flips through setOperant -------
  // The pit is where the quadrant matrix is meant to be learned, so its
  // buttons must repaint exactly as the arena's do (operantChanged wiring is
  // separate code — villageHub setOperant, not arenaCombat's onOperant).
  await page.evaluate(() => window.psyrena.go("practice"));
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-slot-icon]")].some(
      (el) => (el.style.background ?? "").includes("/assets/ui/skills/skinner/contingency_")
    ),
    { timeout: 120_000 }
  );
  await sleep(800);
  if ((await axisFace("contingency_negative")) !== 1 || (await axisFace("consequence_punishment")) !== 1) {
    fail("booth: E/R do not open offering Negative/Punish with their axis icons");
  }
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" })));
  await sleep(400);
  if ((await axisFace("contingency_positive")) !== 1) {
    fail("booth: activating Negative did not flip E's face to offer Positive");
  }
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })));
  await sleep(400);
  if ((await axisFace("consequence_reinforcement")) !== 1) {
    fail("booth: activating Punish did not flip R's face to offer Reinforce");
  }
  if (!/Positive/.test(await barText()) || !/Reinforce/.test(await barText())) {
    fail("booth: flipped faces do not wear the axis-word action labels");
  }
  console.log("booth: E/R action faces flip through setOperant");
  await page.screenshot({ path: `${SHOTS}/4-booth-skinner.png` });

  if (assetFails.length) fail(`asset 404s: ${[...new Set(assetFails)].join(" | ")}`);
  const fatal = pageErrors.filter((e) => !/ResizeObserver/.test(e));
  if (fatal.length) fail(`page errors: ${fatal.join(" | ")}`);

  // ---- mobile/touch layout: the schedules stack like Freud's palette -------
  // LANDSCAPE: the game is a landscape title and portrait boots into the
  // rotation gate ("rotation locked? play anyway") — that gate has its own
  // coverage; this test is about the touch bar.
  const mob = await browser.newPage();
  await mob.emulate({
    viewport: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await mob.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // If the rotation gate still fronts, take its bypass — the layout under it
  // is what this test asserts.
  await sleep(2_000);
  await mob.evaluate(() => {
    // In-page click, and only when actually VISIBLE — the gate button stays
    // in the DOM (display:none) in landscape, where ElementHandle.click()
    // throws "not clickable".
    const b = [...document.querySelectorAll("button")].find(
      (x) => /play anyway/i.test(x.textContent ?? "") && x.offsetParent !== null
    );
    b?.click();
  });
  // The session cookie may skip the login form, land on the picker, or boot
  // straight in — take whichever door opens. (The single-login rule kicks
  // the desktop tab either way; its checks are already done.)
  await mob.waitForFunction(
    () =>
      window.psyrena?.profile !== undefined ||
      !!document.querySelector('input[placeholder="username"]') ||
      !!document.querySelector("#auth .hero"),
    { timeout: 60_000 }
  );
  if (await mob.evaluate(() => !window.psyrena?.profile && !!document.querySelector('input[placeholder="username"]'))) {
    await mob.type('input[placeholder="username"]', USER);
    await mob.type('input[placeholder="password"]', PW);
    await Promise.all([
      mob.waitForSelector("#auth .hero", { timeout: 15_000 }),
      mob.click("#auth button.cta"),
    ]);
  }
  if (await mob.evaluate(() => !window.psyrena?.profile && !!document.querySelector("#auth .hero"))) {
    await mob.evaluate(() => {
      [...document.querySelectorAll("#auth .hero")].find((x) => x.textContent?.includes("Skinner"))?.click();
    });
    await sleep(300);
    await mob.evaluate(() => {
      [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent ?? ""))?.click();
    });
  }
  await mob.waitForFunction(() => window.psyrena?.profile !== undefined, { timeout: 240_000 });
  await mob.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Fixed Ratio")),
    { timeout: 60_000 }
  );
  const touchBar = await mob.evaluate(() => {
    const btns = [...document.querySelectorAll("button")].filter((b) =>
      /Fixed Ratio|Variable Ratio|Fixed Interval|Variable Interval/.test(b.textContent ?? "")
    );
    const rects = btns.map((b) => b.getBoundingClientRect());
    const cx = rects.reduce((s, r) => s + r.left, 0) / Math.max(1, rects.length);
    const cy = rects.reduce((s, r) => s + r.top, 0) / Math.max(1, rects.length);
    const spread = Math.max(...rects.map((r) => Math.hypot(r.left - cx, r.top - cy)), 0);
    const parents = new Set(btns.map((b) => b.parentElement));
    return {
      count: btns.length,
      spread: Math.round(spread),
      oneCluster: parents.size === 1,
      hasE: [...document.querySelectorAll("button")].some((b) => /Negative/.test(b.textContent ?? "")),
    };
  });
  if (touchBar.count !== 4) fail(`touch layout mounts ${touchBar.count} schedule buttons, expected 4`);
  // "Stacked like Freud" = the same palette-cluster component Freud's stages
  // use: one shared parent, tightly grouped — the fan shape is the component's.
  if (!touchBar.oneCluster || touchBar.spread > 160) {
    fail(`schedules are not one tight palette cluster (oneCluster=${touchBar.oneCluster}, spread=${touchBar.spread}px)`);
  }
  if (!touchBar.hasE) fail("touch layout is missing the Contingency toggle");
  console.log(`mobile: 4-schedule palette cluster mounted (spread ${touchBar.spread}px)`);
  await mob.screenshot({ path: `${SHOTS}/3-mobile-skinner.png` });

  console.log(process.exitCode ? "SMOKE TEST FAILED" : "SKINNER SMOKE TEST: ALL CHECKS PASSED");
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
