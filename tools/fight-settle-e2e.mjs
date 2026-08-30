/**
 * Server-decided rewards E2E (dev tool, not shipped).
 *
 * Phase 4 of docs-server-auth-plan.md: the server no longer asks the client how
 * the fight went. It runs the sim, reads its own per-actor stat block, pays the
 * player, and pushes the receipt. This proves all four halves of that:
 *
 *   1. push:      a fight decided on the server arrives as a `fightResult` SSE
 *                 event, without the client reporting anything.
 *   2. payment:   wallet, XP and season rating all moved SERVER-side, by the
 *                 amounts the receipt claims.
 *   3. refusal:   replaying that same result through the old client door
 *                 (`POST /api/fight/result`) is refused, not paid twice.
 *   4. practice:  the door still works for the one caller that has no server
 *                 fight to be settled from.
 *
 * It also covers the personal-best bonus: a first win beats every record there
 * is (there are none), so it pays 1.2× the Imaginz; a later, deliberately worse
 * win beats nothing and pays the flat award.
 *
 * The account is registered fresh on every run, because "personal best" is only
 * a deterministic question when the personal history is empty.
 *
 * Run against a dev server started as:
 *   PSYRENA_FIGHT_DEBUG=1 PSYRENA_INVITE_REQUIRED=0 npx vite --port <n>
 *   E2E_URL=http://localhost:<n> node tools/fight-settle-e2e.mjs
 */

const BASE = process.env.E2E_URL ?? "http://localhost:5173";
const PASS = process.env.E2E_PASS ?? "psyrena123";

/** Standard difficulty, from server/economy.mjs. The bonus is ×1.2, rounded. */
const STANDARD_AWARD = 30;
const STANDARD_XP = 70;
const PB_AWARD = Math.round(STANDARD_AWARD * 1.2);

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** A brand-new account, so every record this run sets is the first of its kind. */
async function register() {
  const username = `settle${Date.now().toString(36)}`;
  const res = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASS }),
  });
  if (!res.ok) {
    throw new Error(
      `register ${username} -> ${res.status} ${JSON.stringify(await res.json().catch(() => ({})))}` +
        " (start the dev server with PSYRENA_INVITE_REQUIRED=0)"
    );
  }
  return { username, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

/** Collect every named SSE event this run cares about. */
function listen(cookie) {
  const got = { fightState: [], fightResult: [] };
  const ac = new AbortController();
  void (async () => {
    const res = await fetch(`${BASE}/api/social/stream`, {
      headers: { Cookie: cookie, Accept: "text/event-stream" },
      signal: ac.signal,
    });
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!name || !data || !(name in got)) continue;
        try {
          got[name].push(JSON.parse(data));
        } catch {
          /* partial frame */
        }
      }
    }
  })().catch(() => undefined);
  return { got, close: () => ac.abort() };
}

const cast = (cookie, kind, extra = {}) =>
  api(cookie, "/api/fight/sim/intent", { kind, ...extra });

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

async function waitForResult(got, from, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (got.fightResult.length > from) return got.fightResult[from];
    await sleep(200);
  }
  return null;
}

/** Economy + rankings, as the SERVER holds them. */
async function ledger(cookie) {
  const eco = (await api(cookie, "/api/economy")).json;
  const rank = (await api(cookie, "/api/rankings")).json;
  return { imaginz: Number(eco.imaginz), xp: Number(eco.xp), rating: Number(rank.me?.rating ?? 0) };
}

