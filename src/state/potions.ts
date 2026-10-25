/**
 * Active potion effects — the client-side ledger mirror of server/coffee.mjs.
 *
 * One module-level cache, same singleton reasoning as state/player.ts: the
 * fight sim (bossFight.ts) needs multipliers at cast time, the HUD needs
 * tiles, and the storefront needs to repaint both after a purchase. The
 * server is the authority on who owns what until when; this cache is only
 * ever what the last /api/coffee response (or buy receipt) said, with expiry
 * enforced locally by wall clock so a stale cache can't buff a fight.
 *
 * `syncPotionBuffs()` runs at village load (villageHub.ts) and after every
 * purchase (coffeeShopPanel.ts pushes the receipt via `setActivePotions`) —
 * there is no poll; a 24 h buff doesn't need one.
 */

import { player } from "./player";
import { getCoffee, type ActivePotion, type PotionEffect } from "../net/coffee";

let active: ActivePotion[] = [];

/** Multiplier for an effect right now: 1 with nothing active, 1.2 buffed. */
function multiplierFor(effect: PotionEffect): number {
  const now = Date.now();
  return active
    .filter((p) => p.effect === effect && p.expiresAt > now)
    .reduce((m, p) => m * (1 + p.magnitude), 1);
}

/** Damage-side potion term the fight sim multiplies every player hit by. */
export function potionDamageMult(): number {
  return multiplierFor("damage");
}

/** Healing-side potion term the fight sim multiplies every heal by. */
export function potionHealingMult(): number {
  return multiplierFor("healing");
}

/** Focus-regen potion term (Cold Brew): the client's regen multiplier takes it at fight start. */
export function potionFocusRegenMult(): number {
  return multiplierFor("focus");
}

/**
 * Adopt a fresh server snapshot: cache it and re-issue the HUD buff tiles.
 * The player store expires tiles by its own clock, so each tile is pushed
 * with the REMAINING duration, not the full 24 h.
 */
export function setActivePotions(list: ActivePotion[]): void {
  const now = Date.now();
  // Effects that just lapsed (or were never re-granted) drop their tile too.
  for (const stale of active) {
    if (!list.some((p) => p.effect === stale.effect)) player.removeBuff(`potion_${stale.effect}`);
  }
  active = list.filter((p) => p.expiresAt > now);
  for (const p of active) {
    const pct = Math.round(p.magnitude * 100);
    player.applyBuff({
      id: `potion_${p.effect}`,
      name: `${p.name} — +${pct}% ${p.effect === "focus" ? "Focus regen" : p.effect}`,
      icon: p.icon,
      kind: "buff",
      durationMs: p.expiresAt - now,
      desc: p.effect === "focus"
        ? `Coffee Shop potion: your Focus refills ${pct}% faster in fights until it wears off. Buy another cup to refresh the day.`
        : `Coffee Shop potion: all ${p.effect} you ${p.effect === "healing" ? "deliver" : "deal"} is increased ${pct}% until it wears off. Buy another cup to refresh the day.`,
    });
  }
}

/**
 * Refresh from the server. Failures are swallowed — a missing buff tile beats
 * a broken village load, and the sim falls back to ×1 the same way.
 */
export function syncPotionBuffs(): Promise<void> {
  return getCoffee()
    .then((state) => setActivePotions(state.active))
    .catch(() => undefined);
}
