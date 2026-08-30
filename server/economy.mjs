/**
 * Psyrena economy layer — Imaginz wallets, gear tiers, loot boxes, fight
 * results, season rankings.
 *
 * Same zero-dependency stance as server/app.mjs, same sqlite file. Score and
 * reward math is deliberately simple and server-side only: this module is the
 * authority on what an attempt was worth, and since phase 4 of
 * docs-server-auth-plan.md it is fed by server/fight.mjs's own sim rather than
 * by a client's account of it — `settleFight` is the door that opened for.
 * Nothing here is realtime — gear/loot/fight are ordinary POSTs, rankings a GET.
 */
import { randomUUID } from "node:crypto";
import { logEvent } from "./events.mjs";

// Gear slots mirror src/ui/gearPanel.ts SLOTS order (hat → pet).
export const GEAR_SLOTS = ["hat", "body", "gloves", "pants", "shoes", "pet"];

// Five quality tiers, identical definitions for every player. upgradeCost is
// the Imaginz price to go from that tier to the next; tier 4 is the cap.
export const GEAR_TIERS = [
  { tier: 0, key: "latent",       name: "Latent",       quality: "Common",    color: "#9aa3ad", upgradeCost: 200 },
  { tier: 1, key: "emergent",     name: "Emergent",     quality: "Uncommon",  color: "#57d977", upgradeCost: 600 },
  { tier: 2, key: "lucid",        name: "Lucid",        quality: "Rare",      color: "#4da3ff", upgradeCost: 1500 },
  { tier: 3, key: "oneiric",      name: "Oneiric",      quality: "Epic",      color: "#b46bff", upgradeCost: 3500 },
  { tier: 4, key: "transcendent", name: "Transcendent", quality: "Legendary", color: "#ffc94d", upgradeCost: null },
];

// Pet progression — mirrors shared/progression.ts (docs/09); do not drift.
// A pet is a stat item: the box pool below is what loot can drop and shards
// can adopt; hero-exclusives (Druzhok) are implicitly owned by their hero and
// never enter the pool. Levels 0..3; PET_UPGRADE_COST[level] pays level+1.
export const PET_BOX_POOL = ["robot", "corgi", "husky", "blackcat", "dino", "unicorn"];
export const PET_EXCLUSIVE = ["druzhok"];
export const PET_MAX_LEVEL = 3;
export const PET_UPGRADE_COST = [200, 600, 1500];
export const PET_LOOT = {
  dropRateByBoxTier: [0, 0.02, 0.05, 0.12],
  shardsByBoxTier: [1, 2, 5, 10],
  adoptCost: 60,
  allOwnedShardMult: 3,
  shardToImaginz: 10,
};

// Loot box tiers: [0] fight loss consolation, [1..3] win by difficulty.
// min/max are the inclusive Imaginz roll range when the box is opened.
export const LOOT_TIERS = [
  { tier: 0, name: "Residue Cache",      min: 40,  max: 80 },
  { tier: 1, name: "Insight Cache",      min: 100, max: 200 },
  { tier: 2, name: "Reverie Cache",      min: 220, max: 400 },
  { tier: 3, name: "Transference Cache", min: 400, max: 700 },
];

const SEASON_MS = 12 * 7 * 24 * 3600 * 1000; // seasons last 12 weeks
const FIRST_SEASON_NAME = "Season 1 — Shadow of the Id";
const FIGHT_AWARD = { standard: 30, hard: 50, nightmare: 80 };
const FIGHT_LOOT_TIER = { standard: 1, hard: 2, nightmare: 3 };
// XP is account progression, not season rating: it never resets, and unlike
// Imaginz it cannot be spent. A loss still pays — the HUD bar should move on
// every attempt or it stops being a reason to attempt anything.
const FIGHT_XP = { standard: 70, hard: 120, nightmare: 200 };
const FIGHT_XP_LOSS = 25;
const DIFF_MULT = { standard: 1.0, hard: 1.5, nightmare: 2.2 };
const DIFFICULTIES = Object.keys(DIFF_MULT);

// Practice mode (bot teammates): a token payout per completed run, win or
// loss — the mode exists to teach, so every attempt moves the wallet a
// little — capped per day so farming bots never rivals a real fight's award.
const PRACTICE_AWARD = 10;
const PRACTICE_DAILY_CAP = 50;

// Arena admission: three free entries per day, resetting at server midnight
// (the day key is the server's local date). Past those, each entry costs
// Imaginz.
const ARENA_FREE_ENTRIES_PER_DAY = 3;
const ARENA_EXTRA_ENTRY_COST = 50;
// Enough for a coffee (500) OR the first cheap gear upgrade after a few
// fights — the progression economy starts meaning something on day one.
// (The 10k testing seed is gone; dev DBs keep whatever they already had.)
export const STARTING_IMAGINZ = 500;

let db = null;
let helpers = null; // { send, readBody } borrowed from app.mjs

