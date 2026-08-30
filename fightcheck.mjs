// Verify: buff-icon text bubbles, P2 grow cap 3x (visual), memory-line voice priority.
import puppeteer from "puppeteer-core";
import fs from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5174/";
const T = "/home/frank/.claude/jobs/e07b81f0/tmp";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan", "--window-size=1600,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("#auth", { timeout: 20000 });
if (await page.$('#auth input[placeholder="username"]')) {
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
await page.waitForFunction(
  () => [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)),
  { timeout: 30000 }
);
await page.evaluate(() => {
  [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click();
});
console.log("logged in, booting…");
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 300000, polling: 1000 }
);
console.log("booted; entering arena (b)");
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" })));
await page.waitForFunction(() => window.psyrenaFight != null, { timeout: 240000, polling: 1000 });
console.log("fight sim live; waiting for p1");
await page.waitForFunction(() => window.psyrenaFight.snapshot().phase === "p1", {
  timeout: 60000,
  polling: 500,
});

// --- buff bubble check: cast E, read the HUD buff row -----------------------
await page.keyboard.press("e");
await new Promise((r) => setTimeout(r, 800));
const buffRow = await page.evaluate(() => {
  const hud = document.getElementById("player-hud");
  if (!hud) return null;
  // row 3 = buff row: the grid child that contains img tiles with bubbles
  const rows = [...hud.children];
  return rows.map((r) => r.textContent.trim()).filter(Boolean);
});
console.log("HUD rows text:", JSON.stringify(buffRow));
await page.screenshot({ path: `${T}/01-buff-bubble.png` });

// --- ride to P2, sampling captions and phase ---------------------------------
const captions = new Set();
let lastPhase = "p1";
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  const s = await page.evaluate(() => ({
    snap: window.psyrenaFight.snapshot(),
    cap: document.getElementById("nightmare-speech")?.textContent?.trim() ?? "",
  }));
  if (s.cap) captions.add(s.cap);
  if (s.snap.phase !== lastPhase) {
    console.log(`phase ${lastPhase} -> ${s.snap.phase} at ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    lastPhase = s.snap.phase;
    if (s.snap.phase === "p3") break;
  }
  if (s.snap.phase === "p2" && s.snap.p2Stage >= 3) {
    await page.screenshot({ path: `${T}/02-p2-late-growth.png` });
  }
  await new Promise((r) => setTimeout(r, 700));
}
await page.screenshot({ path: `${T}/03-final.png` });
fs.writeFileSync(`${T}/captions.json`, JSON.stringify([...captions], null, 2));
console.log("captions seen:", JSON.stringify([...captions], null, 2));
await browser.close();
