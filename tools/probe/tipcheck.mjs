import { mkdirSync } from "node:fs";
// Verify: buff-row popup tooltips — hover on desktop, tap-toggle on touch.
// Casts E in the village to raise a real self-buff tile, then drives the
// pointer and asserts #buff-tooltip visibility + content at each step.
// Usage: node tipcheck.mjs [desktop|mobile]
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5321/";
const OUT = process.env.OUT_DIR ?? "/tmp/psyrena-tipcheck";
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

// The buff row is #player-hud's 5th grid child (frame, stance, chips, xp, BUFFS).
// DOMRect does not structured-clone across evaluate — return plain numbers.
const tileBox = () => {
  const b = document.querySelector("#player-hud")?.children[4]?.firstElementChild?.getBoundingClientRect();
  return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
};

const tipState = () => {
  const tip = document.getElementById("buff-tooltip");
  return {
    exists: !!tip,
    visible: !!tip && tip.style.display !== "none",
    text: tip?.textContent ?? "",
  };
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function desktop() {
  const browser = await launch();
  const page = await browser.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  try {
    await page.setViewport({ width: 1600, height: 900 });
    await login(page, BASE + "?controls=keyboard");
    await new Promise((r) => setTimeout(r, 1500));

    // Raise a real buff tile: E is the defense self-buff on every kit.
    await page.keyboard.press("e");
    await page.waitForFunction(
      () => document.querySelector("#player-hud")?.children[4]?.childElementCount > 0,
      { timeout: 5000 }
    );

    // Every tile: hover each and require name text + a visible popup.
    const tiles = await page.evaluate(() =>
      [...(document.querySelector("#player-hud")?.children[4]?.children ?? [])].map((t) => {
        const b = t.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })
    );
    console.log(`tiles on the row: ${tiles.length}`);
    for (const [i, c] of tiles.entries()) {
      await page.mouse.move(c.x, c.y);
      await new Promise((r) => setTimeout(r, 300));
      const s = await page.evaluate(tipState);
      check(`desktop hover tile[${i}] shows popup`, s.visible && s.text.length > 5, JSON.stringify(s.text.slice(0, 120)));
    }
    await page.screenshot({ path: `${OUT}/tip-desktop-hover.png`, clip: { x: 0, y: 0, width: 560, height: 560 } });

    // Hover off → hidden.
    await page.mouse.move(800, 600);
    await new Promise((r) => setTimeout(r, 300));
    check("desktop hover-off hides popup", !(await page.evaluate(tipState)).visible);

    // Click pins: popup survives the pointer leaving. Use a FRESH 8 s R buff —
    // the E tile only lives 6 s and can expire mid-assertion.
    await page.keyboard.press("r");
    await new Promise((r) => setTimeout(r, 400));
    const lastTile = await page.evaluate(() => {
      const row = document.querySelector("#player-hud")?.children[4];
      const b = row?.lastElementChild?.getBoundingClientRect();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
    });
    check("desktop R raised a tile", !!lastTile);
    await page.mouse.click(lastTile.x, lastTile.y);
    await new Promise((r) => setTimeout(r, 200));
    await page.mouse.move(800, 600);
    await new Promise((r) => setTimeout(r, 700)); // across a 500 ms row repaint
    const pinned = await page.evaluate(tipState);
    check("desktop click pins popup across repaint", pinned.visible, JSON.stringify(pinned.text.slice(0, 120)));

    // Click outside → unpins.
    await page.mouse.click(1000, 600);
    await new Promise((r) => setTimeout(r, 200));
    check("desktop outside click dismisses", !(await page.evaluate(tipState)).visible);

    // Popup dies with its buff: pin the R tile again and outwait it.
    const c1 = await page.evaluate(tileBox);
    if (c1) {
      await page.mouse.click(c1.x + c1.width / 2, c1.y + c1.height / 2);
      await page.waitForFunction(
        () => document.querySelector("#player-hud")?.children[4]?.childElementCount === 0,
        { timeout: 15000 }
      ).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
      const s = await page.evaluate(tipState);
      const rowEmpty = await page.evaluate(
        () => document.querySelector("#player-hud")?.children[4]?.childElementCount === 0
      );
      if (rowEmpty) check("desktop popup closes when buff expires", !s.visible);
      else console.log("skip: expiry check (another tile still live)");
    }
  } catch (e) {
    check("desktop phase ran", false, e.message);
    try { await page.screenshot({ path: `${OUT}/tip-desktop-fail.png` }); } catch {}
  }
  console.log(logs.join("\n") || "(desktop: no page errors)");
  await browser.close();
}

async function mobile() {
  const browser = await launch();
  const page = await browser.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  try {
    await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    );
    await login(page, BASE + "?controls=touch");
    await new Promise((r) => setTimeout(r, 1500));

    // The keydown listener is on window regardless of control scheme — cheap
    // way to raise a real tile without scripting the thumb arc.
    await page.keyboard.press("e");
    await page.waitForFunction(
      () => document.querySelector("#player-hud")?.children[4]?.childElementCount > 0,
      { timeout: 5000 }
    );

    const box = await page.evaluate(tileBox);
    check("mobile tile present", !!box);

    // Tap → popup opens (pinned).
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 300));
    let s = await page.evaluate(tipState);
    check("mobile tap opens popup", s.visible && s.text.length > 5, JSON.stringify(s.text.slice(0, 120)));
    await page.screenshot({ path: `${OUT}/tip-mobile-tap.png`, clip: { x: 0, y: 0, width: 460, height: 390 } });

    // Popup survives the 500 ms repaint (no hover on touch to keep it alive).
    await new Promise((r) => setTimeout(r, 900));
    check("mobile popup survives repaint", (await page.evaluate(tipState)).visible);

    // Second tap on the SAME tile → dismisses.
    const box2 = await page.evaluate(tileBox);
    await page.touchscreen.tap(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await new Promise((r) => setTimeout(r, 300));
    check("mobile second tap dismisses", !(await page.evaluate(tipState)).visible);

    // Tap tile, then tap the world → dismisses. Fresh 8 s R tile — the E one
    // may have expired by now.
    await page.keyboard.press("r");
    await new Promise((r) => setTimeout(r, 400));
    const box3 = await page.evaluate(tileBox);
    await page.touchscreen.tap(box3.x + box3.width / 2, box3.y + box3.height / 2);
    await new Promise((r) => setTimeout(r, 300));
    check("mobile re-tap re-opens", (await page.evaluate(tipState)).visible);
    await page.touchscreen.tap(600, 250);
    await new Promise((r) => setTimeout(r, 300));
    check("mobile outside tap dismisses", !(await page.evaluate(tipState)).visible);
  } catch (e) {
    check("mobile phase ran", false, e.message);
    try { await page.screenshot({ path: `${OUT}/tip-mobile-fail.png` }); } catch {}
  }
  console.log(logs.join("\n") || "(mobile: no page errors)");
  await browser.close();
}

const only = process.argv[2];
if (!only || only === "desktop") await desktop();
if (!only || only === "mobile") await mobile();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
