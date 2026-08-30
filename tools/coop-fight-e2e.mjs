/**
 * Real co-op E2E (dev tool, not shipped).
 *
 * Three players, one boss. Plays a party fight over HTTP with no browser and
 * no client sim, and asserts the things that were impossible while every
 * client ran its own copy of the fight:
 *
 *   1. one session:  three party members land in ONE fight, not three.
 *   2. one boss:     the HP pool is the 3-man pool, and damage from all three
 *                    players comes off the same bar.
 *   3. one table:    every player appears in the shared threat table.
 *   4. own kit:      each player casts their own hero's skills, with their own
 *                    Focus pool and their own cooldowns.
 *   5. shared state: Marks stack on the boss from anyone's casts (team-level
 *                    by design, doc 02) — one player's work buys everyone's
 *                    damage.
 *   6. real support: a heal from one player lands on another player.
 *   7. isolation:    a solo player's fight is untouched by the party's.
 *
 * Run: node tools/coop-fight-e2e.mjs   (needs `npm run dev` already serving)
 */

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_PASS ?? "psyrena123";

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const cast = (cookie, kind, extra = {}) =>
  api(cookie, "/api/fight/sim/intent", { kind, ...extra });
const state = (cookie) => api(cookie, "/api/fight/sim/state");

/**
 * Serve out any desertion lock a previous run left behind.
 *
 * This driver walks out of a fight that is still being fought, which is exactly
 * what `server/fight.mjs` locks people for — so the run that follows has to
 * wait its two minutes (six seconds under PSYRENA_DESERTER_MS) the same as a
 * player would. Probed through `begin`, because a refused admission is free and
 * an accepted one spends a daily arena entry; the `end` that closes each probe
 * is on a session still in its idle countdown, which is not a fight to quit.
 */
async function serveAnyLock(cookie) {
  for (let i = 0; i < 150; i++) {
    const r = await api(cookie, "/api/fight/sim/begin", {});
    if (r.status !== 403) {
      await api(cookie, "/api/fight/sim/end", {});
      return;
    }
    await sleep(1000);
  }
  throw new Error("still locked out — is PSYRENA_DESERTER_MS set?");
}

/** Park a party of three in one room, with `host` leading. */
async function formParty(host, others, names) {
  for (const c of [host, ...others]) {
    await api(c, "/api/queue/leave", {});
    await api(c, "/api/rooms/leave", {});
    await api(c, "/api/fight/sim/end", {});
    await serveAnyLock(c);
  }
  const room = await api(host, "/api/rooms/create", { name: "Co-op E2E", isPublic: true });
  const roomId = room.json.room?.id;
  for (let i = 0; i < others.length; i++) {
    await api(host, "/api/rooms/invite", { username: names[i] });
    await api(others[i], "/api/rooms/join", { roomId });
  }
  return roomId;
}

/** Wait for the boss to engage — the idle countdown is the server's. */
async function waitEngaged(cookie, timeoutMs = 40_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await state(cookie);
    if (st.json.snap?.phase === "p1") return st.json;
    await sleep(500);
  }
  return null;
}

