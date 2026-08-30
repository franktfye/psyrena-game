import { mkdirSync } from "node:fs";
// End-to-end progression check: post one fight result, confirm the server
// awards XP and that a fresh load renders the new level + a filled exp bar.
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5199/";
const OUT = process.env.OUT_DIR ?? "/tmp/psyrena-xpcheck";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--disable-features=WebGPU", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

async function login() {
  await page.goto(BASE + "?controls=keyboard", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#auth", { timeout: 20000 });
  const form = await page.$('#auth input[placeholder="username"]');
  if (form) {
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
    () => [...document.querySelectorAll("#auth button.cta")].some((b) => /enter/i.test(b.textContent)),
    { timeout: 30000 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")].find((b) => /enter/i.test(b.textContent)).click();
  });
  await page.waitForFunction(() => !document.getElementById("auth"), { timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
    { timeout: 420000, polling: 1000 }
  );
}

try {
  await login();
  const before = await page.evaluate(() => fetch("/api/economy").then((r) => r.json()));
  console.log("BEFORE:", JSON.stringify({ level: before.level, xp: before.xp, xpInto: before.xpInto, xpNeeded: before.xpNeeded }));

  // Two nightmare wins (200 XP each) — enough to clear level 1 (150) and prove
  // the curve rolls over rather than just accumulating.
  for (let i = 0; i < 2; i++) {
    const res = await page.evaluate(() =>
      fetch("/api/fight/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ win: true, difficulty: "nightmare", durationMs: 90000, dps: 420, healing: 1200, damageTaken: 3000 }),
      }).then((r) => r.json())
    );
    console.log(`FIGHT ${i + 1}:`, JSON.stringify({ xpAwarded: res.xpAwarded, level: res.level, xp: res.xp, xpInto: res.xpInto, xpNeeded: res.xpNeeded }));
  }

  const after = await page.evaluate(() => fetch("/api/economy").then((r) => r.json()));
  console.log("AFTER:", JSON.stringify({ level: after.level, xp: after.xp, xpInto: after.xpInto, xpNeeded: after.xpNeeded }));

  // Fresh load: the HUD must render what the server now holds.
  await login();
  await new Promise((r) => setTimeout(r, 2500));
  const hudState = await page.evaluate(() => {
    const hud = document.getElementById("player-hud");
    const xpBar = hud.children[2];
    return {
      chips: [...hud.children[1].children].map((c) => c.textContent),
      fill: xpBar.firstElementChild.style.width,
      title: xpBar.title,
      barWidth: Math.round(xpBar.getBoundingClientRect().width),
      panelWidth: Math.round(hud.children[0].getBoundingClientRect().width),
    };
  });
  console.log("HUD:", JSON.stringify(hudState));
  const expectPct = (100 * after.xpInto) / after.xpNeeded;
  const gotPct = parseFloat(hudState.fill);
  console.log(Math.abs(expectPct - gotPct) < 0.5 ? "PASS: bar fill matches server progression" : `FAIL: bar ${gotPct}% vs server ${expectPct}%`);
  console.log(hudState.chips[1] === `Lv ${after.level}` ? "PASS: level chip matches" : `FAIL: chip ${hudState.chips[1]} vs Lv ${after.level}`);
  console.log(hudState.barWidth <= hudState.panelWidth ? "PASS: bar within panel" : "FAIL: bar wider than panel");
  await page.screenshot({ path: `${OUT}/xp-after.png`, clip: { x: 0, y: 0, width: 420, height: 220 } });
} catch (e) {
  console.log("FAILED:", e.message);
  try { await page.screenshot({ path: `${OUT}/xp-fail.png` }); } catch {}
}
await browser.close();
console.log("DONE");
