/**
 * The cast cost model — Focus, the global cooldown, the beat period.
 *
 * These used to be client-only: `FOCUS_COST` was a literal inside
 * arenaCombat.ts, the GCD was a number handed to the action bar, and the Focus
 * pool lived in the browser's player store. The sim never knew about any of
 * it, which is exactly why a client could cast for free. The server enforces
 * them now, so the numbers have to be shared.
 */

import type { Hero } from "../types.ts";
import { BEAT_PERIOD_S } from "../combat.ts";

/** The shared global cooldown, in ms — one number for every hero and skill. */
export const GCD_MS = 1500;

export const FOCUS = {
  /** Pool size. Mirrors the player store's vitals at fight start. */
  max: 100,
  /** Passive regeneration per second. */
  regenPerS: 2,
  /** Re-exported so the server's beat clock cannot drift from the client's. */
  beatPeriodS: BEAT_PERIOD_S,
} as const;

/** Slot kinds the cost table covers — the action bar's vocabulary. */
export type CostKind = "basic" | "palette" | "defense" | "chain" | "ultimate" | "stance";

/**
 * What one cast costs this hero.
 *
 * Palette entries share a flat scaffold cost (doc 02 has no palette tuning
 * yet); everything else is the kit's own `focusCost`. A stance is free by
 * definition (`ThreatStance.toggle`) — and because this gates casting, the
 * zero is also what lets a Focus-starved tank still drop aggro, which is
 * exactly when they need it.
 */
export const PALETTE_FOCUS_COST = 8;

export function focusCostFor(hero: Hero, kind: CostKind): number {
  switch (kind) {
    case "palette":
      return PALETTE_FOCUS_COST;
    case "defense":
      return hero.defense?.focusCost ?? 0;
    case "chain":
      return hero.chain?.focusCost ?? 0;
    case "ultimate":
      return hero.ultimate?.focusCost ?? 0;
    default:
      return 0;
  }
}
