import type { DevelopmentSpec, Hero } from "../types";

/**
 * Jean Piaget — "The Constructor". HEALER, base 60, palette kit.
 *
 * Design (Frank, 2026-10-24): Piaget moves from tank to healer. Keys 1–4 are
 * his four stages of cognitive development, IN ORDER, and each one heals the
 * way a child at that stage thinks:
 *
 *   1  Sensorimotor     Circular Reaction: a heal over time on the most
 *                       wounded. Infants repeat what worked.
 *   2  Preoperational   Centration: the whole heal on ONE teammate, nobody
 *                       else. The preoperational child fixes on one feature.
 *   3  Concrete         Conservation: the team's HP is poured out evenly (the
 *                       total does not change when it is rearranged), then a
 *                       small team heal on top.
 *   4  Formal           Hypothetical: a shield BEFORE the hit. Reasoning about
 *                       what has not happened yet. Unused shield becomes Amp.
 *
 *   Invariant sequence  1 → 2 → 3 → 4 in order refunds Focus (the stages
 *                       cannot be skipped), see PIAGET_DEVELOPMENT.
 *   LMB  Assimilation        fitting the boss into a schema: the damage basic
 *   E    Accommodation       a team shield and 15% team mitigation: the schema
 *                            changes to fit what it could not absorb
 *   R    Object Permanence   the most wounded teammate cannot drop below 1 HP
 *                            for 4 s, then is healed: still there when you
 *                            cannot see them
 *   F    Equilibration       spends the schema Marks: team heal and cleanse
 *
 * During Shapeshift his stages ANSWER the boss's age, like Freud's: infant is
 * Sensorimotor, toddler and child are Preoperational (2 to 7 is one stage),
 * school age is Concrete, adolescent is Formal. So the healer has a job in the
 * one phase with nothing to heal.
 *
 * ★ Every number is DERIVED on the healer row, Skinner's budget (doc 08 §3):
 * base 60 → weight 0.60 → 57/s = 3,420/min, no beat cycle (a stage is not a
 * rhythm), shares 20 basic / 30 palette / 15 E / 10 R / 25 F.
 * tools/sim-check.mjs scenario 12 re-derives every one:
 *
 *   S5 basic     20% = 684/min ÷ 24.1          = 28.4 → 28
 *   S1 palette   30% = 1026/min ÷ 7.5          = 136.8 → 137 per stage, every
 *                stage the same EV (a stage is a delivery shape, not more
 *                throughput — Skinner's rule for his schedules)
 *   S2           15% = 513/min ÷ 5             = 102.6 → 103 team shield
 *   S3           10% = 342/min ÷ 2.4           = 142.5 → 143 heal on release
 *   S4           25% = 855 at 1/min: 30% direct team heal 257, 70% over
 *                6 Marks × 1.25 foreign mix = 598.5 ÷ 7.5 = 80 per Mark
 */
export const PIAGET_DEVELOPMENT: DevelopmentSpec = {
  // Erikson's price trick: each stage key costs 10 (the scaffold 8 × 1.25)
  // and a completed 1→2→3→4 refunds 8, so a perfect sequence nets 32 = four
  // scaffold casts, the price his heals are budgeted at. Out of order pays the
  // full 40. The lesson (the order is invariant) is paid for by the keys.
  sequenceFocusRefund: 8,
  // Four casts take four GCDs (6 s); a step may lag one extra GCD and a bit.
  stepWindowMs: 4_000,
};

/** The NIGHTMARE form tags, in Shapeshift order (bossFight P2_TAGS). */
const AGE = {
  infant: "age.infant",
  toddler: "age.toddler",
  child: "age.child",
  school: "age.school",
  adolescent: "age.adolescent",
} as const;

export const PIAGET: Hero = {
  id: "piaget",
  displayName: "Piaget — The Constructor",
  theory: "Cognitive development: four invariant stages, schemas, assimilation and accommodation, equilibration",
  role: "healer",
  kit: "palette",
  // Role weight, not the basic's damage (that is basic.base).
  baseDamage: 60,
  development: PIAGET_DEVELOPMENT,
  /** S5 · Assimilation. 684/min ÷ 24.1 = 28. */
  basic: {
    id: "piaget.assimilation",
    name: "Assimilation",
    base: 28,
    cooldownMs: 600,
    focusCost: 0,
    effects: [],
  },
  // S1 · 137 healing per stage. base 0: the heal is the payload (the sim
  // reads the magnitudes off the effects). Each cast still places a schema
  // Mark, as every palette kit's does, which is what F spends.
  palette: [
    {
      id: "piaget.sensorimotor",
      name: "Sensorimotor",
      answersAxis: "age",
      answersTag: AGE.infant,
      answersTags: [AGE.infant],
      base: 0,
      markType: "schema",
      focusCost: 10,
      effects: [{ kind: "heal.hot", magnitude: 137, durationMs: 6_000, target: "ally" }],
    },
    {
      id: "piaget.preoperational",
      name: "Preoperational",
      answersAxis: "age",
      answersTag: AGE.toddler,
      answersTags: [AGE.toddler, AGE.child],
      base: 0,
      markType: "schema",
      focusCost: 10,
      effects: [{ kind: "heal.single", magnitude: 137, target: "ally" }],
    },
    {
      id: "piaget.concrete",
      name: "Concrete Operational",
      answersAxis: "age",
      answersTag: AGE.school,
      answersTags: [AGE.school],
      base: 0,
      markType: "schema",
      focusCost: 10,
      effects: [{ kind: "conservation", magnitude: 137, target: "team" }],
    },
    {
      id: "piaget.formal",
      name: "Formal Operational",
      answersAxis: "age",
      answersTag: AGE.adolescent,
      answersTags: [AGE.adolescent],
      base: 0,
      markType: "schema",
      focusCost: 10,
      effects: [{ kind: "shield.team", magnitude: 137, durationMs: 8_000, target: "team" }],
    },
  ],
  /** S2 · Accommodation: 103 team shield + the healer-E 15% team mitigation. */
  defense: {
    id: "piaget.accommodation",
    name: "Accommodation",
    base: 0,
    mitigation: { magnitude: 0.15, durationMs: 6_000, target: "team" },
    cooldownMs: 12_000,
    focusCost: 20,
    effects: [{ kind: "shield.team", magnitude: 103, durationMs: 6_000, target: "team" }],
  },
  /** S3 · Object Permanence: 4 s at no less than 1 HP, then 143. */
  chain: {
    id: "piaget.object-permanence",
    name: "Object Permanence",
    base: 0,
    cooldownMs: 25_000,
    focusCost: 30,
    effects: [{ kind: "ally.undying", magnitude: 143, durationMs: 4_000, target: "ally" }],
  },
  /** S4 · Equilibration: 257 team heal + 80 per Mark spent (healing, not damage). */
  ultimate: {
    id: "piaget.equilibration",
    name: "Equilibration",
    base: 0,
    heal: 257,
    healTarget: "team",
    cooldownMs: 60_000,
    focusCost: 50,
    // The Marks pay HEALING, so the damage term is zero and the payload rides
    // the effect (Skinner's Shaping is the precedent for a healer's F).
    perMark: 0,
    foreignMarkBonus: 0.5,
    maxMarksConsumed: 6,
    effects: [
      { kind: "equilibration.release", magnitude: 80, target: "team" },
      { kind: "team.cleanse", target: "team" },
    ],
  },
  // The stage sequence and the core phenomena (object permanence,
  // conservation) replicate; the ages are earlier and the stages less
  // discrete than Piaget proposed, which the codex says.
  evidenceStatus: "contested",
};
