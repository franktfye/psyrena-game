/**
 * Psyrena achievements / titles / leaderboards layer — same db, same
 * zero-dependency stance as economy.mjs.
 *
 * Achievements are evaluated lazily: there is no event bus, syncAchievements()
 * recomputes the raw stats from the tables economy/social/app already own and
 * inserts rows for anything newly met. The client polls GET /api/achievements
 * and learns about unlocks via the isNew flag, which is true exactly once —
 * the fetch that surfaces a new unlock also marks it seen.
 */
import { progressionFor, currentSeason, GEAR_SLOTS } from "./economy.mjs";

// Static catalogue. stat keys map onto computeStats() below; cmp "lte" stats
// (rank, clear times) are null until the player has a qualifying row, and null
// never satisfies an lte check.
const ACHIEVEMENTS = [
  // collection
  // Accounts start with freud/pavlov/skinner unlocked (app.mjs game_state
  // default), so "split" means a FOURTH mind — the first one earned, not given.
  { id: "col_heroes_2",    category: "collection", name: "Split Personality",   desc: "Unlock 1 hero beyond the starting three.", stat: "heroesUnlocked", cmp: "gte", target: 4, title: null },
  { id: "col_heroes_5",    category: "collection", name: "Crowded Psyche",      desc: "Unlock 5 heroes.",                  stat: "heroesUnlocked", cmp: "gte", target: 5,     title: "Collective Unconscious" },
  { id: "col_heroes_all",  category: "collection", name: "Pantheon of Minds",   desc: "Unlock all 14 heroes.",             stat: "heroesUnlocked", cmp: "gte", target: 14,    title: null },
  { id: "col_gear_full",   category: "collection", name: "Fully Armed",         desc: "Own gear in all 6 slots.",          stat: "gearSlotsOwned", cmp: "gte", target: 6,     title: null },
  { id: "col_loot_10",     category: "collection", name: "Box Opener",          desc: "Open 10 loot boxes.",               stat: "lootOpened",     cmp: "gte", target: 10,    title: null },
  { id: "col_loot_50",     category: "collection", name: "Fortune Hunter",      desc: "Open 50 loot boxes.",               stat: "lootOpened",     cmp: "gte", target: 50,    title: "Fortune Hunter" },
  // ranking
  { id: "rank_top100",     category: "ranking",    name: "On the Board",        desc: "Finish a season at rank 100 or better (awarded at season end).",  stat: "seasonRank",     cmp: "lte", target: 100,   title: null },
  { id: "rank_top10",      category: "ranking",    name: "Elite Mind",          desc: "Finish a season at rank 10 or better (awarded at season end).",   stat: "seasonRank",     cmp: "lte", target: 10,    title: "Elite Mind" },
  { id: "rank_rating_1000",category: "ranking",    name: "Rising Analyst",      desc: "Finish a season with 1,000+ rating (awarded at season end).",     stat: "seasonRating",   cmp: "gte", target: 1000,  title: null },
  { id: "rank_rating_5000",category: "ranking",    name: "Grand Analyst",       desc: "Finish a season with 5,000+ rating (awarded at season end).",     stat: "seasonRating",   cmp: "gte", target: 5000,  title: "Grand Analyst" },
  // damage
  { id: "dmg_score_10k",   category: "damage",     name: "Heavy Hitter",        desc: "Score 10,000+ in a single fight.",  stat: "bestScore",      cmp: "gte", target: 10000, title: null },
  { id: "dmg_score_50k",   category: "damage",     name: "Mindbreaker",         desc: "Score 50,000+ in a single fight.",  stat: "bestScore",      cmp: "gte", target: 50000, title: "Mindbreaker" },
  { id: "dmg_score_100k",  category: "damage",     name: "Psychic Overload",    desc: "Score 100,000+ in a single fight.", stat: "bestScore",      cmp: "gte", target: 100000,title: null },
  { id: "dmg_dps_500",     category: "damage",     name: "Sustained Pressure",  desc: "Reach 500 DPS in a fight.",         stat: "bestDps",        cmp: "gte", target: 500,   title: null },
  { id: "dmg_dps_1500",    category: "damage",     name: "Superego",            desc: "Reach 1,500 DPS in a fight.",       stat: "bestDps",        cmp: "gte", target: 1500,  title: "Superego" },
  // levels
  { id: "lvl_5",           category: "levels",     name: "First Steps",         desc: "Reach account level 5.",            stat: "level",          cmp: "gte", target: 5,     title: null },
  { id: "lvl_10",          category: "levels",     name: "Awakening",           desc: "Reach account level 10.",           stat: "level",          cmp: "gte", target: 10,    title: null },
  { id: "lvl_20",          category: "levels",     name: "Seasoned Psyche",     desc: "Reach account level 20.",           stat: "level",          cmp: "gte", target: 20,    title: "Seasoned Psyche" },
  { id: "lvl_40",          category: "levels",     name: "Deep Dive",           desc: "Reach account level 40.",           stat: "level",          cmp: "gte", target: 40,    title: null },
  { id: "lvl_60",          category: "levels",     name: "Enlightened",         desc: "Reach account level 60.",           stat: "level",          cmp: "gte", target: 60,    title: "Enlightened" },
  // boss
  { id: "boss_1",          category: "boss",       name: "Dream Breaker",       desc: "Defeat your first boss.",           stat: "bossesDefeated", cmp: "gte", target: 1,     title: null },
  { id: "boss_10",         category: "boss",       name: "Nightmare Regular",   desc: "Defeat 10 bosses.",                 stat: "bossesDefeated", cmp: "gte", target: 10,    title: null },
  { id: "boss_50",         category: "boss",       name: "Nightmare Tamer",     desc: "Defeat 50 bosses.",                 stat: "bossesDefeated", cmp: "gte", target: 50,    title: "Nightmare Tamer" },
  { id: "boss_nightmare",  category: "boss",       name: "Into the Abyss",      desc: "Win a nightmare-difficulty fight.", stat: "nightmareWins",   cmp: "gte", target: 1,     title: null },
  { id: "boss_speed",      category: "boss",       name: "Speedrunner",         desc: "Clear any boss in under 90 seconds.",stat: "fastestMs",     cmp: "lte", target: 90000, title: null },
  { id: "boss_speed_nm",   category: "boss",       name: "Dreamcrusher",        desc: "Clear nightmare in under 3 minutes.",stat: "nightmareFastestMs", cmp: "lte", target: 180000, title: "Dreamcrusher" },
  // friends
  { id: "fr_1",            category: "friends",    name: "First Contact",       desc: "Add your first friend.",            stat: "friends",        cmp: "gte", target: 1,     title: null },
  { id: "fr_5",            category: "friends",    name: "Social Network",      desc: "Have 5 friends.",                   stat: "friends",        cmp: "gte", target: 5,     title: "Group Therapist" },
  { id: "fr_10",           category: "friends",    name: "Community Mind",      desc: "Have 10 friends.",                  stat: "friends",        cmp: "gte", target: 10,    title: null },
  // gear
  { id: "gear_t2",         category: "gear",       name: "First Refinement",    desc: "Upgrade any gear slot to tier 2.",  stat: "gearMaxTier",    cmp: "gte", target: 2,     title: null },
  { id: "gear_t4",         category: "gear",       name: "Transcendent",        desc: "Upgrade any gear slot to tier 4.",  stat: "gearMaxTier",    cmp: "gte", target: 4,     title: "Transcendent" },
  { id: "gear_all_t2",     category: "gear",       name: "Polished Mind",       desc: "All 6 gear slots at tier 2+.",      stat: "gearAllMinTier", cmp: "gte", target: 2,     title: null },
  { id: "gear_all_t4",     category: "gear",       name: "The Ideal Self",      desc: "All 6 gear slots at tier 4.",       stat: "gearAllMinTier", cmp: "gte", target: 4,     title: "The Ideal Self" },
];

