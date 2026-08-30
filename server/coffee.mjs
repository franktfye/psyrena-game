/**
 * Psyrena Coffee Shop — potion vendor behind the coffee-shop attendant in the
 * village hub. Same zero-dependency stance as economy.mjs, same sqlite file.
 *
 * The shop sells timed personal buffs ("potions"): drink a Latte and your
 * damage rides +20% for 24 hours, an Americano does the same for healing.
 * Only the S sizes are purchasable — M/L are catalogued so the storefront can
 * gray them out as coming-soon, and the server refuses them outright. There
 * is deliberately NO dock button for any of this: the attendant is the door.
 *
 * The buff itself is enforced client-side by the fight sim (the fight already
 * runs on the client; see src/state/potions.ts) — this module is the ledger:
 * who owns which effect until when, and what was paid.
 */

import { creditImaginz } from "./economy.mjs";
import { logEvent } from "./events.mjs";

// 24 h per cup. One row per (user, effect); re-buying while active EXTENDS
// from the current expiry, so a topped-up cup never wastes paid time.
const POTION_DURATION_MS = 24 * 3600 * 1000;

/**
 * The catalogue. `effect` is the multiplier the client sim applies
 * ("damage" | "healing", +magnitude while active). `available: false` rows
 * are the M/L teasers: rendered grayed in the storefront, refused here.
 */
export const COFFEE_ITEMS = [
  { id: "latte_s",     name: "Latte",     size: "S", price: 500,  effect: "damage",  magnitude: 0.2, available: true,
    desc: "+20% damage for 24 h" },
  { id: "latte_m",     name: "Latte",     size: "M", price: null, effect: "damage",  magnitude: 0,   available: false, desc: "Coming soon" },
  { id: "latte_l",     name: "Latte",     size: "L", price: null, effect: "damage",  magnitude: 0,   available: false, desc: "Coming soon" },
  { id: "americano_s", name: "Americano", size: "S", price: 500,  effect: "healing", magnitude: 0.2, available: true,
    desc: "+20% healing for 24 h" },
  { id: "americano_m", name: "Americano", size: "M", price: null, effect: "healing", magnitude: 0,   available: false, desc: "Coming soon" },
  { id: "americano_l", name: "Americano", size: "L", price: null, effect: "healing", magnitude: 0,   available: false, desc: "Coming soon" },
];

/** Buff presentation, keyed by effect — name/icon the HUD tile and card wear. */
const EFFECT_BUFFS = {
  damage:  { name: "Espresso Veins", icon: "/assets/ui/buffs/espresso_veins.webp" },
  healing: { name: "Steady Hands",   icon: "/assets/ui/buffs/steady_hands.webp" },
};

let db = null;
let helpers = null; // { send, readBody } borrowed from app.mjs

export function initCoffee(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
  db.exec(`
    CREATE TABLE IF NOT EXISTS potion_buffs (
      user_id    TEXT NOT NULL,
      effect     TEXT NOT NULL,
      magnitude  REAL NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, effect)
    );
    -- Gift codes: minted in the admin console (server/admin.mjs), redeemed at
    -- the storefront below. reward_type 'imaginz' pays reward_amount into the
    -- wallet; 'item' pours a free cup (reward_item = COFFEE_ITEMS id).
    -- max_uses 0 = unlimited; each account may redeem a given code once.
    CREATE TABLE IF NOT EXISTS gift_codes (
      code          TEXT PRIMARY KEY,
      created_by    INTEGER REFERENCES users(id),
      note          TEXT,
      reward_type   TEXT NOT NULL,
      reward_amount INTEGER,
      reward_item   TEXT,
      max_uses      INTEGER NOT NULL DEFAULT 1,
      uses          INTEGER NOT NULL DEFAULT 0,
      expires_at    INTEGER,
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gift_uses (
      code    TEXT NOT NULL REFERENCES gift_codes(code),
      user_id INTEGER NOT NULL REFERENCES users(id),
      at      INTEGER NOT NULL,
      PRIMARY KEY (code, user_id)
    );
  `);
}

/**
 * The player's live potion effects — expired rows are swept on read, so the
 * table never needs a timer. Exported for anything server-side that later
 * wants to honor the buffs (score validation, a future authoritative sim).
 */
export function activePotions(userId) {
  const now = Date.now();
  db.prepare("DELETE FROM potion_buffs WHERE user_id = ? AND expires_at <= ?")
    .run(String(userId), now);
  return db
    .prepare("SELECT effect, magnitude, expires_at FROM potion_buffs WHERE user_id = ?")
    .all(String(userId))
    .map((r) => ({
      effect: r.effect,
      magnitude: Number(r.magnitude),
      expiresAt: Number(r.expires_at),
      ...EFFECT_BUFFS[r.effect],
    }));
}

function balanceFor(userId) {
  const row = db.prepare("SELECT imaginz FROM wallets WHERE user_id = ?").get(String(userId));
  return row ? Number(row.imaginz) : 0;
}

