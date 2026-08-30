/**
 * Psyrena account/state API — node:sqlite, zero dependencies.
 *
 * Exported as a bare (req, res) handler so the same code serves two ways:
 *  - mounted into Vite's dev server as middleware (same origin, no CORS, no
 *    second process to start) — see the plugin in vite.config.ts;
 *  - run standalone via server/index.mjs for a production-shaped deployment.
 *
 * This is the ACCOUNT database (who you are, what you've unlocked), not the
 * realtime combat authority — that stays with the Colyseus server planned in
 * docs/06. Keep gameplay-tuning data out of here.
 */
import { DatabaseSync } from "node:sqlite";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initSocial, handleSocial, pushTo, notifyFriendsOf, markOffline, collectOfflineExpired,
  droppedOut,
} from "./social.mjs";
import { initEconomy, handleEconomy, touchArenaHold, STARTING_IMAGINZ } from "./economy.mjs";
import { initVillage, handleVillage, leaveVillage } from "./village.mjs";
import {
  initFight, handleFightSim, deserterLockFor, markFightAbandon, restartDeserterClock,
} from "./fight.mjs";
import { initAchievements, handleAchievements } from "./achievements.mjs";
import { initCoffee, handleCoffee } from "./coffee.mjs";
import { initEvents, logEvent } from "./events.mjs";
import {
  initAdmin, handleAdmin, serveConsole, ensureAdminBootstrap,
  inviteRequired, reserveInvite, releaseInvite, recordInviteUse, banInfo,
} from "./admin.mjs";

// Mirrors HeroId in shared/types.ts. The server validates unlock/select
// against this list; it cannot import the TS union directly from .mjs.
const HERO_IDS = [
  "pavlov", "skinner", "kohlberg", "bronfenbrenner", "vygotsky", "freud",
  "erikson", "piaget", "maslow", "seligman", "csikszentmihalyi", "bandura",
  "beck", "ainsworth",
];

// Matchmaking role per hero — mirrors Hero.role in shared/heroes (authored)
// and ROSTER in src/ui/authFlow.ts (the unshipped), collapsed to the three
// trio slots: support/flex fill the dps seat. shared/teamComp.ts is the
// client-side reading of the same table. A hero missing here (or a player
// with no game_state row) counts as "any" and fills whatever slot is open —
// entering the queue is never gated on role (docs 02: warn, don't block).
const HERO_ROLES = {
  pavlov: "tank", piaget: "tank", ainsworth: "tank",
  skinner: "healer", maslow: "healer", seligman: "healer",
  csikszentmihalyi: "healer", beck: "healer",
  freud: "dps", kohlberg: "dps", bandura: "dps",
  erikson: "dps", vygotsky: "dps", bronfenbrenner: "dps",
};

// Product decision (2026-07-31, amended 2026-08-03 and 2026-08-05): Freud is
// the default SELECTION for every new account; Pavlov — docs/03's free
// starter, whose kit shipped with the tank rework — and Skinner, the first
// healer, are unlocked beside him. Order matters: [0] seeds selected_hero.
const DEFAULT_UNLOCKS = ["freud", "pavlov", "skinner"];
const SEASON = "Season 1 — Shadow of the Id";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// Login-status policy: one live login per account (the newest device wins);
// a user with no social stream keeps their seats for OFFLINE_GRACE_MS —
// enough for a reload or a network blip — before the grace sweep logs them
// out of everything (session, room, queue, village). Env overrides exist so
// the e2e can run the clock fast.
const OFFLINE_GRACE_MS = Number(process.env.PSYRENA_OFFLINE_GRACE_MS) || 120_000;
const PRESENCE_SWEEP_MS = Number(process.env.PSYRENA_PRESENCE_SWEEP_MS) || 20_000;
const LAST_SEEN_THROTTLE_MS = 30_000;

const DB_PATH = process.env.PSYRENA_DB ?? join(dirname(fileURLToPath(import.meta.url)), "psyrena.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Every module runs the same handful of SQL strings thousands of times a
// minute, and node:sqlite recompiles on every prepare() — the lobby poll
// alone was ~1,600 fresh compiles/second at 100 players. Memoize by SQL
// text. Safe because StatementSync's run/get/all execute to completion
// before returning (nothing re-enters a cached statement mid-step) and
// nothing in server/ uses .iterate(); sqlite recompiles cached statements
// itself after a schema change.
{
  const rawPrepare = db.prepare.bind(db);
  const stmtCache = new Map();
  db.prepare = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = rawPrepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };
}

/**
 * Run fn inside a transaction. The multi-table write sequences (a fight
 * result touches six tables) must land whole or not at all — autocommit
 * leaves half a payout behind on any mid-sequence throw. Synchronous only:
 * an await inside fn would hold the transaction across other requests.
 */
function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Orderly close for the standalone runner's shutdown path: force a WAL
 * checkpoint (otherwise the last minutes of play live only in the -wal file)
 * and release the handle. */
export function closeDb() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (err) {
    console.error("[api] db close failed:", err);
  }
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;   -- durable enough under WAL, far fewer fsyncs
  PRAGMA busy_timeout = 5000;    -- a backup's reader must not surface as SQLITE_BUSY
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_salt  TEXT NOT NULL,
    pass_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS game_state (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id),
    rank            TEXT NOT NULL,
    title           TEXT NOT NULL,
    score           INTEGER NOT NULL,
    season          TEXT NOT NULL,
    battles         INTEGER NOT NULL DEFAULT 0,
    wins            INTEGER NOT NULL DEFAULT 0,
    bosses_defeated INTEGER NOT NULL DEFAULT 0,
    playtime_min    INTEGER NOT NULL DEFAULT 0,
    selected_hero   TEXT NOT NULL DEFAULT 'freud',
    unlocked_heroes TEXT NOT NULL DEFAULT '["freud","pavlov","skinner"]'
  );
  -- Owned by social.mjs (request/accept flow); mirrored here because the dev
  -- fixtures below seed friendships before initSocial() runs. Keep in sync.
  CREATE TABLE IF NOT EXISTS friends (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    friend_id  INTEGER NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL,               -- 'pending' (user_id asked) | 'accepted'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    host_id    INTEGER NOT NULL REFERENCES users(id),
    is_public  INTEGER NOT NULL DEFAULT 1,
    pass_salt  TEXT,
    pass_hash  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS room_members (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id),
    room_id   INTEGER NOT NULL REFERENCES rooms(id),
    joined_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS room_invites (
    room_id    INTEGER NOT NULL REFERENCES rooms(id),
    to_id      INTEGER NOT NULL REFERENCES users(id),
    from_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, to_id)
  );
  CREATE TABLE IF NOT EXISTS queue (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id),
    joined_at INTEGER NOT NULL
  );
