import type { Hero, ReinforcementSpec } from "../types";

/**
 * Skinner — "The Reinforcer". Third hero, first HEALER, and the first kit
 * authored OFF-TEMPLATE (docs 03 §7, design decision 2026-08-04: the
 * five-input template is a default, not a mandate — only the role-contract
 * budget math survives as law).
 *
 * The operant chamber turned around: his own party is in the box, and every
 * heal is a pellet earned by behaving. Keys 1–4 are the four SCHEDULES OF
 * REINFORCEMENT as healing spells; E and R are free toggles picking the live
 * quadrant (which behavior earns a consequence × what the consequence is);
 * F consumes ally-side Approximations — he neither generates nor consumes
 * boss Marks, the documented exception to doc 08 §2.1.
 *
 * ★ Budget (docs 03 §7 / 08 §3): healer row, base 60 → weight 0.60 →
 * 57/s = 3,420/min, shares re-authored 20 dmg / 30 schedules / 20 procs /
 * 30 ult. Like Pavlov he has NO beat cycle — a Fixed Ratio that paid ×0.8
 * now and ×1.25 on a payoff beat would not be *fixed*, and un-fixing the
 * fixed schedules is the one lesson this kit must not teach — so every base
 * derives at beat factor 1.0:
 *
 *   schedules:  3420 × 0.30 ÷ 7.5 casts/min           = 137 EV per cast
 *   procs:      3420 × 0.20 = 684/min — Positive ~34 procs/min × 20,
 *               Negative ~20 procs/min × 34 (rarer contingency, richer pellet)
 *   ultimate:   3420 × 0.30 ÷ 1 = 1,026 per cast → 30% direct (308) +
 *               70% payload at an expected 9-stack board (80/Approximation)
 *   basic:      3420 × 0.20 ÷ 24.1 = 28.4/hit budget, authored at HALF (14)
 *               and scaled by Response Strength — see the spec below.
 *
 * `kit: "chain"` is a sim classification, not a design claim: chain is the
 * archetype that neither diagnoses the boss (no Fixation) nor auto-mints
 * Marks on palette casts, which is exactly the off-template healer's shape.
 */

export const SKINNER_REINFORCEMENT: ReinforcementSpec = {
  /**
   * Positive: an ally is reinforced for EMITTING behavior — every 400 damage
   * dealt. Calibrated to a double-DPS comp (~230 team DPS → ~34 procs/min →
   * the slot's 684/min); in the starter trio (~147 DPS) Positive underpays
   * and Negative is the budget-correct toggle. The toggle answers the comp.
   */
  positiveDamagePerProc: 400,
  /**
   * Negative: reinforced for the ABSENCE of the aversive — every 6 s spent
   * taking no damage (~20 team procs/min with two players dodging cleanly,
   * comp-independent).
   */
  negativeCleanSeconds: 6,
  /** 684/min ÷ 34.2 = 20 (Positive) · 684/min ÷ 20 = 34 (Negative). */
  procHeal: { positive: 20, negative: 34 },
  /**
   * Punishment: mitigation lands BEFORE the hit, healing only after — the
   * burst-phase toggle. 10% additive under the 0.40 cap; alongside Pavlov's
   * full 35% this caps the team, which is the intended read.
   */
  procMitigation: { magnitude: 0.1, durationMs: 4_000 },
  /** Extinction: an Approximation no longer reinforced decays in 30 s. */
  approximation: { capPerAlly: 5, durationMs: 30_000 },
  /**
   * 137 = exactly one average schedule cast; 15 s window → the reference
   * engaged healing rate (2,736/min) sustains 5.0 average stacks, landing
   * 14 × (1 + 0.2 × 5) = 28 — the slot's 20% share, reached only by healing.
   */
  responseStrength: { healPerStack: 137, damagePerStack: 0.2, maxStacks: 10, durationMs: 15_000 },
  schedules: {
    /** 137 split across the living — 46 each in a 3-stack. Zero variance. */
    fixedRatio: { teamTotal: 137 },
    /**
     * The slot machine: 75% the FR pellet, 25% the jackpot, EV exactly 137.
     * The jackpot pays no more on average — and players press it anyway.
     * That is the lesson. Lands on the lowest-HP living, Skinner included.
     */
    variableRatio: { low: 46, high: 410, highChance: 0.25 },
    /** Payout per unit TIME on a fixed clock: 34 team-wide every 2 s for 8 s. */
    fixedInterval: { tickTeamTotal: 34, periodMs: 2_000, durationMs: 8_000 },
    /**
     * Random moments for 20 s: each second a 15% chance of a 46 team-wide
     * tick (EV 3 ticks = 138/cast).
     */
    variableInterval: { tickTeamTotal: 46, tickChancePerSec: 0.15, durationMs: 20_000 },
    /**
     * Interval windows SELF-STACK: each cast opens its own window, up to 5
     * live per schedule (a 6th replaces the oldest). Each window still costs
     * a full cast, so stacking is throughput brought forward, not free EV.
     */
    maxStacks: 5,
  },
  /** 1,026 × 0.7 ÷ 9 expected stacks = 80. Full board (15) pays 1,200. */
  shaping: { perApproximation: 80 },
};

