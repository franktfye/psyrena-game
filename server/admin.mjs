/**
 * Psyrena admin layer — the operational console behind GET /admin.
 *
 * Same zero-dependency stance as the rest of server/: this module owns the
 * moderation/ops schema (admin flag, bans, mutes, invitation codes, reports)
 * and every /api/admin/* route. The console UI itself is one static file
 * (server/adminConsole.html) served at /admin; it talks to these routes with
 * the same session cookie the game uses — an admin is just a player whose
 * users.is_admin flag is set.
 *
 * Authorization model:
 *  - The FIRST account ever created is promoted to admin automatically (the
 *    bootstrap problem: someone must be able to open the console before the
 *    console can appoint anyone). PSYRENA_ADMIN=<username> at boot promotes
 *    explicitly for existing databases.
 *  - Every other appointment happens in the console (POST /api/admin/user/appoint).
 *  - Demoting the last remaining admin is refused — the console must never be
 *    able to lock everyone out.
 *
 * Registration policy: once any account exists, new registrations require an
 * invitation code (one-time or multi-use, minted here). Disable with
 * PSYRENA_INVITE_REQUIRED=0 for open-registration deployments.
 *
 * Gift codes for the coffee shop are managed here but REDEEMED in
 * server/coffee.mjs (which owns the storefront and the buff grant); the two
 * tables are created there. This module only mints/lists/disables.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent } from "./events.mjs";
import { pushTo, notifyFriendsOf, onlineCount, onlineUserIds } from "./social.mjs";
import { creditImaginz, balanceFor } from "./economy.mjs";
import { COFFEE_ITEMS } from "./coffee.mjs";

// Permanent ban sentinel: 9999-12-31T23:59:59Z. Anything else is timed.
export const BAN_FOREVER = 253402300799000;

const CONSOLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "adminConsole.html");

let db = null;
let helpers = null; // { send, readBody, tx, leaveRoom, leaveVillage, createUser, setPassword, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX } from app.mjs

export function initAdmin(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;

  // Moderation columns ride on users — guarded ALTERs, same additive-migration
  // style as app.mjs. banned_until/muted_until of 0 mean "not".
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("is_admin")) db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("banned_until")) db.exec("ALTER TABLE users ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("ban_reason")) db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT");
  if (!cols.includes("muted_until")) db.exec("ALTER TABLE users ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0");

  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code       TEXT PRIMARY KEY,
      created_by INTEGER REFERENCES users(id),
      note       TEXT,
      max_uses   INTEGER NOT NULL DEFAULT 1,   -- 0 = unlimited
      uses       INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,                      -- NULL = never
      disabled   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invite_uses (
      code    TEXT NOT NULL REFERENCES invite_codes(code),
      user_id INTEGER NOT NULL REFERENCES users(id),
      at      INTEGER NOT NULL,
      PRIMARY KEY (code, user_id)
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id  INTEGER NOT NULL REFERENCES users(id),
      target_id    INTEGER REFERENCES users(id),
      message_id   INTEGER,                    -- chat_messages.id at report time
      channel      TEXT,                       -- 'lobby' | 'dm' when a message was reported
      message_body TEXT,                       -- snapshot: chat rows prune, reports must not rot
      reason       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
      created_at   INTEGER NOT NULL,
      resolved_by  INTEGER REFERENCES users(id),
      resolved_at  INTEGER,
      resolution   TEXT
    );
  `);

  // PSYRENA_ADMIN=frank promotes an existing account by name — the escape
  // hatch for databases that predate the first-user rule.
  const envAdmin = process.env.PSYRENA_ADMIN?.trim();
  if (envAdmin) {
    const row = db.prepare("SELECT id, is_admin FROM users WHERE username = ?").get(envAdmin);
    if (row && !row.is_admin) {
      db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(row.id);
      console.log(`[admin] promoted ${envAdmin} via PSYRENA_ADMIN`);
    }
  }
  ensureAdminBootstrap();
}

/**
 * If accounts exist but no admin does, promote the oldest account. Called at
 * boot, after the dev seed, and after the first registration — whichever
 * creates the first account, someone can always open the console.
 */
export function ensureAdminBootstrap() {
  if (db.prepare("SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1").get()) return;
  const oldest = db.prepare("SELECT id, username FROM users ORDER BY id LIMIT 1").get();
  if (!oldest) return;
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(oldest.id);
  logEvent("admin.bootstrap", Number(oldest.id), { username: oldest.username });
  console.log(`[admin] bootstrap: ${oldest.username} is now an admin (first account)`);
}

