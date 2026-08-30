// Achievement system UI check — dock button, achievements panel tabs,
// hall-of-minds tabs, equipped title in HUD + above player model.
// Usage: node /tmp/psyrena-achcheck.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5173/";
const logs = [];

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
      "--disable-features=WebGPU",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
}

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

const browser = await launch();
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1600, height: 900 });
  watch(page, "ach");
  await login(page);
  await new Promise((r) => setTimeout(r, 3000));

  // 1. Equip a seeded title via the API so HUD + name tag have something to show.
  const equip = await page.evaluate(async () => {
    const ach = await (await fetch("/api/achievements")).json();
    const owned = ach.titles.owned;
    if (!owned.length) return { status: 0, body: "no owned titles", owned };
    const res = await fetch("/api/title/equip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: owned[0] }),
    });
    return { status: res.status, body: await res.json().catch(() => null), owned };
  });
  console.log("equip:", JSON.stringify(equip));
  await page.evaluate(async () => {
    const { refreshTitle } = await import("/src/ui/playerHud.ts");
    const { setLocalHeroTitle } = await import("/src/scenes/villageHub.ts");
    refreshTitle(); // bare refetch from /api/me
    const ach = await (await fetch("/api/achievements")).json();
    setLocalHeroTitle(ach.titles.equipped ?? null);
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: "/tmp/ach-1-village-nametag.png" });

  // 2. Open the achievements panel from the left dock.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#left-dock [title]")].find((b) => /achievements/i.test(b.title));
    btn.click();
  });
  await page.waitForSelector("#achievements-panel .card", { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#achievements-panel .body .ach-row, #achievements-panel .body .row").length > 0,
    { timeout: 15000 }
  );
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: "/tmp/ach-2-panel-all.png" });

  // 3. Switch to the Gear tab.
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("#achievements-panel button")].find((b) => /^gear$/i.test(b.textContent.trim()));
    tab?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: "/tmp/ach-3-panel-gear.png" });

  // 4. Close achievements, open Hall of Minds, walk the tabs.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#left-dock [title]")].find((b) => /hall/i.test(b.title));
    btn.click();
  });
  await page.waitForSelector("#hall-of-minds .card", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: "/tmp/ach-4-hall-ladder.png" });

  for (const [name, file] of [["Global", "ach-5-hall-global"], ["Team Records", "ach-6-hall-team"], ["Solo Records", "ach-7-hall-solo"]]) {
    await page.evaluate((n) => {
      const tab = [...document.querySelectorAll("#hall-of-minds button")].find((b) => b.textContent.trim().toLowerCase() === n.toLowerCase());
      tab?.click();
    }, name);
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: `/tmp/${file}.png` });
  }

  // 5. HUD avatar panel closeup (title next to name).
  const hud = await page.$("#player-hud");
  if (hud) await hud.screenshot({ path: "/tmp/ach-8-hud.png" });

  const errs = logs.filter((l) => /error|pageerror/i.test(l) && !/favicon|webrtc|socket|deprecat/i.test(l));
  console.log("errors:", errs.length ? errs.join("\n") : "none");
} finally {
  await browser.close();
}
console.log("done");
