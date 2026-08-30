/**
 * Dropping out while waiting — API E2E (no browser).
 *
 * The bug: a player who closed their tab while queued kept their queue row and
 * their room seat for the whole two-minute presence grace. The matchmaker
 * seated them in a trio, and `beginFight` built the sim party from
 * room_members — so the two players who DID show up loaded into a boss sized
 * for three, next to a hero with no body (they never joined the arena presence
 * session) that still soaked damage and held a third of the party's HP.
 *
 * Three checks, one per place the ghost used to get through:
 *   A. the matchmaker  — a queued dropout loses their queue row before a
 *                        match can form around them.
 *   B. the ready barrier — a party member who drops before the countdown is
 *                        evicted, so the barrier's total is the real party.
 *   C. the fight itself — the session that opens has exactly the players who
 *                        are actually there.
 *
 * Run against a throwaway server with the clocks turned down:
 *   PSYRENA_DB=/tmp/qd.db PORT=5211 PSYRENA_DROP_GRACE_MS=800 \
 *   PSYRENA_MATCH_MS=800 PSYRENA_QUEUE_TIMEOUT_MS=2500 node server/index.mjs
 *   E2E_URL=http://127.0.0.1:5211 node tools/queue-drop-e2e.mjs
 */
const BASE = process.env.E2E_URL ?? "http://localhost:5199";
/** Must match the server's PSYRENA_DROP_GRACE_MS + PSYRENA_MATCH_MS, plus air. */
const SWEEP_MS = Number(process.env.E2E_SWEEP_MS) || 2500;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username}: HTTP ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const post = (cookie, path, body = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

const get = (cookie, path) =>
  fetch(`${BASE}${path}`, { headers: { cookie } }).then((r) => r.json());

/**
 * Hold a social stream open, exactly like a browser tab does — closing it is
 * how this test spells "the player dropped".
 */
function openStream(cookie) {
  const ctrl = new AbortController();
  const ready = fetch(`${BASE}/api/social/stream`, { headers: { cookie }, signal: ctrl.signal })
    .then((res) => {
      // Drain, or backpressure stalls the server's writes to this socket.
      void res.body.getReader().read().catch(() => {});
    })
    .catch(() => {});
  return { ready, close: () => ctrl.abort() };
}

const jung = await login("jung", "psyrena123");
const adler = await login("adler", "psyrena123");
const horney = await login("horney", "psyrena123");
const names = new Map([[jung, "jung"], [adler, "adler"], [horney, "horney"]]);

const clean = async () => {
  for (const c of [jung, adler, horney]) {
    await post(c, "/api/queue/leave");
    await post(c, "/api/rooms/leave");
  }
};

// ---------------------------------------------------------------------------
// A. A dropout never reaches the matchmaker.
// ---------------------------------------------------------------------------
await clean();
let streams = [openStream(jung), openStream(adler), openStream(horney)];
await Promise.all(streams.map((s) => s.ready));
await sleep(400);

for (const c of [jung, adler, horney]) await post(c, "/api/queue/join");
const queuedAll = await get(jung, "/api/lobby");
check(queuedAll.queueSize === 3, `all three are queued (queueSize ${queuedAll.queueSize})`);

streams[2].close(); // horney's tab dies mid-queue
await sleep(SWEEP_MS);

const afterDrop = await get(jung, "/api/lobby");
check(afterDrop.queueSize === 2, `dropout left the queue (queueSize ${afterDrop.queueSize})`);
check((await get(horney, "/api/lobby")).queued === false, "dropout's own queue row is gone");

// The queue timeout now launches the two who are still here, as a pair.
await sleep(3500);
const matched = await get(jung, "/api/lobby");
const roster = (matched.room?.members ?? []).map((m) => m.username);
check(!!matched.room, `the survivors still got a match (${matched.room?.name ?? "none"})`);
check(
  roster.length === 2 && !roster.includes("horney"),
  `match holds only the present players (${roster.join(", ") || "empty"})`
);

// ---------------------------------------------------------------------------
// B. A drop between the match and the countdown is evicted by the barrier.
// ---------------------------------------------------------------------------
streams.forEach((s) => s.close());
await clean();
streams = [openStream(jung), openStream(adler), openStream(horney)];
await Promise.all(streams.map((s) => s.ready));
await sleep(400);

const room = await post(jung, "/api/rooms/create", { name: "Drop E2E", isPublic: true });
const roomId = room.json.room?.id;
check(!!roomId, `jung opened a party (room ${roomId})`);
for (const c of [adler, horney]) {
  const r = await post(c, "/api/rooms/join", { roomId });
  check(r.status === 200, `${names.get(c)} joined the party`);
}
check((await get(jung, "/api/lobby")).room?.members?.length === 3, "party is three strong");

streams[2].close(); // horney drops after the party formed, before the fight
await sleep(SWEEP_MS);

const first = await post(jung, "/api/fight/ready");
check(
  first.json.total === 2 && first.json.ready === 1,
  `barrier counts only the present party (${JSON.stringify(first.json)})`
);
const second = await post(adler, "/api/fight/ready");
check(
  second.json.ready === 2 && second.json.total === 2,
  `barrier releases without the dropout (${JSON.stringify(second.json)})`
);
const seats = ((await get(jung, "/api/lobby")).room?.members ?? []).map((m) => m.username);
check(!seats.includes("horney"), `dropout lost their seat (${seats.join(", ")})`);

// ---------------------------------------------------------------------------
// C. The fight the survivors open is sized for the survivors.
// ---------------------------------------------------------------------------
const begun = await post(jung, "/api/fight/sim/begin", { difficulty: "standard" });
check(
  begun.json.party === 2,
  `fight is sized for the two who came — ${begun.json.party} actors ` +
    `${JSON.stringify(begun.json.actors)}`
);
const alsoBegun = await post(adler, "/api/fight/sim/begin", { difficulty: "standard" });
check(
  alsoBegun.json.key === begun.json.key && alsoBegun.json.party === 2,
  `teammate joined the same 2-player session (${alsoBegun.json.key})`
);

await post(jung, "/api/fight/sim/end");
await post(adler, "/api/fight/sim/end");
streams.forEach((s) => s.close());
await clean();

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
