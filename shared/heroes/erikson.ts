import type { Hero, PsychosocialSpec } from "../types";
import { AOE_MAP_WIDE_M } from "../combat.ts";

/**
 * Erik Erikson — "The Life Cycle". DPS, base 100, chain kit.
 *
 * A teaching kit (2026-10-18, Frank): what a student must leave with is the
 * eight psychosocial stages IN ORDER, each one's crisis and age, and the
 * virtue each yields. So the rotation is the chart. The player presses
 * `1-2-1-2-…`, and the bar spells the life cycle out as they go:
 *
 *   1  Life Stage  "Trust" — the current crisis, armed
 *   2  Virtue      "Hope"  — its virtue: the matched pair, the big hit
 *   LMB            "Mother" — one add-on basic after EACH of 1 and 2, named
 *                  after the stage's radius of significant relations (the
 *                  third column of Erikson's chart)
 *   F  Life Review spends the virtues banked by completed pairs
 *
 * Nothing in the kit reads the boss — no answer axis, no age tags (that is
 * Freud's palette). The match is between Erikson's own two keys, so the kit
 * plays the same against NIGHTMARE, solo, or three Eriksons in one party. The
 * rules live in shared/fight/psychosocial.ts.
 *
 * ★ Numbers are the ROLE CONTRACT's (doc 08 §3), DPS row, weight 1.00, budget
 * 95, no beat cycle — so every slot derives at beat factor 1.0:
 *
 *     base = (95 × share) ÷ (casts per second)
 *
 * with the contract's rates S1 7.5 · S2 5 · S3 2.4 · S4 1 · S5 24.1 per min.
 * `tools/sim-check.mjs` scenario 8 re-derives all of it.
 *
 * Two places where Erikson's shape changes the rate a slot is priced at:
 *
 *   - S5 (basic). The add-on is GATED: one basic per palette cast, so its
 *     cadence is the palette's 7.5/min, not the free basic's 24.1. Priced at
 *     the real cadence, the 25% share is 95×0.25 ÷ (7.5/60) = 190 per add-on.
 *     Priced at 24.1 it would be 59, and Erikson would quietly lose 17% of his
 *     budget to a rate the gate makes impossible.
 *   - S1 (palette). The slot's 7.5 casts/min is 3.75 PAIRS/min, so a pair is
 *     worth 95×0.40 ÷ (3.75/60) = 608, split one third on the stage (203) and
 *     two thirds on the virtue (405) — the matched virtue is the max hit.
 */
export const ERIKSON_PSYCHOSOCIAL: PsychosocialSpec = {
  // Ages as the chart is usually taught; relations shortened from Erikson's
  // own wording to fit a button ("maternal person" → Mother, "mankind, my
  // kind" → Humankind). heroLore.ts carries the full chart.
  stages: [
    { crisis: "Trust vs Mistrust", short: "Trust", age: "0 to 1½", virtue: "Hope", relations: "Mother" },
    { crisis: "Autonomy vs Shame and Doubt", short: "Autonomy", age: "1½ to 3", virtue: "Will", relations: "Parents" },
    { crisis: "Initiative vs Guilt", short: "Initiative", age: "3 to 5", virtue: "Purpose", relations: "Family" },
    { crisis: "Industry vs Inferiority", short: "Industry", age: "5 to 12", virtue: "Competence", relations: "School" },
    { crisis: "Identity vs Role Confusion", short: "Identity", age: "12 to 18", virtue: "Fidelity", relations: "Peers" },
    { crisis: "Intimacy vs Isolation", short: "Intimacy", age: "18 to 40", virtue: "Love", relations: "Partners" },
    { crisis: "Generativity vs Stagnation", short: "Generativity", age: "40 to 65", virtue: "Care", relations: "Household" },
    { crisis: "Integrity vs Despair", short: "Integrity", age: "65+", virtue: "Wisdom", relations: "Humankind" },
  ],
  // Pressing 2 with no stage armed: a quarter of the virtue (101). Low enough
  // that the out-of-order press is plainly the wrong one, high enough that a
  // mis-tap is not a wasted GCD. Off the reference rotation, so off-budget.
  unmatchedVirtueMult: 0.25,
  maxVirtues: 8,
  // Frank, 2026-10-18: a correct pair should feel like it pays for itself.
  // Keys 1 and 2 cost 13 each and a completed pair refunds 10, so a pair nets
  // 16 — exactly two scaffold palette casts, the price his numbers are
  // budgeted at. A flat +10 on the old 8-per-key price was simulated at +160%
  // sustained DPS (Focus, not cooldowns, caps every hero's cast rate), so the
  // refund is paid for by the keys' price. Wrong order pays the full 13.
  pairFocusRefund: 10,
};

