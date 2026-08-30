import { mkdirSync } from "node:fs";
// HUD/dock layout verification: the left dock must never overlap the player
// frame (team avatars), and the exp bar must never exceed the panel width.
// Usage: node hudcheck.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5199/";
const OUT = process.env.OUT_DIR ?? "/tmp/psyrena-hudcheck";
mkdirSync(OUT, { recursive: true });

function launch() {
  return puppeteer.launch({
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
}

async function login(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
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

const PROBE = () => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) };
  };
  const hud = document.getElementById("player-hud");
  const dock = document.getElementById("left-dock");
  const frame = hud?.children[0];
  const chipRow = hud?.children[1];
  const xpBar = hud?.children[2];
  const mateRow = hud?.children[4];
  const btns = [...dock.querySelectorAll(".dock-btn")].map((b) => r(b));
  const util = r(dock.querySelector(".util-btn"));
  const hudBox = r(hud), dockBox = r(dock), mateBox = r(mateRow);
  const hit = (a, b) => a && b && !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    hud: hudBox,
    frame: r(frame),
    chipRow: r(chipRow),
    chips: [...(chipRow?.children ?? [])].map((c) => c.textContent),
    xpBar: r(xpBar),
    xpFillPct: xpBar?.firstElementChild?.style.width,
    xpTitle: xpBar?.title,
    mateRow: mateBox,
    dock: dockBox,
    dockRows: getComputedStyle(dock).getPropertyValue("--dock-rows").trim(),
    dockBtn: getComputedStyle(dock).getPropertyValue("--dock-btn").trim(),
    btnCount: btns.length,
    firstBtn: btns[0],
    util,
    overlapDockHud: hit(dockBox, hudBox),
    overlapDockMates: hit(dockBox, mateBox),
    xpWiderThanPanel: xpBar && frame ? r(xpBar).w > r(frame).w + 1 : null,
    dockBottom: dockBox.bottom,
  };
};

async function phase(tag, viewport, { touch = false, arena = false } = {}) {
  const browser = await launch();
  const page = await browser.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`[${tag} pageerror] ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") logs.push(`[${tag} console] ${m.text()}`); });
  page.on("response", (r) => { if (r.status() >= 400) logs.push(`[${tag} http ${r.status()}] ${r.url()}`); });
  try {
    await page.setViewport(viewport);
    if (touch) {
      await page.setUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      );
    }
    await login(page, BASE + (touch ? "?controls=touch" : "?controls=keyboard"));
    if (arena) {
      await page.evaluate(() => window.psyrena.go("arena"));
      await page.waitForFunction(
        () => document.getElementById("boot")?.classList.contains("done") && window.psyrena?.manager?.active,
        { timeout: 420000, polling: 1000 }
      );
    }
    await new Promise((r) => setTimeout(r, 2500));
    const eco = await page.evaluate(() => fetch("/api/economy").then((r) => r.json()));
    const probe = await page.evaluate(PROBE);
    console.log(`\n=== ${tag} ===`);
    console.log("ECONOMY:", JSON.stringify({ imaginz: eco.imaginz, level: eco.level, xp: eco.xp, xpInto: eco.xpInto, xpNeeded: eco.xpNeeded }));
    console.log(JSON.stringify(probe, null, 1));
    await page.screenshot({ path: `${OUT}/${tag}.png` });
    // Crop the HUD corner for a close look.
    await page.screenshot({
      path: `${OUT}/${tag}-corner.png`,
      clip: { x: 0, y: 0, width: Math.min(viewport.width, 460), height: Math.min(viewport.height, 560) },
    });
    if (probe.overlapDockHud) console.log(`FAIL(${tag}): dock overlaps the player frame`);
    else console.log(`PASS(${tag}): dock clear of the player frame`);
    if (probe.xpWiderThanPanel) console.log(`FAIL(${tag}): exp bar wider than the panel`);
    else console.log(`PASS(${tag}): exp bar within the panel`);
    if (probe.dockBottom > probe.viewport.h) console.log(`FAIL(${tag}): dock runs off the bottom`);
    else console.log(`PASS(${tag}): dock inside the viewport`);
  } catch (e) {
    console.log(`${tag} FAILED: ${e.message}`);
    try { await page.screenshot({ path: `${OUT}/${tag}-fail.png` }); } catch {}
  }
  console.log(logs.join("\n") || `(${tag}: no page errors)`);
  await browser.close();
}

const only = process.argv[2];
const phases = {
  desktop: () => phase("desktop-1600x900", { width: 1600, height: 900 }),
  desktopSmall: () => phase("desktop-1366x720", { width: 1366, height: 720 }),
  mobileLandscape: () => phase("mobile-844x390", { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { touch: true }),
  mobilePortrait: () => phase("mobile-390x844", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { touch: true }),
  tablet: () => phase("tablet-1180x820", { width: 1180, height: 820, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { touch: true }),
  arenaMobile: () => phase("arena-844x390", { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { touch: true, arena: true }),
};
for (const [name, fn] of Object.entries(phases)) {
  if (only && only !== name) continue;
  await fn();
}
console.log("\nDONE");
