/**
 * E2E for the social/VFX batch (dev tool, not shipped): two real browser
 * profiles against a running vite dev server, asserting —
 *   1. remote cast VFX sync: frank presses a skill key, jung's tab plays it
 *      (via the psyrenaVillage.lastRemoteCast debug hook);
 *   2. player card: jung taps frank's avatar in the 3D scene and the card
 *      pops with profile info + Add Friend / Whisper;
 *   3. GET /api/social/player: fields + friendship view, 404 on unknowns;
 *   4. perf HUD: hidden by default, the 📈 toggle shows/hides it;
 *   5. touch chat anchor: with ?controls=touch the chat root sits at 50%.
 *
 * Run: node tools/social-vfx-e2e.mjs   (needs a dev server; E2E_URL to point)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5175";
const SHOTS = "/tmp/psyrena-social-vfx-e2e";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--mute-audio",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
});

/** Fresh cookie-isolated context -> page logged in and standing in the village. */
async function bootVillagePage(username, password, query = "") {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => {
    page.errors.push(String(e));
    console.log(`  [${username} pageerror]`, String(e).slice(0, 200));
  });
  await page.goto(`${BASE}/${query}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', username);
  await page.type('input[placeholder="password"]', password);
  await page.click("#auth button.cta");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#auth button.cta")].some((b) =>
        b.textContent.includes("Continue")
      ),
    { timeout: 15_000, polling: 200 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => b.textContent.includes("Continue"))
      .click();
  });
  await page.waitForSelector("#auth .hero", { timeout: 15_000 });
  try {
    await Promise.all([
      page.waitForFunction(() => window.psyrena?.manager?.active, { timeout: 240_000, polling: 500 }),
      page.evaluate(() => {
        [...document.querySelectorAll("#auth button.cta")]
          .find((b) => b.textContent.includes("Enter Psyrena"))
          .click();
      }),
    ]);
  } catch (err) {
    await page.screenshot({ path: `${SHOTS}/boot-fail-${username}.png` }).catch(() => {});
    throw err;
  }
  return page;
}

const seesOther = async (page, other) => {
  try {
    await page.waitForFunction(
      (name) => (window.psyrenaVillage?.remoteNames ?? []).includes(name),
      { timeout: 30_000, polling: 500 },
      other
    );
    return true;
  } catch {
    return false;
  }
};

try {
  // ---- boot both players ---------------------------------------------------
  console.log("… booting frank into the village");
  const pageFrank = await bootVillagePage("frank", "psyrena123");
  console.log("… booting jung into the village");
  const pageJung = await bootVillagePage("jung", "psyrena123");

  check(await seesOther(pageFrank, "jung"), "frank sees jung's avatar");
  check(await seesOther(pageJung, "frank"), "jung sees frank's avatar");

  // ---- 1. remote cast VFX sync --------------------------------------------
  // Give the SSE streams a beat, then frank casts palette slot 1 ("1") and
  // his defense ("e"); jung's tab must record both through the debug hook.
  await sleep(1000);
  const castAndAssert = async (key, kind) => {
    await pageJung.evaluate(() => {
      // Consume the previous value so each assertion is about ITS cast.
      window.__lastCastSeen = window.psyrenaVillage?.lastRemoteCast ?? null;
    });
    await pageFrank.keyboard.press(key);
    try {
      await pageJung.waitForFunction(
        (want) => {
          const c = window.psyrenaVillage?.lastRemoteCast;
          return !!c && c !== window.__lastCastSeen && c.username === "frank" && c.kind === want;
        },
        { timeout: 10_000, polling: 200 },
        kind
      );
      return true;
    } catch {
      return false;
    }
  };
  check(await castAndAssert("1", "palette"), "jung's tab played frank's palette cast (key 1)");
  await sleep(1800); // clear the 1.5 s palette/GCD window before the next press
  check(await castAndAssert("e", "defense"), "jung's tab played frank's defense cast (key E)");
  check(pageJung.errors.length === 0, `no page errors on jung during playback (${pageJung.errors[0] ?? "clean"})`);
  await pageJung.screenshot({ path: `${SHOTS}/remote-cast-jung.png` });

  // ---- 2. player card from a 3D tap ---------------------------------------
  // Aim jung's camera at frank's avatar, project its center to screen space,
  // click it, and expect the card. Projection is done by hand (no BABYLON
  // global in an ES-module build).
  const clickAvatar = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pt = await pageJung.evaluate((flip) => {
        const scene = window.psyrena.manager.active;
        const mesh = scene.meshes.find((m) => m.metadata?.remotePlayer === "frank");
        if (!mesh) return { err: "no mesh stamped remotePlayer=frank" };
        const cam = scene.activeCamera;
        const v = mesh.getBoundingInfo().boundingSphere.centerWorld;
        // Swing the orbit so the avatar is in front of the camera; two tries
        // cover the alpha convention without deriving it.
        const dx = v.x - cam.target.x;
        const dz = v.z - cam.target.z;
        cam.alpha = Math.atan2(dz, dx) + (flip ? 0 : Math.PI);
        scene.render(); // force matrices current for the projection below
        const m = scene.getTransformMatrix().m;
        const cx = v.x * m[0] + v.y * m[4] + v.z * m[8] + m[12];
        const cy = v.x * m[1] + v.y * m[5] + v.z * m[9] + m[13];
        const cw = v.x * m[3] + v.y * m[7] + v.z * m[11] + m[15];
        if (cw <= 0) return { err: "behind camera" };
        const engine = scene.getEngine();
        return {
          x: ((cx / cw) * 0.5 + 0.5) * engine.getRenderWidth(),
          y: (1 - ((cy / cw) * 0.5 + 0.5)) * engine.getRenderHeight(),
        };
      }, attempt === 1);
      if (pt.err) {
        console.log(`  [click attempt ${attempt}] ${pt.err}`);
        continue;
      }
      if (pt.x < 0 || pt.y < 0 || pt.x > 1280 || pt.y > 800) continue;
      await pageJung.mouse.click(pt.x, pt.y);
      try {
        await pageJung.waitForSelector("#player-card .name", { timeout: 5_000 });
        return true;
      } catch {
        /* try the other alpha */
      }
    }
    return false;
  };
  check(await clickAvatar(), "tapping frank's avatar opens the player card");
  const cardText = await pageJung
    .$eval("#player-card .card", (n) => n.textContent)
    .catch(() => "");
  check(/frank/i.test(cardText), `card names the player (${cardText.slice(0, 60)}…)`);
  check(/Score/.test(cardText) && /Battles/.test(cardText), "card shows profile stats");
  const btnLabels = await pageJung
    .$$eval("#player-card button", (bs) => bs.map((b) => b.textContent))
    .catch(() => []);
  check(
    btnLabels.some((t) => /Add Friend|Request Sent|Friends|Accept/.test(t)) &&
      btnLabels.some((t) => /Whisper/.test(t)),
    `card offers friend + whisper actions (${btnLabels.join(" / ")})`
  );
  await pageJung.screenshot({ path: `${SHOTS}/player-card-jung.png` });
  // Whisper hands off to the chat panel's DM tab.
  await pageJung.evaluate(() => {
    [...document.querySelectorAll("#player-card button")]
      .find((b) => b.textContent.includes("Whisper"))
      ?.click();
  });
  const dmOpen = await pageJung
    .waitForFunction(
      () => document.querySelector(".chat-root.full") !== null,
      { timeout: 5_000, polling: 200 }
    )
    .then(() => true)
    .catch(() => false);
  check(dmOpen, "Whisper opens the chat panel");
  await pageJung.screenshot({ path: `${SHOTS}/whisper-jung.png` });

  // ---- 3. GET /api/social/player ------------------------------------------
  const login = async (username, password) => {
    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`${username} login -> ${res.status}`);
    return (res.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const horney = await login("horney", "psyrena123");
  const info = await fetch(`${BASE}/api/social/player?username=frank`, {
    headers: { Cookie: horney },
  }).then((r) => r.json());
  check(
    info.username === "frank" &&
      typeof info.hero === "string" &&
      typeof info.score === "number" &&
      typeof info.online === "boolean" &&
      ["self", "friends", "requested", "incoming", "none"].includes(info.friendship),
    `player endpoint returns the card fields (${JSON.stringify(info)})`
  );
  const missing = await fetch(`${BASE}/api/social/player?username=zzz_nobody`, {
    headers: { Cookie: horney },
  });
  check(missing.status === 404, "player endpoint 404s on unknown names");
  const anon = await fetch(`${BASE}/api/social/player?username=frank`);
  check(anon.status === 401, "player endpoint requires login");

  // ---- 4. perf HUD toggle --------------------------------------------------
  const hud = await pageFrank.evaluate(() => ({
    panel: getComputedStyle(document.getElementById("perf-hud")).display,
    toggle: !!document.getElementById("perf-hud-toggle"),
  }));
  check(hud.toggle && hud.panel === "none", `perf panel hidden by default (${JSON.stringify(hud)})`);
  await pageFrank.click("#perf-hud-toggle");
  const hudShown = await pageFrank
    .waitForFunction(
      () => {
        const p = document.getElementById("perf-hud");
        return getComputedStyle(p).display !== "none" && /fps/i.test(p.textContent ?? "");
      },
      { timeout: 5_000, polling: 200 }
    )
    .then(() => true)
    .catch(() => false);
  check(hudShown, "clicking the 📈 icon shows the perf panel with live numbers");
  await pageFrank.screenshot({ path: `${SHOTS}/hud-frank.png` });
  await pageFrank.click("#perf-hud-toggle");
  const hudReHidden = await pageFrank.evaluate(
    () => getComputedStyle(document.getElementById("perf-hud")).display === "none"
  );
  check(hudReHidden, "clicking again hides it");

  // ---- 5. touch chat anchor ------------------------------------------------
  // Close the two live WebGL tabs first: a third SwiftShader context on top
  // of two running ones is what crashed this boot on the previous run.
  await pageFrank.browserContext().close();
  await pageJung.browserContext().close();
  console.log("… booting horney with ?controls=touch");
  const pageTouch = await bootVillagePage("horney", "psyrena123", "?controls=touch");
  const chatPos = await pageTouch.evaluate(() => {
    const root = document.querySelector(".chat-root");
    if (!root) return { err: "no chat root" };
    return { left: root.style.left, transform: root.style.transform };
  });
  check(
    chatPos.left === "50%" && /translateX\(-50%\)/.test(chatPos.transform ?? ""),
    `touch chat root anchors at bottom-center (${JSON.stringify(chatPos)})`
  );
  await pageTouch.screenshot({ path: `${SHOTS}/touch-chat-horney.png` });
} catch (err) {
  check(false, `unhandled: ${err?.stack ?? err}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