export const SKINNER: Hero = {
  id: "skinner",
  displayName: "Skinner — The Reinforcer",
  theory: "Operant Conditioning",
  role: "healer",
  kit: "chain",
  // Role WEIGHT (healer row 60), not the basic's damage — that is basic.base.
  baseDamage: 60,
  // ★ NO beats — see the header. Every base below derives at factor 1.0.
  reinforcement: SKINNER_REINFORCEMENT,

  /**
   * S5 · Response Rate — a flat auto, off the GCD, whose SIZE is his healing
   * history: base 14 × (1 + 0.2 × Response Strength stacks), 28 at the
   * reference 5-stack average (the 20% share), 42 capped. A Skinner who
   * stops reinforcing his team extinguishes his own damage too.
   */
  basic: {
    id: "skinner.response-rate",
    name: "Response Rate",
    base: 14,
    cooldownMs: 600,
    focusCost: 0,
    effects: [],
  },

  /**
   * S1 · keys 1–4 — the four Schedules of Reinforcement, stacked in the same
   * mobile column Freud's stages use. All four draw one cast budget, so a
   * schedule is a DELIVERY CONTRACT, not extra throughput: equal EV 137.
   * No answer tags (nothing to be wrong about), no Marks (base 0 — these
   * are pure heals; the sim reads the payloads off `reinforcement`).
   */
  palette: [
    {
      id: "skinner.fixed-ratio",
      name: "Fixed Ratio",
      base: 0,
      markType: "reinforcement",
      effects: [{ kind: "schedule.fixed-ratio", target: "team" }],
    },
    {
      id: "skinner.variable-ratio",
      name: "Variable Ratio",
      base: 0,
      markType: "reinforcement",
      effects: [{ kind: "schedule.variable-ratio", target: "ally" }],
    },
    {
      id: "skinner.fixed-interval",
      name: "Fixed Interval",
      base: 0,
      markType: "reinforcement",
      effects: [{ kind: "schedule.fixed-interval", target: "team" }],
    },
    {
      id: "skinner.variable-interval",
      name: "Variable Interval",
      base: 0,
      markType: "reinforcement",
      effects: [{ kind: "schedule.variable-interval", target: "team" }],
    },
  ],

  /**
   * S2 · E — Contingency, a FREE TOGGLE (off the GCD, like Freud's stance
   * switch): which team behavior the chamber watches. Positive = damage
   * dealt; Negative = damage avoided. No cast payload of its own — the 20%
   * proc budget pays out through `reinforcement`.
   */
  defense: {
    id: "skinner.contingency",
    name: "Contingency",
    base: 0,
    cooldownMs: 500,
    focusCost: 0,
    effects: [{ kind: "contingency.toggle", target: "self" }],
  },

  /**
   * S3 · R — Consequence, the second free toggle: what a proc pays.
   * Reinforcement = a heal; Punishment = 10% mitigation for 4 s. E × R is
   * the four-quadrant matrix, named live on the HUD.
   */
  chain: {
    id: "skinner.consequence",
    name: "Consequence",
    base: 0,
    cooldownMs: 500,
    focusCost: 0,
    effects: [{ kind: "consequence.toggle", target: "self" }],
  },

  /**
   * S4 · F — Shaping. A holo-pigeon hops teammate to teammate, healthiest
   * first, each landing bigger — successive approximation, converging on the
   * target that needs it most. 308 direct (team) + 80 per Approximation
   * consumed; overheal converts to Amp, so a full-HP team makes this a raid
   * damage window.
   *
   * ★ Documented exception (doc 08 §2.1): consumes ally-side Approximations,
   * NOT boss Marks — perMark 0 / maxMarksConsumed 0 is the exception being
   * explicit, not a stub.
   */
  ultimate: {
    id: "skinner.shaping",
    name: "Shaping",
    base: 0,
    heal: 308,
    healTarget: "team",
    cooldownMs: 60_000,
    focusCost: 50,
    perMark: 0,
    foreignMarkBonus: 0.5,
    maxMarksConsumed: 0,
    effects: [{ kind: "shaping.release", target: "team" }],
  },

  evidenceStatus: "contemporary",
};