`);

// student_id rides on users — collected at registration whenever an
// invitation code is redeemed (codes are handed out per class roster, the ID
// ties the account back to a student). Guarded ALTER, additive-migration style.
{
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("student_id")) db.exec("ALTER TABLE users ADD COLUMN student_id TEXT");
}

// One-shot sweep: rows created before a hero joined DEFAULT_UNLOCKS still
// hold the old list (the dev account and fixtures predate Pavlov), and
// /api/select-hero 403s on anything not in the row. Purely additive — a
// player's earned unlocks are never removed.
{
  const rows = db.prepare("SELECT user_id, unlocked_heroes FROM game_state").all();
  const patch = db.prepare("UPDATE game_state SET unlocked_heroes = ? WHERE user_id = ?");
  for (const row of rows) {
    let unlocked;
    try {
      unlocked = JSON.parse(row.unlocked_heroes);
    } catch {
      unlocked = [];
    }
    if (!Array.isArray(unlocked)) unlocked = [];
    const merged = [...new Set([...unlocked, ...DEFAULT_UNLOCKS])];
    if (merged.length !== unlocked.length) patch.run(JSON.stringify(merged), row.user_id);
  }
}

// Additive migrations, same style as social.mjs's migrateFriends: the CREATE
// IF NOT EXISTS schema above never re-shapes a live table, so new columns get
// guarded ALTERs. last_seen is presence persistence (written on authenticated
// traffic and on going offline); party_id ties a party's queue rows together
// (NULL = solo) so the matchmaker never splits a room that queued as one.
{
  const gameCols = db.prepare("PRAGMA table_info(game_state)").all().map((c) => c.name);
  if (!gameCols.includes("last_seen")) {
    db.exec("ALTER TABLE game_state ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0");
  }
  // Desertion lock (server/fight.mjs): `pending` is the sentence, `until` the
  // current attempt at serving it — two columns rather than one deadline,
  // because logging in restarts the clock and only a clock that ran out with
  // the player present clears the flag.
  if (!gameCols.includes("deserter_pending")) {
    db.exec("ALTER TABLE game_state ADD COLUMN deserter_pending INTEGER DEFAULT 0");
  }
  if (!gameCols.includes("deserter_until")) {
    db.exec("ALTER TABLE game_state ADD COLUMN deserter_until INTEGER");
  }
  const queueCols = db.prepare("PRAGMA table_info(queue)").all().map((c) => c.name);
  if (!queueCols.includes("party_id")) {
    db.exec("ALTER TABLE queue ADD COLUMN party_id INTEGER REFERENCES rooms(id)");
  }
  // Queue difficulty (2026-08-10): the solo queuer picks Standard/Hard/
  // Nightmare on the way in and the matchmaker only ever groups rows that
  // agree, so nobody lands in a fight — or a payout bracket — they did not opt
  // into. Party rows carry their room's difficulty. Rows in flight when this
  // ships all become 'standard', which is what they were getting anyway.
  if (!queueCols.includes("difficulty")) {
    db.exec("ALTER TABLE queue ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'standard'");
  }
  // Room difficulty (2026-08-04): chosen at creation, shown in the browser
  // list so nobody joins a Nightmare lobby thinking it is Standard. Mirrors
  // the client's FightDifficulty ids (src/fight/difficulty.ts).
  const roomCols = db.prepare("PRAGMA table_info(rooms)").all().map((c) => c.name);
  if (!roomCols.includes("difficulty")) {
    db.exec("ALTER TABLE rooms ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'standard'");
  }
  // Matchmade rooms (2026-08-10) have no real leader — formMatchRoom picks
  // host_id = userIds[0] out of whoever queued first — so they start on a
  // unanimous ready-check instead of one stranger's button. An explicit
  // column, never sniffed off the room name.
  if (!roomCols.includes("matchmade")) {
    db.exec("ALTER TABLE rooms ADD COLUMN matchmade INTEGER NOT NULL DEFAULT 0");
  }
}

const ROOM_DIFFICULTIES = ["standard", "hard", "nightmare"];

/**
 * Boss runs are a 3-stack (doc 01) — a room is a party, not a raid.
 *
 * Rooms/queue live in the account DB for the same reason the hub controller is
 * client-side and dumb: this is the M1 lobby scaffold. The panel polls
 * GET /api/lobby; when the Colyseus hub server lands (docs/06) the poll and
 * these tables are what it replaces. Nothing here is combat-authoritative.
 */
const ROOM_CAP = 3;

// Async scrypt: ~80 ms of CPU per hash runs on libuv's thread pool instead of
// the event loop, so a burst of logins (or a brute-force attempt) cannot stall
// every other player's requests. Callers must await.
function scryptKey(password, salt) {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: (await scryptKey(password, salt)).toString("hex") };
}

async function verifyPassword(password, salt, hash) {
  const candidate = await scryptKey(password, salt);
  const stored = Buffer.from(hash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

// Fixed-cost compare target for logins against unknown usernames: without it,
// a missing user answers in ~1 ms while a real one pays the scrypt cost, and
// the timing difference enumerates the player list.
const DUMMY_CRED = { salt: "0".repeat(32), hash: "0".repeat(128) };

/**
 * Username policy, enforced at the one place accounts are created. Display
 * name and login are the same string; COLLATE NOCASE on users.username makes
 * lookups case-insensitive, so "Frank" and "frank" cannot coexist.
 */
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export async function createUser(username, password, state = {}) {
  const { salt, hash } = await hashPassword(password);
  const info = db
    .prepare("INSERT INTO users (username, pass_salt, pass_hash) VALUES (?, ?, ?)")
    .run(username, salt, hash);
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO game_state (user_id, rank, title, score, season, battles, wins, bosses_defeated, playtime_min, selected_hero, unlocked_heroes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    state.rank ?? "Bronze III",
    state.title ?? "Novice Analyst",
    state.score ?? 0,
    SEASON,
    state.battles ?? 0,
    state.wins ?? 0,
    state.bossesDefeated ?? 0,
    state.playtimeMin ?? 0,
    state.selectedHero ?? DEFAULT_UNLOCKS[0],
    JSON.stringify(state.unlocked ?? DEFAULT_UNLOCKS)
  );
  // Wallet seed for accounts created after boot. The seed accounts above run
  // before initEconomy() has created the wallets table, so this must stay a
  // conditional — those accounts get the same balance from initEconomy's own
  // INSERT OR IGNORE sweep instead.
  const hasWallets = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wallets'")
    .get();
  if (hasWallets) {
    // String(id), not id: wallets.user_id is TEXT, and a numeric bind lands
    // as '1.0' under text affinity — a row the economy's String(userId)
    // lookups can never see, orphaning the starting balance.
    db.prepare("INSERT OR IGNORE INTO wallets (user_id, imaginz) VALUES (?, ?)").run(
      String(id),
      STARTING_IMAGINZ
    );
  }
  return id;
}

/** Re-credential an account: fresh salt, fresh hash. Length policy is the
 * caller's job (the two callers, /api/admin/user/password and any future
 * self-service reset, gate on PASSWORD_MIN/MAX before paying the scrypt). */
export async function setPassword(userId, password) {
  const { salt, hash } = await hashPassword(password);
  db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").run(salt, hash, userId);
}

// Dev fixtures, opt-in only: the Vite dev plugin sets PSYRENA_DEV_SEED=1
// before loading this module, so `npm run dev` keeps its four known accounts
// and two joinable rooms (the e2e scripts log in with them), while a
// production boot (server/index.mjs) NEVER creates accounts — players arrive
// through POST /api/register. All fixture accounts log in with "psyrena123";
// adler's room password is "gemeinschaft". Idempotent: only seeds when
// absent, so a changed rank or score in the DB survives server restarts.
async function seedDevFixtures() {
  if (!db.prepare("SELECT id FROM users WHERE username = ?").get("frank")) {
    await createUser("frank", "psyrena123", {
      rank: "Gold II", title: "Dream Interpreter", score: 1480,
      battles: 37, wins: 22, bossesDefeated: 9, playtimeMin: 412,
    });
    console.log("[api] seeded dev account: frank");
  }
  if (db.prepare("SELECT id FROM users WHERE username = ?").get("jung")) return;
  const jung = await createUser("jung", "psyrena123", {
    rank: "Platinum IV", title: "Shadow Integrator", score: 1740,
    battles: 52, wins: 33, bossesDefeated: 14, playtimeMin: 610,
  });
  const adler = await createUser("adler", "psyrena123", {
    rank: "Gold I", title: "Style Setter", score: 1555,
    battles: 41, wins: 24, bossesDefeated: 11, playtimeMin: 480,
  });
  const horney = await createUser("horney", "psyrena123", {
    rank: "Gold III", title: "Basic Anxiety Breaker", score: 1410,
    battles: 29, wins: 16, bossesDefeated: 7, playtimeMin: 350,
  });
  const frank = Number(db.prepare("SELECT id FROM users WHERE username = ?").get("frank").id);
  // Single row per pair (frank asked) — the social layer's accepted-friend model.
  const addFriend = db.prepare(
    "INSERT OR IGNORE INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'accepted', ?)"
  );
  for (const id of [jung, adler, horney]) addFriend.run(frank, id, Date.now());

  const seedRoom = async (name, hostId, isPublic, password) => {
    const cred = password ? await hashPassword(password) : { salt: null, hash: null };
    const info = db
      .prepare("INSERT INTO rooms (name, host_id, is_public, pass_salt, pass_hash) VALUES (?, ?, ?, ?, ?)")
      .run(name, hostId, isPublic ? 1 : 0, cred.salt, cred.hash);
    db.prepare("INSERT INTO room_members (user_id, room_id) VALUES (?, ?)").run(hostId, Number(info.lastInsertRowid));
  };
  await seedRoom("Shadow Work", jung, true, null);
  await seedRoom("Gemeinschaftsgefühl", adler, true, "gemeinschaft");
  console.log("[api] seeded social fixtures: jung, adler, horney (+2 rooms)");
  // The seed's awaits resume after module init, so the admin bootstrap that
  // ran inside initAdmin saw an empty users table — re-check now that the
  // fixtures exist (promotes frank, the oldest account, in a fresh dev DB).
  ensureAdminBootstrap();
}

if (process.env.PSYRENA_DEV_SEED === "1") {
  seedDevFixtures().catch((err) => console.error("[api] dev seed failed:", err));
}

function profileFor(userId) {
  const user = db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(userId);
  const s = db.prepare("SELECT * FROM game_state WHERE user_id = ?").get(userId);
  return {
    username: user.username,
    createdAt: user.created_at,
    rank: s.rank,
    title: s.title,
    score: s.score,
    season: s.season,
    stats: {
      battles: s.battles,
      wins: s.wins,
      bossesDefeated: s.bosses_defeated,
      playtimeMin: s.playtime_min,
    },
    selectedHero: s.selected_hero,
    unlockedHeroes: JSON.parse(s.unlocked_heroes),
    // Battle record per hero actually played (economy.mjs hero_records, one
    // upsert per fight report). Most-played first; heroes never fought as
    // simply have no row, so the client can render "no battles yet".
    heroStats: db
      .prepare(
        `SELECT hero_id, battles, wins, bosses_defeated, best_score, best_dps, fastest_ms
         FROM hero_records WHERE user_id = ? ORDER BY battles DESC, wins DESC`
      )
      .all(String(userId))
      .map((r) => ({
        heroId: r.hero_id,
        battles: r.battles,
        wins: r.wins,
        bossesDefeated: r.bosses_defeated,
        bestScore: r.best_score,
        bestDps: r.best_dps,
        fastestMs: r.fastest_ms,
      })),
  };
}

/**
 * Take a user out of their room, transferring host or deleting the room as
 * needed. Called on leave, and before any join/create so a player is never in
 * two rooms (room_members' PRIMARY KEY user_id enforces the same invariant).
 */
function leaveRoom(userId) {
  const m = db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").get(userId);
  if (!m) return;
  const roomId = Number(m.room_id);
  db.prepare("DELETE FROM room_members WHERE user_id = ?").run(userId);
  // Leaving the party also leaves the party's queue entry — a solo queue row
  // (party_id NULL) is the player's own business and survives.
  db.prepare("DELETE FROM queue WHERE user_id = ? AND party_id IS NOT NULL").run(userId);
  // The party changed, so every lobby-ready flag it held is stale. Clearing
  // the WHOLE set (rather than just the leaver's) is deliberate: dropping one
  // flag would strand the rest at "2/2 ready, nothing happens", because
  // nothing re-evaluates the all-ready predicate on a leave. Everyone
  // re-presses — the party they agreed to is genuinely not the one they have.
  // Sits above the empty-room return below, so it also covers room deletion,
  // the presence sweep, and formMatchRoom's per-member leaveRoom.
  clearLobbyReady(roomId);
  const rest = db
    .prepare("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at, user_id")
    .all(roomId);
  if (rest.length === 0) {
    db.prepare("DELETE FROM room_invites WHERE room_id = ?").run(roomId);
    db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    // A barrier for a dead room can never fill — drop it, don't let its
    // timer fire a fightStart at nobody.
    const gate = fightReadyByRoom.get(roomId);
    if (gate) {
      clearTimeout(gate.timer);
      fightReadyByRoom.delete(roomId);
    }
    return;
  }
  const room = db.prepare("SELECT host_id FROM rooms WHERE id = ?").get(roomId);
  if (room && Number(room.host_id) === Number(userId)) {
    db.prepare("UPDATE rooms SET host_id = ? WHERE id = ?").run(rest[0].user_id, roomId);
  }
  // A filling barrier no longer waits for the leaver: if everyone still
  // seated is ready, release now instead of stranding them on the timeout.
  // (This is the "or dropped" half of "all loaded or dropped".)
  const gate = fightReadyByRoom.get(roomId);
  if (gate) {
    gate.ready.delete(Number(userId));
    if (rest.every((r) => gate.ready.has(Number(r.user_id)))) releaseFightBarrier(roomId);
  }
}

// ---------------------------------------------------------------------------
// Dropping out while waiting.
//
// A player who disconnects while queued (or while seated in a party that has
// not opened its fight yet) must vanish from the lobby immediately, not after
// the two-minute presence grace. The grace exists so a reload keeps your
// seats; but the matchmaker runs every 5 s and the fight party is built ONCE
// from room_members (fight.mjs `partyOf`), so a queued ghost gets matched,
// seated, and turned into a sim actor: the boss is sized for three, one third
// of the party's HP pool never moves, and the other two see nothing at all
// where that hero should be — they never join the arena presence session, so
// no body is ever spawned for them. Cutting them here is what makes the fight
// the party enters the fight it was promised.
//
// Mid-fight drops are deliberately NOT handled here — walking out of a live
// fight is desertion, with its own lock and its own settlement.
// ---------------------------------------------------------------------------

/** Free every lobby seat this player holds. Village + friends are told too. */
function dropWaitingPlayer(userId, why) {
  const uid = Number(userId);
  db.prepare("DELETE FROM queue WHERE user_id = ?").run(uid);
  leaveRoom(uid); // also transfers host / dissolves an emptied party
  leaveVillage(uid);
  notifyFriendsOf(uid);
  logEvent("queue.drop", uid, { why });
}

/** Queue rows held by players whose connection is gone for good. */
function sweepQueueDrops() {
  for (const row of db.prepare("SELECT user_id FROM queue").all()) {
    const uid = Number(row.user_id);
    if (droppedOut(uid)) dropWaitingPlayer(uid, "queued");
  }
}

/**
 * The members of a room that are still on the network, evicting the ones that
 * are not. Called from the fight-ready barrier — the last moment before the
 * roster hardens into a fight — so a player who dropped between the match and
 * the countdown is gone before `beginFight` ever reads room_members.
 *
 * Only safe pre-fight, which is exactly where the barrier lives.
 */
function liveMembersOf(roomId, keepUserId = null) {
  const seated = db
    .prepare("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at, user_id")
    .all(roomId)
    .map((m) => Number(m.user_id));
  const live = [];
  for (const id of seated) {
    // Whoever is making the request is present by definition, whatever their
    // stream is doing — never evict a player mid-conversation.
    if (id !== Number(keepUserId) && droppedOut(id)) dropWaitingPlayer(id, "pre-fight");
    else live.push(id);
  }
  return live;
}

/** Everything the rooms panel shows, in one payload — it polls this. */
function lobbyFor(userId) {
  const queueRow = db.prepare("SELECT party_id, difficulty FROM queue WHERE user_id = ?").get(userId);
  const queued = !!queueRow;
  // Queued together with the room shown below — the panel renders "queued as
  // party (leader)" vs "your leader queued the party" off room.isHost.
  const partyQueued = !!(queueRow && queueRow.party_id != null);
  const queueDifficulty = queued
    ? (ROOM_DIFFICULTIES.includes(queueRow.difficulty) ? queueRow.difficulty : "standard")
    : null;

  // One pass over the queue: per-pool headcounts for the difficulty picker,
  // plus the role census of the pool the panel is actually reporting on.
  // Counting the whole queue would tell a Nightmare queuer that eleven people
  // are waiting when nobody at all is waiting WITH them. Unknown heroes count
  // as dps. While idle (no pool of my own) the numbers cover everything.
  const queueCounts = { standard: 0, hard: 0, nightmare: 0 };
  const queueRoles = { tank: 0, healer: 0, dps: 0 };
  for (const r of db
    .prepare(
      `SELECT q.difficulty AS diff, g.selected_hero AS hero
       FROM queue q LEFT JOIN game_state g ON g.user_id = q.user_id`
    )
    .all()) {
    const d = ROOM_DIFFICULTIES.includes(r.diff) ? r.diff : "standard";
    queueCounts[d]++;
    if (queueDifficulty && d !== queueDifficulty) continue;
    const role = HERO_ROLES[r.hero] ?? "dps";
    queueRoles[role === "tank" ? "tank" : role === "healer" ? "healer" : "dps"]++;
  }
  const queueSize = queueDifficulty
    ? queueCounts[queueDifficulty]
    : queueCounts.standard + queueCounts.hard + queueCounts.nightmare;

  const mine = db
    .prepare("SELECT r.* FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?")
    .get(userId);
  // isHost stays truthful either way — leaveRoom's host transfer depends on
  // host_id — but a matchmade room's "host" consented to nothing, so the
  // client hides the crown and shows a ready dot per seat instead.
  const readySet = mine ? lobbyReadyByRoom.get(Number(mine.id)) : null;
  const room = mine
    ? {
        id: Number(mine.id),
        name: mine.name,
        isPublic: !!mine.is_public,
        locked: !!mine.pass_hash,
        isHost: Number(mine.host_id) === Number(userId),
        capacity: ROOM_CAP,
        difficulty: mine.difficulty ?? "standard",
        matchmade: !!mine.matchmade,
        readyCount: readySet ? readySet.size : 0,
        youReady: !!readySet?.has(Number(userId)),
        members: db
          .prepare(
            `SELECT u.id, u.username, g.rank, g.selected_hero AS hero
             FROM room_members m
             JOIN users u ON u.id = m.user_id
             JOIN game_state g ON g.user_id = m.user_id
             WHERE m.room_id = ? ORDER BY m.joined_at, u.id`
          )
          .all(Number(mine.id))
          .map((r) => ({
            username: r.username,
            rank: r.rank,
            hero: r.hero,
            isHost: Number(r.id) === Number(mine.host_id),
            ready: !!readySet?.has(Number(r.id)),
          })),
      }
    : null;

  // Member roles for every listed room in ONE query (this payload is polled
  // by every open panel — a query per room was the first N+1 here), grouped
  // in seat order: the browser row shows 🛡✚⚔ so a half-formed party
  // advertises exactly which seat it still needs.
  const rolesByRoom = new Map();
  for (const m of db
    .prepare(
      `SELECT m.room_id, g.selected_hero AS hero
       FROM room_members m LEFT JOIN game_state g ON g.user_id = m.user_id
       WHERE m.room_id IN (SELECT id FROM rooms WHERE is_public = 1 ORDER BY created_at DESC LIMIT 20)
       ORDER BY m.room_id, m.joined_at, m.user_id`
    )
    .all()) {
    const rid = Number(m.room_id);
    if (!rolesByRoom.has(rid)) rolesByRoom.set(rid, []);
    rolesByRoom.get(rid).push(HERO_ROLES[m.hero] ?? "dps");
  }
  const rooms = db
    .prepare(
      `SELECT r.id, r.name, r.pass_hash, r.difficulty, u.username AS host,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS players
       FROM rooms r JOIN users u ON u.id = r.host_id
       WHERE r.is_public = 1 ORDER BY r.created_at DESC LIMIT 20`
    )
    .all()
    .filter((r) => !mine || Number(r.id) !== Number(mine.id))
    .map((r) => ({
      id: Number(r.id),
      name: r.name,
      host: r.host,
      players: Number(r.players),
      capacity: ROOM_CAP,
      locked: !!r.pass_hash,
      difficulty: r.difficulty ?? "standard",
      roles: rolesByRoom.get(Number(r.id)) ?? [],
    }));

  const invites = db
    .prepare(
      `SELECT i.room_id, r.name, u.username AS sender FROM room_invites i
       JOIN rooms r ON r.id = i.room_id
       JOIN users u ON u.id = i.from_id
       WHERE i.to_id = ? ORDER BY i.created_at DESC`
    )
    .all(userId)
    .map((i) => ({ roomId: Number(i.room_id), roomName: i.name, from: i.sender }));

  // One row per friend with their room/queue/invite state joined in — the
  // old per-friend lookups (three queries each) multiplied by the poll rate
  // were the single hottest query pattern on the server. -1 stands in for
  // "no room of mine", which matches no invite row.
  const mineId = mine ? Number(mine.id) : -1;
  const friends = db
    .prepare(
      `SELECT u.id, u.username, g.rank,
              rm.room_id AS room_id,
              (q.user_id IS NOT NULL) AS in_queue,
              (iv.to_id IS NOT NULL) AS invited
       FROM friends f
       JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
       JOIN game_state g ON g.user_id = u.id
       LEFT JOIN room_members rm ON rm.user_id = u.id
       LEFT JOIN queue q ON q.user_id = u.id
       LEFT JOIN room_invites iv ON iv.to_id = u.id AND iv.room_id = ?
       WHERE f.status = 'accepted' AND (f.user_id = ? OR f.friend_id = ?)
       ORDER BY u.username`
    )
    .all(userId, mineId, userId, userId)
    .map((f) => ({
      username: f.username,
      rank: f.rank,
      status: f.room_id != null && Number(f.room_id) === mineId
        ? "party"
        : f.room_id != null ? "in-room" : f.in_queue ? "queued" : "idle",
      invited: !!f.invited,
    }));

  return {
    queued,
    partyQueued,
    queueDifficulty,
    queueSize,
    queueCounts,
    queueRoles,
    room,
    rooms,
    invites,
    friends,
  };
}

// ---------------------------------------------------------------------------
// Matchmaker — turns the queue table into rooms. Boss runs are 3-stacks; a
// party that queued together (queue rows sharing a party_id) is an
// indivisible unit, packed FIFO with solo players into exact trios. Anyone
// stranded past QUEUE_TIMEOUT_MS launches undersized with whoever else is
// still waiting (alone → a solo "Practice Match"). Env overrides let the e2e
// run the clock fast.
// ---------------------------------------------------------------------------
const MATCHMAKER_MS = Number(process.env.PSYRENA_MATCH_MS) || 5000;
const QUEUE_TIMEOUT_MS = Number(process.env.PSYRENA_QUEUE_TIMEOUT_MS) || 90_000;

/**
 * Seat a matched group in a fresh private room. The ONLY producer of
 * matchmade = 1 rooms: their host_id is just userIds[0], so they start on a
 * lobby ready-check rather than that player's button.
 *
 * @param {number[]} userIds
 * @param {string|null} name        null → auto "Ranked Match #<id>"
 * @param {string} difficulty       the pool this group came out of
 */
function formMatchRoom(userIds, name, difficulty = "standard") {
  const diff = ROOM_DIFFICULTIES.includes(difficulty) ? difficulty : "standard";
  const info = db
    .prepare("INSERT INTO rooms (name, host_id, is_public, difficulty, matchmade) VALUES (?, ?, 0, ?, 1)")
    .run(name ?? "Ranked Match", userIds[0], diff);
  const roomId = Number(info.lastInsertRowid);
  const finalName = name ?? `Ranked Match #${roomId}`;
  if (!name) db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(finalName, roomId);
  const delQueue = db.prepare("DELETE FROM queue WHERE user_id = ?");
  const addMember = db.prepare("INSERT INTO room_members (user_id, room_id) VALUES (?, ?)");
  for (const id of userIds) {
    leaveRoom(id);
    delQueue.run(id);
    addMember.run(id, roomId);
  }
  // Push AFTER every member is seated, so a client reacting to the event
  // polls a lobby that already shows the full match. Closed-panel players
  // learn now instead of on the panel's next 2.5 s poll.
  for (const id of userIds) pushTo(id, "match", { roomId, name: finalName, difficulty: diff });
}

