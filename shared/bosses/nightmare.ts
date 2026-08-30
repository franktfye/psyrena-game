/**
 * NIGHTMARE — fight script data, Standard difficulty.
 *
 * The client fight sim (`src/fight/bossFight.ts`) and eventually the Colyseus
 * server both read this object, same rule as heroes: adding/tuning a boss is
 * a DATA change, here — never a branch in scene code.
 *
 * Provenance (see admin/boss-math/extracted-stats.json for the full sheet):
 *  - Phase script, durations, armor, regen, outgoing damage, enrage: doc 04 +
 *    src/scenes/nightmareBoss.ts lookdev timings ("code+doc" on the sheet).
 *  - P2 stage count/duration, debuff numbers, slot cooldowns/focus costs: the
 *    sheet's own proposal ("design — TBD in doc 04").
 *  - hpByTeamSize, heroHp: ASSUMED — flagged below. The sheet marks both
 *    "missing" (open issues P-2 and the hero-HP gap); the values here are
 *    derived from the sheet's Standard reference corner (3 players, no gear,
 *    kill target 65% of the 8:00 enrage) and hand-checked against a 3-hero
 *    team's steady-state throughput. Replace from the sheet's sim when it
 *    exports final numbers.
 */

import type { HeroId, Role, ThreatStance } from "../types";

export type FightPhaseId = "p1" | "p2" | "p3" | "p4";

export interface FightOutgoing {
  hitDamage: number;
  periodS: number;
  /** "threat" = the highest-threat hero (the hate system); "all" = raid-wide. */
  targets: "threat" | "all";
}

export interface FightPhase {
  id: FightPhaseId;
  name: string;
  durationS: number;
  /** Multiplier on damage the boss takes (P3 Fortress armor = 0.10). */
  dmgTakenMult: number;
  /** Fraction of MAX HP regenerated per second (P3 = 0.01). */
  regenPctPerS: number;
  outgoing: FightOutgoing | null;
  /** P2 Shapeshift palette-answer check. */
  skillCheck?: { stages: number; stageDurS: number };
}

export interface P2Debuff {
  /** DoT per stack, as % of boss MAX HP per second. */
  dotPctMaxHpPerStackPerS: number;
  durationMs: number;
  maxStacks: number;
  /** Ignores P3's 90% armor — the designed counter to Fortress. */
  bypassesArmor: boolean;
  /** Sheet default: the DoT only ticks while the boss is armored (P3). */
  ticksOnlyWhileArmored: boolean;
  /**
   * Each live stack also shreds the armor: +this much damage-taken while the
   * boss is armored (P3). A perfect P2 (all five palette answers right) at
   * 0.10/stack turns Fortress's 0.10 damage-taken into 0.60.
   */
  armorShredPerStack: number;
}

export interface BossFightScript {
  bossId: string;
  displayName: string;
  tier: 1 | 2 | 3;
  difficulty: "standard" | "hard" | "nightmare";
  /**
   * The boss enrages after this many FULL cycles of the phase rotation
   * (p1 → p4, then back to p1), not after a wall-clock duration. Phase
   * durations are fixed, so the HUD can still derive an exact countdown.
   */
  enrageCycles: number;
  /** Seconds the boss idles before engaging. */
  idleS: number;
  hpByTeamSize: Record<1 | 2 | 3 | 4 | 5, number>;
  phases: [FightPhase, FightPhase, FightPhase, FightPhase];
  p2Debuff: P2Debuff;
  /**
   * ASSUMED — no hero HP numbers exist anywhere in the repo (the sheet's
   * "blocking gap for healer math"). 1000 puts the P1 100-damage hit at 10%
   * of a health bar, which reads right at Standard.
   */
  heroHp: number;
  /** World-chat warning lead time before each phase change. */
  phaseWarningS: number;
}

