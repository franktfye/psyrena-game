/**

// Dev-fixture credentials (server/app.mjs seeds these under `npm run dev`).
// Point at another instance with PSYRENA_USER / PSYRENA_PW.
const USER = process.env.PSYRENA_USER ?? "frank";
const PW = process.env.PSYRENA_PW ?? "psyrena123";
 * Role-aware matchmaker check (not shipped — dev tool).
 *
 * Drives server/app.mjs's queue against a SCRATCH database (PSYRENA_DB) using
 * the seeded dev fixtures, asserting the 2026-08-04 rules:
 *   1. three solos WITHOUT a full tank/healer/dps spread do NOT match (they
 *      wait for the role or the timeout);
 *   2. the moment the missing role joins, the trio forms instantly;
 *   3. rooms record a difficulty and the browser list carries difficulty +
 *      member roles;
 *   4. the first-clear fight report unlocks Skinner (the healer path).
 *
 * Run: PSYRENA_DB=/tmp/rolequeue.db npx vite --port 5297 &   (fresh db)
 *      E2E_URL=http://localhost:5297 node tools/test-role-queue.mjs
 */
const BASE = (process.env.E2E_URL ?? "http://localhost:5297").replace(/\/$/, "");

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

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
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const resetLobby = async (c) => {
  await api(c, "/api/queue/leave", {});
  await api(c, "/api/rooms/leave", {});
};

const jung = await login("jung", "psyrena123"); // tank (pavlov)
const adler = await login("adler", "psyrena123"); // healer (skinner, via unlock)
const horney = await login("horney", "psyrena123"); // dps (freud)
const frank = await login("frank", PW); // second dps
for (const c of [jung, adler, horney, frank]) await resetLobby(c);

await api(jung, "/api/select-hero", { hero: "pavlov" });
await api(horney, "/api/select-hero", { hero: "freud" });
await api(frank, "/api/select-hero", { hero: "freud" });

// 4. The healer path: Skinner is locked until the first boss clear.
const locked = await api(adler, "/api/select-hero", { hero: "skinner" });
check(locked.status === 403, `skinner locked before the first clear (${locked.status})`);
const report = await api(adler, "/api/fight/result", {
  win: true, difficulty: "standard", durationMs: 60_000, dps: 100, healing: 10, damageTaken: 10,
});
check(report.json.heroUnlocked === "skinner", `first clear reports heroUnlocked (${report.json.heroUnlocked})`);
const sel = await api(adler, "/api/select-hero", { hero: "skinner" });
check(sel.status === 200, `skinner selectable after the clear (${sel.status})`);

// 1. tank + dps + dps: no healer → no instant match.
for (const c of [jung, horney, frank]) await api(c, "/api/queue/join", {});
let lobby = await api(horney, "/api/lobby");
check(lobby.json.queued === true && !lobby.json.room, "tank+dps+dps solos do NOT instant-match");
check(
  lobby.json.queueRoles?.healer === 0 && lobby.json.queueRoles?.tank === 1 && lobby.json.queueRoles?.dps === 2,
  `lobby reports the role census (${JSON.stringify(lobby.json.queueRoles)})`
);

// 2. The healer joins → tank + healer + OLDEST dps form instantly.
const healerJoin = await api(adler, "/api/queue/join", {});
const room = healerJoin.json.room;
check(!!room && /^Ranked Match #\d+$/.test(room.name ?? ""), `healer completes the trio instantly (${room?.name})`);
const members = (room?.members ?? []).map((m) => m.username).sort();
check(
  JSON.stringify(members) === JSON.stringify(["adler", "horney", "jung"]),
  `match holds tank+healer+oldest dps (${members.join(", ")})`
);
lobby = await api(frank, "/api/lobby");
check(lobby.json.queued === true && !lobby.json.room, "the newer dps keeps waiting");

// 3. Room difficulty + roles in the browser list.
await resetLobby(frank);
const created = await api(frank, "/api/rooms/create", { name: "RQ List Room", isPublic: true, difficulty: "nightmare" });
check(created.json.room?.difficulty === "nightmare", "created room records its difficulty");
const trioLobby = await api(jung, "/api/lobby");
const listed = (trioLobby.json.rooms ?? []).find((r) => r.name === "RQ List Room");
check(
  !!listed && listed.difficulty === "nightmare" && Array.isArray(listed.roles) && listed.roles[0] === "dps",
  `browser row carries difficulty + roles (${JSON.stringify({ d: listed?.difficulty, r: listed?.roles })})`
);

for (const c of [jung, adler, horney, frank]) await resetLobby(c);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
