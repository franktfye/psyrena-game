/**
 * Practice-mode bot teammates — the two heroes the player did NOT pick,
 * riding the sim's SimAllySpec combatant path (one cast per 1.5 s GCD, no
 * Focus, no Marks, no ultimates — see BossFight.allyCast).
 *
 * ★ Calibration (2026-08-05, sim grid over the live BossFight):
 * each bot's per-GCD base is its kit's ROLE-CONTRACT throughput × the 1.5 s
 * GCD, so a bot delivers the contract's reference output and nothing more:
 *   - Freud   95   dmg/s (doc 08 dps row)               → skillBase 143
 *   - Pavlov  52.5 dmg/s (tank row 61.75 minus the 15%
 *     share his E pays as healing)                      → skillBase  79
 *   - Skinner 45.6 heal/s (engaged healing, 2 736/min)  → healBase   68
 *
 * Measured over 40 runs per cell with a competent driven player: the trio
 * clears STANDARD at ~60–67% of the enrage window (the sheet's 65% kill
 * target) and FAILS Hard and Nightmare — which is the practice mode's design:
 * bots carry a learning run, they do not carry a challenge run.
 *
 * `baseDamage` is the doc 03 role weight, same convention as the old
 * NIGHTMARE_ALLIES roster (it is what a healer bot swings for when nobody
 * needs healing). Pavlov's stance mirrors his authored Discrimination — AI
 * allies hold their stance open for the whole fight (BossFight constructor).
 */

import type { SimAllySpec } from "./nightmare";

export const PRACTICE_BOTS: Record<string, SimAllySpec> = {
  freud: {
    heroId: "freud",
    displayName: "Freud — The Analyst",
    role: "dps",
    baseDamage: 100,
    skillBase: 143,
  },
  pavlov: {
    heroId: "pavlov",
    displayName: "Pavlov — The Conditioner",
    role: "tank",
    baseDamage: 65,
    skillBase: 79,
    threatStance: { id: "pavlov.discrimination", name: "Discrimination", multiplier: 6, toggle: true },
  },
  skinner: {
    heroId: "skinner",
    displayName: "Skinner — The Reinforcer",
    role: "healer",
    baseDamage: 60,
    skillBase: 0,
    healBase: 68,
  },
};

/**
 * The two bots that fill a practice run around the player's pick. A hero
 * outside the trio (future roster growth) practices with the tank + healer
 * pair — the comp that keeps a learning run alive.
 */
export function practiceBotsFor(playerHeroId: string): SimAllySpec[] {
  const bots = Object.values(PRACTICE_BOTS).filter((b) => b.heroId !== playerHeroId);
  return bots.length === 2 ? bots : [PRACTICE_BOTS.pavlov!, PRACTICE_BOTS.skinner!];
}