/** Storefront snapshot: catalogue + wallet + live buffs, one GET. */
function handleCoffeeState(res, userId) {
  return helpers.send(res, 200, {
    items: COFFEE_ITEMS,
    imaginz: balanceFor(userId),
    active: activePotions(userId),
  });
}

/**
 * Pour one cup: apply the item's timed buff. Re-granting an active effect
 * extends from its CURRENT expiry — paid (or gifted) time is never clipped.
 * Callers must have swept expired rows (activePotions) so a stale expiry
 * can't extend anything. Shared by the buy path and gift-code redemption.
 */
function grantPotion(userId, item) {
  const now = Date.now();
  const current = db
    .prepare("SELECT expires_at FROM potion_buffs WHERE user_id = ? AND effect = ? AND expires_at > ?")
    .get(String(userId), item.effect, now);
  const expiresAt = Math.max(now, Number(current?.expires_at ?? 0)) + POTION_DURATION_MS;
  db.prepare(
    `INSERT INTO potion_buffs (user_id, effect, magnitude, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, effect) DO UPDATE SET
       magnitude = excluded.magnitude, expires_at = excluded.expires_at`
  ).run(String(userId), item.effect, item.magnitude, expiresAt);
  return expiresAt;
}

function handleCoffeeBuy(res, userId, payload) {
  const { send } = helpers;
  const item = COFFEE_ITEMS.find((i) => i.id === payload.item);
  if (!item) return send(res, 400, { error: "No such item on the menu." });
  if (!item.available) {
    return send(res, 400, { error: `The ${item.size} ${item.name} is not brewing yet — coming soon.` });
  }
  const balance = balanceFor(userId);
  if (balance < item.price) {
    return send(res, 402, { error: "Not enough Imaginz.", needed: item.price, balance });
  }
  db.prepare("UPDATE wallets SET imaginz = imaginz - ? WHERE user_id = ?").run(item.price, String(userId));
  grantPotion(userId, item);
  logEvent("coffee.buy", userId, { item: item.id, price: item.price });
  return send(res, 200, {
    ok: true,
    item: item.id,
    balance: balance - item.price,
    active: activePotions(userId),
  });
}

/**
 * Redeem-a-code. Codes are minted in the admin console (gift_codes above):
 * a wallet grant or a free cup. One redemption per account per code; the
 * uses counter is a guarded UPDATE so a shared multi-use code cannot be
 * over-drawn. Everything between the checks and the grant is synchronous,
 * wrapped in one transaction — a mid-grant throw never leaves a use spent
 * with no reward paid.
 */
function handleCoffeeRedeem(res, userId, payload) {
  const { send, tx } = helpers;
  const code = typeof payload.code === "string" ? payload.code.trim().toUpperCase() : "";
  if (!code) return send(res, 400, { error: "Enter a code to redeem." });
  const row = db.prepare("SELECT * FROM gift_codes WHERE code = ?").get(code);
  if (!row || row.disabled) {
    return send(res, 404, { error: "That code isn't on the board." });
  }
  if (row.expires_at != null && Number(row.expires_at) < Date.now()) {
    return send(res, 410, { error: "That code has expired." });
  }
  if (db.prepare("SELECT 1 FROM gift_uses WHERE code = ? AND user_id = ?").get(code, userId)) {
    return send(res, 409, { error: "You already redeemed this code." });
  }

  let message;
  try {
    tx(() => {
      const taken = db.prepare(
        `UPDATE gift_codes SET uses = uses + 1
         WHERE code = ? AND disabled = 0 AND (max_uses = 0 OR uses < max_uses)`
      ).run(code);
      if (Number(taken.changes) === 0) throw new Error("used-up");
      db.prepare("INSERT INTO gift_uses (code, user_id, at) VALUES (?, ?, ?)")
        .run(code, userId, Date.now());
      if (row.reward_type === "imaginz") {
        creditImaginz(userId, Number(row.reward_amount));
        message = `${row.reward_amount} Imaginz added to your wallet.`;
      } else {
        const item = COFFEE_ITEMS.find((i) => i.id === row.reward_item);
        if (!item) throw new Error("bad-item");
        activePotions(userId); // sweep expired rows so the extend-from-expiry math is honest
        grantPotion(userId, item);
        message = `A free ${item.name} (${item.size}) — ${item.desc}.`;
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "used-up") {
      return send(res, 410, { error: "That code has been fully redeemed." });
    }
    throw err;
  }
  logEvent("gift.redeem", userId, { code, reward: row.reward_type === "imaginz"
    ? { type: "imaginz", amount: Number(row.reward_amount) }
    : { type: "item", item: row.reward_item } });
  return send(res, 200, {
    ok: true,
    message,
    imaginz: balanceFor(userId),
    active: activePotions(userId),
  });
}

export async function handleCoffee(req, res, url, userId) {
  const { send, readBody } = helpers;
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/coffee") return handleCoffeeState(res, userId);
  if (route === "POST /api/coffee/buy") return handleCoffeeBuy(res, userId, await readBody(req));
  if (route === "POST /api/coffee/redeem") return handleCoffeeRedeem(res, userId, await readBody(req));
  return send(res, 404, { error: "No such endpoint." });
}
