/**
 * Browser test for Pavlov's NS ⇄ CS button transform (dev tool, not shipped).
 *
 * The conditioning MATH is covered by tools/sim-check.mjs scenario 5; this
 * driver verifies the plumbing the sim cannot see — that the BELL button is
 * the one that transforms (2026-08-08; it used to be the UCS button):
 *  - the desktop NS slot wears palette geometry (44 px icon face, LMB badge)
 *  - riding the loop (bell → UCS, the guaranteed delay pairing) flips the
 *    bell's face to CS while the UCS button stays UCS
 *  - clicking the transformed button casts CS: CONDITIONED is consumed and
 *    the face reverts to NS, and the same click path keeps working after
 *
 * Run: npx vite --port 5199 &  then  E2E_URL=http://localhost:5199/ CHROME_GPU=1 node tools/pavlov-ns-cs-e2e.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.E2E_URL ?? "http://localhost:5199/";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/psyrena-ns-cs-e2e";
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
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[page error]", m.text());
  });

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // ---- auth: login → guide → pick PAVLOV → enter ---------------------------
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', USER);
  await page.type('input[placeholder="password"]', PW);
  await page.click("#auth button.cta");
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
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll("#auth .hero")].find((t) =>
      t.textContent?.includes("Pavlov")
    );
    tile?.click();
  });
  await sleep(300);
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => /enter/i.test(b.textContent ?? ""))
      ?.click();
  });
  await page.waitForFunction(() => window.psyrena?.profile !== undefined, { timeout: 240_000 });

  // ---- into the arena ------------------------------------------------------
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("UCS")),
    { timeout: 60_000 }
  );
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" })));
  await page.waitForFunction(() => window.psyrenaFight !== undefined, { timeout: 120_000 });
  await page.waitForFunction(() => window.psyrenaFight.snapshot().phase !== "idle", {
    timeout: 60_000,
  });

  // The two faces under test, read fresh every time — replaceSlot renames the
  // slot in place, so the BUTTON ELEMENT is stable but its text is not.
  const faces = () =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll("#action-bar button")];
      const bell = all.find((b) => /LMB/.test(b.textContent ?? ""));
      const ucs = all.find((b) => /^1/.test(b.textContent ?? "") && /UCS|CS/.test(b.textContent ?? ""));
      const face = (el) => ({
        text: (el?.textContent ?? "").replace(/\s+/g, " ").trim(),
        w: el?.offsetWidth ?? 0,
        h: el?.offsetHeight ?? 0,
        icon:
          el
            ?.querySelector("[data-slot-icon]")
            ?.style.background.match(/skills\/pavlov\/(\w+)\.webp/)?.[1] ?? null,
      });
      return { bell: face(bell), ucs: face(ucs) };
    });

  // ---- 1. resting geometry: NS wears the palette face ----------------------
  let f = await faces();
  console.log("resting faces:", JSON.stringify(f));
  if (!/NS/.test(f.bell.text)) fail(`bell button does not say NS: "${f.bell.text}"`);
  if (f.bell.w !== 44 || f.bell.h !== 44)
    fail(`bell button is ${f.bell.w}x${f.bell.h}, expected the 44x44 palette face`);
  if (f.bell.icon !== "ns") fail(`bell button icon is ${f.bell.icon}, expected ns`);
  if (!/UCS/.test(f.ucs.text)) fail(`UCS button missing from the bar: "${f.ucs.text}"`);
  await page.screenshot({ path: `${SHOTS}/1-resting-ns-face.png` });

  // ---- 2. run the loop: bell, then food — the guaranteed delay pairing -----
  // Each cycle banks exactly 1 Pairing; the hidden target is 1..3, so at most
  // three cycles light CONDITIONED. A few spares absorb Focus-gate refusals.
  const bellButton = await page.evaluateHandle(() =>
    [...document.querySelectorAll("#action-bar button")].find((b) => /LMB/.test(b.textContent ?? ""))
  );
  // The transformed face reads "LMBCS" — textContent concatenates the key
  // badge and the label with no whitespace — so "contains CS but not NS" is
  // the discriminator ("LMBNS Bell" is the resting face).
  const isCsFace = (text) => text.includes("CS") && !text.includes("NS");
  let flipped = false;
  for (let i = 0; i < 8 && !flipped; i++) {
    await bellButton.asElement().click(); // the ring…
    await sleep(400);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }))); // …then the food
    for (let w = 0; w < 8 && !flipped; w++) {
      await sleep(500);
      flipped = isCsFace((await faces()).bell.text);
    }
  }
  f = await faces();
  console.log("conditioned faces:", JSON.stringify(f));
  if (!flipped) fail(`bell never flipped to CS: "${f.bell.text}"`);
  if (!/UCS/.test(f.ucs.text)) fail(`UCS button changed face while CONDITIONED: "${f.ucs.text}"`);
  if (f.bell.icon !== "cs") fail(`transformed bell icon is ${f.bell.icon}, expected cs`);
  if (f.bell.w !== 44) fail(`transformed bell is ${f.bell.w}px wide — the swap reshaped the button`);
  await page.screenshot({ path: `${SHOTS}/2-conditioned-cs-face.png` });

  // ---- 3. cash it: the SAME button casts CS and reverts to NS --------------
  const marksBefore = await page.evaluate(() => window.psyrenaFight.snapshot().marks);
  await sleep(1_600); // let the UCS cast's GCD clear so the CS press is accepted
  await bellButton.asElement().click();
  let reverted = false;
  for (let w = 0; w < 12 && !reverted; w++) {
    await sleep(500);
    reverted = /NS/.test((await faces()).bell.text);
  }
  f = await faces();
  console.log("after CS faces:", JSON.stringify(f));
  if (!reverted) fail(`bell did not revert to NS after CS was cast: "${f.bell.text}"`);
  // CS places 3 Conditioning Marks when its projectile lands — proof the click
  // on the transformed button reached the sim as a PALETTE cast, not a bell.
  let marksAfter = marksBefore;
  for (let w = 0; w < 12 && marksAfter <= marksBefore; w++) {
    await sleep(500);
    marksAfter = await page.evaluate(() => window.psyrenaFight.snapshot().marks);
  }
  if (!(marksAfter > marksBefore))
    fail(`CS click placed no Marks (${marksBefore} → ${marksAfter}) — cast did not reach the sim`);
  console.log(`CS landed: marks ${marksBefore} → ${marksAfter}`);

  // ---- 4. the reverted button still rings the bell -------------------------
  const threatBefore = await page.evaluate(
    () => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer)?.value ?? 0
  );
  // Re-click on each poll round: the revert carries the CS cast's cooldown
  // over (that is the point of replaceSlot), so the first press after the
  // flip-back is legitimately refused for up to 3 s.
  let threatAfter = threatBefore;
  for (let i = 0; i < 6 && threatAfter <= threatBefore; i++) {
    await bellButton.asElement().click();
    for (let w = 0; w < 6 && threatAfter <= threatBefore; w++) {
      await sleep(500);
      threatAfter = await page.evaluate(
        () => window.psyrenaFight.snapshot().threat.find((r) => r.isPlayer)?.value ?? 0
      );
    }
  }
  if (!(threatAfter > threatBefore)) fail("reverted NS button no longer casts the bell");
  await page.screenshot({ path: `${SHOTS}/3-reverted-ns-face.png` });

  if (process.exitCode !== 1) console.log("NS ⇄ CS TRANSFORM TEST: ALL CHECKS PASSED");
} catch (e) {
  fail(`driver error: ${e?.message ?? e}`);
  try {
    await page?.screenshot({ path: `${SHOTS}/error.png` });
  } catch {}
} finally {
  await browser.close();
}
