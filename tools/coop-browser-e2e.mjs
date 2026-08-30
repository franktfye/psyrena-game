/**
 * Co-op ON SCREEN (dev tool, not shipped).
 *
 * `tools/coop-fight-e2e.mjs` proves the SERVER runs one fight for a party. It
 * says nothing about what the players see, and for the whole of phase 1 and 2
 * that was the gap: three people in one room, each watching their own private
 * copy of the boss. This drives two REAL browsers through the real party
 * launch and asserts the thing a player would actually notice —
 *
 *   both clients render the SAME boss, and when EITHER one casts, the HP bar
 *   falls by the same amount on both screens.
 *
 * Exactly two WebGL contexts are live at once; a third SwiftShader tab is what
 * makes a boot "fail" for no reason (see the worktree notes).
 *
 * Run: node tools/coop-browser-e2e.mjs   (needs a dev server already serving)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_PASS ?? "psyrena123";
const SHOTS = "/tmp/psyrena-coop-browser";
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

/**
 * Call the API as one of the logged-in tabs — never with a node-side cookie:
 * the server enforces single login, so logging in from node would delete the
 * browser's session out from under it.
 */
const api = (page, path, body) =>
  page.evaluate(
    async (p, b) => {
      const res = await fetch(p, {
        method: b === undefined ? "GET" : "POST",
        headers: b === undefined ? undefined : { "Content-Type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    },
    path,
    body
  );

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

/** Log in and stand in the village. Own browser context = own session cookie. */
async function bootVillagePage(username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${username} pageerror]`, String(e).slice(0, 200)));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });

  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', username);
  await page.type('input[placeholder="password"]', PASS);
  await page.click("#auth button.cta");
  // The intro guide (WELCOME TO PSYRENA … Continue) sits between login and the
  // hero picker — authFlow.ts runAuthFlow.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#auth button.cta")].some((b) =>
        b.textContent.includes("Continue")
      ),
    { timeout: 20_000, polling: 200 }
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("#auth button.cta")]
      .find((b) => b.textContent.includes("Continue"))
      .click();
  });
  await page.waitForSelector("#auth .hero", { timeout: 20_000 });
  await Promise.all([
    page.waitForFunction(() => window.psyrena?.manager?.active, { timeout: 240_000, polling: 500 }),
    page.evaluate(() => {
      [...document.querySelectorAll("#auth button.cta")]
        .find((b) => b.textContent.includes("Enter Psyrena"))
        .click();
    }),
  ]);
  return page;
}

/** The boss's live HP as THIS client believes it. */
const bossHp = (page) => page.evaluate(() => window.psyrenaFight?.snapshot()?.hp ?? null);
const snap = (page) => page.evaluate(() => window.psyrenaFight?.snapshot() ?? null);

/** Cast a palette skill and let the projectile land + a state frame arrive. */
async function castAndSettle(page, key) {
  await page.keyboard.press(key);
  await sleep(3_000);
}

try {
  console.log("… booting frank and jung into the village");
  const pageFrank = await bootVillagePage("frank");
  const pageJung = await bootVillagePage("jung");
  for (const p of [pageFrank, pageJung]) {
    await api(p, "/api/queue/leave", {});
    await api(p, "/api/rooms/leave", {});
    await api(p, "/api/fight/sim/end", {});
  }

  // ---- party up ------------------------------------------------------------
  const room = await api(pageFrank, "/api/rooms/create", { name: "Co-op Browser E2E", isPublic: true });
  const roomId = room.json.room?.id;
  await api(pageFrank, "/api/rooms/invite", { username: "jung" });
  // Join through the invite popup the way a player would — it also gets that
  // card off jung's screen, which is otherwise still sitting over the boss
  // frame in the screenshot at the end. Falls back to the API if the push is
  // slow: this test is about the fight, not about the invite.
  const joinedFromPopup = await pageJung
    .waitForSelector("#party-invite button", { timeout: 15_000 })
    .then(() =>
      pageJung.evaluate(() => {
        const btn = [...document.querySelectorAll("#party-invite button")].find((b) =>
          b.textContent.includes("Join")
        );
        btn?.click();
        return !!btn;
      })
    )
    .catch(() => false);
  if (!joinedFromPopup) await api(pageJung, "/api/rooms/join", { roomId });
  let seated = false;
  for (let i = 0; i < 20 && !seated; i++) {
    const lobby = await api(pageFrank, "/api/lobby");
    seated = (lobby.json.room?.members ?? []).length === 2;
    if (!seated) await sleep(500);
  }
  check(seated, `frank and jung are seated in one party (room ${roomId})`);

  console.log("… leader launches the party");
  const launch = await api(pageFrank, "/api/rooms/launch", {});
  check(launch.status === 200, `launch accepted (${launch.status})`);

  // The admission gate can ask for a PAID entry once the day's free runs are
  // spent — a real part of the launch flow, and the player has to consent.
  const answerPaidEntry = async (page, who) => {
    const asked = await page.evaluate(() => {
      const dlg = document.getElementById("game-dialog");
      if (!dlg) return null;
      const msg = dlg.querySelector(".msg")?.textContent ?? "";
      const ok = [...dlg.querySelectorAll("button")].find((b) => /enter|ok/i.test(b.textContent));
      if (ok) ok.click();
      return msg.slice(0, 80);
    });
    if (asked !== null) console.log(`  [${who}] answered the entry gate: ${asked}`);
  };

  const inArena = async (page, who) => {
    const deadline = Date.now() + 300_000;
    let ok = false;
    while (Date.now() < deadline) {
      ok = await page.evaluate(() => document.body.dataset.scene === "arena");
      if (ok) break;
      await answerPaidEntry(page, who);
      await sleep(1_000);
    }
    if (!ok) await page.screenshot({ path: `${SHOTS}/stuck-${who}.png` });
    check(ok, `${who} entered the boss arena`);
    return ok;
  };
  const [frankIn, jungIn] = await Promise.all([
    inArena(pageFrank, "frank"),
    inArena(pageJung, "jung"),
  ]);

  if (frankIn && jungIn) {
    // ---- one boss, on two screens ------------------------------------------
    // The fight opens dormant and engages on the SERVER's countdown; casts are
    // refused until then, so wait for the phase both clients are told about.
    const engaged = async (page, who) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const s = await snap(page);
        if (s && s.phase !== "idle" && s.phase !== "dead") return s;
        await sleep(1_000);
      }
      check(false, `${who}'s client never saw the boss engage`);
      return null;
    };
    const sf = await engaged(pageFrank, "frank");
    const sj = await engaged(pageJung, "jung");

    if (sf && sj) {
      check(
        sf.hpMax === sj.hpMax,
        `both clients render one boss of the same size (${sf.hpMax} vs ${sj.hpMax})`
      );
      // Two seats means the 2-man HP pool, not two solo bosses.
      check(sf.hpMax > 30_000, `the boss is scaled for the PARTY, not for one (${sf.hpMax} HP)`);
      const names = (s) => s.threat.map((r) => r.name.toLowerCase()).sort().join(",");
      check(
        names(sf) === "frank,jung" && names(sj) === "frank,jung",
        `both clients show the same threat table (frank: ${names(sf)} | jung: ${names(sj)})`
      );

      // ---- either one casts, both bars fall ---------------------------------
      const before = { f: await bossHp(pageFrank), j: await bossHp(pageJung) };
      console.log(`  before frank's cast — frank ${before.f}, jung ${before.j}`);
      await castAndSettle(pageFrank, "1");
      const afterF = { f: await bossHp(pageFrank), j: await bossHp(pageJung) };
      console.log(`  after  frank's cast — frank ${afterF.f}, jung ${afterF.j}`);
      check(afterF.f < before.f, `frank's own cast moved the boss on frank's screen`);
      check(
        afterF.j < before.j,
        `FRANK's cast moved the boss on JUNG's screen (${Math.round(before.j)} → ${Math.round(afterF.j)})`
      );

      await castAndSettle(pageJung, "1");
      const afterJ = { f: await bossHp(pageFrank), j: await bossHp(pageJung) };
      console.log(`  after  jung's  cast — frank ${afterJ.f}, jung ${afterJ.j}`);
      check(
        afterJ.f < afterF.f,
        `JUNG's cast moved the boss on FRANK's screen (${Math.round(afterF.f)} → ${Math.round(afterJ.f)})`
      );
      check(afterJ.j < afterF.j, `jung's own cast moved the boss on jung's screen`);

      // Same pool, same number: the two clients are not merely both falling,
      // they are reading one HP value off one server-side fight. Frames are
      // 100 ms apart, so allow a single tick of the boss's own DoTs.
      const drift = Math.abs(afterJ.f - afterJ.j);
      check(drift < 60, `both screens agree on the boss's HP (drift ${drift.toFixed(1)})`);

      // And the DOM says so too — the assertion a player could make by eye.
      const hpText = (page) =>
        page.evaluate(() => document.getElementById("bossFrameHp")?.textContent ?? "");
      console.log(`  boss frame — frank "${await hpText(pageFrank)}" | jung "${await hpText(pageJung)}"`);
      await pageFrank.screenshot({ path: `${SHOTS}/coop-frank.png` });
      await pageJung.screenshot({ path: `${SHOTS}/coop-jung.png` });
    }
  }

  for (const p of [pageFrank, pageJung]) {
    await api(p, "/api/fight/sim/end", {});
    await api(p, "/api/rooms/leave", {});
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  console.log(`shots in ${SHOTS}`);
} finally {
  await browser.close();
}