export const ERIKSON: Hero = {
  id: "erikson",
  displayName: "Erik Erikson — The Life Cycle",
  theory: "Psychosocial development: eight life stages, each a crisis that yields a virtue",
  role: "dps",
  kit: "chain",
  baseDamage: 100,
  // No `beats`: the stages are a sequence the player walks, not a clock.
  psychosocial: ERIKSON_PSYCHOSOCIAL,
  // S5 · 25% ÷ (7.5 add-ons/min — one per palette cast, see above) = 190.
  basic: {
    id: "erikson.relations",
    name: "Significant Relations",
    base: 190,
    cooldownMs: 600,
    focusCost: 0,
    effects: [{ kind: "psychosocial.addon" }],
  },
  // S1 · 40% ÷ (3.75 pairs/min) = 608 per pair → 203 stage + 405 virtue.
  // No `answersAxis`: a chain-kit entry is always correct during Shapeshift.
  // No `mark.grant`: Erikson banks his own virtues, not the team's Marks.
  palette: [
    {
      id: "erikson.stage",
      name: "Life Stage",
      base: 203,
      markType: "crisis",
      focusCost: 13,
      effects: [{ kind: "psychosocial.stage" }],
    },
    {
      id: "erikson.virtue",
      name: "Virtue",
      base: 405,
      markType: "crisis",
      focusCost: 13,
      effects: [{ kind: "psychosocial.virtue" }],
    },
  ],
  /**
   * S2 · 9% as healing ÷ (5 casts/min) = 102.6 → 103, plus the DPS row's 20%
   * self-mitigation for 6 s on a 12 s cooldown (Freud's E at beat 1.0).
   * Moratorium: Erikson's sanctioned pause before adult commitments.
   */
  defense: {
    id: "erikson.moratorium",
    name: "Psychosocial Moratorium",
    base: 0,
    heal: 103,
    mitigation: { magnitude: 0.2, durationMs: 6_000, target: "self" },
    cooldownMs: 12_000,
    focusCost: 20,
    effects: [],
  },
  /**
   * S3 · 6% ÷ (2.4 casts/min) = 142.5 → 143, AOE like Freud's R. Inert beyond
   * its damage on NIGHTMARE (one target); survival's "enemies lose their
   * target" rider lands with that mode, not as dead data here.
   */
  chain: {
    id: "erikson.identity-crisis",
    name: "Identity Crisis",
    base: 143,
    aoeRadius: AOE_MAP_WIDE_M,
    cooldownMs: 25_000,
    focusCost: 30,
    effects: [],
  },
  /**
   * S4 · 20% = 1140 per cast at 1/min, 30% direct / 70% payload:
   *   direct     = 342
   *   perVirtue  = 798 ÷ 3.75 = 212.8 → 213
   *
   * The payload is priced at the virtues a reference player HAS when F comes
   * up — 3.75 pairs per minute of cooldown — not at the cap of 8, and not with
   * Freud's 1.25 foreign-Mark mix: virtues are Erikson's own, nobody else's
   * board feeds them. `perMark` carries the per-virtue value (the field the
   * ultimate resolver reads); `maxMarksConsumed` is the virtue cap.
   */
  ultimate: {
    id: "erikson.life-review",
    name: "Life Review",
    base: 342,
    cooldownMs: 60_000,
    focusCost: 50,
    perMark: 213,
    foreignMarkBonus: 0,
    maxMarksConsumed: 8,
    effects: [{ kind: "virtues.release", target: "boss" }],
  },
  // Influential and still taught everywhere, but the stage model is loosely
  // testable; Marcia's identity statuses are its best-operationalised part.
  evidenceStatus: "contested",
};
