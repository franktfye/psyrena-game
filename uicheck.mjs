// UI verification driver — desktop gear/shop panels + mobile chat overlap.
// Usage: node /tmp/psyrena-uicheck.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5173/";
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

function watch(page, tag) {
  page.on("console", (m) => logs.push(`[${tag} ${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[${tag} pageerror] ${e.message}`));
}

function launch() {
  return puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: "new",
    protocolTimeout: 600000,
    args: [
      "--no-sandbox",
      // Force the WebGL2 fallback: WebGPU under swiftshader inits, then loses
      // its context mid-boot and the scene never builds (see core/engine.ts).
      "--disable-features=WebGPU",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
}

// ---------- Phase A: desktop gear + shop -----------------------------------
{
  const browser = await launch();
  const page = await browser.newPage();
  try {
  await page.setViewport({ width: 1600, height: 900 });
  watch(page, "desktop");
  await login(page);

  // 1) Gear panel via the dock button.
  await page.click('#left-dock button[aria-label="Gear (G)"]');
  await page.waitForSelector("#gear", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#gear .slot").length === 6, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500)); // let icons decode
  const gearInfo = await page.evaluate(() =>
    [...document.querySelectorAll("#gear .slot")].map((s) => ({
      label: s.querySelector(".lb")?.textContent,
      tier: s.querySelector(".tn")?.textContent,
      cta: s.querySelector(".up")?.textContent,
      icon: (s.querySelector(".box")?.style.backgroundImage ?? "").replace(/.*\//, "").replace(/[")]/g, ""),
    }))
  );
  console.log("GEAR SLOTS:", JSON.stringify(gearInfo, null, 1));
  await page.screenshot({ path: "/tmp/psyrena-ui2-gear.png" });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("gear"), { timeout: 5000 });

  // 2) Aim the camera at the outfitter attendant and tap it (real pointer
  //    events, so the scene pick path runs end to end).
  const found = await page.evaluate(() => {
    const s = window.psyrena.manager.active;
    const mesh = s.getMeshByName("npc_outfitter");
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
  if (!found) throw new Error("npc_outfitter mesh not found");
  await new Promise((r) => setTimeout(r, 3000)); // settle frames (software GL)
  await page.mouse.click(800, 450);
  await page.waitForSelector("#shop", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#shop .group").length === 6, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));
  const shopInfo = await page.evaluate(() => ({
    groups: [...document.querySelectorAll("#shop .group")].map((g) => ({
      slot: g.dataset.slot,
      cards: g.querySelectorAll(".gcard").length,
      states: [...g.querySelectorAll(".gcard")].map((c) => c.className.replace("gcard ", "")),
    })),
    balance: document.querySelector("#shop .bal")?.textContent,
    gearPanelAlsoOpen: Boolean(document.getElementById("gear")),
  }));
  console.log("SHOP:", JSON.stringify(shopInfo, null, 1));
  await page.screenshot({ path: "/tmp/psyrena-ui2-shop.png" });
  await browser.close();
  } catch (e) {
    console.log("DESKTOP PHASE FAILED:", e.message);
    try { await page.screenshot({ path: "/tmp/psyrena-ui2-desktop-fail.png" }); } catch {}
    try { await browser.close(); } catch {}
  }
}

// ---------- Phase B: mobile chat overlap ------------------------------------
{
  const browser = await launch();
  const page = await browser.newPage();
  try {
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.setUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  );
  watch(page, "mobile");

  await page.goto(BASE + "?controls=touch", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#auth", { timeout: 20000 });
  const loginForm = await page.$('#auth input[placeholder="username"]');
  if (loginForm) {
    await page.type('#auth input[placeholder="username"]', USER);
    await page.type('#auth input[type="password"]', PW);
    await page.click("#auth button.cta");
  }
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

  await page.tap(".chat-root > button");
  await page.waitForSelector(".chat-root.full .chat-open", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 800));
  const geom = await page.evaluate(() => {
    const icon = document.querySelector(".chat-root > button").getBoundingClientRect();
    const input = document.querySelector(".chat-input-row input").getBoundingClientRect();
    const r = (b) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
    const overlap = !(icon.right <= input.left || input.right <= icon.left || icon.bottom <= input.top || input.bottom <= icon.top);
    return { icon: r(icon), input: r(input), overlap };
  });
  console.log("CHAT GEOM:", JSON.stringify(geom));
  if (geom.overlap) throw new Error("chat input still overlaps the icon");
  console.log("CHAT OVERLAP CHECK: PASS");
  await page.screenshot({ path: "/tmp/psyrena-ui2-chat-mobile.png" });
  await browser.close();
  } catch (e) {
    console.log("MOBILE PHASE FAILED:", e.message);
    try { await page.screenshot({ path: "/tmp/psyrena-ui2-mobile-fail.png" }); } catch {}
    try { await browser.close(); } catch {}
  }
}

console.log(logs.join("\n") || "(no page errors)");
console.log("DONE");