// ---------------------------------------------------------------------------
// Fight-ready barrier — a party starts its boss fight together.
//
// Each client POSTs /api/fight/ready when its arena scene has fully loaded
// (models + shaders). The barrier releases with an SSE `fightStart` push to
// every member once all seated members are ready — or when the timeout runs
// out, so one member on hotel wifi (or one who closed the tab mid-load) can
// delay the party but never strand it. State is in-memory: a server restart
// mid-barrier just means the clients' own fallback timers start the fight.
// ---------------------------------------------------------------------------
const FIGHT_READY_TIMEOUT_MS = Number(process.env.PSYRENA_FIGHT_READY_MS) || 45_000;
/** roomId -> { ready: Set<userId>, timer } for barriers currently filling. */
const fightReadyByRoom = new Map();

function releaseFightBarrier(roomId) {
  const gate = fightReadyByRoom.get(roomId);
  if (!gate) return;
  clearTimeout(gate.timer);
  fightReadyByRoom.delete(roomId);
  // Last call before the roster hardens: anyone whose connection died waiting
  // is evicted here, so the party that starts is the party that is present.
  // The gate is already out of the map, so the eviction's own release path
  // (leaveRoom) finds nothing and cannot re-enter this function.
  for (const id of liveMembersOf(roomId)) pushTo(id, "fightStart", { roomId });
}

