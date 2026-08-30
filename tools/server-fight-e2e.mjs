/**
 * Server-authoritative fight E2E (dev tool, not shipped).
 *
 * Plays a whole boss fight over HTTP — no browser, no client sim. This is the
 * proof that the sim really runs on the server: the driver only ever sends
 * intents and reads pushed state, exactly like a real client, and it asserts
 * the things a cheating client used to be able to lie about.
 *
 *   1. begin/state:  a fight opens, the boss has its difficulty-scaled HP, and
 *                    the server reports a Focus pool and a beat the client
 *                    never told it.
 *   2. authority:    the boss's HP only moves when the SERVER applies a cast;
 *                    the caller is told what it dealt.
 *   3. Focus:        casts drain the pool, an empty pool refuses the cast, and
 *                    the pool regenerates on the server's clock.
 *   4. GCD:          a second cast inside the global cooldown is refused.
 *   5. phases:       the boss engages and advances on the server's tick with
 *                    no client involvement at all.
 *   6. events:       the sim's hooks arrive as a wire event stream (this is
 *                    what drives the client's VFX/SFX once it is wired up).
 *   7. isolation:    two players who are NOT partied get separate fights.
 *                    (Party co-op — one shared boss — is asserted by
 *                    tools/coop-fight-e2e.mjs.)
 *
 * Run: node tools/server-fight-e2e.mjs   (needs `npm run dev` already serving)
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

/** Collect pushed fight frames off the social stream. */
function listen(cookie) {
  const frames = [];
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
        if (!/^event: fightState$/m.test(block)) continue;
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data) {
          try {
            frames.push(JSON.parse(data));
          } catch {
            /* partial frame */
          }
        }
      }
    }
  })().catch(() => undefined);
  return { frames, close: () => ac.abort() };
}

const cast = (cookie, kind, extra = {}) =>
  api(cookie, "/api/fight/sim/intent", { kind, ...extra });

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
async function serveAnyLock(cookie, label) {
  for (let i = 0; i < 150; i++) {
    const r = await api(cookie, "/api/fight/sim/begin", {});
    if (r.status !== 403) {
      await api(cookie, "/api/fight/sim/end", {});
      return;
    }
    await sleep(1000);
  }
  throw new Error(`${label} is still locked out — is PSYRENA_DESERTER_MS set?`);
}

