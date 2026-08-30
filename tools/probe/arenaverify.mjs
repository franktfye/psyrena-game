import { mkdirSync } from "node:fs";
// Post-fix verification: spawn-pad start, follow camera, walk-in, fog.
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const URL = process.env.PSYRENA_URL ?? "http://127.0.0.1:5174/";
const T = process.env.OUT_DIR ?? "/tmp/psyrena-arenaverify";
mkdirSync(T, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan", "--window-size=1600,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
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
await page.waitForFunction(
  () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
  { timeout: 180000 }
);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" })));
await page.waitForFunction(
  () => window.psyrena?.manager?.active?.getMeshByName?.("floor") != null,
  { timeout: 180000, polling: 1000 }
);
await new Promise((r) => setTimeout(r, 6000));

const at = () =>
  page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const h = s.getTransformNodeByName("arenaHero");
    const c = s.activeCamera;
    return {
      hero: { x: +h.position.x.toFixed(2), y: +h.position.y.toFixed(2), z: +h.position.z.toFixed(2) },
      cam: { alpha: +c.alpha.toFixed(2), radius: +c.radius.toFixed(2), target: { x: +c.target.x.toFixed(2), y: +c.target.y.toFixed(2), z: +c.target.z.toFixed(2) } },
    };
  });

console.log("spawn:", JSON.stringify(await at()));
await page.screenshot({ path: `${T}/after_spawn.png` });

// Walk forward (camera-relative W = toward the boss) for ~4 s.
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" })));
await new Promise((r) => setTimeout(r, 2000));
console.log("mid-bridge:", JSON.stringify(await at()));
await page.screenshot({ path: `${T}/after_bridge.png` });
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "w" })));
console.log("on disc:", JSON.stringify(await at()));
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${T}/after_ondisc.png` });

// Keep walking toward the boss to judge the fog from gameplay range.
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" })));
await new Promise((r) => setTimeout(r, 2500));
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "w" })));
console.log("near boss:", JSON.stringify(await at()));
await new Promise((r) => setTimeout(r, 1000));
await page.screenshot({ path: `${T}/after_nearboss.png` });

console.log(logs.slice(0, 10).join("\n") || "(no page errors)");
await browser.close();