// ---------------------------------------------------------------------------
// Lobby ready-check — how a MATCHMADE party agrees to pull.
//
// A room the matchmaker built has no leader anyone consented to (host_id is
// just whoever queued first), so nobody gets to drag two strangers into a
// fight. Instead every seated member flips a ready dot and the last press
// launches. Player-created rooms are untouched: they have a real leader.
//
// Distinct from fightReadyByRoom below, which is the in-ARENA load barrier —
// this one runs while everyone is still standing in the village.
// ---------------------------------------------------------------------------
/** roomId -> Set<userId> who have pressed Ready in a matchmade lobby. */
const lobbyReadyByRoom = new Map();

/**
 * Drop every lobby-ready flag for a room. In memory rather than a DB column
 * for the same reason the fight barrier is: "ready" is a claim about someone
 * sitting at their keyboard right now, and a flag that survived a restart
 * would auto-launch a fight into three empty chairs. Losing them fails safe.
 */
function clearLobbyReady(roomId) {
  lobbyReadyByRoom.delete(Number(roomId));
}

/**
 * Start the fight for a whole room: pull every member out of the matchmaking
 * queue, spend the lobby-ready flags, and push `partyLaunch` to each member —
 * which is what actually walks their client into the arena (src/main.ts).
 *
 * The ONE launch path. The leader's button (POST /api/rooms/launch) and the
 * matchmade ready-check (POST /api/rooms/ready) both come through here, so
 * both kinds of party reach the arena — and the fight-ready barrier — the same
 * way. Synchronous throughout; callers rely on that for atomicity.
 *
 * @returns {{roomId:number, difficulty:string, members:number[]}|null} null if
 *          the room is already gone.
 */
function launchRoom(roomId) {
  const id = Number(roomId);
  const room = db.prepare("SELECT id, difficulty FROM rooms WHERE id = ?").get(id);
  if (!room) return null;
  const members = db
    .prepare("SELECT user_id FROM room_members WHERE room_id = ?")
    .all(id)
    .map((m) => Number(m.user_id));
  const difficulty = ROOM_DIFFICULTIES.includes(room.difficulty) ? room.difficulty : "standard";
  const clearQueue = db.prepare("DELETE FROM queue WHERE user_id = ?");
  for (const uid of members) clearQueue.run(uid);
  // Spent: a member who bounces back to this lobby presses Ready again, and a
  // stale flag would re-fire the auto-launch the moment someone else toggled.
  clearLobbyReady(id);
  for (const uid of members) pushTo(uid, "partyLaunch", { roomId: id, difficulty });
  return { roomId: id, difficulty, members };
}

/**
 * Queue rows grouped into FIFO units: a party stays one unit, solo is its own.
 * Each unit carries the difficulty pool it belongs to — a party takes its
 * ROOM's difficulty (COALESCE below), which is self-healing: a room whose
 * difficulty changed after queueing can never end up with its members split
 * across two pools, which would let formMatchRoom break the party in half.
 */
