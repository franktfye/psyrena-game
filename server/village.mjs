/**
 * Psyrena village presence — shared overworld lobbies of up to 50 players.
 *
 * Same SSE stance as server/social.mjs: client → server is ordinary POSTs,
 * server → client fan-out is one EventSource stream per tab. Presence is
 * in-memory only (positions are ephemeral by nature); the db handle is used
 * solely to resolve username/hero identity (and, for arena sessions, to
 * verify party membership). Presence here is per session and does not touch
 * the social layer's online roster.
 *
 * Two session flavors share all of the machinery below:
 *  - Village commons, ids "v1", "v2", … — auto-assigned, up to 50 players.
 *  - Arena party sessions, ids "a<roomId>" — joined explicitly with
 *    `{arena: roomId}`, gated on a room_members seat, capped at the party
 *    size. They exist so teammates SEE each other fighting (positions and
 *    casts are cosmetic). The fight itself is one shared sim in
 *    server/fight.mjs — this channel only carries the bodies.
 */

const MAX_PER_SESSION = 50;
const SPAWN_RADIUS = 6; // members spawn on a 6m ring around the origin
const STATE_RATE = { count: 10, windowMs: 1000 }; // 10 state posts/s per user
const CAST_RATE = { count: 8, windowMs: 2000 }; // casts are GCD-gated client-side; this is abuse headroom
const HEARTBEAT_MS = 25_000;
const FLUSH_MS = 200; // state broadcasts are batched on this cadence
const SWEEP_MS = 15_000;
const EXPIRE_MS = 60_000; // no state/join for 60s → member is gone

let db = null;
let helpers = null; // { send, readBody } borrowed from app.mjs

/** sessionId -> { members: Map<userId, member>, streams: Set<res>, nextIndex } */
const sessions = new Map();
/** userId -> sessionId */
const userSession = new Map();
/** userId -> recent state-post timestamps, for the rate limit */
const recentState = new Map();
/** userId -> recent cast-post timestamps, for the rate limit */
const recentCast = new Map();
/** sessionId -> Map<username, [x,y,z,ry,action]> awaiting the next flush */
const pendingState = new Map();

let sessionCounter = 0;
let timersStarted = false;

export function initVillage(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
  // Guard against double intervals if the module is reloaded (Vite middleware).
  if (timersStarted) return;
  timersStarted = true;
  const flush = setInterval(flushState, FLUSH_MS);
  const sweep = setInterval(sweepMembers, SWEEP_MS);
  flush.unref?.();
  sweep.unref?.();
}

// ---------------------------------------------------------------------------
// Sessions and membership
// ---------------------------------------------------------------------------

function identity(userId) {
  const row = db
    .prepare(
      `SELECT u.username, g.selected_hero AS hero
       FROM users u JOIN game_state g ON g.user_id = u.id WHERE u.id = ?`
    )
    .get(userId);
  return row ?? { username: "?", hero: "freud" };
}

/** Deterministic spawn on the 6m ring, slot by join order, facing the origin. */
function spawnPos(index) {
  const angle = index * ((2 * Math.PI) / 12);
  const x = SPAWN_RADIUS * Math.cos(angle);
  const z = SPAWN_RADIUS * Math.sin(angle);
  return { x, y: 0, z, ry: Math.atan2(-Math.cos(angle), -Math.sin(angle)) };
}

function snapshotOf(session) {
  return [...session.members.values()].map((m) => ({
    username: m.username, hero: m.hero, pet: m.pet ?? null, x: m.x, y: m.y, z: m.z, ry: m.ry,
  }));
}

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* a dying socket is handled by its own close event */
  }
}

function broadcast(session, event, data) {
  // Serialize once, write N times: the 5 Hz state flush of a full session to
  // all its streams made per-recipient stringify the quadratic term here.
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.streams) {
    try {
      res.write(frame);
    } catch {
      /* a dying socket is handled by its own close event */
    }
  }
}

function addMember(session, sid, userId, pet = null) {
  const who = identity(userId);
  const member = { ...who, pet, ...spawnPos(session.nextIndex++), action: "idle", lastSeen: Date.now() };
  session.members.set(userId, member);
  userSession.set(userId, sid);
  broadcast(session, "join", {
    username: member.username, hero: member.hero, pet: member.pet,
    x: member.x, y: member.y, z: member.z, ry: member.ry,
  });
  return member;
}

