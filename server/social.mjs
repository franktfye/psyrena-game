/**
 * Psyrena social layer — lobby chat, private messages, friends, presence.
 *
 * Same zero-dependency stance as server/app.mjs, same sqlite file. Realtime is
 * Server-Sent Events rather than a WebSocket: SSE is plain HTTP, so it flows
 * through the Vite middleware mount unchanged (an Upgrade handshake would not),
 * the HttpOnly session cookie authenticates it for free, and EventSource
 * reconnects itself. Client → server traffic is ordinary POSTs; only the
 * server → client fan-out needs to be live.
 *
 * This is the HUB social channel (5 Hz-class traffic, doc 06), not the combat
 * stream — the Colyseus arena tick stays a separate future system.
 */

import { fileReport } from "./admin.mjs";

const LOBBY_HISTORY = 50; // what a joining client gets
const KEEP_MESSAGES = 500; // rows kept in the lobby channel / per DM conversation
const BODY_MAX = 240;
const RATE_LIMIT = { count: 5, windowMs: 4000 };
const HEARTBEAT_MS = 25_000;

let db = null;
let helpers = null; // { send, readBody } borrowed from app.mjs

/** userId -> Set<ServerResponse> — one user can have several tabs open. */
const clients = new Map();
/** userId -> recent message timestamps, for the send rate limit. */
const recentSends = new Map();
/**
 * userId -> Date.now() of the last-stream close (or an offline beacon). The
 * grace sweep in app.mjs consumes this; a reconnecting stream cancels the
 * entry. In-memory on purpose: after a dev-server module reload nobody is in
 * the map, so nobody can be grace-logged-out on stale evidence.
 */
const offlineSince = new Map();

/**
 * How long a lost stream is forgiven for someone who is still WAITING —
 * queued, or seated in a party whose fight has not opened yet.
 *
 * The general presence grace (app.mjs OFFLINE_GRACE_MS) is two minutes, which
 * is right for someone standing in the village: a reload or a tunnel keeps
 * their friends list and their room. It is badly wrong for a queued player,
 * because the matchmaker will seat them in a trio they are not coming back to
 * — and the fight party is built once, from room_members, so the other two
 * load into a boss sized for three beside a hero nobody is driving. This leash
 * is instead cut to just past the browser's own SSE reconnect (the stream is
 * served with `retry: 3000`), so a real blip still survives it and a closed
 * tab is gone before the next matchmaker tick.
 */
export const DROP_GRACE_MS = Number(process.env.PSYRENA_DROP_GRACE_MS) || 8000;

/**
 * Milliseconds since this user's last stream closed, or 0 while they hold one.
 *
 * Only ever non-zero for someone who HAD a stream and lost it — a client that
 * never opens one (the API-only e2e harnesses) is never reported as dropped.
 */
export function offlineFor(userId) {
  const id = Number(userId);
  if (clients.has(id)) return 0;
  const at = offlineSince.get(id);
  return at == null ? 0 : Date.now() - at;
}

/** True once a waiting player's disconnect has outlasted DROP_GRACE_MS. */
export function droppedOut(userId) {
  return offlineFor(userId) > DROP_GRACE_MS;
}

