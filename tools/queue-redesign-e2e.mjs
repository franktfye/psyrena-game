/**
 * Queue redesign e2e — the server half, driven straight through the HTTP API.
 *
 * Covers the two rules the 2026-08-10 redesign added, both of which are
 * invisible in the UI until they go wrong:
 *
 *   1. The matchmaker never groups across difficulties. Difficulty decides the
 *      boss's HP/damage AND the score/imaginz/XP/loot multipliers, so a player
 *      swept into someone else's pool is handed a fight and a paycheck they
 *      did not choose.
 *   2. A matchmade room — which has no leader anyone consented to — starts
 *      only when every seated member has pressed ready. A player-created room
 *      still starts on its leader's button, and only at full strength.
 *
 * Runs headless against a scratch DB on a scratch port; touches nothing real.
 *
 *   node tools/queue-redesign-e2e.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const workDir = mkdtempSync(join(tmpdir(), "psyrena-queue-e2e-"));

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// --- a session per player: one cookie jar, one set of helpers ---------------
function player(username) {
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith("psyrena_session=")) cookie = c.split(";")[0];
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  return {
    username,
    call,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    lobby: async () => (await call("GET", "/api/lobby")).json,
  };
}

async function register(username, hero) {
  const p = player(username);
  const reg = await p.post("/api/register", { username, password: "Testpass123" });
  if (reg.status !== 200) throw new Error(`register ${username}: ${reg.status} ${JSON.stringify(reg.json)}`);
  const sel = await p.post("/api/select-hero", { hero });
  if (sel.status !== 200) throw new Error(`select-hero ${username}: ${JSON.stringify(sel.json)}`);
  return p;
}

async function waitFor(fn, ms = 4000) {
  const started = Date.now();
  for (;;) {
    const hit = await fn();
    if (hit) return hit;
    if (Date.now() - started > ms) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

// --- boot -------------------------------------------------------------------
const running = [];
const serverLog = [];

/** Start a server on `port` against `dbFile`; resolves once it answers. */
async function boot(port, dbFile, extraEnv = {}) {
  const proc = spawn(process.execPath, [join(ROOT, "server", "index.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PSYRENA_DB: dbFile,
      PSYRENA_INVITE_REQUIRED: "0",
      PSYRENA_REGISTER_RATE_MAX: "999",
      PSYRENA_LOGIN_RATE_MAX: "999",
      // Match fast so the suite does not sit on the 5 s production tick.
      PSYRENA_MATCH_MS: "400",
      // Long enough that the timeout hatch never fires under us — the one
      // section that wants it boots its own server with a short value.
      PSYRENA_QUEUE_TIMEOUT_MS: "600000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(proc);
  proc.stdout.on("data", (d) => serverLog.push(String(d)));
  proc.stderr.on("data", (d) => serverLog.push(String(d)));
  const up = await waitFor(async () => {
    if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode}:\n${serverLog.join("")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/lobby`);
      return r.status === 401 || r.status === 200;
    } catch {
      return false;
    }
  }, 15000);
  if (!up) throw new Error(`server on ${port} never came up:\n${serverLog.join("")}`);
  return proc;
}

const cleanup = () => {
  for (const p of running) p.kill("SIGTERM");
  rmSync(workDir, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  const mainDb = join(workDir, "test.db");
  await boot(PORT, mainDb);

  // -------------------------------------------------------------------------
  console.log("\nA. Difficulty partitions the queue");
  // A role-complete trio that does NOT agree on difficulty must never match.
  const tankH = await register("qr_tank_h", "pavlov");
  const healH = await register("qr_heal_h", "skinner");
  const dpsN = await register("qr_dps_n", "freud");

  await tankH.post("/api/queue/join", { difficulty: "hard" });
  await healH.post("/api/queue/join", { difficulty: "hard" });
  await dpsN.post("/api/queue/join", { difficulty: "nightmare" });

  const crossed = await waitFor(async () => ((await tankH.lobby()).room ? true : false), 2000);
  check("a role-complete trio split across pools does NOT match", !crossed);

  const hardLobby = await tankH.lobby();
  check("queueSize counts only my own pool", hardLobby.queueSize === 2, `got ${hardLobby.queueSize}`);
  check(
    "queueCounts reports every pool",
    hardLobby.queueCounts?.hard === 2 && hardLobby.queueCounts?.nightmare === 1,
    JSON.stringify(hardLobby.queueCounts)
  );
  check(
    "role census covers my pool only (dps still missing)",
    hardLobby.queueRoles?.dps === 0,
    JSON.stringify(hardLobby.queueRoles)
  );
  check("queueDifficulty echoes what I picked", hardLobby.queueDifficulty === "hard");

  // The third seat, this time in the right pool.
  const dpsH = await register("qr_dps_h", "freud");
  await dpsH.post("/api/queue/join", { difficulty: "hard" });

  const matched = await waitFor(async () => (await tankH.lobby()).room, 4000);
  check("same-pool role-complete trio matches", !!matched);
  check("the formed room carries the pool's difficulty", matched?.difficulty === "hard", matched?.difficulty);
  check("the formed room is flagged matchmade", matched?.matchmade === true);
  check("the trio is seated together", matched?.members?.length === 3, `${matched?.members?.length}`);

  const stillWaiting = await dpsN.lobby();
  check("the odd-pool player is left queued, not swept in", stillWaiting.room === null && stillWaiting.queued);

  // -------------------------------------------------------------------------
  console.log("\nB. Matchmade rooms start on a unanimous ready-check");
  const before = await tankH.lobby();
  check("nobody starts out ready", before.room.readyCount === 0 && before.room.youReady === false);
  check("members carry their own ready flag", before.room.members.every((m) => m.ready === false));

  await tankH.post("/api/rooms/ready", { ready: true });
  const one = await tankH.lobby();
  check("my press is reflected back to me", one.room.youReady === true && one.room.readyCount === 1);
  const seenByOther = await healH.lobby();
  check(
    "my press is visible to teammates",
    seenByOther.room.members.filter((m) => m.ready).length === 1,
    JSON.stringify(seenByOther.room.members.map((m) => m.ready))
  );
  check("a partial ready-check does NOT launch", seenByOther.room !== null && seenByOther.queued === false);

  await healH.post("/api/rooms/ready", { ready: true });
  const two = await tankH.lobby();
  check("2/3 still holds the party", two.room !== null && two.room.readyCount === 2);

  // Un-readying steps back out — the check is a toggle, not a trapdoor.
  await healH.post("/api/rooms/ready", { ready: false });
  check("un-ready decrements the count", (await tankH.lobby()).room.readyCount === 1);
  await healH.post("/api/rooms/ready", { ready: true });

  // The LAST press launches everyone. The room is torn down as the members
  // walk into the arena, so the launch shows up as partyLaunch + a cleared
  // queue; the room row itself survives until someone leaves it.
  const launch = await dpsH.post("/api/rooms/ready", { ready: true });
  check("the last ready press returns 200", launch.status === 200, `${launch.status}`);
  const after = await tankH.lobby();
  check("launching clears the party's queue rows", after.queued === false);
  check("ready flags are spent by the launch", after.room.readyCount === 0);

  // -------------------------------------------------------------------------
  console.log("\nC. A membership change resets the dots");
  await tankH.post("/api/rooms/ready", { ready: true });
  await healH.post("/api/rooms/ready", { ready: true });
  check("two are ready again", (await tankH.lobby()).room.readyCount === 2);
  await healH.post("/api/rooms/leave", {});
  const afterLeave = await tankH.lobby();
  check(
    "a member leaving clears EVERY flag, not just theirs",
    afterLeave.room.readyCount === 0 && afterLeave.room.members.every((m) => !m.ready),
    `readyCount=${afterLeave.room.readyCount}`
  );

  // -------------------------------------------------------------------------
  console.log("\nD. Player-created rooms: leader only, full strength only");
  const host = await register("qr_host", "pavlov");
  const mate = await register("qr_mate", "skinner");
  await host.post("/api/rooms/create", { name: "Test Room", isPublic: true, difficulty: "standard" });
  const roomId = (await host.lobby()).room.id;
  await mate.post("/api/rooms/join", { roomId });

  const teamRoom = (await host.lobby()).room;
  check("a created room is NOT matchmade", teamRoom.matchmade === false);
  check("its creator is the host", teamRoom.isHost === true);

  const readyOnTeam = await host.post("/api/rooms/ready", { ready: true });
  check("the ready-check is refused in a team room", readyOnTeam.status === 403, `${readyOnTeam.status}`);

  const shortLaunch = await host.post("/api/rooms/launch", {});
  check("an under-strength leader launch is refused", shortLaunch.status === 409, `${shortLaunch.status}`);

  const memberLaunch = await mate.post("/api/rooms/launch", {});
  check("a non-leader launch is refused", memberLaunch.status === 403, `${memberLaunch.status}`);

  const third = await register("qr_third", "freud");
  await third.post("/api/rooms/join", { roomId });
  const fullLaunch = await host.post("/api/rooms/launch", {});
  check("a full party's leader launch succeeds", fullLaunch.status === 200, `${fullLaunch.status}`);

  // -------------------------------------------------------------------------
  console.log("\nE. A party queues at its ROOM's difficulty, not the leader's picker");
  const ph = await register("qr_party_host", "pavlov");
  await ph.post("/api/rooms/create", { name: "Nightmare Room", isPublic: true, difficulty: "nightmare" });
  // Leader asks for standard; the room says nightmare, and the room wins.
  await ph.post("/api/queue/join", { difficulty: "standard" });
  const partyQ = await ph.lobby();
  check("the party queued at the room's difficulty", partyQ.queueDifficulty === "nightmare", partyQ.queueDifficulty);
  check(
    "it lands in the nightmare pool",
    (partyQ.queueCounts?.nightmare ?? 0) >= 1,
    JSON.stringify(partyQ.queueCounts)
  );
  await ph.post("/api/queue/leave", {});

  // -------------------------------------------------------------------------
  console.log("\nF. Re-queueing keeps your place; changing difficulty resets it");
  const hopper = await register("qr_hopper", "freud");
  await hopper.post("/api/queue/join", { difficulty: "standard" });
  const firstAt = (await hopper.lobby()).queueDifficulty;
  await hopper.post("/api/queue/join", { difficulty: "standard" });
  check("re-queueing at the same difficulty is idempotent", firstAt === "standard");
  await hopper.post("/api/queue/join", { difficulty: "nightmare" });
  check("changing difficulty moves pools", (await hopper.lobby()).queueDifficulty === "nightmare");
  await hopper.post("/api/queue/leave", {});

  // -------------------------------------------------------------------------
  console.log("\nG. Migrations are idempotent, and survive a restart");
  // Booting a SECOND process against the same file re-runs every guarded
  // ALTER. If any of them were unguarded this throws and the server dies.
  await boot(PORT + 2, mainDb);
  const rebooted = player("qr_reboot");
  const relog = await rebooted.post("/api/login", { username: "qr_hopper", password: "Testpass123" });
  check("a second boot on an existing DB serves traffic", relog.status === 200, `${relog.status}`);

  // -------------------------------------------------------------------------
  console.log("\nH. The 90 s hatch: alone past the timeout, per pool");
  const hatchDb = join(workDir, "hatch.db");
  const HPORT = PORT + 4;
  await boot(HPORT, hatchDb, { PSYRENA_QUEUE_TIMEOUT_MS: "1200", PSYRENA_MATCH_MS: "400" });
  const hatchBase = `http://127.0.0.1:${HPORT}`;
  const lone = (() => {
    let cookie = "";
    const call = async (method, path, body) => {
      const res = await fetch(hatchBase + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        if (c.startsWith("psyrena_session=")) cookie = c.split(";")[0];
      }
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    return { call, post: (p, b) => call("POST", p, b ?? {}), lobby: async () => (await call("GET", "/api/lobby")).json };
  })();
  await lone.post("/api/register", { username: "qr_lonely", password: "Testpass123" });
  await lone.post("/api/select-hero", { hero: "freud" });
  await lone.post("/api/queue/join", { difficulty: "nightmare" });

  const hatchRoom = await waitFor(async () => (await lone.lobby()).room, 8000);
  check("a lone stale queuer is taken in rather than stranded", !!hatchRoom);
  check("the hatch room is matchmade", hatchRoom?.matchmade === true);
  check("it keeps the pool's difficulty", hatchRoom?.difficulty === "nightmare", hatchRoom?.difficulty);
  check("it is a 1-seat room", hatchRoom?.members?.length === 1, `${hatchRoom?.members?.length}`);
  const soloReady = await lone.post("/api/rooms/ready", { ready: true });
  check("one press launches a 1-seat matchmade room", soloReady.status === 200, `${soloReady.status}`);
  check("and it leaves the queue", (await lone.lobby()).queued === false);

  // -------------------------------------------------------------------------
  // The seam between this work and the drop-out sweep (tools/queue-drop-e2e):
  // a ready-check counts PRESSES, and a player whose tab died can never press.
  // Without eviction at the door the lobby stalls on a ghost for the whole
  // presence grace, which is the exact failure that fix exists to prevent.
  console.log("\nI. A ready-check does not stall on a dropped teammate");
  const DPORT = PORT + 6;
  const dropDb = join(workDir, "drop.db");
  await boot(DPORT, dropDb, { PSYRENA_DROP_GRACE_MS: "600", PSYRENA_MATCH_MS: "400" });
  const dBase = `http://127.0.0.1:${DPORT}`;

  const dPlayer = (name) => {
    let cookie = "";
    const call = async (method, path, body) => {
      const res = await fetch(dBase + path, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        if (c.startsWith("psyrena_session=")) cookie = c.split(";")[0];
      }
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    // Holding this open is what makes the player "present"; aborting it is the
    // tab closing.
    const stream = () => {
      const ctrl = new AbortController();
      const ready = fetch(`${dBase}/api/social/stream`, { headers: { cookie }, signal: ctrl.signal })
        .then((r) => void r.body.getReader().read().catch(() => {}))
        .catch(() => {});
      return { ready, close: () => ctrl.abort() };
    };
    return { name, call, post: (p, b) => call("POST", p, b ?? {}), lobby: async () => (await call("GET", "/api/lobby")).json, stream };
  };

  const trio = [
    { p: dPlayer("qr_d_tank"), hero: "pavlov" },
    { p: dPlayer("qr_d_heal"), hero: "skinner" },
    { p: dPlayer("qr_d_dps"), hero: "freud" },
  ];
  for (const { p, hero } of trio) {
    await p.post("/api/register", { username: p.name, password: "Testpass123" });
    await p.post("/api/select-hero", { hero });
  }
  const streams = trio.map(({ p }) => p.stream());
  await Promise.all(streams.map((s) => s.ready));
  await new Promise((r) => setTimeout(r, 300));
  for (const { p } of trio) await p.post("/api/queue/join", { difficulty: "standard" });

  const dRoom = await waitFor(async () => (await trio[0].p.lobby()).room, 5000);
  check("the drop-test trio matched", dRoom?.members?.length === 3, `${dRoom?.members?.length}`);

  streams[2].close(); // the dps closes their tab in the lobby
  await new Promise((r) => setTimeout(r, 1200));

  await trio[0].p.post("/api/rooms/ready", { ready: true });
  const afterEvict = await trio[0].p.lobby();
  check(
    "the dropped teammate is evicted from the lobby",
    afterEvict.room?.members?.length === 2,
    `${afterEvict.room?.members?.length} still seated`
  );

  // Two present players can now finish the check between them.
  const finish = await trio[1].p.post("/api/rooms/ready", { ready: true });
  check("the remaining pair can complete the ready-check", finish.status === 200, `${finish.status}`);
  const launched = await trio[0].p.lobby();
  check(
    "and the fight launches rather than stalling on the ghost",
    launched.room?.readyCount === 0 && launched.queued === false,
    JSON.stringify({ readyCount: launched.room?.readyCount, queued: launched.queued })
  );
} catch (err) {
  console.error("\nHARNESS ERROR:", err);
  console.error(serverLog.join(""));
  failures++;
}

console.log(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
