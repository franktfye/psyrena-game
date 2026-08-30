/**
 * Multiplayer E2E (dev tool, not shipped): drives TWO real browser profiles
 * against the running vite dev server and asserts the networking features
 * end-to-end —
 *   1. village mutual visibility: frank and jung each see the other's avatar
 *      (via the window.psyrenaVillage debug hook in wireVillagePresence);
 *   2. single-login: a second frank login makes the first tab show the
 *      blocking "signed in from another device" overlay (#kicked);
 *   3. queue: party queue (host queues everyone, non-host gets 403), solo
 *      fill to an exact 3-stack, and the `match` SSE event — this part runs
 *      over the HTTP API with node fetch + session cookies, which is the
 *      matchmaker's actual surface.
 *
 * Run: node tools/mp-e2e.mjs   (needs `npm run dev` already serving)
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
// frank's password differs between the main checkout and a fresh worktree DB
// (worktrees re-seed every account with the dev default), so it is overridable.
const FRANK_PASS = process.env.E2E_FRANK_PASS ?? PW;
const SHOTS = "/tmp/psyrena-mp-e2e";
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

// ---------------------------------------------------------------------------
// fetch-side helpers — cookie-jar-free: each user is one captured cookie
// ---------------------------------------------------------------------------

async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`${username} login -> ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function api(cookie, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const resetLobby = async (cookie) => {
  await api(cookie, "/api/rooms/leave", {});
  await api(cookie, "/api/queue/leave", {});
};

/** Minimal SSE reader over fetch — enough to await one named event. */
async function openSse(cookie) {
  const res = await fetch(`${BASE}/api/social/stream`, {
    headers: { Cookie: cookie, Accept: "text/event-stream" },
  });
  if (!res.ok) throw new Error(`stream -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const ev = { event: "message", data: "" };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data += line.slice(6);
        }
        if (ev.data) events.push(ev);
      }
    }
  })().catch(() => {});
  return {
    waitFor: (name, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = setInterval(() => {
          const hit = events.find((e) => e.event === name);
          if (hit) {
            clearInterval(tick);
            resolve(JSON.parse(hit.data));
          } else if (Date.now() - t0 > timeoutMs) {
            clearInterval(tick);
            reject(new Error(`no '${name}' event within ${timeoutMs}ms`));
          }
        }, 100);
      }),
    close: () => reader.cancel().catch(() => {}),
  };
}

// ---------------------------------------------------------------------------
// browser side
// ---------------------------------------------------------------------------

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
async function bootVillagePage(username, password) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${username} pageerror]`, String(e).slice(0, 160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page.type('input[placeholder="username"]', username);
  await page.type('input[placeholder="password"]', password);
  await page.click("#auth button.cta");
  // The intro guide (WELCOME TO PSYRENA … Continue) sits between login and
  // the picker every time — authFlow.ts runAuthFlow.
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
  await Promise.all([
    page.waitForFunction(() => window.psyrena?.manager?.active, { timeout: 120_000, polling: 500 }),
    page.evaluate(() => {
      [...document.querySelectorAll("#auth button.cta")]
        .find((b) => b.textContent.includes("Enter Psyrena"))
        .click();
    }),
  ]);
  return page;
}

try {
  // ---- 1. village mutual visibility ---------------------------------------
  console.log("… booting frank into the village");
  const pageFrank = await bootVillagePage("frank", FRANK_PASS);
  console.log("… booting jung into the village");
  const pageJung = await bootVillagePage("jung", "psyrena123");

  const roster = (page) =>
    page.evaluate(() => ({
      count: window.psyrenaVillage?.remoteCount ?? -1,
      names: window.psyrenaVillage?.remoteNames ?? [],
    }));

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

  check(await seesOther(pageFrank, "jung"), "frank sees jung's avatar in the village");
  check(await seesOther(pageJung, "frank"), "jung sees frank's avatar in the village");
  console.log("  frank roster:", JSON.stringify(await roster(pageFrank)));
  console.log("  jung  roster:", JSON.stringify(await roster(pageJung)));
  await pageFrank.screenshot({ path: `${SHOTS}/village-frank.png` });
  await pageJung.screenshot({ path: `${SHOTS}/village-jung.png` });

  // ---- 2. single-login kick ------------------------------------------------
  console.log("… logging frank in on a second device");
  const ctx3 = await browser.createBrowserContext();
  const page3 = await ctx3.newPage();
  await page3.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page3.waitForSelector('input[placeholder="username"]', { timeout: 30_000 });
  await page3.type('input[placeholder="username"]', USER);
  await page3.type('input[placeholder="password"]', FRANK_PASS);
  await page3.click("#auth button.cta");
  // The second login only needs the session to exist server-side for the kick
  // to fire; the intro guide showing is proof the login round-tripped.
  await page3.waitForFunction(
    () =>
      [...document.querySelectorAll("#auth button.cta")].some((b) =>
        b.textContent.includes("Continue")
      ),
    { timeout: 15_000, polling: 200 }
  );
  let kicked = true;
  try {
    await pageFrank.waitForSelector("#kicked", { timeout: 10_000 });
  } catch {
    kicked = false;
  }
  check(kicked, "first frank tab shows the signed-in-elsewhere overlay");
  if (kicked) {
    const text = await pageFrank.$eval("#kicked", (n) => n.textContent);
    check(/another device/i.test(text), "overlay names the cause (another device)");
  }
  await pageFrank.screenshot({ path: `${SHOTS}/kicked-frank.png` });

  // ---- 3. queue: party + solo -> exact 3-stack + match SSE -----------------
  // Pure API from here: fetch logins kick the browser pages (single-login),
  // which is fine — the village and kick assertions are done.
  console.log("… queue tests over the API (frank + jung party, horney solo)");
  const frank = await login("frank", FRANK_PASS);
  const jung = await login("jung", "psyrena123");
  const horney = await login("horney", "psyrena123");
  for (const c of [frank, jung, horney]) await resetLobby(c);

  // Jung's stream opens BEFORE the invite so the push has somewhere to land.
  const jungStream = await openSse(jung);

  await api(frank, "/api/rooms/create", { name: "MP E2E Party", isPublic: false });
  await api(frank, "/api/rooms/invite", { username: "jung" });
  const inviteEv = await jungStream.waitFor("invite").catch(() => null);
  check(
    inviteEv?.name === "MP E2E Party" && inviteEv?.from === "frank",
    `invitee got the invite SSE event (${JSON.stringify(inviteEv)})`
  );
  const jungLobby = await api(jung, "/api/lobby");
  const invite = jungLobby.json.invites.find((i) => i.roomName === "MP E2E Party");
  check(!!invite, "jung received the party invite");
  await api(jung, "/api/rooms/join", { roomId: invite.roomId });

  const nonHost = await api(jung, "/api/queue/join", {});
  check(
    nonHost.status === 403 && /party leader/i.test(nonHost.json.error ?? ""),
    `non-host queue attempt is a clear 403 (${nonHost.json.error})`
  );

  // Horney's stream also opens BEFORE the match forms, to catch the push.
  const horneyStream = await openSse(horney);

  const hostQueue = await api(frank, "/api/queue/join", {});
  check(
    hostQueue.json.queued === true &&
      hostQueue.json.partyQueued === true &&
      hostQueue.json.room?.name === "MP E2E Party",
    "host queue keeps the room and flags partyQueued"
  );
  const memberLobby = await api(jung, "/api/lobby");
  check(
    memberLobby.json.queued === true &&
      memberLobby.json.partyQueued === true &&
      memberLobby.json.room?.isHost === false,
    "party member shows queued (leader queued the party)"
  );

  const soloQueue = await api(horney, "/api/queue/join", {});
  const matchRoom = soloQueue.json.room;
  check(
    !!matchRoom && /^Ranked Match #\d+$/.test(matchRoom.name ?? ""),
    `solo join completes the trio into a ranked match (${matchRoom?.name})`
  );
  const members = (matchRoom?.members ?? []).map((m) => m.username).sort();
  check(
    JSON.stringify(members) === JSON.stringify(["frank", "horney", "jung"]),
    `match holds the party + solo fill (${members.join(", ")})`
  );
  const frankLobby = await api(frank, "/api/lobby");
  check(
    frankLobby.json.room?.id === matchRoom?.id,
    "party leader landed in the same match room"
  );

  const matchEvHorney = await horneyStream.waitFor("match").catch(() => null);
  check(
    matchEvHorney?.roomId === matchRoom?.id && matchEvHorney?.name === matchRoom?.name,
    `solo player got the match SSE event (${JSON.stringify(matchEvHorney)})`
  );
  const matchEvJung = await jungStream.waitFor("match").catch(() => null);
  check(
    matchEvJung?.roomId === matchRoom?.id,
    "party member got the match SSE event too"
  );
  horneyStream.close();
  jungStream.close();

  // Cleanup so reruns start clean (the transient match room dies on last leave).
  for (const c of [frank, jung, horney]) await resetLobby(c);
} catch (err) {
  check(false, `unhandled: ${err?.stack ?? err}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