export function isAdmin(userId) {
  if (!userId) return false;
  const row = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId);
  return !!row?.is_admin;
}

/** Active ban for this account, or null. Expired bans read as null. */
export function banInfo(userId) {
  const row = db.prepare("SELECT banned_until, ban_reason FROM users WHERE id = ?").get(userId);
  if (!row || Number(row.banned_until) <= Date.now()) return null;
  return {
    until: Number(row.banned_until),
    permanent: Number(row.banned_until) >= BAN_FOREVER,
    reason: row.ban_reason ?? "",
  };
}

// ---------------------------------------------------------------------------
// Invitation codes — the registration gate. app.mjs consumes these.
// ---------------------------------------------------------------------------

/**
 * Whether POST /api/register must present a code right now. Precedence:
 * PSYRENA_INVITE_REQUIRED=0 forces open (deployment-level override), then the
 * console-set policy (admin_settings), then the default — required as soon as
 * any account exists (the bootstrap account itself never needs a code).
 */
export function inviteRequired() {
  if (process.env.PSYRENA_INVITE_REQUIRED === "0") return false;
  const policy = db.prepare("SELECT value FROM admin_settings WHERE key = 'invite_required'").get();
  if (policy) return policy.value !== "0";
  return !!db.prepare("SELECT 1 FROM users LIMIT 1").get();
}

/** Console toggle behind POST /api/admin/invites/policy. */
export function setInviteRequired(required, byUserId) {
  db.prepare(
    `INSERT INTO admin_settings (key, value, updated_by, updated_at) VALUES ('invite_required', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(required ? "1" : "0", byUserId, Date.now());
}

/**
 * Atomically take one use of a code. Guarded UPDATE, so two concurrent
 * registrations racing for a one-time code cannot both win: whoever's UPDATE
 * changes zero rows lost. Returns null on success or an error string.
 * Call releaseInvite() if account creation fails afterwards.
 */
export function reserveInvite(code) {
  const row = db.prepare("SELECT * FROM invite_codes WHERE code = ?").get(code);
  if (!row || row.disabled) return "That invitation code is not valid.";
  if (row.expires_at != null && Number(row.expires_at) < Date.now()) {
    return "That invitation code has expired.";
  }
  const taken = db.prepare(
    `UPDATE invite_codes SET uses = uses + 1
     WHERE code = ? AND disabled = 0 AND (max_uses = 0 OR uses < max_uses)`
  ).run(code);
  if (Number(taken.changes) === 0) return "That invitation code has already been used.";
  return null;
}

export function releaseInvite(code) {
  db.prepare("UPDATE invite_codes SET uses = MAX(0, uses - 1) WHERE code = ?").run(code);
}

export function recordInviteUse(code, userId) {
  db.prepare("INSERT OR IGNORE INTO invite_uses (code, user_id, at) VALUES (?, ?, ?)")
    .run(code, userId, Date.now());
  logEvent("invite.redeem", userId, { code });
}

// Codes read over voice/text without ambiguity: no 0/O, 1/I/L.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function mintCode(prefix) {
  let body = "";
  for (const byte of randomBytes(8)) body += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Filing reports — called from social.mjs (player-facing) with the target
// already resolved. Kept here so the schema and its writers live together.
// ---------------------------------------------------------------------------

export function fileReport({ reporterId, targetId, messageId, channel, messageBody, reason }) {
  const info = db.prepare(
    `INSERT INTO reports (reporter_id, target_id, message_id, channel, message_body, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(reporterId, targetId ?? null, messageId ?? null, channel ?? null, messageBody ?? null, reason, Date.now());
  logEvent("report.file", reporterId, { reportId: Number(info.lastInsertRowid), targetId, messageId });
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function userByRef(payload) {
  if (payload.userId != null) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.userId)) ?? null;
  }
  if (typeof payload.username === "string") {
    return db.prepare("SELECT * FROM users WHERE username = ?").get(payload.username.trim()) ?? null;
  }
  return null;
}

/** Sever every live hold a user has: sessions, room, queue, village seat. */
function forceLogout(uid, reason) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(uid);
  helpers.leaveRoom(uid);
  db.prepare("DELETE FROM queue WHERE user_id = ?").run(uid);
  helpers.leaveVillage(uid);
  pushTo(uid, "kicked", { reason });
  notifyFriendsOf(uid);
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Last `days` calendar days (UTC), oldest first, zero-filled. */
function daySeries(days) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(now - i * 24 * 3600 * 1000));
  return out;
}