function removeMember(sid, userId) {
  const session = sessions.get(sid);
  if (!session) return;
  const member = session.members.get(userId);
  if (!member) return;
  session.members.delete(userId);
  userSession.delete(userId);
  // Drop any queued-but-unflushed position too, or the next flush broadcasts
  // one stale update for a player everyone just watched leave.
  pendingState.get(sid)?.delete(member.username);
  broadcast(session, "leave", { username: member.username });
  // v1 is the permanent commons; every other session dies when it empties.
  if (session.members.size === 0 && sid !== "v1") {
    sessions.delete(sid);
    pendingState.delete(sid);
  }
}

/**
 * Server-initiated departure (logout, offline beacon, grace sweep) — the same
 * path as POST /api/village/leave, callable from app.mjs.
 */
export function leaveVillage(userId) {
  const sid = userSession.get(userId);
  if (sid) removeMember(sid, userId);
}

/** First VILLAGE session with room, else a fresh one. v1 is always created
 *  first. Arena sessions ("a<roomId>") never absorb village joiners. */
function sessionWithSpace() {
  for (const [sid, s] of sessions) {
    if (sid.startsWith("v") && s.members.size < MAX_PER_SESSION) return [sid, s];
  }
  const sid = `v${++sessionCounter}`;
  const s = { members: new Map(), streams: new Set(), nextIndex: 0 };
  sessions.set(sid, s);
  return [sid, s];
}

// ---------------------------------------------------------------------------
// Background timers — state flush and member expiry
// ---------------------------------------------------------------------------

function flushState() {
  for (const [sid, pending] of pendingState) {
    if (pending.size === 0) continue;
    const session = sessions.get(sid);
    if (session) broadcast(session, "state", { players: Object.fromEntries(pending) });
    pending.clear();
  }
}