let db = null;
let helpers = null; // { send, readBody } borrowed from app.mjs

export function initAchievements(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id        TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at    INTEGER NOT NULL,
      seen           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, achievement_id)
    );
  `);
  // One-shot retarget sweep: col_heroes_2 used to mean "2 heroes", which the
  // three starter heroes satisfied on account creation, so every account holds
  // the row. Now that it means a FOURTH hero, drop the freebies once; the next
  // syncAchievements() re-inserts for anyone who genuinely qualifies. The meta
  // table exists by now — initEconomy() runs first (server/index.mjs order).
  if (!db.prepare("SELECT value FROM meta WHERE key = 'ach_col_heroes_2_target_4'").get()) {
    db.prepare("DELETE FROM user_achievements WHERE achievement_id = 'col_heroes_2'").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('ach_col_heroes_2_target_4', '1')").run();
  }
}

// ---------------------------------------------------------------------------
// Stats — every achievement input, gathered from tables owned elsewhere.
// ---------------------------------------------------------------------------

function computeStats(userId) {
  const gs = db.prepare("SELECT * FROM game_state WHERE user_id = ?").get(userId);
  const heroesUnlocked = gs ? JSON.parse(gs.unlocked_heroes).length : 0;
  const bossesDefeated = gs ? Number(gs.bosses_defeated) : 0;

  const gearRows = db
    .prepare("SELECT slot, tier FROM gear_pieces WHERE user_id = ?")
    .all(String(userId));
  const tiers = Object.fromEntries(GEAR_SLOTS.map((s) => [s, 0]));
  for (const r of gearRows) if (r.slot in tiers) tiers[r.slot] = Number(r.tier);
  const tierList = GEAR_SLOTS.map((s) => tiers[s]);
  const gearSlotsOwned = tierList.filter((t) => t >= 1).length;
  const gearMaxTier = Math.max(...tierList);
  const gearAllMinTier = Math.min(...tierList); // missing slot reads as tier 0

  const lootOpened = Number(
    db.prepare("SELECT COUNT(*) AS n FROM loot_boxes WHERE user_id = ? AND opened = 1")
      .get(String(userId)).n
  );

  const season = currentSeason();
  const mine = db
    .prepare("SELECT * FROM season_scores WHERE user_id = ? AND season_id = ?")
    .get(String(userId), Number(season.id));
  const bestScore = mine ? Number(mine.best_score) : 0;
  // Rank/rating achievements are settled at season end: they read the player's
  // most recent ENDED season, so while a season is still running both stats
  // are null (never unlockable). Otherwise someone on a ghost server could
  // claim top-rank titles the moment a season starts.
  const ended = db
    .prepare(
      `SELECT ss.season_id, ss.rating FROM season_scores ss
       JOIN seasons s ON s.id = ss.season_id
       WHERE ss.user_id = ? AND s.ends_at < ?
       ORDER BY ss.season_id DESC LIMIT 1`
    )
    .get(String(userId), Date.now());
  // No ended-season row → null, which never satisfies a gte or lte check.
  const seasonRating = ended ? Number(ended.rating) : null;
  const seasonRank = ended
    ? Number(
        db.prepare("SELECT COUNT(*) AS n FROM season_scores WHERE season_id = ? AND rating > ?")
          .get(Number(ended.season_id), seasonRating).n
      ) + 1
    : null;

  const wallet = db.prepare("SELECT xp FROM wallets WHERE user_id = ?").get(String(userId));
  const level = progressionFor(wallet ? Number(wallet.xp) : 0).level;

  const rec = db.prepare("SELECT * FROM user_records WHERE user_id = ?").get(String(userId));
  const nightmareWins = rec ? Number(rec.nightmare_wins) : null;
  const fastestMs = rec && rec.fastest_ms != null ? Number(rec.fastest_ms) : null;
  const nightmareFastestMs = rec && rec.nightmare_fastest_ms != null ? Number(rec.nightmare_fastest_ms) : null;
  const bestDps = rec ? Number(rec.best_dps) : 0;

  // Canonical accepted-friend query, same shape as social.mjs friendIds().
  const friends = Number(
    db.prepare(
      `SELECT COUNT(*) AS n FROM friends
       WHERE status = 'accepted' AND (user_id = ? OR friend_id = ?)`
    ).get(userId, userId).n
  );

  return {
    heroesUnlocked, gearSlotsOwned, lootOpened, seasonRank, seasonRating,
    bestScore, level, bossesDefeated, nightmareWins, fastestMs,
    nightmareFastestMs, bestDps, friends, gearMaxTier, gearAllMinTier,
  };
}

// ---------------------------------------------------------------------------
// Sync — recompute stats, insert newly met achievements, return the full list.
// ---------------------------------------------------------------------------

export function syncAchievements(userId) {
  const stats = computeStats(userId);
  const rows = db
    .prepare("SELECT achievement_id, unlocked_at, seen FROM user_achievements WHERE user_id = ?")
    .all(String(userId));
  const unlocked = new Map(rows.map((r) => [r.achievement_id, r]));
  const insert = db.prepare(
    "INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)"
  );

  return ACHIEVEMENTS.map((def) => {
    const value = stats[def.stat];
    const met = def.cmp === "gte"
      ? (value ?? 0) >= def.target
      : value != null && value <= def.target;
    let row = unlocked.get(def.id);
    if (met && !row) {
      const now = Date.now();
      insert.run(String(userId), def.id, now);
      row = { achievement_id: def.id, unlocked_at: now, seen: 0 };
    }
    return {
      id: def.id,
      category: def.category,
      name: def.name,
      desc: def.desc,
      icon: `/assets/ui/achievements/${def.id}.webp`,
      target: def.target,
      progress: value ?? 0,
      unlocked: !!row,
      unlockedAt: row ? Number(row.unlocked_at) : null,
      isNew: !!row && !Number(row.seen),
      title: def.title,
    };
  });
}

/** Titles the player may equip: titles of unlocked defs, in catalogue order. */
function ownedTitles(list) {
  return list.filter((a) => a.unlocked && a.title).map((a) => a.title);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function sendAchievements(res, userId) {
  const { send } = helpers;
  const achievements = syncAchievements(userId);
  const gs = db.prepare("SELECT title FROM game_state WHERE user_id = ?").get(userId);
  send(res, 200, {
    achievements,
    titles: {
      owned: ownedTitles(achievements),
      equipped: gs && gs.title ? gs.title : null,
    },
  });
  // isNew is a one-shot: the fetch that surfaces an unlock also marks it seen.
  db.prepare("UPDATE user_achievements SET seen = 1 WHERE user_id = ? AND seen = 0")
    .run(String(userId));
}

async function handleTitleEquip(req, res, userId) {
  const { send, readBody } = helpers;
  const { title } = await readBody(req);
  if (title === null || title === undefined) {
    // Unequip. game_state.title is NOT NULL, so "no title" is stored as ''.
    db.prepare("UPDATE game_state SET title = '' WHERE user_id = ?").run(userId);
    return send(res, 200, { ok: true, title: null });
  }
  if (typeof title !== "string") return send(res, 400, { error: "title must be a string or null." });
  const owned = ownedTitles(syncAchievements(userId));
  if (!owned.includes(title)) return send(res, 400, { error: "Title not earned." });
  db.prepare("UPDATE game_state SET title = ? WHERE user_id = ?").run(title, userId);
  return send(res, 200, { ok: true, title });
}

// ---------------------------------------------------------------------------
// Leaderboards — three boards over season_scores / user_records / wallets.
// TEXT user_id on the economy side, CAST keeps the users join honest.
// ---------------------------------------------------------------------------

function handleLeaderboards(res, userId) {
  const { send } = helpers;
  const sid = Number(currentSeason().id);

  // -- global: season rating ------------------------------------------------
  const globalTop = db
    .prepare(
      `SELECT u.username, s.user_id, s.rating, w.xp
       FROM season_scores s
       JOIN users u ON u.id = CAST(s.user_id AS INTEGER)
       LEFT JOIN wallets w ON w.user_id = s.user_id
       WHERE s.season_id = ? ORDER BY s.rating DESC, s.user_id LIMIT 100`
    )
    .all(sid)
    .map((r, i) => ({
      rank: i + 1,
      username: r.username,
      rating: Number(r.rating),
      level: progressionFor(r.xp != null ? Number(r.xp) : 0).level,
    }));
  const myScore = db
    .prepare("SELECT rating FROM season_scores WHERE user_id = ? AND season_id = ?")
    .get(String(userId), sid);
  const myXpRow = db.prepare("SELECT xp FROM wallets WHERE user_id = ?").get(String(userId));
  const myXp = myXpRow ? Number(myXpRow.xp) : 0;
  const myLevel = progressionFor(myXp).level;
  const globalOwn = myScore
    ? {
        rank: Number(
          db.prepare("SELECT COUNT(*) AS n FROM season_scores WHERE season_id = ? AND rating > ?")
            .get(sid, Number(myScore.rating)).n
        ) + 1,
        rating: Number(myScore.rating),
        level: myLevel,
      }
    : { rank: null, rating: 0, level: myLevel };

  // -- clears: fastest boss kill ---------------------------------------------
  const clearsTop = db
    .prepare(
      `SELECT u.username, r.fastest_ms, r.fastest_diff
       FROM user_records r JOIN users u ON u.id = CAST(r.user_id AS INTEGER)
       WHERE r.fastest_ms IS NOT NULL
       ORDER BY r.fastest_ms ASC, r.user_id LIMIT 100`
    )
    .all()
    .map((r, i) => ({
      rank: i + 1,
      username: r.username,
      ms: Number(r.fastest_ms),
      difficulty: r.fastest_diff,
    }));
  const myRec = db
    .prepare("SELECT fastest_ms, fastest_diff FROM user_records WHERE user_id = ?")
    .get(String(userId));
  const clearsOwn = myRec && myRec.fastest_ms != null
    ? {
        rank: Number(
          db.prepare("SELECT COUNT(*) AS n FROM user_records WHERE fastest_ms IS NOT NULL AND fastest_ms < ?")
            .get(Number(myRec.fastest_ms)).n
        ) + 1,
        ms: Number(myRec.fastest_ms),
        difficulty: myRec.fastest_diff,
      }
    : { rank: null, ms: null, difficulty: null };

  // -- levels: lifetime XP ----------------------------------------------------
  const levelsTop = db
    .prepare(
      `SELECT u.username, w.xp
       FROM wallets w JOIN users u ON u.id = CAST(w.user_id AS INTEGER)
       ORDER BY w.xp DESC, w.user_id LIMIT 100`
    )
    .all()
    .map((r, i) => ({
      rank: i + 1,
      username: r.username,
      level: progressionFor(Number(r.xp)).level,
      xp: Number(r.xp),
    }));
  // Everyone has an XP total (0 counts), so this board is never unranked.
  const levelsOwn = {
    rank: Number(
      db.prepare("SELECT COUNT(*) AS n FROM wallets WHERE xp > ?").get(myXp).n
    ) + 1,
    level: myLevel,
    xp: myXp,
  };

  return send(res, 200, {
    global: { top: globalTop, own: globalOwn },
    clears: { top: clearsTop, own: clearsOwn },
    levels: { top: levelsTop, own: levelsOwn },
  });
}

// ---------------------------------------------------------------------------
// Router — /api/achievements, /api/title/equip, /api/leaderboards.
// ---------------------------------------------------------------------------

export async function handleAchievements(req, res, url, userId) {
  const { send } = helpers;
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/achievements") return sendAchievements(res, userId);
  if (route === "POST /api/title/equip") return handleTitleEquip(req, res, userId);
  if (route === "GET /api/leaderboards") return handleLeaderboards(res, userId);
  return send(res, 404, { error: "No such endpoint." });
}