function queueUnits() {
  const waiting = db
    .prepare(
      `SELECT q.user_id, q.joined_at, q.party_id, g.selected_hero AS hero,
              COALESCE(pr.difficulty, q.difficulty) AS diff
       FROM queue q
       LEFT JOIN game_state g ON g.user_id = q.user_id
       LEFT JOIN rooms pr ON pr.id = q.party_id
       ORDER BY q.joined_at, q.user_id`
    )
    .all();
  const units = [];
  const byParty = new Map();
  for (const r of waiting) {
    const role = HERO_ROLES[r.hero] ?? "any";
    const diff = ROOM_DIFFICULTIES.includes(r.diff) ? r.diff : "standard";
    const pid = r.party_id == null ? null : Number(r.party_id);
    if (pid === null) {
      units.push({ ids: [Number(r.user_id)], roles: [role], at: Number(r.joined_at), party: false, diff });
      continue;
    }
    let unit = byParty.get(pid);
    if (!unit) {
      byParty.set(pid, (unit = { ids: [], roles: [], at: Number(r.joined_at), party: true, diff }));
      units.push(unit);
    }
    unit.ids.push(Number(r.user_id));
    unit.roles.push(role);
    unit.at = Math.min(unit.at, Number(r.joined_at));
  }
  return units.sort((a, b) => a.at - b.at);
}

/**
 * Can these ROOM_CAP roles cover one tank + one healer + one dps seat?
 * "any" (unknown hero) is a wildcard. Backtracking over 3 slots — trivial at
 * this size, and it stays correct if ROOM_CAP ever grows past distinct slots.
 */
function rolesCompleteTrio(roles) {
  if (roles.length !== ROOM_CAP) return false;
  const slots = ["tank", "healer", "dps"];
  const used = slots.map(() => false);
  const place = (i) => {
    if (i === roles.length) return true;
    for (let s = 0; s < slots.length; s++) {
      if (used[s]) continue;
      if (roles[i] !== "any" && roles[i] !== slots[s]) continue;
      used[s] = true;
      if (place(i + 1)) return true;
      used[s] = false;
    }
    return false;
  };
  return place(0);
}

/**
 * Match ONE difficulty's queue, in isolation. `open` is that pool's units,
 * oldest first; `difficulty` is stamped on every room this forms.
 *
 * Must stay await-free: the whole function is one synchronous span, and that
 * is what makes the FIFO packing atomic against the next request. The dead-row
 * sweeps (sessions, dropped browsers) happen once in matchQueue below, before
 * the pools are cut — a pool must never see a unit the sweep would have taken.
 */
function matchQueuePool(open, difficulty) {
  // Pass 1 — groups containing a party. A party chose its own comp (docs 02:
  // warn, never gate), so it packs FIFO exactly as before — but when several
  // fills would complete the trio, prefer the one that completes the ROLES
  // (tank + healer + dps) before falling back to plain FIFO.
  for (;;) {
    const seed = open.find((u) => u.party);
    if (!seed) break;
    const rest = open.filter((u) => u !== seed);
    let pick = null;
    if (seed.ids.length >= ROOM_CAP) {
      pick = [seed];
    } else {
      const need = ROOM_CAP - seed.ids.length;
      // Role-completing fill first (FIFO among candidates)…
      const dfs = (start, acc, accSize) => {
        if (accSize === need) {
          const roles = [...seed.roles, ...acc.flatMap((u) => u.roles)];
          return rolesCompleteTrio(roles) ? [...acc] : null;
        }
        for (let i = start; i < rest.length; i++) {
          if (accSize + rest[i].ids.length > need) continue;
          acc.push(rest[i]);
          const hit = dfs(i + 1, acc, accSize + rest[i].ids.length);
          acc.pop();
          if (hit) return hit;
        }
        return null;
      };
      let fill = dfs(0, [], 0);
      // …else the pre-role behaviour: oldest units that fit.
      if (!fill) {
        fill = [];
        let size = seed.ids.length;
        for (const u of rest) {
          if (size + u.ids.length > ROOM_CAP) continue;
          fill.push(u);
          size += u.ids.length;
          if (size === ROOM_CAP) break;
        }
        if (size < ROOM_CAP) fill = null;
      }
      if (fill) pick = [seed, ...fill];
    }
    if (!pick) break;
    formMatchRoom(pick.flatMap((u) => u.ids), null, difficulty);
    open = open.filter((u) => !pick.includes(u));
  }

  // Pass 2 — pure solos: a trio forms the moment the queue holds a
  // role-complete set (1 tank + 1 healer + 1 dps; unknown heroes fill any
  // seat), oldest players first. Three same-role solos wait — the timeout
  // below is their escape hatch, so entering is still never gated on role.
  for (;;) {
    const solos = open.filter((u) => !u.party);
    let trio = null;
    outer: for (let i = 0; i < solos.length; i++)
      for (let j = i + 1; j < solos.length; j++)
        for (let k = j + 1; k < solos.length; k++) {
          const cand = [solos[i], solos[j], solos[k]];
          if (rolesCompleteTrio(cand.flatMap((u) => u.roles))) {
            trio = cand;
            break outer;
          }
        }
    if (!trio) break;
    formMatchRoom(trio.flatMap((u) => u.ids), null, difficulty);
    open = open.filter((u) => !trio.includes(u));
  }

  // Timeout rule: once anyone in THIS pool is stale, launch everyone still
  // waiting in it — in FIFO chunks of up to ROOM_CAP, still never splitting a
  // party. Per-pool on both counts: a stale Nightmare player must not
  // force-flush a healthy Standard pool into undersized rooms, and a chunk
  // must never mix difficulties (a crossed chunk would hand a Standard queuer
  // Nightmare HP/damage AND the Nightmare payout bracket they never chose).
  // Alone past the timeout you get a 1-seat room — the shipped behaviour, and
  // the only one consistent with "solo runs are always possible".
  if (open.length && open.some((u) => Date.now() - u.at > QUEUE_TIMEOUT_MS)) {
    let chunk = [];
    let size = 0;
    for (const unit of open) {
      if (size + unit.ids.length > ROOM_CAP) {
        formMatchRoom(chunk.flatMap((u) => u.ids), "Practice Match", difficulty);
        chunk = [];
        size = 0;
      }
      chunk.push(unit);
      size += unit.ids.length;
    }
    if (chunk.length) formMatchRoom(chunk.flatMap((u) => u.ids), "Practice Match", difficulty);
  }
}

/**
 * Sweep dead rows, then match each difficulty as its own queue.
 *
 * Difficulty is a contract, not a preference: it drives the boss's HP and
 * damage multipliers AND the score, imaginz, XP and loot-tier multipliers in
 * economy.mjs. Grouping across pools would hand a player a fight and a
 * paycheck they never opted into, so the pools never see each other.
 *
 * Per-pool snapshots are safe because queue.user_id is the PRIMARY KEY: every
 * user sits in exactly one pool, so one pool's formMatchRoom (which deletes
 * queue rows and calls leaveRoom) can never invalidate another's units. Do not
 * "simplify" this back into one shared array.
 */
function matchQueue() {
  // Ghost rows first: a user whose sessions are all gone (kicked by a new
  // login, grace-logged-out) must not hold a match slot.
  db.prepare(
    "DELETE FROM queue WHERE user_id NOT IN (SELECT user_id FROM sessions WHERE expires_at > ?)"
  ).run(Date.now());
  // …and neither may one whose session is still valid but whose browser is
  // gone: matching them is what puts an undriven hero in the boss fight.
  // Both sweeps run BEFORE the pools are cut, so a dead row can never be
  // counted into one pool's FIFO and then vanish out from under it.
  sweepQueueDrops();

  const pools = new Map();
  for (const u of queueUnits()) {
    if (!pools.has(u.diff)) pools.set(u.diff, []);
    pools.get(u.diff).push(u);
  }
  // Iterate the canonical list, not pools.keys() — a deterministic order keeps
  // the clock-forcing e2e scripts reproducible.
  for (const d of ROOM_DIFFICULTIES) {
    const pool = pools.get(d);
    if (pool?.length) matchQueuePool(pool, d);
  }
}

// Runs on every queue join plus a slow timer for the timeout rule. Rebound
// (not merely guarded) on globalThis: a Vite middleware reload must neither
// stack duplicate intervals nor keep ticking a stale closure of this file.
const MATCHMAKER_KEY = "__psyrenaMatchmaker";
if (globalThis[MATCHMAKER_KEY]) clearInterval(globalThis[MATCHMAKER_KEY]);
globalThis[MATCHMAKER_KEY] = setInterval(() => {
  try {
    matchQueue();
  } catch (err) {
    console.error("[matchmaker]", err);
  }
}, MATCHMAKER_MS);
globalThis[MATCHMAKER_KEY].unref?.();