export const NIGHTMARE_STANDARD: BossFightScript = {
  bossId: "nightmare",
  displayName: "NIGHTMARE",
  tier: 1,
  difficulty: "standard",
  enrageCycles: 3, // 3 × 210 s of phase time — was a fixed 480 s (doc 04)
  idleS: 10,
  // ASSUMED (P-2): derived for the sheet's Standard corner — 3 players, gear
  // ×1.00, kill ≈ 65% of enrage (~5:12). 4/5-player values scale with the
  // extra damage dealers, not linearly with heads. 1/2-player rows follow the
  // same per-head budget (30k each) — the sim allies are gone (only real
  // players engage the boss), so the under-3 corners are real fights now, and
  // the boss's OUTGOING scales down with them (BossFight.sizeMult) because
  // the 100-per-2s hit was tuned for a 5×-threat tank with a dedicated
  // healer, neither of which a solo run has.
  hpByTeamSize: { 1: 30_000, 2: 60_000, 3: 90_000, 4: 120_000, 5: 150_000 },
  phases: [
    {
      id: "p1",
      name: "Onslaught",
      durationS: 60,
      dmgTakenMult: 1.0,
      regenPctPerS: 0,
      outgoing: { hitDamage: 100, periodS: 2, targets: "threat" },
    },
    {
      id: "p2",
      name: "Shapeshift",
      durationS: 30, // sheet: 5 stages × 6 s (lookdev ran 5 × 10 s)
      dmgTakenMult: 1.0,
      regenPctPerS: 0,
      outgoing: null,
      skillCheck: { stages: 5, stageDurS: 6 },
    },
    {
      id: "p3",
      name: "Fortress",
      durationS: 60,
      dmgTakenMult: 0.1, // armor blocks 90%; the P2 debuff bypasses it
      regenPctPerS: 0.01,
      outgoing: null,
    },
    {
      id: "p4",
      name: "Terror",
      durationS: 60,
      dmgTakenMult: 1.0,
      regenPctPerS: 0,
      outgoing: { hitDamage: 50, periodS: 5, targets: "all" },
    },
  ],
  p2Debuff: {
    // The sheet's proposal (its primary design output): 0.15% max HP/s per
    // stack, 5 stacks per clean pass, 105 s so one pass covers a Fortress.
    dotPctMaxHpPerStackPerS: 0.15,
    durationMs: 105_000,
    maxStacks: 5,
    bypassesArmor: true,
    ticksOnlyWhileArmored: true,
    armorShredPerStack: 0.1, // correct palette answers weaken Fortress 10% each
  },
  heroHp: 1_000, // ASSUMED — see interface note
  phaseWarningS: 5,
};

/**
 * Ally data for the fight sim's Combatant list.
 *
 * The hard-coded bot roster (Piaget + Maslow, `NIGHTMARE_ALLIES`) is GONE —
 * only real players engage the boss now, and the sim scales its HP and
 * outgoing to the actual headcount (hpByTeamSize + BossFight.sizeMult). The
 * spec type stays: it is the shape a REAL teammate will occupy in the
 * Combatant list once the networked fight room feeds them in.
 */
export interface SimAllySpec {
  heroId: HeroId;
  displayName: string;
  role: Role;
  /** Doc 03 baseDamage (basic attacks). */
  baseDamage: number;
  /** Doc 03 palette-skill base; cast every GCD. 0 = the palette heals instead. */
  skillBase: number;
  /**
   * ASSUMED heal throughput — the sheet lists healerHps as "missing". Maslow's
   * palette heals; this is the per-cast amount that keeps a Standard tank up
   * through Onslaught (100 dmg / 2 s) with slack for Terror.
   */
  healBase?: number;
  /**
   * The stance this ally holds for the whole fight, if any — an AI has no
   * hands to toggle it with.
   *
   * ★ 2026-08-03: threat is stance-driven now (shared/combat.ts `THREAT`), so
   * a tank without one banks 1× and stops holding aggro. This field is what
   * keeps the sim's hate table identical across that rule change; it goes away
   * for real once Piaget's *Centration* ships as an authored kit (doc 07 #s-9).
   */
  threatStance?: ThreatStance;
}