async function main() {
  const frank = await login("frank");
  const jung = await login("jung");
  const stream = listen(frank);
  await sleep(400);
  // Sessions outlive the client that opened them — that is what lets a reload
  // rejoin a fight in progress — so an earlier run (or a browser tab closed
  // mid-fight) would otherwise hand this one a boss already in phase 3.
  for (const c of [frank, jung]) {
    await api(c, "/api/rooms/leave", {});
    await api(c, "/api/fight/sim/end", {});
  }
  await serveAnyLock(frank, "frank");
  await serveAnyLock(jung, "jung");

  // ---- 1. a fight opens on the server -------------------------------------
  const begin = await api(frank, "/api/fight/sim/begin", { difficulty: "hard" });
  check(begin.status === 200, `begin a hard fight (${begin.status})`);
  const snap0 = begin.json.snap;
  check(snap0?.hpMax === 45000, `boss HP is difficulty-scaled server-side (${snap0?.hpMax} = 30k × 1.5)`);
  check(snap0?.phase === "idle", `fight opens dormant (${snap0?.phase})`);
  check(begin.json.you?.focusMax === 100, `the server owns a Focus pool (${begin.json.you?.focus}/${begin.json.you?.focusMax})`);

  // The sim refuses casts while the boss is still dormant, so wait it out —
  // the idle countdown is the server's, and this driver has no say in it.
  let engagedAt = 0;
  for (let i = 0; i < 60; i++) {
    const st = await api(frank, "/api/fight/sim/state");
    if (st.json.snap.phase === "p1") { engagedAt = st.json.t; break; }
    await sleep(500);
  }
  check(engagedAt > 0, `the boss engaged on the server's own clock at t=${engagedAt}ms`);

  // ---- 2 + 3. casts move HP and drain Focus, both server-side -------------
  const before = (await api(frank, "/api/fight/sim/state")).json.snap.hp;
  const hit1 = await cast(frank, "palette", { paletteIndex: 0 });
  check(hit1.json.ok === true, `a palette cast is accepted (${JSON.stringify(hit1.json).slice(0, 90)})`);
  check(hit1.json.dealt > 0, `the SERVER reports the damage it applied (${hit1.json.dealt})`);
  check(hit1.json.focus === 92, `the cast cost Focus server-side (${hit1.json.focus}/100)`);

  const afterOne = await api(frank, "/api/fight/sim/state");
  // The boss also takes its own DoTs and the fight is live, so assert the cast
  // is accounted for rather than demanding an untouched ledger.
  check(
    afterOne.json.snap.hp <= before - hit1.json.dealt + 1,
    `boss HP moved by at least what the server dealt (${Math.round(before)} → ${Math.round(afterOne.json.snap.hp)}, dealt ${hit1.json.dealt})`
  );

  // ---- 4. the global cooldown is the server's rule ------------------------
  const tooSoon = await cast(frank, "palette", { paletteIndex: 1 });
  check(tooSoon.json.ok === false && tooSoon.json.why === "gcd", `a cast inside the GCD is refused (${tooSoon.json.why})`);

  // A forged intent cannot invent a skill it does not have.
  const bogus = await cast(frank, "palette", { paletteIndex: 99 });
  check(bogus.json.ok === false, `an out-of-range skill is refused (${bogus.json.why})`);

  // ---- 3b. drain the pool and watch the server refuse ---------------------
  let refusedForFocus = false;
  let casts = 0;
  // Palette costs 8 and the pool regenerates 2/s across a 1.5 s GCD, so the
  // net drain is ~5 a cast — twenty-odd casts empties it.
  for (let i = 0; i < 28 && !refusedForFocus; i++) {
    await sleep(1600); // clear the GCD
    const r = await cast(frank, "palette", { paletteIndex: i % 3 });
    if (r.json.ok) casts++;
    else if (r.json.why === "not enough Focus") refusedForFocus = true;
  }
  check(refusedForFocus, `an empty Focus pool refuses the cast (after ${casts} casts)`);
  await sleep(4000);
  const regen = await api(frank, "/api/fight/sim/state");
  check(regen.json.you.focus > 0, `Focus regenerates on the server's clock (${regen.json.you.focus})`);

  // ---- 5. the boss engaged and is advancing with no client input ----------
  const engaged = await api(frank, "/api/fight/sim/state");
  check(engaged.json.snap.phase === "p1", `the boss engaged on the server tick (phase ${engaged.json.snap.phase})`);
  check(engaged.json.snap.enrageRemainingS > 0, `the enrage clock is running (${Math.round(engaged.json.snap.enrageRemainingS)}s left)`);

  // ---- 6. the hook stream is on the wire ---------------------------------
  const kinds = new Set(stream.frames.flatMap((f) => (f.events ?? []).map((e) => e.e)));
  check(stream.frames.length > 10, `state frames are being pushed (${stream.frames.length})`);
  check(kinds.has("phase"), `phase events reach the client (${[...kinds].join(",")})`);
  check(kinds.has("announce"), "world announcements reach the client");
  const anyStrike = stream.frames.some((f) => (f.events ?? []).some((e) => e.e === "strike"));
  check(anyStrike, "the boss is striking — its outgoing runs server-side");

  // ---- 7. unpartied players fight separately -----------------------------
  await api(jung, "/api/rooms/leave", {});
  await api(frank, "/api/rooms/leave", {});
  await api(jung, "/api/fight/sim/begin", {});
  const jungState = await api(jung, "/api/fight/sim/state");
  const frankState = await api(frank, "/api/fight/sim/state");
  check(
    jungState.json.snap.hp !== frankState.json.snap.hp,
    `unpartied players fight their own boss (jung ${Math.round(jungState.json.snap.hp)} vs frank ${Math.round(frankState.json.snap.hp)})`
  );

  await api(frank, "/api/fight/sim/end", {});
  await api(jung, "/api/fight/sim/end", {});
  stream.close();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