function overview() {
  const now = Date.now();
  const startOfDay = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const n = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);

  const totals = {
    users: n("SELECT COUNT(*) AS n FROM users"),
    admins: n("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1"),
    online: onlineCount(),
    sessions: n("SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ?", now),
    queue: n("SELECT COUNT(*) AS n FROM queue"),
    rooms: n("SELECT COUNT(*) AS n FROM rooms"),
    banned: n("SELECT COUNT(*) AS n FROM users WHERE banned_until > ?", now),
    muted: n("SELECT COUNT(*) AS n FROM users WHERE muted_until > ?", now),
    openReports: n("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    imaginzSupply: n("SELECT COALESCE(SUM(imaginz),0) AS n FROM wallets"),
    messagesToday: n("SELECT COUNT(*) AS n FROM chat_messages WHERE at >= ?", startOfDay),
    fightsToday: n("SELECT COUNT(*) AS n FROM game_events WHERE type = 'fight.result' AND at >= ?", startOfDay),
    registrationsToday: n("SELECT COUNT(*) AS n FROM game_events WHERE type = 'auth.register' AND at >= ?", startOfDay),
  };

  // 14-day series. users.created_at is sqlite TEXT UTC, game_events.at epoch ms.
  const days = daySeries(14);
  const zero = () => Object.fromEntries(days.map((d) => [d, 0]));
  const registrations = zero();
  for (const r of db.prepare(
    "SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-14 days') GROUP BY d"
  ).all()) if (r.d in registrations) registrations[r.d] = Number(r.n);

  const since14 = now - 14 * 24 * 3600 * 1000;
  const fights = zero(), logins = zero(), purchases = zero();
  const seriesFor = { "fight.result": fights, "auth.login": logins, "coffee.buy": purchases };
  for (const r of db.prepare(
    "SELECT type, at FROM game_events WHERE at >= ? AND type IN ('fight.result','auth.login','coffee.buy')"
  ).all(since14)) {
    const bucket = seriesFor[r.type];
    const d = dayKey(Number(r.at));
    if (bucket && d in bucket) bucket[d]++;
  }

  const eventTypes = db.prepare(
    "SELECT type, COUNT(*) AS n FROM game_events WHERE at >= ? GROUP BY type ORDER BY n DESC"
  ).all(now - 7 * 24 * 3600 * 1000).map((r) => ({ type: r.type, count: Number(r.n) }));

  const topPlayers = db.prepare(
    `SELECT u.id, u.username, g.rank, g.score, g.battles, g.wins, g.selected_hero AS hero
     FROM users u JOIN game_state g ON g.user_id = u.id ORDER BY g.score DESC LIMIT 10`
  ).all().map((r) => ({
    id: Number(r.id), username: r.username, rank: r.rank, score: Number(r.score),
    battles: Number(r.battles), wins: Number(r.wins), hero: r.hero,
  }));

  const heroPopularity = db.prepare(
    "SELECT selected_hero AS hero, COUNT(*) AS n FROM game_state GROUP BY selected_hero ORDER BY n DESC"
  ).all().map((r) => ({ hero: r.hero, count: Number(r.n) }));

  const fightStats = db.prepare(
    "SELECT COALESCE(SUM(battles),0) AS battles, COALESCE(SUM(wins),0) AS wins, COALESCE(SUM(bosses_defeated),0) AS bosses FROM game_state"
  ).get();

  return {
    totals,
    lifetime: {
      battles: Number(fightStats.battles),
      wins: Number(fightStats.wins),
      bossesDefeated: Number(fightStats.bosses),
    },
    days,
    series: { registrations, fights, logins, purchases },
    eventTypes,
    topPlayers,
    heroPopularity,
  };
}

function userSummaryRow(r, now) {
  return {
    id: Number(r.id),
    username: r.username,
    createdAt: r.created_at,
    isAdmin: !!r.is_admin,
    banned: Number(r.banned_until) > now,
    bannedUntil: Number(r.banned_until) > now ? Number(r.banned_until) : null,
    banReason: Number(r.banned_until) > now ? r.ban_reason ?? "" : null,
    muted: Number(r.muted_until) > now,
    mutedUntil: Number(r.muted_until) > now ? Number(r.muted_until) : null,
    online: r.online != null ? !!r.online : undefined,
    rank: r.rank,
    score: Number(r.score ?? 0),
    battles: Number(r.battles ?? 0),
    wins: Number(r.wins ?? 0),
    lastSeen: Number(r.last_seen ?? 0),
    imaginz: Number(r.imaginz ?? 0),
  };
}

