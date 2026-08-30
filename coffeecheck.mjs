// Coffee Shop panel verification driver — NPC tap → panel → buy → HUD tile.
// Usage: PSYRENA_URL=http://localhost:5199/ node coffeecheck.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5199/";
const logs = [];

async function login(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#auth", { timeout: 20000 });
  const loginForm = await page.$('#auth input[placeholder="username"]');
  if (loginForm) {
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

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--disable-features=WebGPU",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage();
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
try {
  await page.setViewport({ width: 1600, height: 900 });
  await login(page);

  // HUD potion tile from the boot-time syncPotionBuffs (latte active in db).
  await new Promise((r) => setTimeout(r, 2000));
  const bootTiles = await page.evaluate(() =>
    [...document.querySelectorAll("#player-hud img")].map((i) => i.src.replace(/.*\//, ""))
  );
  console.log("HUD IMAGES AT BOOT:", JSON.stringify(bootTiles));

  // Aim the camera at the coffee-shop attendant and tap it (real pointer
  // events, so the scene pick path runs end to end).
  const found = await page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const mesh = s.getMeshByName("npc_coffee-shop");
    if (!mesh) return false;
    const p = mesh.getAbsolutePosition();
    const c = s.activeCamera;
    s.onBeforeRenderObservable.add(() => {
      c.alpha = 0.6;
      c.beta = 1.15;
      c.radius = 6;
      c.target.set(p.x, p.y + 1.0, p.z);
    });
    return true;
  });
  if (!found) throw new Error("npc_coffee-shop mesh not found");
  await new Promise((r) => setTimeout(r, 3000));
  await page.mouse.click(800, 450);
  await page.waitForSelector("#coffee", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#coffee .group").length === 2, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));
  const info = await page.evaluate(() => ({
    balance: document.querySelector("#coffee .bal")?.textContent,
    groups: [...document.querySelectorAll("#coffee .group")].map((g) => ({
      drink: g.dataset.drink,
      cards: [...g.querySelectorAll(".gcard")].map((c) => ({
        nm: c.querySelector(".nm")?.textContent,
        pr: c.querySelector(".pr")?.textContent,
        locked: c.classList.contains("locked"),
        live: c.querySelector(".live")?.textContent ?? null,
        cta: c.querySelector(".buy")?.textContent ?? c.querySelector(".st")?.textContent,
      })),
    })),
    redeem: {
      input: Boolean(document.querySelector("#coffee .redeem input")),
      button: document.querySelector("#coffee .redeem button")?.textContent,
    },
  }));
  console.log("COFFEE PANEL:", JSON.stringify(info, null, 1));
  await page.screenshot({ path: "coffee-panel.png" });

  // Buy the Americano (S) — the one not yet active.
  await page.evaluate(() => {
    const g = [...document.querySelectorAll("#coffee .group")].find((x) => x.dataset.drink === "Americano");
    g.querySelector(".buy").click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll("#coffee .live")].length >= 2,
    { timeout: 10000 }
  );
  const after = await page.evaluate(() => ({
    balance: document.querySelector("#coffee .bal")?.textContent,
    hint: document.querySelector("#coffee .hint")?.textContent,
    lives: [...document.querySelectorAll("#coffee .live")].map((l) => l.textContent),
    hudTiles: [...document.querySelectorAll("#player-hud img")].map((i) => ({
      src: i.src.replace(/.*\//, ""),
      title: i.closest("div[title]")?.title ?? "",
    })),
  }));
  console.log("AFTER BUY:", JSON.stringify(after, null, 1));
  await page.screenshot({ path: "coffee-after-buy.png" });

  // Redeem stub: type a code, expect the polite refusal in the hint line.
  await page.type("#coffee .redeem input", "SECRETBREW");
  await page.click("#coffee .redeem button");
  await page.waitForFunction(
    () => /code/i.test(document.querySelector("#coffee .hint")?.textContent ?? ""),
    { timeout: 10000 }
  );
  console.log("REDEEM HINT:", await page.evaluate(() => document.querySelector("#coffee .hint")?.textContent));

  // Escape closes; second tap toggle is scene-side (covered by shop pattern).
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("coffee"), { timeout: 5000 });
  console.log("PANEL CLOSED OK");
  await browser.close();
} catch (e) {
  console.log("FAILED:", e.message);
  console.log(logs.slice(-25).join("\n"));
  try { await page.screenshot({ path: "coffee-fail.png" }); } catch {}
  try { await browser.close(); } catch {}
  process.exit(1);
}
