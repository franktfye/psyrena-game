/**
 * Fight-ready barrier API E2E (no browser): jung hosts a public room, adler
 * joins, both open their social SSE streams; jung readies (both should see
 * `fightReady` 1/2), then adler readies (both should see `fightStart`).
 * Also asserts the solo path: horney (roomless) gets { solo: true }.
 */
const BASE = process.env.E2E_URL ?? "http://localhost:5199";
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) {
    failures++;
    process.exitCode = 1;
  }
};

async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username}: HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return cookie;
}

const post = (cookie, path, body = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

/** Collect named SSE events from /api/social/stream into an array. */
function tapStream(cookie, events) {
  const seen = [];
  const ctrl = new AbortController();
  void (async () => {
    const res = await fetch(`${BASE}/api/social/stream`, {
      headers: { cookie },
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (ev && events.includes(ev)) seen.push({ ev, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return { seen, close: () => ctrl.abort() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jung = await login("jung", "psyrena123");
const adler = await login("adler", "psyrena123");
const horney = await login("horney", "psyrena123");

// Solo path first: horney is in no room.
await post(horney, "/api/rooms/leave"); // make sure
const solo = await post(horney, "/api/fight/ready");
check(solo.status === 200 && solo.json.solo === true, `roomless player gets solo:true (${JSON.stringify(solo.json)})`);

// Party: fresh public room, both seated.
await post(jung, "/api/rooms/leave");
await post(adler, "/api/rooms/leave");
const created = await post(jung, "/api/rooms/create", { name: "Barrier E2E", isPublic: true });
const roomId = created.json.room?.id;
check(!!roomId, `jung created room ${roomId}`);
const joined = await post(adler, "/api/rooms/join", { roomId });
check(joined.status === 200, "adler joined the room");

const jungTap = tapStream(jung, ["fightReady", "fightStart"]);
const adlerTap = tapStream(adler, ["fightReady", "fightStart"]);
await sleep(500); // streams connected

const r1 = await post(jung, "/api/fight/ready");
check(
  r1.json.solo === false && r1.json.ready === 1 && r1.json.total === 2,
  `first ready is 1/2 (${JSON.stringify(r1.json)})`
);
await sleep(600);
check(
  adlerTap.seen.some((e) => e.ev === "fightReady" && e.data.ready === 1 && e.data.total === 2),
  "unready teammate saw fightReady 1/2 push"
);
check(!adlerTap.seen.some((e) => e.ev === "fightStart"), "no premature fightStart");

const r2 = await post(adler, "/api/fight/ready");
check(r2.json.ready === 2 && r2.json.total === 2, `second ready completes 2/2 (${JSON.stringify(r2.json)})`);
await sleep(600);
check(
  jungTap.seen.some((e) => e.ev === "fightStart" && e.data.roomId === roomId),
  "jung got fightStart push"
);
check(
  adlerTap.seen.some((e) => e.ev === "fightStart" && e.data.roomId === roomId),
  "adler got fightStart push"
);

// A second barrier for the same room starts clean.
const r3 = await post(jung, "/api/fight/ready");
check(r3.json.ready === 1 && r3.json.total === 2, `barrier resets after release (${JSON.stringify(r3.json)})`);

jungTap.close();
adlerTap.close();
// tidy: dissolve the test room
await post(adler, "/api/rooms/leave");
await post(jung, "/api/rooms/leave");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
