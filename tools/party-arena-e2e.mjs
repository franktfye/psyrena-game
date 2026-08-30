/**
 * Party-arena + remote-pet E2E (dev tool, not shipped).
 *
 * Drives TWO real browser profiles and asserts the two things that were
 * broken and are only provable in a live scene:
 *
 *   1. village: each player sees the OTHER player's pet walking beside them
 *      (a `pet_<id>` transform node parented to nothing but chasing the
 *      remote avatar — counted through the scene graph, since the local pet
 *      shares the naming);
 *   2. arena: after the leader launches the party, BOTH clients enter the
 *      boss arena and each one renders the other as a teammate
 *      (window.psyrenaFight.mates()).
 *
 * Run: node tools/party-arena-e2e.mjs   (needs `npm run dev` already serving)
 * Only two WebGL contexts are live at once — a third SwiftShader tab is what
 * makes a boot "fail" for no reason (see the worktree notes).
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_PASS ?? "psyrena123";
/**
 * Per-account password override, e.g. `E2E_PASS_FRANK=…`.
 *
 * The seeded fixtures all share one password, but `frank` is a real account
 * somebody actually plays and its password gets rotated (the admin console can
 * set one). When that happens this driver used to die on an unexplained
 * 20 s timeout waiting for the hero picker, which reads as a broken app rather
 * than a wrong password.
 */
const passFor = (username) =>
  process.env[`E2E_PASS_${username.toUpperCase()}`] ?? PASS;

/**
 * Which accounts play the three seats.
 *
 * Overridable because the default leader, `frank`, is an account a HUMAN
 * actually plays — and the server enforces single login, so a person opening
 * the game on their phone mid-run deletes this driver's session out from under
 * it. That surfaces as a mid-run 401 and a cascade of unrelated-looking
 * presence failures, which is a miserable thing to debug. Point it at pure
 * fixtures to run un-raced:
 *
 *   E2E_LEADER=jung E2E_MEMBER=adler E2E_FILLER=horney node tools/party-arena-e2e.mjs
 */
const LEADER = process.env.E2E_LEADER ?? "frank";
const MEMBER = process.env.E2E_MEMBER ?? "jung";
/** Seats the third chair over plain HTTP — never gets a browser. */
const FILLER = process.env.E2E_FILLER ?? "adler";
const SHOTS = "/tmp/psyrena-party-arena";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};

/**
 * Call the API as one of the logged-in tabs.
 *
 * Deliberately NOT node fetch with a captured cookie: the server enforces
 * single login, so a node-side login would delete the browser's session out
 * from under it (and every later call 401s). The page's own cookie is the
 * only session these players have.
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

/**
 * Log in and stand in the village, with `pet` equipped.
 *
 * The pet lives in client-side wardrobe storage, so it has to be planted in
 * localStorage for this origin — which means loading the page once, writing
 * the key, and reloading into the real boot.
 */
async function bootVillagePage(username, pet) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${username} pageerror]`, String(e).slice(0, 200)));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.evaluate(
    (user, petId) => {
      localStorage.setItem(
        `psyrena_wardrobe:${user}`,
        JSON.stringify({ pet: petId, petChosen: true })
      );
    },
    username,
    pet
  );
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });

  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', username);
  await page.type('input[placeholder="password"]', passFor(username));
  await page.click("#auth button.cta");
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#auth button.cta")].some((b) =>
          b.textContent.includes("Continue")
        ),
      { timeout: 20_000, polling: 200 }
    );
  } catch {
    // Name the actual cause. A rejected login leaves the form up with its
    // error line, and waiting for a button that will never render turns that
    // into a bare "Waiting failed: 20000ms exceeded".
    const err = await page.evaluate(
      () => document.querySelector("#auth .err, #auth .note")?.textContent?.trim() ?? ""
    );
    throw new Error(
      `${username} never reached the hero picker${err ? ` — the login form says: ${err}` : ""}` +
        ` (set E2E_PASS_${username.toUpperCase()} if this account's password differs)`
    );
  }
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

