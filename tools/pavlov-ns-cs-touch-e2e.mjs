/**
 * Touch-layout half of the NS ⇄ CS transform test (dev tool, not shipped).
 *
 * tools/pavlov-ns-cs-e2e.mjs proves the desktop row; this driver proves the
 * CORNER CIRCLE — the touch basic button — in the practice pit:
 *  - the corner button stays a circle wearing "NS / Bell" at rest
 *  - the conditioning loop (tap bell → key "1" food) flips its face to CS
 *    without reshaping it, while the arc's UCS button never changes
 *  - tapping the SAME button then casts CS: the face reverts to NS within
 *    seconds (only `conditioned.consume` reverts that fast — decay takes
 *    20 s), which is the proof the tap resolved the LIVE slot id, not the
 *    mount-time one
 *
 * Run: npx vite --port 5199 &  then  E2E_URL=http://localhost:5199/ CHROME_GPU=1 node tools/pavlov-ns-cs-touch-e2e.mjs
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = (process.env.E2E_URL ?? "http://localhost:5199/") + "?controls=touch";
const SHOTS = process.env.E2E_SHOTS ?? "/tmp/psyrena-ns-cs-touch-e2e";
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
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", ...gpuArgs],
});

let page;
try {
  page = await browser.newPage();
  // iPhone-ish landscape, the orientation the game plays in.
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[page error]", m.text());
  });

  console.log("… loading", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

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
    [...document.querySelectorAll("#auth .hero")]
      .find((t) => t.textContent?.includes("Pavlov"))
      ?.click();
  });
  await sleep(300);
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => /enter/i.test(b.textContent ?? ""))
      ?.click();
  });
  await page.waitForFunction(
    () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
    { timeout: 240_000 }
  );

  // ---- into the practice pit (the touch scene that runs the sim) -----------
  await page.evaluate(() => window.psyrena.go("practice"));
  await page.waitForFunction(
    () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
    { timeout: 120_000 }
  );
  await page.waitForSelector("#action-bar", { timeout: 60_000 });
  await sleep(2_000);

  // The corner basic: the only bar button wearing the "ATTACK" state tag.
  // Face reads are geometry-free: offsetWidth ignores the cluster's scale()
  // transform, so 96 is the authored TOUCH_BASIC size.
  const corner = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("#action-bar button")].find((b) =>
        (b.textContent ?? "").includes("ATTACK")
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        w: el.offsetWidth,
        radius: getComputedStyle(el).borderRadius,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      };
    });
  const ucsFace = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("#action-bar button")]
          .map((b) => (b.textContent ?? "").trim())
          .find((t) => /UCS/.test(t)) ?? null
    );
  const isCsFace = (text) => text.includes("CS") && !text.includes("NS");

  let c = await corner();
  console.log("resting corner:", JSON.stringify(c), "ucs:", await ucsFace());
  if (!c) {
    fail("no corner basic button in the touch cluster");
    throw new Error("no corner button");
  }
  if (!c.text.includes("NS")) fail(`corner button does not say NS: "${c.text}"`);
  if (c.w !== 96 || c.radius !== "50%")
    fail(`corner button is ${c.w}px / radius ${c.radius}, expected the 96 px circle`);
  if (!(await ucsFace())) fail("no UCS button on the arc");
  await page.screenshot({ path: `${SHOTS}/1-resting-corner.png` });

  // ---- flip it: tap bell → key "1" food, the guaranteed delay pairing ------
  let flipped = false;
  for (let i = 0; i < 8 && !flipped; i++) {
    c = await corner();
    await page.touchscreen.tap(c.cx, c.cy); // the ring…
    await sleep(400);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }))); // …the food
    for (let w = 0; w < 8 && !flipped; w++) {
      await sleep(500);
      flipped = isCsFace((await corner())?.text ?? "");
    }
  }
  c = await corner();
  console.log("conditioned corner:", JSON.stringify(c), "ucs:", await ucsFace());
  if (!flipped) fail(`corner button never flipped to CS: "${c.text}"`);
  if (c.w !== 96 || c.radius !== "50%")
    fail(`transformed corner is ${c.w}px / radius ${c.radius} — the flip reshaped the circle`);
  if (!(await ucsFace())) fail("UCS arc button changed face while CONDITIONED");
  await page.screenshot({ path: `${SHOTS}/2-conditioned-corner.png` });

  // ---- cash it: the SAME tap path casts CS and the face reverts ------------
  await sleep(1_600); // let the UCS cast's GCD clear so the CS tap is accepted
  let reverted = false;
  for (let i = 0; i < 4 && !reverted; i++) {
    c = await corner();
    await page.touchscreen.tap(c.cx, c.cy);
    for (let w = 0; w < 6 && !reverted; w++) {
      await sleep(500);
      reverted = ((await corner())?.text ?? "").includes("NS");
    }
  }
  c = await corner();
  console.log("after CS corner:", JSON.stringify(c));
  if (!reverted) fail(`corner did not revert to NS after the CS tap: "${c.text}"`);
  await page.screenshot({ path: `${SHOTS}/3-reverted-corner.png` });

  if (process.exitCode !== 1) console.log("NS ⇄ CS TOUCH TEST: ALL CHECKS PASSED");
} catch (e) {
  fail(`driver error: ${e?.message ?? e}`);
  try {
    await page?.screenshot({ path: `${SHOTS}/error.png` });
  } catch {}
} finally {
  await browser.close();
}