export function initSocial(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
  db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      user_id    INTEGER NOT NULL REFERENCES users(id),
      friend_id  INTEGER NOT NULL REFERENCES users(id),
      status     TEXT NOT NULL,               -- 'pending' (user_id asked) | 'accepted'
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,                  -- 'lobby' | 'dm'
      from_id INTEGER NOT NULL REFERENCES users(id),
      to_id   INTEGER,                        -- dm recipient, NULL for lobby
      body    TEXT NOT NULL,
      at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_dm ON chat_messages (channel, from_id, to_id, id);
  `);
  migrateFriends();
}

/**
 * The first scaffold shipped friends as a status-less mutual-pair table
 * (app.mjs created it before this module existed). Upgrade that shape in
 * place: add the columns, then collapse each mutual pair to one accepted row
 * so the single-row request/accept model holds.
 */
function migrateFriends() {
  const cols = db.prepare("PRAGMA table_info(friends)").all().map((c) => c.name);
  if (cols.includes("status")) return;
  db.exec(`
    ALTER TABLE friends ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted';
    ALTER TABLE friends ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
    DELETE FROM friends WHERE user_id > friend_id AND EXISTS (
      SELECT 1 FROM friends f2
      WHERE f2.user_id = friends.friend_id AND f2.friend_id = friends.user_id
    );
    UPDATE friends SET created_at = ${Date.now()} WHERE created_at = 0;
  `);
  console.log("[social] migrated friends table to request/accept schema");
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function userByName(name) {
  return typeof name === "string"
    ? db.prepare("SELECT id, username FROM users WHERE username = ?").get(name.trim()) ?? null
    : null;
}

function identity(userId) {
  const row = db
    .prepare(
      `SELECT u.username, g.selected_hero AS hero
       FROM users u JOIN game_state g ON g.user_id = u.id WHERE u.id = ?`
    )
    .get(userId);
  return row ?? { username: "?", hero: "freud" };
}

/** Accepted friendships involving userId → array of the OTHER user's id. */
function friendIds(userId) {
  return db
    .prepare(
      `SELECT user_id, friend_id FROM friends
       WHERE status = 'accepted' AND (user_id = ? OR friend_id = ?)`
    )
    .all(userId, userId)
    .map((r) => (Number(r.user_id) === userId ? Number(r.friend_id) : Number(r.user_id)));
}

function friendRow(a, b) {
  return (
    db
      .prepare("SELECT user_id, friend_id, status FROM friends WHERE user_id = ? AND friend_id = ?")
      .get(a, b) ??
    db
      .prepare("SELECT user_id, friend_id, status FROM friends WHERE user_id = ? AND friend_id = ?")
      .get(b, a) ??
    null
  );
}

/** Everything the friends panel renders, from one user's point of view. */
function snapshotFor(userId) {
  const friends = friendIds(userId).map((id) => {
    const who = identity(id);
    return { username: who.username, hero: who.hero, online: clients.has(id) };
  });
  const incoming = db
    .prepare("SELECT user_id FROM friends WHERE friend_id = ? AND status = 'pending'")
    .all(userId)
    .map((r) => identity(Number(r.user_id)).username);
  const outgoing = db
    .prepare("SELECT friend_id FROM friends WHERE user_id = ? AND status = 'pending'")
    .all(userId)
    .map((r) => identity(Number(r.friend_id)).username);
  return { friends, incoming, outgoing };
}

function messageJson(row) {
  const from = identity(Number(row.from_id));
  return {
    id: Number(row.id),
    from: from.username,
    hero: from.hero,
    to: row.to_id == null ? undefined : identity(Number(row.to_id)).username,
    body: row.body,
    at: Number(row.at),
  };
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeFrame(res, frame) {
  try {
    res.write(frame);
  } catch {
    /* a dying socket is handled by its own close event */
  }
}

function sseWrite(res, event, data) {
  writeFrame(res, sseFrame(event, data));
}

/** Live-connection census for the admin dashboard. */
export function onlineCount() {
  return clients.size;
}

export function onlineUserIds() {
  return [...clients.keys()].map(Number);
}

/** Exported so app.mjs can push account-level events (kicked, match). */
export function pushTo(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  // Serialize once, write N times — with a full lobby the per-recipient
  // stringify was the quadratic term in the chat fan-out.
  const frame = sseFrame(event, data);
  for (const res of set) writeFrame(res, frame);
}

function broadcast(event, data) {
  const frame = sseFrame(event, data);
  for (const set of clients.values()) for (const res of set) writeFrame(res, frame);
}

/** Friends care about MY presence/roster change: each gets their own snapshot. */
export function notifyFriendsOf(userId) {
  for (const fid of friendIds(userId)) {
    if (clients.has(fid)) pushTo(fid, "friends", snapshotFor(fid));
  }
}

/**
 * Record that a user went offline NOW (last stream closed, or the pagehide
 * beacon fired). This is the one moment "last seen" is known exactly, so the
 * persistent column is written here too.
 */
export function markOffline(userId) {
  offlineSince.set(userId, Date.now());
  db.prepare("UPDATE game_state SET last_seen = ? WHERE user_id = ?").run(Date.now(), userId);
}

/**
 * Users offline for longer than graceMs who never reconnected. Entries are
 * consumed — the caller (app.mjs's grace sweep) owns the logout that follows.
 * A live stream cancels the pending offline state (the beacon can fire on a
 * tab that then comes straight back from the bfcache).
 */
export function collectOfflineExpired(graceMs) {
  const now = Date.now();
  const expired = [];
  for (const [userId, at] of offlineSince) {
    if (clients.has(userId)) {
      offlineSince.delete(userId);
    } else if (now - at > graceMs) {
      offlineSince.delete(userId);
      expired.push(userId);
    }
  }
  return expired;
}

// A player legitimately holds one or two streams (a reload's old tab lingers
// briefly). A script opening thousands would hold a socket and a heartbeat
// timer each — refuse before the writeHead commits the connection.
const MAX_STREAMS_PER_USER = 4;

function handleStream(req, res, userId) {
  if ((clients.get(userId)?.size ?? 0) >= MAX_STREAMS_PER_USER) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many open streams." }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    // Tells nginx-style proxies not to buffer the stream in a future deploy.
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  let set = clients.get(userId);
  const firstConnection = !set;
  if (!set) clients.set(userId, (set = new Set()));
  set.add(res);
  offlineSince.delete(userId); // a live stream cancels any pending grace logout

  const lobby = db
    .prepare("SELECT * FROM chat_messages WHERE channel = 'lobby' ORDER BY id DESC LIMIT ?")
    .all(LOBBY_HISTORY)
    .reverse()
    .map(messageJson);
  sseWrite(res, "hello", { you: identity(userId).username, ...snapshotFor(userId), lobby });

  // Comment-only heartbeat: keeps proxies and the browser's reconnect logic
  // convinced the stream is alive without waking the client's message handlers.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* close handler does the cleanup */
    }
  }, HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    const live = clients.get(userId);
    if (live) {
      live.delete(res);
      if (live.size === 0) clients.delete(userId);
    }
    if (!clients.has(userId)) {
      // Went fully offline: start the grace clock and tell their friends.
      markOffline(userId);
      notifyFriendsOf(userId);
    }
  });

  if (firstConnection) notifyFriendsOf(userId); // came online
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function rateLimited(userId) {
  const now = Date.now();
  const list = (recentSends.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (list.length >= RATE_LIMIT.count) return true;
  list.push(now);
  recentSends.set(userId, list);
  return false;
}

function pruneChannel(channel) {
  db.prepare(
    `DELETE FROM chat_messages WHERE channel = ? AND id NOT IN (
       SELECT id FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT ?)`
  ).run(channel, channel, KEEP_MESSAGES);
}

/**
 * DMs prune per CONVERSATION, not per channel: a global 500-row cap on the
 * whole 'dm' channel would shred every private history within minutes of a
 * full lobby chatting. idx_chat_dm covers both sides of the pair.
 */
function pruneDm(a, b) {
  db.prepare(
    `DELETE FROM chat_messages WHERE channel = 'dm'
       AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
       AND id NOT IN (
         SELECT id FROM chat_messages WHERE channel = 'dm'
           AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
         ORDER BY id DESC LIMIT ?)`
  ).run(a, b, b, a, a, b, b, a, KEEP_MESSAGES);
}

function handleSend(res, userId, payload) {
  const { send } = helpers;
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!body) return send(res, 400, { error: "Empty message." });
  if (body.length > BODY_MAX) return send(res, 400, { error: `Max ${BODY_MAX} characters.` });
  if (rateLimited(userId)) return send(res, 429, { error: "Slow down a little." });
  // Moderation mute (users.muted_until, set from the admin console).
  const mute = db.prepare("SELECT muted_until FROM users WHERE id = ?").get(userId);
  if (mute && Number(mute.muted_until) > Date.now()) {
    const mins = Math.ceil((Number(mute.muted_until) - Date.now()) / 60_000);
    return send(res, 403, { error: `You are muted for another ${mins} min.` });
  }

  let target = null;
  if (payload.to !== undefined) {
    target = userByName(payload.to);
    if (!target) return send(res, 404, { error: "No such player." });
    if (Number(target.id) === userId) return send(res, 400, { error: "That would be a monologue." });
    const row = friendRow(userId, Number(target.id));
    if (!row || row.status !== "accepted") {
      return send(res, 403, { error: "You can only whisper friends." });
    }
  }

  const channel = target ? "dm" : "lobby";
  const info = db
    .prepare("INSERT INTO chat_messages (channel, from_id, to_id, body, at) VALUES (?, ?, ?, ?, ?)")
    .run(channel, userId, target ? Number(target.id) : null, body, Date.now());
  if (target) pruneDm(userId, Number(target.id));
  else pruneChannel("lobby");
  const msg = messageJson(
    db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(Number(info.lastInsertRowid))
  );

  if (target) {
    pushTo(userId, "dm", msg);
    pushTo(Number(target.id), "dm", msg);
  } else {
    broadcast("lobby", msg);
  }
  return send(res, 200, { ok: true, msg });
}

function handleDmHistory(res, userId, url) {
  const { send } = helpers;
  const other = userByName(url.searchParams.get("with"));
  if (!other) return send(res, 404, { error: "No such player." });
  const messages = db
    .prepare(
      `SELECT * FROM chat_messages WHERE channel = 'dm'
       AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
       ORDER BY id DESC LIMIT 50`
    )
    .all(userId, Number(other.id), Number(other.id), userId)
    .reverse()
    .map(messageJson);
  return send(res, 200, { messages });
}

// ---------------------------------------------------------------------------
// Reports — player-facing moderation intake. The reported message's body is
// snapshotted into the report (server/admin.mjs owns the table): chat rows
// prune aggressively, and a report must outlive its evidence.
// ---------------------------------------------------------------------------

const REPORT_RATE = { count: 3, windowMs: 60_000 };
const recentReports = new Map();

function handleReport(res, userId, payload) {
  const { send } = helpers;
  const reason = typeof payload.reason === "string" ? payload.reason.trim().slice(0, 200) : "";
  if (!reason) return send(res, 400, { error: "Say what you are reporting." });
  const now = Date.now();
  const hits = (recentReports.get(userId) ?? []).filter((t) => now - t < REPORT_RATE.windowMs);
  if (hits.length >= REPORT_RATE.count) {
    return send(res, 429, { error: "You are reporting too fast — give the moderators a moment." });
  }
  hits.push(now);
  recentReports.set(userId, hits);

  let targetId, messageId = null, channel = null, messageBody = null;
  if (payload.messageId != null) {
    const m = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(Number(payload.messageId));
    if (!m) return send(res, 404, { error: "That message is gone." });
    // A whisper is only reportable by one of its two participants.
    if (m.channel === "dm" && Number(m.from_id) !== userId && Number(m.to_id) !== userId) {
      return send(res, 403, { error: "Not your conversation." });
    }
    if (Number(m.from_id) === userId) return send(res, 400, { error: "That is your own message." });
    targetId = Number(m.from_id);
    messageId = Number(m.id);
    channel = m.channel;
    messageBody = m.body;
  } else {
    const target = userByName(payload.username);
    if (!target) return send(res, 404, { error: "No such player." });
    if (Number(target.id) === userId) return send(res, 400, { error: "You cannot report yourself." });
    targetId = Number(target.id);
  }
  const reportId = fileReport({ reporterId: userId, targetId, messageId, channel, messageBody, reason });
  return send(res, 200, { ok: true, reportId });
}

/**
 * Public profile card — what tapping a player in the village shows. Only
 * fields any player could already see on a leaderboard are returned (no
 * wallet, no email); `friendship` is from the REQUESTER's point of view so
 * the card can label its button without a second round trip.
 */
function handlePlayerInfo(res, userId, url) {
  const { send } = helpers;
  const target = userByName(url.searchParams.get("username"));
  if (!target) return send(res, 404, { error: "No such player." });
  const targetId = Number(target.id);
  const g =
    db
      .prepare(
        `SELECT rank, title, score, battles, wins, bosses_defeated, selected_hero
         FROM game_state WHERE user_id = ?`
      )
      .get(targetId) ?? {};
  const row = friendRow(userId, targetId);
  const friendship =
    targetId === userId
      ? "self"
      : row?.status === "accepted"
        ? "friends"
        : row?.status === "pending"
          ? Number(row.user_id) === userId
            ? "requested"
            : "incoming"
          : "none";
  return send(res, 200, {
    username: target.username,
    hero: g.selected_hero ?? "freud",
    rank: g.rank ?? "Novice",
    title: g.title ?? "",
    score: Number(g.score ?? 0),
    battles: Number(g.battles ?? 0),
    wins: Number(g.wins ?? 0),
    bossesDefeated: Number(g.bosses_defeated ?? 0),
    online: clients.has(targetId),
    friendship,
  });
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

function handleFriendOp(res, userId, payload) {
  const { send } = helpers;
  const op = payload.op;
  const target = userByName(payload.username);
  if (!target) return send(res, 404, { error: "No such player." });
  const targetId = Number(target.id);
  if (targetId === userId) return send(res, 400, { error: "You are already your own ally." });

  const row = friendRow(userId, targetId);

  // A request that actually became pending — as opposed to one that collapsed
  // into an accept because they had already asked. Only the former is worth
  // pushing a card for; the latter makes them friends outright, and the
  // `friends` snapshot below already says so.
  let asked = false;

  if (op === "request") {
    if (row?.status === "accepted") return send(res, 400, { error: "Already friends." });
    if (row && Number(row.user_id) === userId) return send(res, 400, { error: "Request already sent." });
    if (row) {
      // They asked first — treat my request as an accept.
      db.prepare("UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?")
        .run(targetId, userId);
    } else {
      db.prepare("INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)")
        .run(userId, targetId, Date.now());
      asked = true;
    }
  } else if (op === "accept") {
    if (!row || row.status !== "pending" || Number(row.user_id) !== targetId) {
      return send(res, 400, { error: "No pending request from them." });
    }
    db.prepare("UPDATE friends SET status = 'accepted' WHERE user_id = ? AND friend_id = ?")
      .run(targetId, userId);
  } else if (op === "decline" || op === "remove") {
    db.prepare("DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)")
      .run(userId, targetId, targetId, userId);
  } else {
    return send(res, 400, { error: "Unknown friend op." });
  }

  pushTo(userId, "friends", snapshotFor(userId));
  pushTo(targetId, "friends", snapshotFor(targetId));

  // The `friends` snapshot above is state, not an event: it repaints the chat
  // panel's roster and nothing else, so a player with the panel shut never
  // learned they had been asked. This is the same missing half the party
  // invite had (ui/invitePopup.ts) — push the request itself so the recipient
  // gets a card on screen. Sent AFTER the snapshot so the card and the list it
  // refers to can never disagree.
  //
  // Only for a live recipient, by construction: `pushTo` is a no-op with no
  // open stream. Someone offline is not dropped, they just meet the request as
  // a list entry next login — which is what the hello snapshot is for.
  if (asked) {
    const from = identity(userId);
    pushTo(targetId, "friendRequest", { from: from.username, hero: from.hero });
  }

  return send(res, 200, snapshotFor(userId));
}

// ---------------------------------------------------------------------------
// Router — everything under /api/social/*. Auth is required for all of it.
// ---------------------------------------------------------------------------

export async function handleSocial(req, res, url, userId) {
  const { send, readBody } = helpers;
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/social/stream") return handleStream(req, res, userId);
  if (route === "POST /api/social/send") return handleSend(res, userId, await readBody(req));
  if (route === "GET /api/social/dm") return handleDmHistory(res, userId, url);
  if (route === "GET /api/social/player") return handlePlayerInfo(res, userId, url);
  if (route === "POST /api/social/friend") return handleFriendOp(res, userId, await readBody(req));
  if (route === "POST /api/social/report") return handleReport(res, userId, await readBody(req));
  return send(res, 404, { error: "No such endpoint." });
}