async function main() {
  const { username, cookie } = await register();
  console.log(`(fresh account: ${username})\n`);
  const stream = listen(cookie);
  await sleep(500);

  // ---- 1. a fight the SERVER decides, and pays for -------------------------
  const before = await ledger(cookie);
  const entered = await api(cookie, "/api/arena/enter", {});
  check(entered.status === 200, `arena admission taken (${entered.status}, cost ${entered.json.cost})`);

  const begin = await api(cookie, "/api/fight/sim/begin", { difficulty: "standard" });
  check(begin.status === 200, `a ranked fight opens on the server (${begin.status})`);
  check(await waitEngaged(cookie), "the boss engaged on the server's own clock");

  // Real casts, so the server has real per-actor damage to score. Nothing here
  // tells it what that damage was worth — that is the whole point.
  for (let i = 0; i < 4; i++) {
    await cast(cookie, "palette", { paletteIndex: i % 3 });
    await sleep(1600); // clear the GCD
  }
  const win = await api(cookie, "/api/fight/sim/debug", { action: "win" });
  check(win.status === 200, `the debug win lands on the server (${win.status})`);

  const receipt = await waitForResult(stream.got, 0);
  check(receipt !== null, "the server PUSHED a fightResult — the client reported nothing");
  if (!receipt) throw new Error("no settlement pushed; the rest cannot be asserted");
  check(receipt.key === begin.json.key, `the receipt names the fight it paid for (${receipt.key})`);
  check(receipt.score > 0, `the server scored the run from its own numbers (score ${receipt.score})`);
  check(receipt.xpAwarded === STANDARD_XP, `a standard win pays ${STANDARD_XP} XP (${receipt.xpAwarded})`);
  check(!!receipt.lootBox, `a win minted a cache (${receipt.lootBox?.name})`);

  // ---- personal best: a first-ever win beats every record there is ---------
  check(
    !!receipt.personalBest,
    `a first win is a personal best (${JSON.stringify(receipt.personalBest)})`
  );
  check(
    receipt.imaginzAwarded === PB_AWARD,
    `a personal best pays 1.2× the award (${receipt.imaginzAwarded}, base ${STANDARD_AWARD})`
  );
  check(
    receipt.personalBest?.bonus === PB_AWARD - STANDARD_AWARD,
    `the bonus is reported for the overlay (+${receipt.personalBest?.bonus} ◈)`
  );

  // ---- 2. the money actually moved, server-side ----------------------------
  const after = await ledger(cookie);
  check(
    after.imaginz === before.imaginz + receipt.imaginzAwarded,
    `the wallet moved by the award (${before.imaginz} → ${after.imaginz}, +${receipt.imaginzAwarded})`
  );
  check(
    after.xp === before.xp + STANDARD_XP,
    `XP moved server-side (${before.xp} → ${after.xp})`
  );
  check(
    after.rating === before.rating + receipt.score,
    `season rating moved by the score (${before.rating} → ${after.rating}, +${receipt.score})`
  );

  // ---- 3. the old client door refuses to pay the same fight again ----------
  const replay = await api(cookie, "/api/fight/result", {
    win: true,
    difficulty: "standard",
    durationMs: 60_000,
    dps: 4_000,
    healing: 20_000,
    damageTaken: 0,
  });
  check(
    replay.status === 409,
    `a replayed ranked report is refused (${replay.status}: ${replay.json.error})`
  );
  const afterReplay = await ledger(cookie);
  check(
    afterReplay.imaginz === after.imaginz && afterReplay.rating === after.rating,
    `the refused report paid nothing (${afterReplay.imaginz} ◈, rating ${afterReplay.rating})`
  );

  await api(cookie, "/api/fight/sim/end", {});

  // ---- a second, deliberately worse win beats nothing ----------------------
  const begin2 = await api(cookie, "/api/fight/sim/begin", { difficulty: "standard" });
  check(begin2.status === 200, `a fight that ended normally leaves the door open (${begin2.status})`);
  check(await waitEngaged(cookie), "the second boss engaged");
  // No casts, and a longer run: no damage record, no score record, no clear
  // record. There is nothing here to be a best at.
  await sleep(12_000);
  await api(cookie, "/api/fight/sim/debug", { action: "win" });
  const receipt2 = await waitForResult(stream.got, 1);
  check(receipt2 !== null, "the second fight was settled too");
  check(
    receipt2 && receipt2.personalBest === undefined,
    `a worse win reports no personal best (${JSON.stringify(receipt2?.personalBest)})`
  );
  check(
    receipt2?.imaginzAwarded === STANDARD_AWARD,
    `and pays the flat award (${receipt2?.imaginzAwarded})`
  );

  await api(cookie, "/api/fight/sim/end", {});

  // ---- 4. practice still reports, because nothing else holds its numbers ---
  const practice = await api(cookie, "/api/fight/result", {
    win: true,
    difficulty: "standard",
    durationMs: 60_000,
    dps: 120,
    healing: 500,
    damageTaken: 800,
    practice: true,
  });
  check(practice.status === 200, `a practice report is still accepted (${practice.status})`);
  check(
    !!practice.json.practice,
    `and still pays its capped token award (+${practice.json.imaginzAwarded} ◈, ${practice.json.practice?.today}/${practice.json.practice?.cap} today)`
  );

  stream.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