/** Every pet root currently in the scene graph, by node name. */
const petNodes = (page) =>
  page.evaluate(() =>
    (window.psyrena?.manager?.active?.transformNodes ?? [])
      .map((n) => n.name)
      .filter((n) => n.startsWith("pet_"))
  );

const sees = async (page, fn, arg, timeout = 60_000) => {
  try {
    await page.waitForFunction(fn, { timeout, polling: 500 }, arg);
    return true;
  } catch {
    return false;
  }
};

try {
  console.log(`… booting ${LEADER} (corgi) and ${MEMBER} (husky) into the village`);
  const pageFrank = await bootVillagePage(LEADER, "corgi");
  const pageJung = await bootVillagePage(MEMBER, "husky");
  for (const p of [pageFrank, pageJung]) {
    await api(p, "/api/queue/leave", {});
    await api(p, "/api/rooms/leave", {});
  }

  // ---- 1. mutual presence, then the OTHER player's pet --------------------
  check(
    await sees(pageFrank, (n) => (window.psyrenaVillage?.remoteNames ?? []).includes(n), MEMBER),
    `${LEADER} sees ${MEMBER}'s avatar`
  );
  check(
    await sees(pageJung, (n) => (window.psyrenaVillage?.remoteNames ?? []).includes(n), LEADER),
    `${MEMBER} sees ${LEADER}'s avatar`
  );

  // The leader walks a corgi, the member a husky: each tab holds BOTH roots —
  // its own pet and the remote one.
  check(
    await sees(
      pageFrank,
      () =>
        (window.psyrena?.manager?.active?.transformNodes ?? []).some((n) => n.name === "pet_husky"),
      null
    ),
    `${LEADER} sees ${MEMBER.toUpperCase()}'s pet (husky) in the village`
  );
  check(
    await sees(
      pageJung,
      () =>
        (window.psyrena?.manager?.active?.transformNodes ?? []).some((n) => n.name === "pet_corgi"),
      null
    ),
    `${MEMBER} sees ${LEADER.toUpperCase()}'s pet (corgi) in the village`
  );
  console.log(`  ${LEADER} pet nodes:`, JSON.stringify(await petNodes(pageFrank)));
  console.log(`  ${MEMBER} pet nodes:`, JSON.stringify(await petNodes(pageJung)));

  // ---- 1b. a friend REQUEST arrives as a popup, not just a list row -------
  // The fixtures seed the leader and member as friends, so unmake it first;
  // accepting from the card puts the fixture back exactly as it was found.
  await api(pageFrank, "/api/social/friend", { op: "remove", username: MEMBER });
  const asked = await api(pageFrank, "/api/social/friend", { op: "request", username: MEMBER });
  check(asked.status === 200, `${LEADER}'s friend request is accepted (${asked.status})`);
  check(
    await sees(pageJung, () => !!document.getElementById("friend-request"), null, 10_000),
    `${MEMBER} gets a friend-request POPUP immediately (no panel open)`
  );
  await pageJung.screenshot({ path: `${SHOTS}/friend-request-jung.png` });
  await pageJung.evaluate(() => {
    [...document.querySelectorAll("#friend-request button")]
      .find((b) => b.textContent.includes("Accept"))
      .click();
  });
  check(
    await sees(
      pageFrank,
      (n) => (window.psyrena?.social?.friends ?? []).some((f) => f.username === n),
      MEMBER,
      10_000
    ),
    "accepting from the card befriends them on BOTH sides"
  );
  await pageFrank.screenshot({ path: `${SHOTS}/village-frank.png` });
  await pageJung.screenshot({ path: `${SHOTS}/village-jung.png` });

  // ---- 2. leader launches, both land in the arena, both see each other ----
  const room = await api(pageFrank, "/api/rooms/create", { name: "Arena E2E", isPublic: true });
  const roomId = room.json.room?.id;
  await api(pageFrank, "/api/rooms/invite", { username: MEMBER });
  // The invite popup must be up on jung's screen the moment the push lands —
  // that is fix #3, and it is only observable in the DOM.
  check(
    await sees(pageJung, () => !!document.getElementById("party-invite"), null, 10_000),
    `${MEMBER} gets an invite POPUP immediately (no panel open)`
  );
  await pageJung.screenshot({ path: `${SHOTS}/invite-popup-jung.png` });
  // …and its Join button is what seats him.
  await pageJung.evaluate(() => {
    [...document.querySelectorAll("#party-invite button")]
      .find((b) => b.textContent.includes("Join"))
      .click();
  });
  let seated = false;
  for (let i = 0; i < 20 && !seated; i++) {
    const lobby = await api(pageFrank, "/api/lobby");
    seated = (lobby.json.room?.members ?? []).length === 2;
    if (!seated) await new Promise((r) => setTimeout(r, 500));
  }
  check(seated, `joining from the popup seats ${MEMBER} in ${LEADER}'s party`);
  // The leader's own panel must offer the launch — fix #5's UI half.
  await pageFrank.evaluate(async () => {
    const mod = await import("/src/ui/roomsPanel.ts");
    mod.openRoomsPanel();
  });
  await pageFrank.waitForSelector("#rooms", { timeout: 10_000 });
  const launchBtn = await sees(
    pageFrank,
    () =>
      [...document.querySelectorAll("#rooms button")].some((b) =>
        b.textContent.toLowerCase().includes("start")
      ),
    null,
    15_000
  );
  check(launchBtn, "the leader's room view offers a start-the-fight button");
  await pageFrank.screenshot({ path: `${SHOTS}/room-view-leader.png` });
  // A party member must NOT get one.
  await pageJung.evaluate(async () => {
    const mod = await import("/src/ui/roomsPanel.ts");
    mod.openRoomsPanel();
  });
  await pageJung.waitForSelector("#rooms", { timeout: 10_000 });
  const memberHasLaunch = await pageJung.evaluate(() =>
    [...document.querySelectorAll("#rooms button")].some((b) =>
      b.textContent.toLowerCase().includes("start")
    )
  );
  check(!memberHasLaunch, "a party member gets no start button (leader-only)");
  for (const p of [pageFrank, pageJung]) {
    await p.evaluate(async () => {
      const mod = await import("/src/ui/roomsPanel.ts");
      mod.closeRoomsPanel();
    });
  }

  // ---- seat a third member so the party is launchable --------------------
  // A hand-made room needs ROOM_CAP (3) members before the server will start
  // its fight — "the queue no longer promises a solo fight". Two browsers is
  // the ceiling here (a third SwiftShader tab is what makes a boot "fail" for
  // no reason, per the header), so the third seat is filled over plain HTTP:
  // adler has no browser session for a node-side login to trample, and the
  // fight-ready barrier releases on its own timeout when a seated member
  // never loads in. The two real clients still get their arena.
  const adlerLogin = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: FILLER, password: passFor(FILLER) }),
  });
  const adlerCookie = (adlerLogin.headers.get("set-cookie") ?? "").split(";")[0];
  const asAdler = (path, body) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adlerCookie },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  await asAdler("/api/queue/leave", {});
  await asAdler("/api/rooms/leave", {});
  await api(pageFrank, "/api/rooms/invite", { username: FILLER });
  const adlerJoin = await asAdler("/api/rooms/join", { roomId });
  check(adlerJoin.status === 200, `a third member fills the party (${adlerJoin.status})`);

  console.log("… leader launches the party");
  const launch = await api(pageFrank, "/api/rooms/launch", {});
  check(launch.status === 200, `launch accepted (${launch.status})`);

  // The admission gate can ask for a PAID entry once the day's free runs are
  // spent — a real part of the launch flow, and the player has to consent.
  // Answer it the way a player would, or the client never leaves the village.
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
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ok) await page.screenshot({ path: `${SHOTS}/stuck-${who}.png` });
    check(ok, `${who} auto-entered the boss arena`);
    return ok;
  };
  // Both clients load concurrently — that IS the barrier under test.
  const [frankIn, jungIn] = await Promise.all([
    inArena(pageFrank, LEADER),
    inArena(pageJung, MEMBER),
  ]);

  if (frankIn && jungIn) {
    check(
      await sees(pageFrank, (n) => (window.psyrenaFight?.mates?.() ?? []).includes(n), MEMBER, 90_000),
      `${LEADER} sees ${MEMBER} as a teammate IN THE FIGHT`
    );
    check(
      await sees(pageJung, (n) => (window.psyrenaFight?.mates?.() ?? []).includes(n), LEADER, 90_000),
      `${MEMBER} sees ${LEADER} as a teammate IN THE FIGHT`
    );
    console.log(
      `  ${LEADER} mates:`,
      JSON.stringify(await pageFrank.evaluate(() => window.psyrenaFight?.mates?.() ?? "no hook"))
    );
    console.log(
      `  ${MEMBER} mates:`,
      JSON.stringify(await pageJung.evaluate(() => window.psyrenaFight?.mates?.() ?? "no hook"))
    );
    // Remote pets are deliberately absent in the arena (fight fluency).
    check(
      (await petNodes(pageFrank)).filter((n) => n === "pet_husky").length === 0,
      "no remote pets in the arena (fight stays uncluttered)"
    );

    // ---- 3. a teammate's SKILL VFX plays on the other screen --------------
    // Presence proved their body is there; this proves their magic is. The
    // cast kits are built lazily on the first cast received, so the node
    // simply not existing beforehand is half the assertion.
    const fxKits = (page) =>
      page.evaluate(() =>
        (window.psyrena?.manager?.active?.transformNodes ?? [])
          .map((n) => n.name)
          .filter((n) => n.startsWith("mateCastFx_"))
      );
    check(
      (await fxKits(pageFrank)).length === 0,
      "no teammate cast kit before anyone casts (built on demand)"
    );

    // Wait for the fight to actually engage, or every press is refused.
    await sees(
      pageJung,
      () => window.psyrenaFight?.snapshot?.().phase === "p1",
      null,
      120_000
    );
    // Press through the GCD a few times — one press can lose a race with the
    // countdown, and a refused cast broadcasts nothing by design.
    for (let i = 0; i < 6; i++) {
      await pageJung.keyboard.press("1");
      await new Promise((r) => setTimeout(r, 1700));
      if ((await fxKits(pageFrank)).length > 0) break;
    }
    const kits = await fxKits(pageFrank);
    check(kits.length > 0, `${LEADER} renders ${MEMBER}'s cast VFX kit (${JSON.stringify(kits)})`);
    // …and it is anchored on JUNG's rig, not floating at the world origin —
    // otherwise the effect plays in the wrong place, which is its own bug.
    const anchored = await pageFrank.evaluate(() => {
      const scene = window.psyrena?.manager?.active;
      const kit = (scene?.transformNodes ?? []).find((n) => n.name.startsWith("mateCastFx_"));
      return kit?.parent?.name ?? null;
    });
    check(
      typeof anchored === "string" && anchored.startsWith("mate_"),
      `the kit is parented to the casting teammate (${anchored})`
    );

    await pageFrank.screenshot({ path: `${SHOTS}/arena-frank.png` });
    await pageJung.screenshot({ path: `${SHOTS}/arena-jung.png` });
  }

  for (const p of [pageFrank, pageJung]) await api(p, "/api/rooms/leave", {});
  await asAdler("/api/rooms/leave", {}); // the HTTP-only third seat
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  console.log(`shots in ${SHOTS}`);
} finally {
  await browser.close();
}
