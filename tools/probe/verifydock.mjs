// One-off verification driver for this branch:
//  A (desktop): village dock shows functional buttons + no exit; "b" → arena
//    dock shows ONLY exit (+fullscreen util); exit button pops a confirm.
//  B (touch): chat opens above the dock (z-order + hit test) and the touch
//    cluster (basic + arc) keeps a right margin off the viewport edge.
// Usage: PSYRENA_URL=http://localhost:5183/ node verifydock.mjs
import puppeteer from "puppeteer-core";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.PSYRENA_URL ?? "http://localhost:5183/";
const fails = [];
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) fails.push(msg);
};

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

const vis = (el) => el && getComputedStyle(el).display !== "none";

// ---------- Phase A: desktop dock scoping ----------------------------------
{
  const browser = await launch();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1600, height: 900 });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await login(page, BASE);

    const village = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const vis = (el) => el && getComputedStyle(el).display !== "none";
      return {
        scene: document.body.dataset.scene,
        fnVisible: [...document.querySelectorAll("#left-dock .dock-fn")].every(vis),
        fnCount: document.querySelectorAll("#left-dock .dock-fn").length,
        exitVisible: vis(q("#left-dock .dock-exit")),
      };
    });
    ok(village.scene === "village", `body[data-scene] stamped village (got ${village.scene})`);
    ok(village.fnCount === 6 && village.fnVisible, `village dock shows all ${village.fnCount} functional buttons`);
    ok(!village.exitVisible, "village dock hides Exit Battlefield");
    await page.screenshot({ path: "/tmp/verify-dock-village.png" });

    // Dev keybind straight to the arena.
    await page.keyboard.press("b");
    await page.waitForFunction(
      () => document.body.dataset.scene === "arena" && document.getElementById("boot")?.classList.contains("done"),
      { timeout: 420000, polling: 1000 }
    );
    await new Promise((r) => setTimeout(r, 1000));

    const arena = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const vis = (el) => el && getComputedStyle(el).display !== "none";
      return {
        fnHidden: [...document.querySelectorAll("#left-dock .dock-fn")].every((el) => !vis(el)),
        exitVisible: vis(q("#left-dock .dock-exit")),
        exitIcon: q("#left-dock .dock-exit")?.style.backgroundImage ?? "",
      };
    });
    ok(arena.fnHidden, "arena dock hides every functional button");
    ok(arena.exitVisible, "arena dock shows Exit Battlefield");
    ok(arena.exitIcon.includes("exit.webp"), `exit icon wired (${arena.exitIcon})`);

    // The exit tap must ask before leaving; dismiss so we stay put.
    let sawDialog = null;
    page.once("dialog", (d) => {
      sawDialog = d.message();
      void d.dismiss();
    });
    await page.click("#left-dock .dock-exit");
    await new Promise((r) => setTimeout(r, 500));
    ok(!!sawDialog, `exit tap confirms first (${sawDialog})`);
    ok(
      await page.evaluate(() => document.body.dataset.scene === "arena"),
      "declining the confirm stays in the arena"
    );
    await page.screenshot({ path: "/tmp/verify-dock-arena.png" });
  } catch (e) {
    fails.push(`desktop phase: ${e.message}`);
    console.log("DESKTOP PHASE FAILED:", e.message);
    try { await page.screenshot({ path: "/tmp/verify-dock-desktop-fail.png" }); } catch {}
  }
  await browser.close();
}

// ---------- Phase B: touch chat z-order + cluster margin --------------------
{
  const browser = await launch();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await login(page, BASE + "?controls=touch");
    await new Promise((r) => setTimeout(r, 800));

    // Touch cluster right margin: every button's right edge must sit clear of
    // the viewport edge (pre-fix the arc's top slot rendered ~1 px from it).
    const margin = await page.evaluate(() => {
      const bar = document.getElementById("action-bar");
      if (!bar) return null;
      const btns = [...bar.querySelectorAll("button")].filter((b) => b.offsetParent !== null || b.getBoundingClientRect().width > 0);
      const gaps = btns.map((b) => Math.round(window.innerWidth - b.getBoundingClientRect().right));
      return { count: btns.length, minGap: Math.min(...gaps), gaps };
    });
    ok(!!margin && margin.count > 0, `touch cluster found (${margin?.count ?? 0} buttons)`);
    if (margin) ok(margin.minGap >= 8, `cluster right margin >= 8px (min ${margin.minGap}px, all ${JSON.stringify(margin.gaps)})`);

    // Chat above the dock: open it, then hit-test the top-left region where
    // the dock buttons live — the element under the point must be inside the
    // chat, not a dock button.
    await page.tap(".chat-root > button");
    await page.waitForSelector(".chat-root.full .chat-open", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));
    const chat = await page.evaluate(() => {
      const root = document.querySelector(".chat-root");
      const dock = document.getElementById("left-dock");
      const zChat = Number(getComputedStyle(root).zIndex);
      const zDock = dock ? Number(getComputedStyle(dock).zIndex) : -1;
      const dockBtn = dock?.querySelector("button");
      let covered = true;
      if (dockBtn) {
        const r = dockBtn.getBoundingClientRect();
        if (r.width > 0) {
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          covered = !!at && !dock.contains(at);
        }
      }
      return { zChat, zDock, covered };
    });
    ok(chat.zChat > chat.zDock, `open chat stacks above dock (chat z=${chat.zChat}, dock z=${chat.zDock})`);
    ok(chat.covered, "hit test over a dock button lands on the chat, not the dock");
    await page.screenshot({ path: "/tmp/verify-chat-touch.png" });
  } catch (e) {
    fails.push(`touch phase: ${e.message}`);
    console.log("TOUCH PHASE FAILED:", e.message);
    try { await page.screenshot({ path: "/tmp/verify-chat-touch-fail.png" }); } catch {}
  }
  await browser.close();
}

console.log(fails.length ? `\n${fails.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(fails.length ? 1 : 0);
