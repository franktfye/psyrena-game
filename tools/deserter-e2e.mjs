/**
 * Deserter-lock E2E (dev tool, not shipped).
 *
 * The rule: quit a boss fight half way and you cannot enter another one for two
 * minutes — and the clock is served WHILE PLAYING. Logging off does not run it
 * down; signing back in starts it over. That last part is the whole design, and
 * it is the part a wall-clock timer would get wrong, so it is asserted here
 * directly:
 *
 *   1. clean exit:   a fight that ENDED leaves no lock. Finishing is not
 *                    quitting.
 *   2. abandonment:  leaving a live fight locks both doors — `sim/begin` and
 *                    `arena/enter` — with 403 and the time remaining.
 *   3. practice:     still open. It is free, it is how you learn the fight, and
 *                    the penalty is about abandoning a real one.
 *   4. re-login:     signing in restarts the clock, so waiting it out logged
 *                    off buys nothing.
 *   5. expiry:       served with the player present, it clears.
 *
 * Run against a dev server started as:
 *   PSYRENA_FIGHT_DEBUG=1 PSYRENA_DESERTER_MS=6000 npx vite --port <n>
 *   E2E_URL=http://localhost:<n> node tools/deserter-e2e.mjs
 *
 * 6000 ms is what makes steps 4 and 5 finish in a test rather than in two
 * minutes; the production value is 120_000 (server/fight.mjs DESERTER_LOCK_MS).
 */

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_PASS ?? "psyrena123";
const LOCK_MS = Number(process.env.PSYRENA_DESERTER_MS) || 6000;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The words the gates are supposed to say — "…enter again in 1:43." */
const LOCK_MESSAGE = /You left a fight in progress\. You can enter again in \d+:\d\d\./;

async function login(username) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASS }),
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

const begin = (cookie) => api(cookie, "/api/fight/sim/begin", { difficulty: "standard" });
const end = (cookie) => api(cookie, "/api/fight/sim/end", {});

/** The idle countdown is the server's; nothing here can hurry it. */
async function waitEngaged(cookie, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await api(cookie, "/api/fight/sim/state");
    if (st.json.snap?.phase && st.json.snap.phase !== "idle") return true;
    await sleep(500);
  }
  return false;
}

async function waitOver(cookie, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await api(cookie, "/api/fight/sim/state");
    if (st.json.over) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Serve out whatever a previous run left behind.
 *
 * Probed through `sim/begin`, not `arena/enter`: a refused admission is free
 * but an accepted one spends a daily entry, and this loop would eat the lot.
 * A session that never left the 10 s idle countdown is not a fight anyone can
 * quit half way, so the `end` that closes each probe costs nothing.
 */
async function clearLock(cookie, label) {
  for (let i = 0; i < 40; i++) {
    const r = await begin(cookie);
    if (r.status === 200) {
      await end(cookie);
      return true;
    }
    if (r.status !== 403) throw new Error(`${label} begin -> ${r.status}`);
    await sleep(1000);
  }
  return false;
}

async function main() {
  let frank = await login("frank");
  await api(frank, "/api/rooms/leave", {});
  check(await clearLock(frank, "frank"), "start from a clean slate (no lock outstanding)");

  // ---- 1. a fight that ENDS is never desertion ----------------------------
  check((await begin(frank)).status === 200, "open a fight to finish honestly");
  check(await waitEngaged(frank), "the boss engaged");
  await api(frank, "/api/fight/sim/debug", { action: "win" });
  check(await waitOver(frank), "the fight ended on the server");
  const cleanExit = await end(frank);
  check(cleanExit.json.deserted === false, "leaving a FINISHED fight is not desertion");
  const afterClean = await begin(frank);
  check(afterClean.status === 200, `and the arena stays open (${afterClean.status})`);

  // ---- 2. walking out of a LIVE fight locks both doors ---------------------
  check(await waitEngaged(frank), "the next boss engaged — this is the one being quit");
  const quit = await end(frank);
  check(quit.json.deserted === true, "leaving a LIVE fight is desertion");

  const lockedBegin = await begin(frank);
  check(lockedBegin.status === 403, `sim/begin is refused (${lockedBegin.status})`);
  check(
    LOCK_MESSAGE.test(String(lockedBegin.json.error)),
    `and names the time left — "${lockedBegin.json.error}"`
  );
  const lockedEnter = await api(frank, "/api/arena/enter", {});
  check(lockedEnter.status === 403, `arena/enter is refused too (${lockedEnter.status})`);
  check(
    LOCK_MESSAGE.test(String(lockedEnter.json.error)),
    `with the same words — "${lockedEnter.json.error}"`
  );

  // ---- 3. practice is not part of the punishment ---------------------------
  const practice = await api(frank, "/api/fight/result", {
    win: true,
    difficulty: "standard",
    durationMs: 60_000,
    dps: 100,
    healing: 0,
    damageTaken: 100,
    practice: true,
  });
  check(practice.status === 200, `a practice run still pays while locked (${practice.status})`);

  // ---- 4. the clock is served while PLAYING, not while away ----------------
  // Two thirds of the way through, sign in again. If the lock were a wall-clock
  // deadline, it would expire on schedule below; it must not.
  await sleep(Math.round(LOCK_MS * 0.7));
  frank = await login("frank");
  await sleep(Math.round(LOCK_MS * 0.6)); // past the ORIGINAL deadline
  const stillLocked = await begin(frank);
  check(
    stillLocked.status === 403,
    `re-login restarted the clock — still locked past the original expiry (${stillLocked.status}: ${stillLocked.json.error})`
  );

  // ---- 5. and it does clear, once it is actually served --------------------
  await sleep(LOCK_MS + 1500);
  const freed = await begin(frank);
  check(freed.status === 200, `the lock clears once served (${freed.status})`);
  const enterAgain = await api(frank, "/api/arena/enter", {});
  check(enterAgain.status === 200, `and the arena turnstile opens again (${enterAgain.status})`);

  await end(frank); // still idle, so this costs nothing
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
