/**
 * Psyrena game-event log — the one append-only record every module writes to.
 *
 * Same zero-dependency stance as the rest of server/: one table, one writer.
 * Everything operationally interesting lands here as (at, type, user_id, data)
 * — logins, registrations, fight reports, purchases, redemptions, moderation
 * actions — and the admin console (server/admin.mjs) is the reader: the
 * statistics dashboard and the event browser are both views over this table.
 *
 * Writes are deliberately fire-and-forget: a failed event insert must never
 * break the player-facing request that produced it.
 */

const RETENTION_DAYS = 90;

let db = null;

export function initEvents(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      user_id INTEGER,
      data    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_at      ON game_events (at);
    CREATE INDEX IF NOT EXISTS idx_events_type_at ON game_events (type, at);
    CREATE INDEX IF NOT EXISTS idx_events_user_at ON game_events (user_id, at);
  `);
  // Boot-time retention sweep — one DELETE per process start keeps the table
  // bounded without a timer.
  db.prepare("DELETE FROM game_events WHERE at < ?")
    .run(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
}

/**
 * Record one event. `data` is any JSON-serializable bag of context (kept
 * small — this is a ledger, not a dump). Safe to call from anywhere after
 * initEvents(); a throw is logged and swallowed.
 */
export function logEvent(type, userId, data = undefined) {
  if (!db) return;
  try {
    db.prepare("INSERT INTO game_events (at, type, user_id, data) VALUES (?, ?, ?, ?)")
      .run(Date.now(), String(type), userId == null ? null : Number(userId),
           data === undefined ? null : JSON.stringify(data));
  } catch (err) {
    console.error("[events] log failed:", err);
  }
}