function sweepMembers() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    for (const [userId, member] of [...session.members]) {
      if (now - member.lastSeen > EXPIRE_MS) removeMember(sid, userId);
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleJoin(res, userId, payload = {}) {
  const { send } = helpers;
  // Cosmetic pet declaration — the equipped pet lives client-side (wardrobe
  // localStorage), so the client says which one rides along. Length-capped
  // like every other client string here.
  const pet = typeof payload.pet === "string" && payload.pet ? payload.pet.slice(0, 32) : null;

  // Arena party session: an explicit `{arena: roomId}` join, gated on the
  // caller actually holding a seat in that room.
  const arenaRoomId = Number.isInteger(payload.arena) ? Number(payload.arena) : null;
  let wantSid = null;
  if (arenaRoomId !== null) {
    const seat = db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").get(userId);
    if (!seat || Number(seat.room_id) !== arenaRoomId) {
      return send(res, 403, { error: "You are not in that party." });
    }
    wantSid = `a${arenaRoomId}`;
  }

  // Idempotent: re-joining the SAME session keeps you in it (and refreshes
  // the pet). Joining a different flavor (village → arena or back) moves you.
  const existing = userSession.get(userId);
  if (existing && sessions.has(existing)) {
    if (wantSid === null ? existing.startsWith("v") : existing === wantSid) {
      const session = sessions.get(existing);
      const member = session.members.get(userId);
      member.lastSeen = Date.now();
      // A pet swap mid-session: re-broadcast this member's `join` so everyone
      // already standing here swaps the pet too (clients treat a join for a
      // known player as an update). Only on a real change — a plain keepalive
      // re-join must stay silent.
      if (payload.pet !== undefined && pet !== member.pet) {
        member.pet = pet;
        broadcast(session, "join", {
          username: member.username, hero: member.hero, pet: member.pet,
          x: member.x, y: member.y, z: member.z, ry: member.ry,
        });
      }
      return send(res, 200, { sessionId: existing, players: snapshotOf(session) });
    }
    removeMember(existing, userId);
  }

  if (wantSid !== null) {
    let session = sessions.get(wantSid);
    if (!session) {
      session = { members: new Map(), streams: new Set(), nextIndex: 0 };
      sessions.set(wantSid, session);
    }
    addMember(session, wantSid, userId, pet);
    return send(res, 200, { sessionId: wantSid, players: snapshotOf(session) });
  }

  const [sid, session] = sessionWithSpace();
  addMember(session, sid, userId, pet);
  return send(res, 200, { sessionId: sid, players: snapshotOf(session) });
}

function handleLeave(res, userId) {
  const { send } = helpers;
  leaveVillage(userId);
  return send(res, 200, { ok: true });
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function handleState(res, userId, payload) {
  const { send } = helpers;
  const sid = userSession.get(userId);
  if (!sid || !sessions.has(sid)) return send(res, 409, { error: "Not in a village session." });

  // Over the limit the update is dropped silently — the client still gets a
  // 200 so it doesn't treat its own movement spam as an error.
  const now = Date.now();
  const list = (recentState.get(userId) ?? []).filter((t) => now - t < STATE_RATE.windowMs);
  if (list.length >= STATE_RATE.count) return send(res, 200, { ok: true, dropped: true });
  list.push(now);
  recentState.set(userId, list);

  const session = sessions.get(sid);
  const member = session.members.get(userId);
  member.x = num(payload.x, member.x);
  member.y = num(payload.y, member.y);
  member.z = num(payload.z, member.z);
  member.ry = num(payload.ry, member.ry);
  member.action = typeof payload.action === "string" ? payload.action.slice(0, 32) : member.action;
  member.lastSeen = now;

  let pending = pendingState.get(sid);
  if (!pending) pendingState.set(sid, (pending = new Map()));
  pending.set(member.username, [member.x, member.y, member.z, member.ry, member.action]);
  return send(res, 200, { ok: true });
}

/**
 * Skill casts are discrete events: unlike positions they bypass the batched
 * pendingState map (last-write-wins would eat bursts) and broadcast at once.
 * The payload is cosmetic-only — remote tabs play VFX/animation from it, no
 * combat resolution — so validation is just shape and rate.
 */
function handleCast(res, userId, payload) {
  const { send } = helpers;
  const sid = userSession.get(userId);
  if (!sid || !sessions.has(sid)) return send(res, 409, { error: "Not in a village session." });

  const now = Date.now();
  const list = (recentCast.get(userId) ?? []).filter((t) => now - t < CAST_RATE.windowMs);
  if (list.length >= CAST_RATE.count) return send(res, 200, { ok: true, dropped: true });
  list.push(now);
  recentCast.set(userId, list);

  const session = sessions.get(sid);
  const member = session.members.get(userId);
  member.lastSeen = now;
  const id = typeof payload.id === "string" ? payload.id.slice(0, 32) : "";
  const kind = typeof payload.kind === "string" ? payload.kind.slice(0, 16) : "";
  if (!id || !kind) return send(res, 400, { error: "Bad cast payload." });
  broadcast(session, "cast", { username: member.username, id, kind });
  return send(res, 200, { ok: true });
}

// Same guard as social.mjs's stream cap: a reload legitimately overlaps two
// streams; thousands is a socket/timer exhaustion attack.
const MAX_STREAMS_PER_USER = 4;
const userStreamCount = new Map();

function handleStream(req, res, url, userId) {
  const { send } = helpers;
  const sid = url.searchParams.get("session");
  // A stream only ever sees the session the user actually belongs to.
  if (!sid || userSession.get(userId) !== sid || !sessions.has(sid)) {
    return send(res, 403, { error: "That is not your village session." });
  }
  if ((userStreamCount.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
    return send(res, 429, { error: "Too many open streams." });
  }
  userStreamCount.set(userId, (userStreamCount.get(userId) ?? 0) + 1);
  const session = sessions.get(sid);
  const member = session.members.get(userId);
  member.lastSeen = Date.now();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  session.streams.add(res);
  sseWrite(res, "hello", { sessionId: sid, players: snapshotOf(session) });

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* close handler does the cleanup */
    }
  }, HEARTBEAT_MS);

  // Closing the stream does NOT leave the session — tabs reconnect; the 60s
  // sweep is what actually retires a member.
  req.on("close", () => {
    clearInterval(heartbeat);
    session.streams.delete(res);
    const n = (userStreamCount.get(userId) ?? 1) - 1;
    if (n <= 0) userStreamCount.delete(userId);
    else userStreamCount.set(userId, n);
  });
}

// ---------------------------------------------------------------------------
// Router — everything under /api/village/*. Auth is required for all of it.
// ---------------------------------------------------------------------------

export async function handleVillage(req, res, url, userId) {
  const { send, readBody } = helpers;
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;

  if (route === "POST /api/village/join") return handleJoin(res, userId, await readBody(req));
  if (route === "POST /api/village/leave") return handleLeave(res, userId);
  if (route === "POST /api/village/state") return handleState(res, userId, await readBody(req));
  if (route === "POST /api/village/cast") return handleCast(res, userId, await readBody(req));
  if (route === "GET /api/village/stream") return handleStream(req, res, url, userId);
  return send(res, 404, { error: "No such endpoint." });
}