export function initEconomy(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      imaginz INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gear_pieces (
      user_id TEXT NOT NULL,
      slot    TEXT NOT NULL,
      tier    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, slot)
    );
    -- Owned pets and their upgrade level (docs/09 §3). A missing row means
    -- "not owned"; hero-exclusive pets never get rows (implicit ownership).
    CREATE TABLE IF NOT EXISTS pets (
      user_id     TEXT NOT NULL,
      pet_id      TEXT NOT NULL,
      level       INTEGER NOT NULL DEFAULT 0,
      obtained_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, pet_id)
    );
    CREATE TABLE IF NOT EXISTS loot_boxes (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      tier       INTEGER NOT NULL,
      source     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      opened     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS seasons (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS season_scores (
      user_id   TEXT NOT NULL,
      season_id INTEGER NOT NULL,
      rating    INTEGER NOT NULL DEFAULT 0,
      battles   INTEGER NOT NULL DEFAULT 0,
      wins      INTEGER NOT NULL DEFAULT 0,
      best_score INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, season_id)
    );
    -- Lifetime per-fight records (achievements + clears leaderboard). Columns
    -- stay NULL until the player has a qualifying fight: fastest_* only count
    -- wins, nightmare_* only nightmare wins; best_dps tracks every attempt.
    CREATE TABLE IF NOT EXISTS user_records (
      user_id              TEXT PRIMARY KEY,
      fastest_ms           INTEGER,
      fastest_diff         TEXT,
      nightmare_fastest_ms INTEGER,
      nightmare_wins       INTEGER DEFAULT 0,
      best_dps             REAL DEFAULT 0
    );
    -- Per-hero battle records: the account-wide counters above, broken down
    -- by the hero that actually fought. Written by handleFightResult from
    -- game_state.selected_hero at report time — server-derived, never a
    -- client-supplied field. The account totals stay in game_state /
    -- user_records; these rows only answer "played as whom, with what record".
    CREATE TABLE IF NOT EXISTS hero_records (
      user_id         TEXT NOT NULL,
      hero_id         TEXT NOT NULL,
      battles         INTEGER NOT NULL DEFAULT 0,
      wins            INTEGER NOT NULL DEFAULT 0,
      bosses_defeated INTEGER NOT NULL DEFAULT 0,
      best_score      INTEGER NOT NULL DEFAULT 0,
      best_dps        REAL NOT NULL DEFAULT 0,
      fastest_ms      INTEGER,
      fastest_diff    TEXT,
      PRIMARY KEY (user_id, hero_id)
    );
    -- Per-day arena admissions; day_key is the server-local date, so the
    -- count resets at server midnight simply by keying a fresh row.
    CREATE TABLE IF NOT EXISTS arena_entries (
      user_id INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day_key)
    );
    -- Per-day practice-run Imaginz, same day-key reset story. total is the
    -- Imaginz already paid today, clamped at PRACTICE_DAILY_CAP on award.
    CREATE TABLE IF NOT EXISTS practice_awards (
      user_id INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      total   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day_key)
    );
    -- Migration seed: every account without a wallet starts on the standard
    -- balance. INSERT OR IGNORE never touches a balance already granted.
    -- CAST matters: user_id is TEXT and the runtime lookups bind String(id),
    -- so an integer-bound insert would orphan the row as '1.0'.
    INSERT OR IGNORE INTO wallets (user_id, imaginz)
      SELECT CAST(id AS TEXT), ${STARTING_IMAGINZ} FROM users;
  `);
  // xp landed after wallets shipped, so it is an ALTER, not part of the CREATE
  // above — an existing psyrena.db already has the table and CREATE IF NOT
  // EXISTS would silently skip the new column.
  const cols = db.prepare("PRAGMA table_info(wallets)").all().map((c) => c.name);
  if (!cols.includes("xp")) {
    db.exec("ALTER TABLE wallets ADD COLUMN xp INTEGER NOT NULL DEFAULT 0");
  }
  // Repair rows orphaned by the old numeric bind (stored as '1.0' under the
  // TEXT column's affinity): fold their balances into the canonical '1' row.
  // Runs after the xp ALTER so the merge can carry xp too; idempotent — once
  // no '%.0' rows exist it is a no-op.
  db.exec(`
    INSERT INTO wallets (user_id, imaginz, xp)
      SELECT CAST(CAST(user_id AS INTEGER) AS TEXT), imaginz, xp
      FROM wallets WHERE user_id LIKE '%.0'
      ON CONFLICT(user_id) DO UPDATE SET
        imaginz = imaginz + excluded.imaginz,
        xp = xp + excluded.xp;
    DELETE FROM wallets WHERE user_id LIKE '%.0';
  `);
  // last_at landed after arena_entries shipped — same guarded-ALTER story as
  // wallets.xp. Stamps the moment of the latest admission, so a re-entry
  // inside ARENA_REENTRY_GRACE_MS (a reload rejoining its fight) is free.
  const entryCols = db.prepare("PRAGMA table_info(arena_entries)").all().map((c) => c.name);
  if (!entryCols.includes("last_at")) {
    db.exec("ALTER TABLE arena_entries ADD COLUMN last_at INTEGER");
  }
  // Pet shards (docs/09 §4 pity floor) ride the wallet row — same guarded
  // ALTER story as wallets.xp: the table predates the column.
  if (!cols.includes("shards")) {
    db.exec("ALTER TABLE wallets ADD COLUMN shards INTEGER NOT NULL DEFAULT 0");
  }
}

// ---------------------------------------------------------------------------
// Account progression — XP and level
//
// One curve, evaluated server-side, so the HUD only ever renders numbers it was
// handed. The step grows with level (150 · L^1.25) so early levels land inside
// a session or two and later ones are a run of fights; MAX_LEVEL clamps the bar
// to full rather than letting it read as an infinite grind.
// ---------------------------------------------------------------------------

export const MAX_LEVEL = 60;

/** XP required to go from `level` to `level + 1`. */
export function xpForLevel(level) {
  return Math.round(150 * Math.pow(level, 1.25));
}

/**
 * Resolve a raw XP total into { level, xp, xpInto, xpNeeded } — everything the
 * HUD needs for "Lv 7" plus a fill fraction, with no curve maths on the client.
 */
export function progressionFor(totalXp) {
  const xp = Math.max(0, Math.round(Number(totalXp) || 0));
  let level = 1;
  let rest = xp;
  while (level < MAX_LEVEL) {
    const need = xpForLevel(level);
    if (rest < need) break;
    rest -= need;
    level += 1;
  }
  // At the cap the bar reads full instead of empty: xpInto === xpNeeded.
  const xpNeeded = level >= MAX_LEVEL ? xpForLevel(MAX_LEVEL) : xpForLevel(level);
  const xpInto = level >= MAX_LEVEL ? xpNeeded : rest;
  return { level, xp, xpInto, xpNeeded };
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export function balanceFor(userId) {
  const row = db.prepare("SELECT imaginz FROM wallets WHERE user_id = ?").get(String(userId));
  return row ? Number(row.imaginz) : 0;
}

export function creditImaginz(userId, amount) {
  db.prepare(
    `INSERT INTO wallets (user_id, imaginz) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET imaginz = imaginz + excluded.imaginz`
  ).run(String(userId), Math.round(amount));
  return balanceFor(userId);
}

export function shardsFor(userId) {
  const row = db.prepare("SELECT shards FROM wallets WHERE user_id = ?").get(String(userId));
  return row ? Number(row.shards) : 0;
}

export function creditShards(userId, amount) {
  db.prepare(
    `INSERT INTO wallets (user_id, imaginz, shards) VALUES (?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET shards = shards + excluded.shards`
  ).run(String(userId), Math.round(amount));
  return shardsFor(userId);
}

/** Raw lifetime XP. Rides the wallet row: same owner, same lifetime. */
export function xpFor(userId) {
  const row = db.prepare("SELECT xp FROM wallets WHERE user_id = ?").get(String(userId));
  return row ? Number(row.xp) : 0;
}

/** Grant XP and return the resolved progression snapshot. */
export function creditXp(userId, amount) {
  db.prepare(
    `INSERT INTO wallets (user_id, imaginz, xp) VALUES (?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp`
  ).run(String(userId), Math.max(0, Math.round(amount)));
  return progressionFor(xpFor(userId));
}

// ---------------------------------------------------------------------------
// Seasons — lazy rollover: the current season is resolved on read, and a new
// one is minted the first time anyone reads past the previous one's end.
// ---------------------------------------------------------------------------

export function currentSeason() {
  const now = Date.now();
  const marker = db.prepare("SELECT value FROM meta WHERE key = 'current_season'").get();
  if (!marker) {
    const info = db
      .prepare("INSERT INTO seasons (name, starts_at, ends_at) VALUES (?, ?, ?)")
      .run(FIRST_SEASON_NAME, now, now + SEASON_MS);
    db.prepare("INSERT INTO meta (key, value) VALUES ('current_season', ?)")
      .run(String(info.lastInsertRowid));
    return db.prepare("SELECT * FROM seasons WHERE id = ?").get(Number(info.lastInsertRowid));
  }
  let season = db.prepare("SELECT * FROM seasons WHERE id = ?").get(Number(marker.value));
  // Loop (not if) so a server that slept through several seasons still lands
  // on a live one. The poetic suffix is a Season 1 one-off.
  while (now > Number(season.ends_at)) {
    const info = db
      .prepare("INSERT INTO seasons (name, starts_at, ends_at) VALUES (?, ?, ?)")
      .run(`Season ${Number(season.id) + 1}`, Number(season.ends_at), Number(season.ends_at) + SEASON_MS);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'current_season'")
      .run(String(info.lastInsertRowid));
    season = db.prepare("SELECT * FROM seasons WHERE id = ?").get(Number(info.lastInsertRowid));
  }
  return season;
}

// ---------------------------------------------------------------------------
// Loot boxes
// ---------------------------------------------------------------------------

function createLootBox(userId, tier, source) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO loot_boxes (id, user_id, tier, source, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, String(userId), tier, source, Date.now());
  return { id, tier, name: LOOT_TIERS[tier].name };
}

function handleLootOpen(res, userId, payload) {
  const { send } = helpers;
  const box = typeof payload.id === "string"
    ? db.prepare("SELECT * FROM loot_boxes WHERE id = ?").get(payload.id)
    : null;
  if (!box || box.user_id !== String(userId)) return send(res, 404, { error: "No such loot box." });
  if (box.opened) return send(res, 409, { error: "Already opened." });
  const tier = Number(box.tier);
  const t = LOOT_TIERS[tier];
  const roll = t.min + Math.floor(Math.random() * (t.max - t.min + 1));
  db.prepare("UPDATE loot_boxes SET opened = 1 WHERE id = ?").run(box.id);
  const balance = creditImaginz(userId, roll);

  // Pets ride the box (docs/09 §4): a shard grant every open, plus a whole-pet
  // roll among the UNOWNED pool — duplicates cannot happen. With the pool
  // cleared the drop slot pays shards ×3 instead, so no roll is ever dead.
  let shardsGained = PET_LOOT.shardsByBoxTier[tier] ?? 0;
  let pet = null;
  const unowned = PET_BOX_POOL.filter(
    (id) =>
      !db.prepare("SELECT 1 FROM pets WHERE user_id = ? AND pet_id = ?").get(String(userId), id)
  );
  const dropRate = PET_LOOT.dropRateByBoxTier[tier] ?? 0;
  if (dropRate > 0 && Math.random() < dropRate) {
    if (unowned.length > 0) {
      pet = unowned[Math.floor(Math.random() * unowned.length)];
      db.prepare(
        "INSERT INTO pets (user_id, pet_id, level, obtained_at) VALUES (?, ?, 0, ?)"
      ).run(String(userId), pet, Date.now());
    } else {
      shardsGained *= PET_LOOT.allOwnedShardMult;
    }
  }
  const shards = creditShards(userId, shardsGained);
  logEvent("loot.open", userId, { tier, imaginz: roll, shards: shardsGained, pet });
  return send(res, 200, {
    id: box.id,
    tier,
    imaginz: roll,
    balance,
    shardsGained,
    shards,
    // The 2% moment — null on every ordinary open.
    pet,
  });
}

// ---------------------------------------------------------------------------
// Gear
// ---------------------------------------------------------------------------

function gearFor(userId) {
  const rows = db.prepare("SELECT slot, tier FROM gear_pieces WHERE user_id = ?").all(String(userId));
  const gear = Object.fromEntries(GEAR_SLOTS.map((s) => [s, 0]));
  for (const r of rows) if (r.slot in gear) gear[r.slot] = Number(r.tier);
  return gear;
}

function handleGearUpgrade(res, userId, payload) {
  const { send } = helpers;
  const slot = payload.slot;
  if (!GEAR_SLOTS.includes(slot)) return send(res, 400, { error: "Unknown gear slot." });
  // A missing row means tier 0 — rows are only written on upgrade.
  const row = db
    .prepare("SELECT tier FROM gear_pieces WHERE user_id = ? AND slot = ?")
    .get(String(userId), slot);
  const tier = row ? Number(row.tier) : 0;
  if (tier >= GEAR_TIERS.length - 1) return send(res, 400, { error: "Already at the highest tier." });
  const cost = GEAR_TIERS[tier].upgradeCost;
  const balance = balanceFor(userId);
  if (balance < cost) {
    return send(res, 402, { error: "Not enough Imaginz.", needed: cost, balance });
  }
  db.prepare("UPDATE wallets SET imaginz = imaginz - ? WHERE user_id = ?").run(cost, String(userId));
  db.prepare(
    `INSERT INTO gear_pieces (user_id, slot, tier) VALUES (?, ?, 1)
     ON CONFLICT(user_id, slot) DO UPDATE SET tier = tier + 1`
  ).run(String(userId), slot);
  logEvent("gear.upgrade", userId, { slot, tier: tier + 1, cost });
  return send(res, 200, { slot, tier: tier + 1, imaginz: balance - cost });
}

// ---------------------------------------------------------------------------
// Pets — ownership, upgrades, shard adoption (docs/09 §3–4)
// ---------------------------------------------------------------------------

/** Owned pets as { petId: level }. Exclusives are implicit — no rows here. */
function petsFor(userId) {
  const rows = db.prepare("SELECT pet_id, level FROM pets WHERE user_id = ?").all(String(userId));
  return Object.fromEntries(rows.map((r) => [r.pet_id, Number(r.level)]));
}

function handlePetUpgrade(res, userId, payload) {
  const { send } = helpers;
  const petId = payload.petId;
  const known = PET_BOX_POOL.includes(petId) || PET_EXCLUSIVE.includes(petId);
  if (!known) return send(res, 400, { error: "Unknown pet." });
  let row = db
    .prepare("SELECT level FROM pets WHERE user_id = ? AND pet_id = ?")
    .get(String(userId), petId);
  // Hero-exclusive pets are implicitly owned (level 0) until achievements
  // take over the grant — their first upgrade mints the row.
  if (!row && !PET_EXCLUSIVE.includes(petId)) {
    return send(res, 404, { error: "You do not own this pet." });
  }
  const level = row ? Number(row.level) : 0;
  if (level >= PET_MAX_LEVEL) return send(res, 400, { error: "Already at the highest level." });
  const cost = PET_UPGRADE_COST[level];
  const balance = balanceFor(userId);
  if (balance < cost) {
    return send(res, 402, { error: "Not enough Imaginz.", needed: cost, balance });
  }
  db.prepare("UPDATE wallets SET imaginz = imaginz - ? WHERE user_id = ?").run(cost, String(userId));
  db.prepare(
    `INSERT INTO pets (user_id, pet_id, level, obtained_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, pet_id) DO UPDATE SET level = level + 1`
  ).run(String(userId), petId, Date.now());
  logEvent("pet.upgrade", userId, { petId, level: level + 1, cost });
  return send(res, 200, { petId, level: level + 1, imaginz: balance - cost });
}

function handlePetAdopt(res, userId, payload) {
  const { send } = helpers;
  const petId = payload.petId;
  if (!PET_BOX_POOL.includes(petId)) return send(res, 400, { error: "This pet cannot be adopted." });
  const owned = db
    .prepare("SELECT 1 FROM pets WHERE user_id = ? AND pet_id = ?")
    .get(String(userId), petId);
  if (owned) return send(res, 409, { error: "Already owned." });
  const shards = shardsFor(userId);
  if (shards < PET_LOOT.adoptCost) {
    return send(res, 402, { error: "Not enough shards.", needed: PET_LOOT.adoptCost, shards });
  }
  db.prepare("UPDATE wallets SET shards = shards - ? WHERE user_id = ?").run(
    PET_LOOT.adoptCost,
    String(userId)
  );
  db.prepare("INSERT INTO pets (user_id, pet_id, level, obtained_at) VALUES (?, ?, 0, ?)").run(
    String(userId),
    petId,
    Date.now()
  );
  logEvent("pet.adopt", userId, { petId, shards: PET_LOOT.adoptCost });
  return send(res, 200, { petId, level: 0, shards: shards - PET_LOOT.adoptCost });
}

/**
 * Endgame sink: shards → Imaginz at PET_LOOT.shardToImaginz per shard, only
 * once the whole box pool is owned — before that, shards are pet progress
 * and converting them would be a trap.
 */
function handleShardConvert(res, userId) {
  const { send } = helpers;
  const ownedCount = PET_BOX_POOL.filter((id) =>
    db.prepare("SELECT 1 FROM pets WHERE user_id = ? AND pet_id = ?").get(String(userId), id)
  ).length;
  if (ownedCount < PET_BOX_POOL.length) {
    return send(res, 409, { error: "Shards convert only after every pet is adopted." });
  }
  const shards = shardsFor(userId);
  if (shards <= 0) return send(res, 400, { error: "No shards to convert." });
  db.prepare("UPDATE wallets SET shards = 0 WHERE user_id = ?").run(String(userId));
  const balance = creditImaginz(userId, shards * PET_LOOT.shardToImaginz);
  return send(res, 200, { converted: shards, imaginz: shards * PET_LOOT.shardToImaginz, balance, shards: 0 });
}

// ---------------------------------------------------------------------------
// Fight results → score, season rating, Imaginz, one loot box
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

// Sanity bounds for the one remaining CLIENT-asserted ranked path (the
// offline fallback — see the trust-boundary note in handleFightResult).
// Sized from the sim's own numbers: solo boss HP ≈30k
// (shared/bosses/nightmare.ts hpByTeamSize), so even a perfect burst kill
// cannot sustain 5k DPS, and no kit heals faster than it damages. The floor on
// duration is what stops a 1 ms report turning a trickle of healing into an
// infinite per-second rate.
const RANKED_MIN_DURATION_MS = 15_000;
const RANKED_DPS_CEIL = 5_000;
const RANKED_HPS_CEIL = 5_000;

/**
 * Users whose latest attempt the SERVER has already paid out.
 *
 * server/fight.mjs stamps this the moment it settles a fight from its own
 * numbers; `handleArenaEnter` clears it, because taking an admission is what
 * "a new attempt" means. In between, a `POST /api/fight/result` naming that
 * fight is a replay — honest clients skip the report entirely (the receipt
 * came down the SSE stream), so anything arriving here is either a stale tab
 * or a forgery, and both must be refused rather than paid twice.
 */
const serverSettled = new Set();

/** Called by server/fight.mjs at the end of a fight it ran and paid. */
export function noteServerSettled(userId) {
  serverSettled.add(Number(userId));
}

/**
 * Pay one player for one ranked attempt.
 *
 * The whole payout — score, rating, wallet, XP, loot, records — with no
 * validation, because the caller is the authority: server/fight.mjs hands it
 * the numbers its own sim produced, and the HTTP fallback door below
 * sanitizes before it gets here. Returns the response body that door replies
 * with, which is also what the server pushes to the party as `fightResult`.
 */
export function settleFight(userId, { win, difficulty, durationMs, dps, healing, damageTaken }) {
  const { tx } = helpers;
  const durSec = Math.max(0.001, Number(durationMs) / 1000);
  const hps = Math.max(0, Number(healing) || 0) / durSec;
  const dtps = Math.max(0, Number(damageTaken) || 0) / durSec;
  const safeDps = Math.max(0, Number(dps) || 0);
  const base = Math.max(0, safeDps * 2 + hps * 1.5 - dtps * 0.5);
  const score = Math.round(base * DIFF_MULT[difficulty] * (win ? 1.2 : 0.4) * 10);
  const clearMs = Math.round(durationMs);

  // Which hero fought: the account's selected hero, read from the same row
  // POST /api/select-hero validates and writes — the client never says.
  const heroId = String(
    db.prepare("SELECT selected_hero FROM game_state WHERE user_id = ?").get(userId)
      ?.selected_hero ?? "freud"
  );

  // ---- Personal best -------------------------------------------------------
  // Read BEFORE the record UPSERTs below, which are about to overwrite exactly
  // these columns — compared after the write, every win either always or never
  // beats itself, and nothing outside would show which.
  //
  // The three compared are the three the writes below treat as records, one
  // for one: account-lifetime best DPS and fastest clear (`user_records`), and
  // best score for the hero you actually played (`hero_records`). Season
  // `best_score` is deliberately not in the set — it resets every twelve weeks,
  // and a "personal best" that resurrects itself on a calendar is not one.
  //
  // A first-ever win always lands here: with no row to beat, every number is a
  // best. That is meant — this is a teaching game, and the first clear is the
  // one most worth paying for.
  const prevAccount = win
    ? db.prepare("SELECT fastest_ms, best_dps FROM user_records WHERE user_id = ?").get(String(userId))
    : null;
  const prevHero = win
    ? db.prepare("SELECT best_score FROM hero_records WHERE user_id = ? AND hero_id = ?")
        .get(String(userId), heroId)
    : null;
  const personalBests = [];
  if (win) {
    if (score > Number(prevHero?.best_score ?? 0)) personalBests.push("score");
    if (safeDps > Number(prevAccount?.best_dps ?? 0)) personalBests.push("dps");
    if (prevAccount?.fastest_ms == null || clearMs < Number(prevAccount.fastest_ms)) {
      personalBests.push("time");
    }
  }

  const baseAward = win ? FIGHT_AWARD[difficulty] : 10;
  // Imaginz only, on purpose: XP, loot tier and season rating stay exactly what
  // the attempt earned, so beating yourself pays a bonus without inflating the
  // ladder everyone else is measured on.
  const award = personalBests.length > 0 ? Math.round(baseAward * 1.2) : baseAward;
  const xpAwarded = win ? FIGHT_XP[difficulty] : FIGHT_XP_LOSS;
  const tier = win ? FIGHT_LOOT_TIER[difficulty] : 0;
  const season = currentSeason();

  // Six tables move on one payout. One transaction, so a mid-payout throw
  // can never leave Imaginz credited with the season score (or the spent
  // admission) unwritten. Everything inside is synchronous — an await here
  // would hold the transaction open across other requests.
  let progression, lootBox, heroUnlocked = null;
  tx(() => {
  creditImaginz(userId, award);
  progression = creditXp(userId, xpAwarded);
  lootBox = createLootBox(userId, tier, `fight:${difficulty}:${win ? "win" : "loss"}`);

  db.prepare(
    `INSERT INTO season_scores (user_id, season_id, rating, battles, wins, best_score)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(user_id, season_id) DO UPDATE SET
       rating = rating + excluded.rating,
       battles = battles + 1,
       wins = wins + excluded.wins,
       best_score = MAX(best_score, excluded.best_score)`
  ).run(String(userId), Number(season.id), score, win ? 1 : 0, score);
  db.prepare(
    `UPDATE game_state SET battles = battles + 1, wins = wins + ?,
       bosses_defeated = bosses_defeated + ? WHERE user_id = ?`
  ).run(win ? 1 : 0, win ? 1 : 0, userId);

  // Docs 05 hero access: Skinner is granted free on the FIRST boss clear —
  // classical then operant, in course order, and the starter tank finally
  // gets his healer. Purely additive; the sweep in app.mjs never removes it.
  if (win) {
    const gsRow = db
      .prepare("SELECT unlocked_heroes FROM game_state WHERE user_id = ?")
      .get(userId);
    let unlocked;
    try {
      unlocked = JSON.parse(gsRow?.unlocked_heroes ?? "[]");
    } catch {
      unlocked = [];
    }
    if (Array.isArray(unlocked) && !unlocked.includes("skinner")) {
      unlocked.push("skinner");
      db.prepare("UPDATE game_state SET unlocked_heroes = ? WHERE user_id = ?").run(
        JSON.stringify(unlocked),
        userId
      );
      heroUnlocked = "skinner";
    }
  }

  // Lifetime records: best DPS moves on every fight; fastest clears and
  // nightmare counters only move on (nightmare) wins.
  const nightmareWin = win && difficulty === "nightmare";
  db.prepare(
    `INSERT INTO user_records (user_id, fastest_ms, fastest_diff, nightmare_fastest_ms, nightmare_wins, best_dps)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       best_dps = MAX(best_dps, excluded.best_dps),
       fastest_ms = CASE WHEN excluded.fastest_ms IS NOT NULL
           AND (fastest_ms IS NULL OR excluded.fastest_ms < fastest_ms)
         THEN excluded.fastest_ms ELSE fastest_ms END,
       fastest_diff = CASE WHEN excluded.fastest_ms IS NOT NULL
           AND (fastest_ms IS NULL OR excluded.fastest_ms < fastest_ms)
         THEN excluded.fastest_diff ELSE fastest_diff END,
       nightmare_fastest_ms = CASE WHEN excluded.nightmare_fastest_ms IS NOT NULL
           AND (nightmare_fastest_ms IS NULL OR excluded.nightmare_fastest_ms < nightmare_fastest_ms)
         THEN excluded.nightmare_fastest_ms ELSE nightmare_fastest_ms END,
       nightmare_wins = nightmare_wins + excluded.nightmare_wins`
  ).run(
    String(userId),
    win ? clearMs : null,
    win ? difficulty : null,
    nightmareWin ? clearMs : null,
    nightmareWin ? 1 : 0,
    safeDps
  );

  db.prepare(
    `INSERT INTO hero_records (user_id, hero_id, battles, wins, bosses_defeated, best_score, best_dps, fastest_ms, fastest_diff)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, hero_id) DO UPDATE SET
       battles = battles + 1,
       wins = wins + excluded.wins,
       bosses_defeated = bosses_defeated + excluded.bosses_defeated,
       best_score = MAX(best_score, excluded.best_score),
       best_dps = MAX(best_dps, excluded.best_dps),
       fastest_ms = CASE WHEN excluded.fastest_ms IS NOT NULL
           AND (fastest_ms IS NULL OR excluded.fastest_ms < fastest_ms)
         THEN excluded.fastest_ms ELSE fastest_ms END,
       fastest_diff = CASE WHEN excluded.fastest_ms IS NOT NULL
           AND (fastest_ms IS NULL OR excluded.fastest_ms < fastest_ms)
         THEN excluded.fastest_diff ELSE fastest_diff END`
  ).run(
    String(userId),
    heroId,
    win ? 1 : 0,
    win ? 1 : 0,
    score,
    safeDps,
    win ? clearMs : null,
    win ? difficulty : null
  );

  // The attempt is paid — its admission is spent. Without this, any next entry
  // inside the re-entry grace would ride the finished attempt's hold for free
  // (defeat → village → straight back in). Both day keys, because a fight that
  // crossed the server's midnight was admitted under yesterday's.
  db.prepare(
    `UPDATE arena_entries SET last_at = NULL
     WHERE user_id = ? AND last_at IS NOT NULL AND day_key IN (?, ?)`
  ).run(String(userId), arenaDayKey(), arenaDayKey(new Date(Date.now() - 86_400_000)));
  });

  const rating = Number(
    db.prepare("SELECT rating FROM season_scores WHERE user_id = ? AND season_id = ?")
      .get(String(userId), Number(season.id)).rating
  );
  logEvent("fight.result", userId, {
    win, difficulty, score, durationMs: clearMs, dps: Math.round(safeDps),
    personalBests: personalBests.join(",") || undefined,
  });
  return {
    score,
    rating,
    seasonId: Number(season.id),
    imaginzAwarded: award,
    balance: balanceFor(userId),
    xpAwarded,
    ...progression,
    lootBox,
    // First clear: the account just earned its healer ("skinner"). Absent on
    // every later report — clients may toast it or ignore it.
    ...(heroUnlocked ? { heroUnlocked } : {}),
    // Absent unless the run beat something — the overlay tests for the field
    // rather than for a zero bonus.
    ...(personalBests.length > 0
      ? { personalBest: { kinds: personalBests, bonus: award - baseAward } }
      : {}),
  };
}

async function handleFightResult(res, userId, payload) {
  const { send } = helpers;
  const win = !!payload.win;
  const difficulty = payload.difficulty;
  if (!DIFFICULTIES.includes(difficulty)) {
    return send(res, 400, { error: "difficulty must be standard | hard | nightmare." });
  }

  // Practice run (bot teammates): a fixed token award capped per day, and
  // NOTHING else moves — no season rating, no records, no loot, no XP, no
  // achievement counters, no arena-entry spend. The response keeps the ranked
  // report's shape (score/rating/progression) so the loot overlay renders,
  // with a practice receipt riding alongside.
  if (payload.practice === true) {
    const day = arenaDayKey();
    const row = db
      .prepare("SELECT total FROM practice_awards WHERE user_id = ? AND day_key = ?")
      .get(String(userId), day);
    const today = Number(row?.total ?? 0);
    const award = Math.max(0, Math.min(PRACTICE_AWARD, PRACTICE_DAILY_CAP - today));
    if (award > 0) {
      creditImaginz(userId, award);
      db.prepare(
        `INSERT INTO practice_awards (user_id, day_key, total) VALUES (?, ?, ?)
         ON CONFLICT(user_id, day_key) DO UPDATE SET total = total + excluded.total`
      ).run(String(userId), day, award);
    }
    const season = currentSeason();
    const ratingRow = db
      .prepare("SELECT rating FROM season_scores WHERE user_id = ? AND season_id = ?")
      .get(String(userId), Number(season.id));
    logEvent("fight.practice", userId, { win, difficulty, awarded: award });
    return send(res, 200, {
      score: 0,
      rating: Number(ratingRow?.rating ?? 0),
      seasonId: Number(season.id),
      imaginzAwarded: award,
      balance: balanceFor(userId),
      xpAwarded: 0,
      ...creditXp(userId, 0), // current level/xp, unchanged
      practice: { awarded: award, today: today + award, cap: PRACTICE_DAILY_CAP },
    });
  }

  // ---- Trust boundary.
  //
  // The ranked fight the game actually plays does NOT come through here any
  // more. server/fight.mjs runs the sim, holds every number this payout is
  // computed from, and calls `settleFight` itself the moment the boss (or the
  // party) drops — so the honest client's job at fight end is to render the
  // receipt it was pushed, not to report one.
  //
  // What is left is a narrow door, kept open for the two callers that have no
  // server session to be settled from:
  //   * PRACTICE runs, handled above — bots in one tab, no server fight.
  //   * the OFFLINE FALLBACK: a player whose `begin` failed (or whose state
  //     stream never delivered) played the local sim and still deserves the
  //     attempt they played (src/fight/fightDriver.ts `goLocal`).
  //
  // So this door stays client-asserted, and two things bound it. A report must
  // spend an OPEN arena admission — three free a day, then Imaginz — which
  // caps how often a forger can knock, in the currency a player actually pays;
  // and the sanitizing clamps below cap what one knock can be worth. What IS
  // gone is the old per-user report cooldown: it existed to make forging no
  // faster than playing, and it was measuring a rate that the admission spend
  // already limits far more tightly.
  const settledByServer = serverSettled.has(Number(userId));
  const today = arenaDayKey();
  {
    const openHold = (key) =>
      db.prepare("SELECT last_at FROM arena_entries WHERE user_id = ? AND day_key = ?")
        .get(String(userId), key)?.last_at != null;
    // Yesterday's key too, for the fight that crossed the server's midnight.
    const open = openHold(today) || openHold(arenaDayKey(new Date(Date.now() - 86_400_000)));
    // A settled fight has already spent its admission, so "no open hold" is
    // the shape a replay arrives in — name that case instead of sending the
    // player back to a turnstile they already walked through.
    if (settledByServer || !open) {
      return send(res, 409, {
        error: settledByServer
          ? "That fight was already settled and paid by the server."
          : "No open arena admission — enter the arena first.",
      });
    }
  }
  const rawDuration = Number(payload.durationMs);
  if (!Number.isFinite(rawDuration) || rawDuration < RANKED_MIN_DURATION_MS) {
    return send(res, 400, { error: "Fight too short to score." });
  }
  const durationMs = clamp(payload.durationMs, RANKED_MIN_DURATION_MS, 3_600_000);
  const durSecCap = durationMs / 1000;
  return send(res, 200, settleFight(userId, {
    win,
    difficulty,
    durationMs,
    dps: clamp(payload.dps, 0, RANKED_DPS_CEIL),
    healing: clamp(payload.healing, 0, RANKED_HPS_CEIL * durSecCap),
    damageTaken: clamp(payload.damageTaken, 0, RANKED_HPS_CEIL * durSecCap),
  }));
}

// ---------------------------------------------------------------------------
// Arena admission — 3 free entries a day, then Imaginz per entry
// ---------------------------------------------------------------------------

/** Server-local date, so the free entries reset at the server's midnight. */
function arenaDayKey(now = new Date()) {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

function arenaEntriesUsed(userId) {
  const row = db
    .prepare("SELECT count FROM arena_entries WHERE user_id = ? AND day_key = ?")
    .get(String(userId), arenaDayKey());
  return row ? Number(row.count) : 0;
}

/** Everything the client needs to render the gate before asking to enter. */
function arenaStatusFor(userId) {
  const used = arenaEntriesUsed(userId);
  const practiceRow = db
    .prepare("SELECT total FROM practice_awards WHERE user_id = ? AND day_key = ?")
    .get(String(userId), arenaDayKey());
  return {
    used,
    freePerDay: ARENA_FREE_ENTRIES_PER_DAY,
    freeLeft: Math.max(0, ARENA_FREE_ENTRIES_PER_DAY - used),
    extraCost: ARENA_EXTRA_ENTRY_COST,
    balance: balanceFor(userId),
    // Practice-run budget: what today's bot runs already paid, and the cap.
    practiceAward: PRACTICE_AWARD,
    practiceToday: Number(practiceRow?.total ?? 0),
    practiceCap: PRACTICE_DAILY_CAP,
  };
}

function handleArenaStatus(res, userId) {
  return helpers.send(res, 200, arenaStatusFor(userId));
}

/**
 * An admission HOLDS for this long: re-entering inside the window is free and
 * uncounted. Mirrors the presence grace (app.mjs OFFLINE_GRACE_MS, same env
 * override) on purpose — a player who dropped mid-fight keeps their seats for
 * 2 minutes, and their paid admission must survive the same reload, or the
 * reconnect the grace promises costs them an entry.
 */
const ARENA_REENTRY_GRACE_MS = Number(process.env.PSYRENA_OFFLINE_GRACE_MS) || 120_000;

/**
 * Restart the re-entry clock at the moment the player dropped. Called from
 * the presence-offline beacon (app.mjs): a fight that ran longer than the
 * grace would otherwise have an expired hold by the time the tab died, and
 * the promised 2-minute reconnect would charge a fresh admission. Only an
 * OPEN hold refreshes — after a reported result `last_at` is NULL and a
 * village pagehide must not resurrect it.
 */
export function touchArenaHold(userId) {
  db.prepare(
    "UPDATE arena_entries SET last_at = ? WHERE user_id = ? AND day_key = ? AND last_at IS NOT NULL"
  ).run(Date.now(), String(userId), arenaDayKey());
}

/**
 * Take one admission. Free while the daily allowance lasts; past it the entry
 * costs Imaginz, refused with 402 when the wallet cannot cover it. The client
 * calls this BEFORE switching scenes and stays in the village on a refusal.
 * A repeat call within ARENA_REENTRY_GRACE_MS is the SAME admission — a
 * reload or network drop rejoining its fight — and charges nothing.
 */
function handleArenaEnter(res, userId) {
  const { send, deserterLockFor } = helpers;
  // Desertion lock (server/fight.mjs): whoever walked out of a live fight owes
  // the clock before they are admitted to another. Practice runs never reach
  // this handler — they are free and they are how you learn the fight, so the
  // penalty for abandoning a real one has no business closing that door.
  const lock = deserterLockFor?.(userId);
  if (lock) return send(res, 403, { error: lock.message });
  // Taking an admission IS the start of a new attempt, so whatever the server
  // settled last time stops being the current fight (see `serverSettled`).
  serverSettled.delete(Number(userId));
  const key = arenaDayKey();
  const last = db
    .prepare("SELECT last_at FROM arena_entries WHERE user_id = ? AND day_key = ?")
    .get(String(userId), key);
  const now = Date.now();
  if (last?.last_at != null && now - Number(last.last_at) < ARENA_REENTRY_GRACE_MS) {
    db.prepare("UPDATE arena_entries SET last_at = ? WHERE user_id = ? AND day_key = ?")
      .run(now, String(userId), key);
    return send(res, 200, { ok: true, cost: 0, rejoin: true, ...arenaStatusFor(userId) });
  }
  const used = arenaEntriesUsed(userId);
  let cost = 0;
  if (used >= ARENA_FREE_ENTRIES_PER_DAY) {
    cost = ARENA_EXTRA_ENTRY_COST;
    const balance = balanceFor(userId);
    if (balance < cost) {
      return send(res, 402, {
        error: "No free entries left today and not enough Imaginz.",
        needed: cost,
        ...arenaStatusFor(userId),
      });
    }
    db.prepare("UPDATE wallets SET imaginz = imaginz - ? WHERE user_id = ?").run(cost, String(userId));
  }
  db.prepare(
    `INSERT INTO arena_entries (user_id, day_key, count, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, day_key) DO UPDATE SET count = count + 1, last_at = excluded.last_at`
  ).run(String(userId), key, now);
  logEvent("arena.enter", userId, { cost });
  return send(res, 200, { ok: true, cost, ...arenaStatusFor(userId) });
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

function handleRankings(res, userId) {
  const { send } = helpers;
  const season = currentSeason();
  const sid = Number(season.id);
  // season_scores.user_id is TEXT by spec; CAST keeps the users join honest.
  const top = db
    .prepare(
      `SELECT u.username, s.rating, s.battles, s.wins, s.best_score
       FROM season_scores s JOIN users u ON u.id = CAST(s.user_id AS INTEGER)
       WHERE s.season_id = ? ORDER BY s.rating DESC, s.user_id LIMIT 50`
    )
    .all(sid)
    .map((r) => ({
      username: r.username,
      rating: Number(r.rating),
      battles: Number(r.battles),
      wins: Number(r.wins),
      bestScore: Number(r.best_score),
    }));

  const mine = db
    .prepare("SELECT * FROM season_scores WHERE user_id = ? AND season_id = ?")
    .get(String(userId), sid);
  const myRating = mine ? Number(mine.rating) : 0;
  const rank = Number(
    db.prepare("SELECT COUNT(*) AS n FROM season_scores WHERE season_id = ? AND rating > ?")
      .get(sid, myRating).n
  ) + 1;

  return send(res, 200, {
    season: { id: sid, name: season.name, endsAt: Number(season.ends_at) },
    top,
    me: {
      rating: myRating,
      rank,
      battles: mine ? Number(mine.battles) : 0,
      wins: mine ? Number(mine.wins) : 0,
      bestScore: mine ? Number(mine.best_score) : 0,
    },
  });
}

// One-shot economy snapshot for the portal: balance, gear tiers, unopened boxes.
function handleEconomyState(res, userId) {
  const { send } = helpers;
  const lootBoxes = db
    .prepare("SELECT id, tier, source, created_at FROM loot_boxes WHERE user_id = ? AND opened = 0 ORDER BY created_at")
    .all(String(userId))
    .map((b) => ({
      id: b.id,
      tier: Number(b.tier),
      name: LOOT_TIERS[Number(b.tier)].name,
      source: b.source,
      createdAt: Number(b.created_at),
    }));
  return send(res, 200, {
    imaginz: balanceFor(userId),
    gear: gearFor(userId),
    pets: petsFor(userId),
    shards: shardsFor(userId),
    lootBoxes,
    ...progressionFor(xpFor(userId)),
  });
}

// ---------------------------------------------------------------------------
// Router — everything under /api/gear|loot|fight|rankings|economy.
// ---------------------------------------------------------------------------

export async function handleEconomy(req, res, url, userId) {
  const { send, readBody } = helpers;
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/economy") return handleEconomyState(res, userId);
  if (route === "POST /api/gear/upgrade") return handleGearUpgrade(res, userId, await readBody(req));
  if (route === "POST /api/pet/upgrade") return handlePetUpgrade(res, userId, await readBody(req));
  if (route === "POST /api/pet/adopt") return handlePetAdopt(res, userId, await readBody(req));
  if (route === "POST /api/pet/shards/convert") return handleShardConvert(res, userId);
  if (route === "POST /api/loot/open") return handleLootOpen(res, userId, await readBody(req));
  if (route === "POST /api/fight/result") return handleFightResult(res, userId, await readBody(req));
  if (route === "GET /api/rankings") return handleRankings(res, userId);
  if (route === "GET /api/arena/status") return handleArenaStatus(res, userId);
  if (route === "POST /api/arena/enter") return handleArenaEnter(res, userId);
  return send(res, 404, { error: "No such endpoint." });
}