// Grace logout: a user whose last social stream has been closed for
// OFFLINE_GRACE_MS is gone for real — free every seat they hold. Reconnects
// cancel the pending state before it ever reaches this sweep (social.mjs).
const PRESENCE_SWEEP_KEY = "__psyrenaPresenceSweep";
if (globalThis[PRESENCE_SWEEP_KEY]) clearInterval(globalThis[PRESENCE_SWEEP_KEY]);
globalThis[PRESENCE_SWEEP_KEY] = setInterval(() => {
  try {
    for (const userId of collectOfflineExpired(OFFLINE_GRACE_MS)) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
      // Dropping off the network mid-fight is desertion too — otherwise the
      // cheapest way to dodge the lock would be to kill the tab, which is the
      // very thing it exists to discourage.
      markFightAbandon(userId);
      leaveRoom(userId);
      db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
      leaveVillage(userId);
      notifyFriendsOf(userId);
    }
  } catch (err) {
    console.error("[presence-sweep]", err);
  }
}, PRESENCE_SWEEP_MS);
globalThis[PRESENCE_SWEEP_KEY].unref?.();

/** userId -> last persisted-at. Throttles the per-request last_seen write. */
const lastSeenWrites = new Map();
function touchLastSeen(userId) {
  const now = Date.now();
  if (now - (lastSeenWrites.get(userId) ?? 0) < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWrites.set(userId, now);
  db.prepare("UPDATE game_state SET last_seen = ? WHERE user_id = ?").run(now, userId);
}

function readCookie(req, name) {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function sessionUser(req) {
  const token = readCookie(req, "psyrena_session");
  if (!token) return null;
  const row = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return Number(row.user_id);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(json);
}

/**
 * Client IP for rate limiting. Proxy headers are trivially forged, so they
 * are honored only when the operator says a trusted proxy sits in front
 * (PSYRENA_TRUST_PROXY=1 — set it when deploying behind Cloudflare, which
 * stamps CF-Connecting-IP, or any reverse proxy that sets X-Forwarded-For).
 */
function clientIp(req) {
  if (process.env.PSYRENA_TRUST_PROXY === "1") {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

// Sliding-window rate limiter for the unauthenticated auth endpoints — the
// only routes an attacker can hit without an account, and the only ones whose
// cost (scrypt) is high enough to matter. Keyed strings keep login and
// register windows separate. The map self-prunes on access; the size guard is
// a backstop against an address-rotating flood inflating it forever.
// Env overrides exist so the e2e can register a cast of accounts fast.
const LOGIN_RATE = { windowMs: 60_000, max: Number(process.env.PSYRENA_LOGIN_RATE_MAX) || 10 };
const REGISTER_RATE = { windowMs: 3_600_000, max: Number(process.env.PSYRENA_REGISTER_RATE_MAX) || 5 };
const authHits = new Map();
function rateLimited(key, { windowMs, max }) {
  const now = Date.now();
  const hits = (authHits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { authHits.set(key, hits); return true; }
  hits.push(now);
  if (authHits.size > 10_000) authHits.clear();
  authHits.set(key, hits);
  return false;
}

/**
 * Session cookie. `Secure` rides on PSYRENA_SECURE_COOKIES=1 (set it on any
 * HTTPS deployment) rather than sniffing the request: behind a TLS-terminating
 * proxy the local hop is plain HTTP, and in dev over the tailnet there is no
 * TLS at all — the operator knows which world they are in, the code cannot.
 */
function sessionCookie(token, maxAgeSec) {
  const secure = process.env.PSYRENA_SECURE_COOKIES === "1" ? "; Secure" : "";
  return `psyrena_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

/** Shared by login and register: newest device wins, older tabs hear it. */
function openSession(res, uid) {
  const hadOthers =
    Number(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(uid).n) > 0;
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(uid);
  if (hadOthers) pushTo(uid, "kicked", { reason: "Signed in from another device." });
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, uid, Date.now() + SESSION_TTL_MS);
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000));
}

// Friends + chat live in server/social.mjs, on the same db. Registered here so
// there is exactly one place (this file) that owns the connection and schema.
const apiHelpers = { send, readBody, tx };
initEvents(db); // first: every other module may logEvent()
initSocial(db, apiHelpers);

// Imaginz/gear/loot/rankings (economy.mjs) and village presence (village.mjs)
// share the same db and helpers on the same principle.
// The arena turnstile has to see the desertion lock the fight module keeps,
// and fight.mjs already imports economy.mjs for the payout — so the check is
// handed down rather than imported back up (same shape as initAdmin's extras).
initEconomy(db, { ...apiHelpers, deserterLockFor });
initVillage(db, apiHelpers);
// The boss fight itself: server-authoritative sessions running the same
// shared/fight sim the client used to own outright.
initFight(db, apiHelpers);
initAchievements(db, apiHelpers);
initCoffee(db, apiHelpers);
// Last: the admin layer's bootstrap promotion needs the tables above, and its
// force-logout needs the seat-freeing helpers this file owns. createUser and
// the credential policy ride along so the console's create-user route enforces
// the same rules as /api/register without admin.mjs importing this module.
initAdmin(db, { ...apiHelpers, leaveRoom, leaveVillage, createUser, setPassword, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        // Destroy, don't just reject: a settled promise stops nobody from
        // streaming gigabytes into `data` for the life of the socket.
        req.destroy();
        data = "";
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

/**
 * Handle one request. Returns false (without touching the response) when the
 * URL is not /api/*, so Vite middleware can fall through to static serving.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api/")) {
    // The admin console shell rides the API handler so it exists under both
    // the Vite dev middleware and the standalone runner. Data-free: every
    // fetch it makes is admin-checked in handleAdmin.
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      return serveConsole(res), true;
    }
    return false;
  }
  const route = `${req.method} ${url.pathname}`;

  try {
    // Unauthenticated liveness probe for the deployment's monitor/load
    // balancer. Touches the DB so a wedged SQLite handle reads as down.
    if (route === "GET /api/health") {
      db.prepare("SELECT 1").get();
      return send(res, 200, { ok: true }), true;
    }

    // Ungated: the login screen asks this to label the invitation-code box
    // (required vs optional) — admins flip the policy in the console.
    if (route === "GET /api/register/policy") {
      return send(res, 200, { inviteRequired: inviteRequired() }), true;
    }

    if (route === "POST /api/login") {
      if (rateLimited(`login:${clientIp(req)}`, LOGIN_RATE)) {
        return send(res, 429, { error: "Too many attempts — wait a minute and try again." }), true;
      }
      const { username, password } = await readBody(req);
      const user = typeof username === "string" && typeof password === "string"
        ? db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim())
        : null;
      // Unknown users still pay the scrypt cost (against DUMMY_CRED) so the
      // response time never says whether the username exists.
      const ok = user
        ? await verifyPassword(password, user.pass_salt, user.pass_hash)
        : (await verifyPassword(String(password ?? ""), DUMMY_CRED.salt, DUMMY_CRED.hash), false);
      if (!ok) return send(res, 401, { error: "Wrong username or password." }), true;
      const ban = banInfo(Number(user.id));
      if (ban) {
        const until = ban.permanent ? "" : ` until ${new Date(ban.until).toUTCString()}`;
        const why = ban.reason ? ` — ${ban.reason}` : "";
        return send(res, 403, { error: `This account is banned${until}${why}.` }), true;
      }
      openSession(res, Number(user.id));
      // A desertion lock is served WHILE PLAYING: signing in restarts it, so
      // waiting it out logged off buys nothing (server/fight.mjs).
      restartDeserterClock(Number(user.id));
      logEvent("auth.login", Number(user.id));
      return send(res, 200, profileFor(Number(user.id))), true;
    }

    if (route === "POST /api/register") {
      if (rateLimited(`reg:${clientIp(req)}`, REGISTER_RATE)) {
        return send(res, 429, { error: "Too many new accounts from this address — try again later." }), true;
      }
      const { username, password, inviteCode, studentId } = await readBody(req);
      const name = typeof username === "string" ? username.trim() : "";
      if (!USERNAME_RE.test(name)) {
        return send(res, 400, { error: "Username must be 3–20 characters: letters, digits, - or _." }), true;
      }
      if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        return send(res, 400, { error: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.` }), true;
      }
      if (db.prepare("SELECT id FROM users WHERE username = ?").get(name)) {
        return send(res, 409, { error: "That name is taken." }), true;
      }
      // Invitation gate (admin console mints codes; PSYRENA_INVITE_REQUIRED=0
      // opens registration). Reserve BEFORE the slow scrypt path so two racing
      // registrations cannot both spend a one-time code, and release on any
      // failure after the reservation so a lost race never burns a use.
      const invite = typeof inviteCode === "string" ? inviteCode.trim().toUpperCase() : "";
      // Registering with a code also demands a student ID — codes go out per
      // class roster, and the ID is what ties the account back to a student.
      const student = typeof studentId === "string" ? studentId.trim() : "";
      if (invite && !student) {
        return send(res, 400, { error: "Student ID is required when registering with an invitation code." }), true;
      }
      if (student.length > 64) {
        return send(res, 400, { error: "Student ID must be 64 characters or fewer." }), true;
      }
      if (inviteRequired()) {
        if (!invite) return send(res, 403, { error: "Registration needs an invitation code." }), true;
        const problem = reserveInvite(invite);
        if (problem) return send(res, 403, { error: problem }), true;
      }
      let uid;
      try {
        uid = await createUser(name, password);
      } catch {
        // The UNIQUE constraint closes the race between the pre-check and the
        // insert (createUser awaits scrypt, so another register can interleave).
        if (invite) releaseInvite(invite);
        return send(res, 409, { error: "That name is taken." }), true;
      }
      if (student) db.prepare("UPDATE users SET student_id = ? WHERE id = ?").run(student, uid);
      if (invite) recordInviteUse(invite, uid);
      // The very first account becomes the admin (see admin.mjs) — someone
      // must be able to open the console before the console can appoint.
      ensureAdminBootstrap();
      logEvent("auth.register", uid, { username: name, invite: invite || null, studentId: student || null });
      openSession(res, uid);
      return send(res, 200, profileFor(uid)), true;
    }

    if (route === "POST /api/logout") {
      const token = readCookie(req, "psyrena_session");
      const row = token
        ? db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token)
        : null;
      if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      // A logout is a full departure: free the party seat, the queue slot and
      // the village spot now instead of waiting for the sweeps.
      if (row) {
        const uid = Number(row.user_id);
        leaveRoom(uid);
        db.prepare("DELETE FROM queue WHERE user_id = ?").run(uid);
        leaveVillage(uid);
        notifyFriendsOf(uid);
        logEvent("auth.logout", uid);
      }
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return send(res, 200, { ok: true }), true;
    }

    const userId = sessionUser(req);
    if (userId) touchLastSeen(userId);

    if (route === "POST /api/presence/offline") {
      // navigator.sendBeacon target (fired from pagehide): no headers, maybe
      // no body — only the session cookie matters. The user is marked offline
      // immediately (grace clock starts) and their village seat is freed; the
      // session itself survives until the grace sweep in case they come back.
      if (userId) {
        markOffline(userId);
        leaveVillage(userId);
        notifyFriendsOf(userId);
        // A drop mid-fight restarts the arena admission's re-entry clock, so
        // the same 2-minute grace that holds their seats also holds the entry
        // they paid — reconnect and walk back in free.
        touchArenaHold(userId);
      }
      return send(res, 200, { ok: true }), true;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      return await handleAdmin(req, res, url, userId), true;
    }

    if (url.pathname.startsWith("/api/social/")) {
      return await handleSocial(req, res, url, userId), true;
    }

    if (url.pathname.startsWith("/api/village/")) {
      return await handleVillage(req, res, url, userId), true;
    }

    // The server-authoritative fight sim. Like the barrier below it, this must
    // intercept before the /api/fight/* economy dispatch, which only knows
    // /api/fight/result.
    if (url.pathname.startsWith("/api/fight/sim/")) {
      return await handleFightSim(req, res, url, userId), true;
    }

    // Fight-ready barrier — must intercept before the /api/fight/* economy
    // dispatch below, which only knows /api/fight/result.
    if (route === "POST /api/fight/ready") {
      if (!userId) return send(res, 401, { error: "Not logged in." }), true;
      // `skip` = "I am not coming" (declined the paid entry, admission
      // refused). It counts toward the barrier without the sender being in
      // the arena, so one member bowing out releases the rest immediately
      // instead of holding them for the full timeout.
      const readyBody = await readBody(req);
      const skipping = readyBody.skip === true;
      const seat = db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").get(userId);
      if (!seat) return send(res, 200, { solo: true }), true;
      const roomId = Number(seat.room_id);
      // Teammates who dropped while the party was forming are evicted before
      // the count is taken: the barrier must not hold the rest waiting on a
      // browser that is gone, and the fight must not be built around them.
      const members = liveMembersOf(roomId, userId);
      // A one-seat "party" (undersized practice match) has nobody to wait for.
      // Being left alone by a drop lands here too, so any barrier already
      // filling for this room is torn down rather than left to time out and
      // fire a fightStart at a player who has long since started.
      if (members.length <= 1) {
        const stale = fightReadyByRoom.get(roomId);
        if (stale) {
          clearTimeout(stale.timer);
          fightReadyByRoom.delete(roomId);
        }
        return send(res, 200, { solo: true }), true;
      }
      let gate = fightReadyByRoom.get(roomId);
      if (!gate) {
        gate = {
          ready: new Set(),
          timer: setTimeout(() => releaseFightBarrier(roomId), FIGHT_READY_TIMEOUT_MS),
        };
        fightReadyByRoom.set(roomId, gate);
      }
      gate.ready.add(Number(userId));
      const readyCount = members.filter((id) => gate.ready.has(id)).length;
      if (readyCount >= members.length) {
        releaseFightBarrier(roomId);
      } else {
        for (const id of members) {
          pushTo(id, "fightReady", { roomId, ready: readyCount, total: members.length });
        }
      }
      // A skipper is not waiting on anything — answer `solo` so its client
      // (which is still standing in the village) never blocks on the release.
      if (skipping) return send(res, 200, { solo: true, skipped: true }), true;
      return send(res, 200, { solo: false, roomId, ready: readyCount, total: members.length }), true;
    }

    if (url.pathname.startsWith("/api/gear/") || url.pathname.startsWith("/api/loot/") ||
        url.pathname.startsWith("/api/pet/") ||
        url.pathname.startsWith("/api/fight/") || url.pathname.startsWith("/api/arena/") ||
        route === "GET /api/rankings" || route === "GET /api/economy") {
      return await handleEconomy(req, res, url, userId), true;
    }

    if (route === "GET /api/achievements" || route === "GET /api/leaderboards" ||
        url.pathname.startsWith("/api/title/")) {
      return await handleAchievements(req, res, url, userId), true;
    }

    if (route === "GET /api/coffee" || url.pathname.startsWith("/api/coffee/")) {
      return await handleCoffee(req, res, url, userId), true;
    }

    if (route === "GET /api/me") {
      if (!userId) return send(res, 401, { error: "Not logged in." }), true;
      return send(res, 200, profileFor(userId)), true;
    }

    if (route === "POST /api/select-hero") {
      if (!userId) return send(res, 401, { error: "Not logged in." }), true;
      const { hero } = await readBody(req);
      if (!HERO_IDS.includes(hero)) return send(res, 400, { error: "Unknown hero." }), true;
      const unlocked = JSON.parse(
        db.prepare("SELECT unlocked_heroes FROM game_state WHERE user_id = ?").get(userId).unlocked_heroes
      );
      if (!unlocked.includes(hero)) return send(res, 403, { error: "Hero is locked." }), true;
      db.prepare("UPDATE game_state SET selected_hero = ? WHERE user_id = ?").run(hero, userId);
      return send(res, 200, profileFor(userId)), true;
    }

    // ---- Lobby: rooms, queue, invites (portal panel) ----------------------
    // Friend add/accept/remove lives in social.mjs under /api/social/friend.
    // Every route below is session-gated; the panel cannot open logged out.
    if (route.startsWith("GET /api/lobby") || route.startsWith("POST /api/rooms") ||
        route.startsWith("POST /api/queue") || route.startsWith("POST /api/invites")) {
      if (!userId) return send(res, 401, { error: "Not logged in." }), true;
    }

    if (route === "GET /api/lobby") {
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/queue/join") {
      // Queueing does NOT leave your room: the party is the unit being
      // queued. The host queues everyone (one row per member, tied by
      // party_id); solo players queue alone as before.
      //
      // Body FIRST, before any DB read: everything below is then one
      // synchronous span, so nothing can slip between "am I in a party" and
      // the enqueue.
      const body = await readBody(req);
      const wanted = ROOM_DIFFICULTIES.includes(body?.difficulty) ? body.difficulty : "standard";
      const mine = db
        .prepare(
          "SELECT r.id, r.host_id, r.difficulty FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?"
        )
        .get(userId);
      if (mine && Number(mine.host_id) !== Number(userId)) {
        return send(res, 403, { error: "Only the party leader can queue." }), true;
      }
      // A party queues at ITS ROOM's difficulty — that is the contract its
      // members already accepted when they walked in — so the leader's own
      // picker is ignored here on purpose.
      const diff = mine
        ? (ROOM_DIFFICULTIES.includes(mine.difficulty) ? mine.difficulty : "standard")
        : wanted;
      const now = Date.now();
      if (mine) {
        const members = db
          .prepare("SELECT user_id FROM room_members WHERE room_id = ?")
          .all(Number(mine.id));
        const enqueue = db
          .prepare("INSERT OR REPLACE INTO queue (user_id, joined_at, party_id, difficulty) VALUES (?, ?, ?, ?)");
        for (const m of members) enqueue.run(Number(m.user_id), now, Number(mine.id), diff);
      } else {
        // Re-queueing at the SAME difficulty keeps your place — mashing the
        // button must not reset your wait. CHANGING difficulty resets
        // joined_at, or a player who has already aged past QUEUE_TIMEOUT_MS in
        // one pool could hop to another and instantly force-flush it into
        // undersized rooms.
        const row = db.prepare("SELECT joined_at, difficulty FROM queue WHERE user_id = ?").get(userId);
        if (!row) {
          db.prepare("INSERT INTO queue (user_id, joined_at, party_id, difficulty) VALUES (?, ?, NULL, ?)")
            .run(userId, now, diff);
        } else if (row.difficulty !== diff) {
          db.prepare("UPDATE queue SET joined_at = ?, party_id = NULL, difficulty = ? WHERE user_id = ?")
            .run(now, diff, userId);
        }
      }
      matchQueue(); // a full trio is matched before this response is built
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/queue/leave") {
      // The leader's dequeue pulls the whole party back out; a member's own
      // dequeue drops only their row (their real exit is leaving the room).
      const row = db.prepare("SELECT party_id FROM queue WHERE user_id = ?").get(userId);
      if (row && row.party_id != null) {
        const party = db.prepare("SELECT host_id FROM rooms WHERE id = ?").get(Number(row.party_id));
        if (party && Number(party.host_id) === Number(userId)) {
          db.prepare("DELETE FROM queue WHERE party_id = ?").run(Number(row.party_id));
          return send(res, 200, lobbyFor(userId)), true;
        }
      }
      db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/rooms/create") {
      const { name, password, isPublic, difficulty } = await readBody(req);
      const roomName = typeof name === "string" ? name.trim() : "";
      if (!roomName || roomName.length > 32) {
        return send(res, 400, { error: "Room name must be 1–32 characters." }), true;
      }
      const diff = ROOM_DIFFICULTIES.includes(difficulty) ? difficulty : "standard";
      const pw = typeof password === "string" ? password : "";
      const cred = pw ? await hashPassword(pw) : { salt: null, hash: null };
      leaveRoom(userId);
      db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
      const info = db
        .prepare(
          "INSERT INTO rooms (name, host_id, is_public, pass_salt, pass_hash, difficulty) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(roomName, userId, isPublic === false ? 0 : 1, cred.salt, cred.hash, diff);
      db.prepare("INSERT INTO room_members (user_id, room_id) VALUES (?, ?)")
        .run(userId, Number(info.lastInsertRowid));
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/rooms/join") {
      const { roomId, password } = await readBody(req);
      const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(Number(roomId));
      if (!room) return send(res, 404, { error: "That room is gone." }), true;
      // An invite is a key: it bypasses the password (and is how private
      // rooms are entered at all).
      const invited = !!db
        .prepare("SELECT to_id FROM room_invites WHERE room_id = ? AND to_id = ?")
        .get(room.id, userId);
      if (room.pass_hash && !invited) {
        if (typeof password !== "string" || !(await verifyPassword(password, room.pass_salt, room.pass_hash))) {
          return send(res, 403, { error: "Wrong room password." }), true;
        }
      }
      if (!room.is_public && !invited) {
        return send(res, 403, { error: "That room is invite-only." }), true;
      }
      // Cap check sits AFTER the awaited password verify so no other request
      // can slip between the count and the insert — the check-then-act pair
      // must stay await-free to stay atomic on the single thread.
      const count = Number(
        db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?").get(room.id).n
      );
      if (count >= ROOM_CAP) return send(res, 409, { error: "Room is full." }), true;
      leaveRoom(userId);
      db.prepare("DELETE FROM queue WHERE user_id = ?").run(userId);
      db.prepare("INSERT INTO room_members (user_id, room_id) VALUES (?, ?)").run(userId, Number(room.id));
      db.prepare("DELETE FROM room_invites WHERE room_id = ? AND to_id = ?").run(Number(room.id), userId);
      // A new face changes what everyone already said yes to — re-ready.
      clearLobbyReady(Number(room.id));
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/rooms/leave") {
      leaveRoom(userId);
      return send(res, 200, lobbyFor(userId)), true;
    }

    // A matchmade lobby has no leader anyone agreed to, so it starts only when
    // EVERY seated member says ready. The last press launches through the same
    // launchRoom() the leader's button uses, so both kinds of party reach the
    // arena — and the fight-ready barrier — identically.
    if (route === "POST /api/rooms/ready") {
      // Sole await: everything after it is one synchronous span, which is what
      // makes "count the flags → launch" atomic against a simultaneous press.
      const body = await readBody(req);
      const wantReady = body?.ready !== false; // a bare {} means "ready"
      const mine = db
        .prepare(
          "SELECT r.id, r.matchmade FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?"
        )
        .get(userId);
      if (!mine) return send(res, 409, { error: "You are not in a room." }), true;
      if (!mine.matchmade) {
        return send(res, 403, { error: "This party starts when its leader does." }), true;
      }
      const roomId = Number(mine.id);
      // Evict teammates whose browser is gone BEFORE reading the flag set.
      // A ready-check counts presses, and someone who dropped can never press
      // — without this the lobby stalls on a ghost until the two-minute
      // presence grace. Ordering matters: an eviction runs leaveRoom, which
      // clears the whole set (the party changed), so the set must be fetched
      // after. Our own press is never evicted — liveMembersOf keeps the caller.
      const members = liveMembersOf(roomId, userId);
      let set = lobbyReadyByRoom.get(roomId);
      if (!set) lobbyReadyByRoom.set(roomId, (set = new Set()));
      if (wantReady) set.add(Number(userId));
      else set.delete(Number(userId));
      // Count only SEATED members: a leaver's stale flag must never complete
      // the check (clearLobbyReady in leaveRoom drops it anyway).
      const readyCount = members.filter((id) => set.has(id)).length;
      if (members.length > 0 && readyCount === members.length) {
        // A 1-seat room (queue timeout, nobody else waiting) launches on the
        // first press — which is exactly right for it.
        launchRoom(roomId);
      } else {
        for (const id of members) {
          pushTo(id, "lobbyReady", { roomId, ready: readyCount, total: members.length });
        }
      }
      return send(res, 200, lobbyFor(userId)), true;
    }

    // Host-only: start the fight for the whole party. Every member gets a
    // `partyLaunch` SSE push and auto-enters the boss arena; the fight-ready
    // barrier below then holds the countdown until everyone loaded (or
    // dropped). Launching also pulls the party out of the matchmaking queue —
    // a direct launch supersedes waiting for fills.
    if (route === "POST /api/rooms/launch") {
      const mine = db
        .prepare(
          "SELECT r.id, r.host_id, r.matchmade FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?"
        )
        .get(userId);
      if (!mine) return send(res, 409, { error: "You are not in a room." }), true;
      if (Number(mine.host_id) !== Number(userId)) {
        return send(res, 403, { error: "Only the party leader can start the fight." }), true;
      }
      // A player-created party pulls at full strength or not at all — the
      // client greys the button, and a rule the server does not enforce is
      // decoration. Matchmade rooms are exempt: the queue timeout deliberately
      // forms 1- and 2-seat rooms, and the ready-check is their only way in.
      if (!mine.matchmade) {
        const count = Number(
          db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?").get(Number(mine.id)).n
        );
        if (count < ROOM_CAP) {
          return send(res, 409, { error: "Your party is not full yet — queue for a fill." }), true;
        }
      }
      launchRoom(Number(mine.id));
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/rooms/invite") {
      const { username } = await readBody(req);
      const mine = db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").get(userId);
      if (!mine) return send(res, 409, { error: "You are not in a room." }), true;
      const target = typeof username === "string"
        ? db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim())
        : null;
      if (!target) return send(res, 404, { error: "No such player." }), true;
      const isFriend = !!db
        .prepare(
          `SELECT status FROM friends WHERE status = 'accepted'
           AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`
        )
        .get(userId, target.id, target.id, userId);
      if (!isFriend) return send(res, 403, { error: "You can only invite friends." }), true;
      const already = db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").get(target.id);
      if (already && Number(already.room_id) === Number(mine.room_id)) {
        return send(res, 409, { error: "Already in your party." }), true;
      }
      db.prepare(
        "INSERT OR REPLACE INTO room_invites (room_id, to_id, from_id) VALUES (?, ?, ?)"
      ).run(Number(mine.room_id), Number(target.id), userId);
      // Push the invite down the invitee's social stream: without it an
      // invitation is only discoverable by opening the rooms panel, which is
      // exactly the player who doesn't know they were invited.
      {
        const room = db.prepare("SELECT name FROM rooms WHERE id = ?").get(Number(mine.room_id));
        const from = db.prepare("SELECT username FROM users WHERE id = ?").get(userId);
        pushTo(Number(target.id), "invite", {
          roomId: Number(mine.room_id),
          name: room ? String(room.name) : "a party",
          from: from ? String(from.username) : "someone",
        });
      }
      return send(res, 200, lobbyFor(userId)), true;
    }

    if (route === "POST /api/invites/decline") {
      const { roomId } = await readBody(req);
      db.prepare("DELETE FROM room_invites WHERE room_id = ? AND to_id = ?").run(Number(roomId), userId);
      return send(res, 200, lobbyFor(userId)), true;
    }

    return send(res, 404, { error: "No such endpoint." }), true;
  } catch (err) {
    // An error after headers went out (an SSE stream that failed mid-setup)
    // cannot be answered with a status — a second writeHead throws, escapes
    // this handler, and under Node's default unhandled-rejection policy takes
    // the whole process (and every player) with it. End the socket instead.
    if (res.headersSent) {
      console.error("[api] failed after headers sent:", err);
      return res.end(), true;
    }
    return send(res, 400, { error: err instanceof Error ? err.message : "Bad request." }), true;
  }
}