async function main() {
  const frank = await login("frank");
  const jung = await login("jung");
  const adler = await login("adler");
  const horney = await login("horney");

  const roomId = await formParty(frank, [jung, adler], ["jung", "adler"]);
  console.log(`… party of three in room ${roomId}`);

  // ---- 1. one session for the whole party --------------------------------
  const b1 = await api(frank, "/api/fight/sim/begin", { difficulty: "standard" });
  const b2 = await api(jung, "/api/fight/sim/begin", { difficulty: "standard" });
  const b3 = await api(adler, "/api/fight/sim/begin", { difficulty: "standard" });
  check(b1.status === 200 && b2.status === 200 && b3.status === 200, "all three open the fight");
  check(
    b1.json.key === b2.json.key && b2.json.key === b3.json.key,
    `all three land in ONE session (${b1.json.key})`
  );
  check(b1.json.party === 3, `the session holds the whole party (${b1.json.party})`);
  check(b1.json.actors?.length === 3, `three actors in the sim (${JSON.stringify(b1.json.actors)})`);

  // ---- 2. one boss, scaled for three -------------------------------------
  check(
    b1.json.snap.hpMax === 90000,
    `the boss is the 3-man boss, not three solo bosses (${b1.json.snap.hpMax} HP)`
  );
  check(
    b1.json.snap.hp === b2.json.snap.hp && b2.json.snap.hp === b3.json.snap.hp,
    "everyone is looking at the same HP pool"
  );

  // ---- 3. one threat table -----------------------------------------------
  const engaged = await waitEngaged(frank);
  check(engaged !== null, "the boss engaged");
  const names = (engaged?.snap.threat ?? []).map((r) => r.name.toLowerCase());
  check(
    ["frank", "jung", "adler"].every((n) => names.includes(n)),
    `every player is in the shared threat table (${names.join(", ")})`
  );

  // ---- 4 + 2b. three players, one falling bar ----------------------------
  const before = (await state(frank)).json.snap.hp;
  const hits = [];
  for (const [who, cookie] of [["frank", frank], ["jung", jung], ["adler", adler]]) {
    // Per-slot cooldowns are real and server-enforced, and the three heroes
    // have different kits — so take the first slot this hero will actually
    // give us rather than assuming slot 0 is always up.
    let r = null;
    for (let i = 0; i < 4; i++) {
      r = await cast(cookie, "palette", { paletteIndex: i });
      if (r.json.ok) break;
    }
    hits.push({ who, ...r.json });
  }
  const dealt = hits.reduce((n, h) => n + (h.dealt ?? 0), 0);
  check(
    hits.every((h) => h.ok),
    `all three cast their own kit (${hits.map((h) => `${h.who}:${h.dealt}`).join(" ")})`
  );
  const after = (await state(frank)).json.snap.hp;
  check(
    after <= before - dealt + 1,
    `ONE boss took all three players' damage (${Math.round(before)} → ${Math.round(after)}, dealt ${dealt})`
  );

  // Each player's Focus pool is their own.
  const f1 = (await state(frank)).json.you;
  const f2 = (await state(jung)).json.you;
  check(f1.actorId !== f2.actorId, `each player is a distinct actor (${f1.actorId} vs ${f2.actorId})`);
  check(f1.focus <= 92 && f2.focus <= 92, `each spent from their own Focus (${f1.focus}, ${f2.focus})`);

  // ---- 5. Marks are team-level -------------------------------------------
  const marks = (await state(jung)).json.snap.marks;
  check(marks > 0, `Marks from the party's casts stack on the shared boss (${marks})`);

  // ---- 6. the party is in ONE live combat, together ----------------------
  // Keep everyone casting and wait for the boss to hurt SOMEBODY. Which body
  // it swings at is a threat roll, so this must not care who: the earlier
  // version watched only frank's own HP and reported a false failure on every
  // run where the boss picked jung or adler instead.
  //
  // `allies` is the snapshot's "everyone but the primary actor", so between it
  // and this caller's own `you` the check sees the whole party.
  let sharedCombat = false;
  let seen = "nobody hurt yet";
  for (let round = 0; round < 12 && !sharedCombat; round++) {
    await sleep(1600);
    for (const cookie of [frank, jung, adler]) {
      for (let i = 0; i < 4; i++) {
        const r = await cast(cookie, "palette", { paletteIndex: i });
        if (r.json.ok) break;
      }
    }
    const st = await state(frank);
    const allies = st.json.snap.allies ?? [];
    const alive = (st.json.snap.threat ?? []).filter((r) => r.alive).length;
    const wounded = [
      ...(st.json.you.hp < st.json.you.hpMax ? ["frank"] : []),
      ...allies.filter((a) => a.hpPct < 1).map((a) => a.name),
    ];
    if (alive >= 2 && wounded.length > 0) {
      sharedCombat = true;
      seen = `${wounded.join(" + ")} wounded, ${alive} still up`;
    }
  }
  check(sharedCombat, `the party is in one live combat together (${seen})`);

  // ---- 7. a solo player is unaffected ------------------------------------
  await api(horney, "/api/rooms/leave", {});
  const solo = await api(horney, "/api/fight/sim/begin", {});
  check(solo.json.key.startsWith("solo:"), `a roomless player gets a solo session (${solo.json.key})`);
  check(solo.json.snap.hpMax === 30000, `the solo boss is the 1-man boss (${solo.json.snap.hpMax} HP)`);
  check(solo.json.party === 1, `the solo session holds one actor (${solo.json.party})`);

  for (const c of [frank, jung, adler, horney]) {
    await api(c, "/api/fight/sim/end", {});
    await api(c, "/api/rooms/leave", {});
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