function listUsers(url) {
  const now = Date.now();
  const q = (url.searchParams.get("q") ?? "").trim();
  const filter = url.searchParams.get("filter") ?? "";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const where = [];
  const args = [];
  if (q) { where.push("u.username LIKE ?"); args.push(`%${q}%`); }
  if (filter === "admins") where.push("u.is_admin = 1");
  if (filter === "banned") { where.push("u.banned_until > ?"); args.push(now); }
  if (filter === "muted") { where.push("u.muted_until > ?"); args.push(now); }
  if (filter === "online") {
    const ids = onlineUserIds();
    where.push(ids.length ? `u.id IN (${ids.map(() => "?").join(",")})` : "0");
    args.push(...ids);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT u.*, g.rank, g.score, g.battles, g.wins, g.last_seen, w.imaginz
     FROM users u
     LEFT JOIN game_state g ON g.user_id = u.id
     LEFT JOIN wallets w ON w.user_id = CAST(u.id AS TEXT)
     ${whereSql} ORDER BY u.id LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).get(...args)?.n ?? 0);
  const online = new Set(onlineUserIds());
  return {
    total,
    users: rows.map((r) => ({ ...userSummaryRow(r, now), online: online.has(Number(r.id)) })),
  };
}

function userDetail(id) {
  const now = Date.now();
  const r = db.prepare(
    `SELECT u.*, g.rank, g.title, g.score, g.season, g.battles, g.wins, g.bosses_defeated,
            g.playtime_min, g.selected_hero, g.unlocked_heroes, g.last_seen, w.imaginz
     FROM users u
     LEFT JOIN game_state g ON g.user_id = u.id
     LEFT JOIN wallets w ON w.user_id = CAST(u.id AS TEXT)
     WHERE u.id = ?`
  ).get(id);
  if (!r) return null;
  return {
    ...userSummaryRow(r, now),
    online: new Set(onlineUserIds()).has(Number(id)),
    title: r.title,
    bossesDefeated: Number(r.bosses_defeated ?? 0),
    playtimeMin: Number(r.playtime_min ?? 0),
    selectedHero: r.selected_hero,
    unlockedHeroes: r.unlocked_heroes ? JSON.parse(r.unlocked_heroes) : [],
    heroRecords: db.prepare(
      "SELECT hero_id, battles, wins, bosses_defeated, best_score, best_dps FROM hero_records WHERE user_id = ? ORDER BY battles DESC"
    ).all(String(id)).map((h) => ({
      hero: h.hero_id, battles: Number(h.battles), wins: Number(h.wins),
      bosses: Number(h.bosses_defeated), bestScore: Number(h.best_score), bestDps: Number(h.best_dps),
    })),
    potions: db.prepare(
      "SELECT effect, magnitude, expires_at FROM potion_buffs WHERE user_id = ? AND expires_at > ?"
    ).all(String(id), now).map((p) => ({ effect: p.effect, magnitude: Number(p.magnitude), expiresAt: Number(p.expires_at) })),
    studentId: r.student_id ?? null,
    invitedWith: db.prepare("SELECT code FROM invite_uses WHERE user_id = ?").get(id)?.code ?? null,
    recentEvents: db.prepare(
      "SELECT id, at, type, data FROM game_events WHERE user_id = ? ORDER BY id DESC LIMIT 30"
    ).all(id).map((e) => ({ id: Number(e.id), at: Number(e.at), type: e.type, data: e.data ? JSON.parse(e.data) : null })),
    recentMessages: db.prepare(
      "SELECT id, channel, body, at FROM chat_messages WHERE from_id = ? AND channel = 'lobby' ORDER BY id DESC LIMIT 20"
    ).all(id).map((m) => ({ id: Number(m.id), channel: m.channel, body: m.body, at: Number(m.at) })),
    reportsAgainst: Number(db.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_id = ?").get(id)?.n ?? 0),
  };
}

function codeRowJson(r, usersById) {
  return {
    code: r.code,
    createdBy: r.created_by == null ? null : usersById.get(Number(r.created_by)) ?? `#${r.created_by}`,
    note: r.note ?? "",
    maxUses: Number(r.max_uses),
    uses: Number(r.uses),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    disabled: !!r.disabled,
    createdAt: Number(r.created_at),
  };
}

function usernameMap() {
  return new Map(db.prepare("SELECT id, username FROM users").all().map((u) => [Number(u.id), u.username]));
}

// ---------------------------------------------------------------------------
// The console page + router
// ---------------------------------------------------------------------------

/** GET /admin — the console shell. Data-free, so serving it ungated is safe:
 * every fetch it makes is admin-checked, and it renders its own login form. */
export function serveConsole(res) {
  const html = readFileSync(CONSOLE_PATH);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

export async function handleAdmin(req, res, url, userId) {
  const { send, readBody } = helpers;
  const route = `${req.method} ${url.pathname}`;
  const now = Date.now();

  // The one route a non-admin may call: the console uses it to decide between
  // its login form and the app. Never a 401/403 — the answer IS the state.
  if (route === "GET /api/admin/me") {
    if (!userId) return send(res, 200, { loggedIn: false, admin: false });
    const u = db.prepare("SELECT username, is_admin FROM users WHERE id = ?").get(userId);
    return send(res, 200, { loggedIn: true, admin: !!u?.is_admin, username: u?.username ?? "?" });
  }

  if (!userId) return send(res, 401, { error: "Not logged in." });
  if (!isAdmin(userId)) return send(res, 403, { error: "Admin access required." });

  if (route === "GET /api/admin/overview") return send(res, 200, overview());

  if (route === "GET /api/admin/users") return send(res, 200, listUsers(url));

  if (route === "GET /api/admin/user") {
    const detail = userDetail(Number(url.searchParams.get("id")));
    if (!detail) return send(res, 404, { error: "No such user." });
    return send(res, 200, detail);
  }

  if (route === "POST /api/admin/user/appoint") {
    const payload = await readBody(req);
    const target = userByRef(payload);
    if (!target) return send(res, 404, { error: "No such user." });
    const makeAdmin = payload.admin !== false;
    if (!makeAdmin) {
      const admins = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get().n);
      if (target.is_admin && admins <= 1) {
        return send(res, 409, { error: "Cannot demote the last admin — appoint someone else first." });
      }
    }
    db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(makeAdmin ? 1 : 0, target.id);
    logEvent(makeAdmin ? "admin.appoint" : "admin.demote", Number(target.id), { by: userId });
    return send(res, 200, { ok: true, username: target.username, admin: makeAdmin });
  }

  if (route === "POST /api/admin/user/ban") {
    const payload = await readBody(req);
    const target = userByRef(payload);
    if (!target) return send(res, 404, { error: "No such user." });
    if (Number(target.id) === userId) return send(res, 400, { error: "You cannot ban yourself." });
    if (target.is_admin) return send(res, 400, { error: "Demote them before banning another admin." });
    const hours = Number(payload.hours) || 0;
    const until = hours > 0 ? now + hours * 3600 * 1000 : BAN_FOREVER;
    const reason = typeof payload.reason === "string" ? payload.reason.trim().slice(0, 200) : "";
    db.prepare("UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?").run(until, reason, target.id);
    forceLogout(Number(target.id), reason ? `Banned: ${reason}` : "You have been banned.");
    logEvent("admin.ban", Number(target.id), { by: userId, until, reason });
    return send(res, 200, { ok: true, username: target.username, until });
  }

  if (route === "POST /api/admin/user/unban") {
    const target = userByRef(await readBody(req));
    if (!target) return send(res, 404, { error: "No such user." });
    db.prepare("UPDATE users SET banned_until = 0, ban_reason = NULL WHERE id = ?").run(target.id);
    logEvent("admin.unban", Number(target.id), { by: userId });
    return send(res, 200, { ok: true, username: target.username });
  }

  if (route === "POST /api/admin/user/mute") {
    const payload = await readBody(req);
    const target = userByRef(payload);
    if (!target) return send(res, 404, { error: "No such user." });
    if (Number(target.id) === userId) return send(res, 400, { error: "You cannot mute yourself." });
    const minutes = Math.max(1, Number(payload.minutes) || 60);
    const until = now + minutes * 60 * 1000;
    db.prepare("UPDATE users SET muted_until = ? WHERE id = ?").run(until, target.id);
    logEvent("admin.mute", Number(target.id), { by: userId, until, minutes });
    return send(res, 200, { ok: true, username: target.username, until });
  }

  if (route === "POST /api/admin/user/unmute") {
    const target = userByRef(await readBody(req));
    if (!target) return send(res, 404, { error: "No such user." });
    db.prepare("UPDATE users SET muted_until = 0 WHERE id = ?").run(target.id);
    logEvent("admin.unmute", Number(target.id), { by: userId });
    return send(res, 200, { ok: true, username: target.username });
  }

  if (route === "POST /api/admin/user/kick") {
    const target = userByRef(await readBody(req));
    if (!target) return send(res, 404, { error: "No such user." });
    if (Number(target.id) === userId) return send(res, 400, { error: "You cannot kick yourself." });
    forceLogout(Number(target.id), "Disconnected by an administrator.");
    logEvent("admin.kick", Number(target.id), { by: userId });
    return send(res, 200, { ok: true, username: target.username });
  }

  if (route === "POST /api/admin/user/grant") {
    const payload = await readBody(req);
    const target = userByRef(payload);
    if (!target) return send(res, 404, { error: "No such user." });
    const amount = Math.trunc(Number(payload.imaginz) || 0);
    if (!amount) return send(res, 400, { error: "Amount must be a non-zero integer." });
    const balance = balanceFor(Number(target.id));
    if (amount < 0 && balance + amount < 0) {
      return send(res, 400, { error: `They only have ${balance} Imaginz.` });
    }
    creditImaginz(Number(target.id), amount);
    logEvent("admin.grant", Number(target.id), { by: userId, imaginz: amount });
    return send(res, 200, { ok: true, username: target.username, balance: balance + amount });
  }

  if (route === "POST /api/admin/user/create") {
    const { createUser, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX } = helpers;
    const payload = await readBody(req);
    const name = typeof payload.username === "string" ? payload.username.trim() : "";
    if (!USERNAME_RE.test(name)) {
      return send(res, 400, { error: "Username must be 3–20 characters: letters, digits, - or _." });
    }
    const password = payload.password;
    if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return send(res, 400, { error: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.` });
    }
    const student = typeof payload.studentId === "string" ? payload.studentId.trim() : "";
    if (student.length > 64) {
      return send(res, 400, { error: "Student ID must be 64 characters or fewer." });
    }
    if (db.prepare("SELECT id FROM users WHERE username = ?").get(name)) {
      return send(res, 409, { error: "That name is taken." });
    }
    let uid;
    try {
      uid = await createUser(name, password);
    } catch {
      // UNIQUE constraint closes the race between the pre-check and the
      // insert — createUser awaits scrypt, so another request can interleave.
      return send(res, 409, { error: "That name is taken." });
    }
    if (student) db.prepare("UPDATE users SET student_id = ? WHERE id = ?").run(student, uid);
    logEvent("admin.user_create", uid, { username: name, by: userId, studentId: student || null });
    return send(res, 200, { ok: true, id: uid, username: name });
  }

  if (route === "POST /api/admin/user/password") {
    const { setPassword, PASSWORD_MIN, PASSWORD_MAX } = helpers;
    const payload = await readBody(req);
    const target = userByRef(payload);
    if (!target) return send(res, 404, { error: "No such user." });
    // Setting a password IS logging in as them — the same takeover shield as
    // the ban route. Your own account is fair game.
    if (target.is_admin && Number(target.id) !== userId) {
      return send(res, 400, { error: "Demote them before changing another admin's password." });
    }
    const password = payload.password;
    if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return send(res, 400, { error: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.` });
    }
    await setPassword(Number(target.id), password);
    // Old sessions die with the old password — whoever holds them (the point
    // of most resets) is out. Skipped for self so the admin's own console
    // session survives the change they just made.
    if (Number(target.id) !== userId) {
      forceLogout(Number(target.id), "Your password was changed by an administrator.");
    }
    logEvent("admin.user_password", Number(target.id), { by: userId });
    return send(res, 200, { ok: true, username: target.username });
  }

  // ---- Invitation codes ---------------------------------------------------

  if (route === "GET /api/admin/invites") {
    const users = usernameMap();
    const codes = db.prepare("SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 200").all()
      .map((r) => ({
        ...codeRowJson(r, users),
        usedBy: db.prepare("SELECT user_id FROM invite_uses WHERE code = ? ORDER BY at").all(r.code)
          .map((u) => users.get(Number(u.user_id)) ?? `#${u.user_id}`),
      }));
    return send(res, 200, {
      required: inviteRequired(),
      // The env var trumps the console policy; the UI disables its toggle
      // and says why instead of offering a switch that would do nothing.
      envOpen: process.env.PSYRENA_INVITE_REQUIRED === "0",
      codes,
    });
  }

  if (route === "POST /api/admin/invites/policy") {
    const { required } = await readBody(req);
    setInviteRequired(required !== false, userId);
    logEvent("admin.invite.policy", userId, { required: required !== false });
    return send(res, 200, { ok: true, required: inviteRequired() });
  }

  if (route === "POST /api/admin/invites/create") {
    const payload = await readBody(req);
    const count = Math.min(50, Math.max(1, Math.trunc(Number(payload.count) || 1)));
    const maxUses = Math.max(0, Math.trunc(Number(payload.maxUses ?? 1))); // 0 = unlimited
    const expiresAt = Number(payload.expiresDays) > 0 ? now + Number(payload.expiresDays) * 24 * 3600 * 1000 : null;
    const note = typeof payload.note === "string" ? payload.note.trim().slice(0, 100) : "";
    const insert = db.prepare(
      "INSERT INTO invite_codes (code, created_by, note, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = mintCode("PSY");
      insert.run(code, userId, note, maxUses, expiresAt, now);
      codes.push(code);
    }
    logEvent("admin.invite.create", userId, { count, maxUses, codes });
    return send(res, 200, { ok: true, codes });
  }

  if (route === "POST /api/admin/invites/disable") {
    const { code, disabled } = await readBody(req);
    const changed = db.prepare("UPDATE invite_codes SET disabled = ? WHERE code = ?")
      .run(disabled === false ? 0 : 1, String(code ?? ""));
    if (!Number(changed.changes)) return send(res, 404, { error: "No such code." });
    logEvent("admin.invite.disable", userId, { code, disabled: disabled !== false });
    return send(res, 200, { ok: true });
  }

  // ---- Gift codes (coffee shop) — tables owned by coffee.mjs --------------

  if (route === "GET /api/admin/gifts") {
    const users = usernameMap();
    const codes = db.prepare("SELECT * FROM gift_codes ORDER BY created_at DESC LIMIT 200").all()
      .map((r) => ({
        ...codeRowJson(r, users),
        reward: r.reward_type === "imaginz"
          ? { type: "imaginz", amount: Number(r.reward_amount) }
          : { type: "item", item: r.reward_item },
        usedBy: db.prepare("SELECT user_id FROM gift_uses WHERE code = ? ORDER BY at").all(r.code)
          .map((u) => users.get(Number(u.user_id)) ?? `#${u.user_id}`),
      }));
    const items = COFFEE_ITEMS.filter((i) => i.available).map((i) => ({ id: i.id, label: `${i.name} (${i.size}) — ${i.desc}` }));
    return send(res, 200, { codes, items });
  }

  if (route === "POST /api/admin/gifts/create") {
    const payload = await readBody(req);
    const rewardType = payload.rewardType === "item" ? "item" : "imaginz";
    let rewardAmount = null, rewardItem = null;
    if (rewardType === "imaginz") {
      rewardAmount = Math.trunc(Number(payload.amount) || 0);
      if (rewardAmount <= 0) return send(res, 400, { error: "Imaginz amount must be positive." });
    } else {
      const item = COFFEE_ITEMS.find((i) => i.id === payload.item && i.available);
      if (!item) return send(res, 400, { error: "Unknown or unavailable coffee item." });
      rewardItem = item.id;
    }
    const custom = typeof payload.code === "string" ? payload.code.trim().toUpperCase() : "";
    if (custom && !/^[A-Z0-9-]{4,32}$/.test(custom)) {
      return send(res, 400, { error: "Custom codes: 4–32 characters, A–Z, 0–9 and dashes." });
    }
    const code = custom || mintCode("GIFT");
    if (db.prepare("SELECT 1 FROM gift_codes WHERE code = ?").get(code)) {
      return send(res, 409, { error: "That code already exists." });
    }
    const maxUses = Math.max(0, Math.trunc(Number(payload.maxUses ?? 1))); // 0 = unlimited
    const expiresAt = Number(payload.expiresDays) > 0 ? now + Number(payload.expiresDays) * 24 * 3600 * 1000 : null;
    const note = typeof payload.note === "string" ? payload.note.trim().slice(0, 100) : "";
    db.prepare(
      `INSERT INTO gift_codes (code, created_by, note, reward_type, reward_amount, reward_item, max_uses, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(code, userId, note, rewardType, rewardAmount, rewardItem, maxUses, expiresAt, now);
    logEvent("admin.gift.create", userId, { code, rewardType, rewardAmount, rewardItem, maxUses });
    return send(res, 200, { ok: true, code });
  }

  if (route === "POST /api/admin/gifts/disable") {
    const { code, disabled } = await readBody(req);
    const changed = db.prepare("UPDATE gift_codes SET disabled = ? WHERE code = ?")
      .run(disabled === false ? 0 : 1, String(code ?? ""));
    if (!Number(changed.changes)) return send(res, 404, { error: "No such code." });
    logEvent("admin.gift.disable", userId, { code, disabled: disabled !== false });
    return send(res, 200, { ok: true });
  }

  // ---- Chat moderation ----------------------------------------------------
  // Lobby only: whispers are private and are surfaced to moderation solely
  // through a report's message snapshot, never by browsing.

  if (route === "GET /api/admin/chat") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const from = (url.searchParams.get("user") ?? "").trim();
    const args = [];
    let whereUser = "";
    if (from) {
      const u = db.prepare("SELECT id FROM users WHERE username = ?").get(from);
      if (!u) return send(res, 404, { error: "No such user." });
      whereUser = "AND m.from_id = ?";
      args.push(Number(u.id));
    }
    const messages = db.prepare(
      `SELECT m.id, m.from_id, u.username, m.body, m.at FROM chat_messages m
       JOIN users u ON u.id = m.from_id
       WHERE m.channel = 'lobby' ${whereUser} ORDER BY m.id DESC LIMIT ?`
    ).all(...args, limit).reverse().map((m) => ({
      id: Number(m.id), userId: Number(m.from_id), from: m.username, body: m.body, at: Number(m.at),
    }));
    return send(res, 200, { messages });
  }

  if (route === "POST /api/admin/chat/delete") {
    const { id } = await readBody(req);
    const row = db.prepare("SELECT * FROM chat_messages WHERE id = ? AND channel = 'lobby'").get(Number(id));
    if (!row) return send(res, 404, { error: "No such lobby message." });
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run(Number(id));
    logEvent("admin.chat.delete", Number(row.from_id), { by: userId, messageId: Number(id), body: row.body });
    return send(res, 200, { ok: true });
  }

  // ---- Reports ------------------------------------------------------------

  if (route === "GET /api/admin/reports") {
    const status = url.searchParams.get("status") ?? "open";
    const users = usernameMap();
    const rows = status === "all"
      ? db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 200").all()
      : db.prepare("SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 200").all(status);
    return send(res, 200, {
      reports: rows.map((r) => ({
        id: Number(r.id),
        reporter: users.get(Number(r.reporter_id)) ?? `#${r.reporter_id}`,
        target: r.target_id == null ? null : users.get(Number(r.target_id)) ?? `#${r.target_id}`,
        targetId: r.target_id == null ? null : Number(r.target_id),
        messageId: r.message_id == null ? null : Number(r.message_id),
        channel: r.channel,
        messageBody: r.message_body,
        reason: r.reason,
        status: r.status,
        createdAt: Number(r.created_at),
        resolvedBy: r.resolved_by == null ? null : users.get(Number(r.resolved_by)) ?? `#${r.resolved_by}`,
        resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
        resolution: r.resolution,
      })),
    });
  }

  if (route === "POST /api/admin/reports/resolve") {
    const payload = await readBody(req);
    const id = Number(payload.id);
    const status = payload.status === "dismissed" ? "dismissed" : "resolved";
    const resolution = typeof payload.resolution === "string" ? payload.resolution.trim().slice(0, 300) : "";
    const changed = db.prepare(
      "UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status = 'open'"
    ).run(status, userId, now, resolution, id);
    if (!Number(changed.changes)) return send(res, 404, { error: "No such open report." });
    logEvent("admin.report.resolve", userId, { reportId: id, status, resolution });
    return send(res, 200, { ok: true });
  }

  // ---- Event browser ------------------------------------------------------

  if (route === "GET /api/admin/events") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const before = Number(url.searchParams.get("before")) || 0;
    const type = (url.searchParams.get("type") ?? "").trim();
    const userQ = (url.searchParams.get("user") ?? "").trim();
    const where = [];
    const args = [];
    if (before > 0) { where.push("e.id < ?"); args.push(before); }
    if (type) { where.push("e.type = ?"); args.push(type); }
    if (userQ) {
      const u = db.prepare("SELECT id FROM users WHERE username = ?").get(userQ);
      if (!u) return send(res, 404, { error: "No such user." });
      where.push("e.user_id = ?");
      args.push(Number(u.id));
    }
    const users = usernameMap();
    const events = db.prepare(
      `SELECT e.* FROM game_events e ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY e.id DESC LIMIT ?`
    ).all(...args, limit).map((e) => ({
      id: Number(e.id),
      at: Number(e.at),
      type: e.type,
      userId: e.user_id == null ? null : Number(e.user_id),
      user: e.user_id == null ? null : users.get(Number(e.user_id)) ?? `#${e.user_id}`,
      data: e.data ? JSON.parse(e.data) : null,
    }));
    const types = db.prepare("SELECT DISTINCT type FROM game_events ORDER BY type").all().map((r) => r.type);
    return send(res, 200, { events, types });
  }

  return send(res, 404, { error: "No such endpoint." });
}
