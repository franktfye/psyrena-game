import type { Hero, ModelingSpec } from "../types";
import { AOE_MAP_WIDE_M } from "../combat.ts";

/**
 * Albert Bandura — "The Mirror". FLEX, base 85, palette kit.
 *
 * Design (Frank, 2026-10-24): observational learning's four processes ARE the
 * controls.
 *
 *   ATTENTION     his model is picked for him: the most SALIENT teammate, the
 *                 one doing the most right now (Bandura: we copy competent,
 *                 high-status models). Tapping a party frame overrides it.
 *   RETENTION     keys 1–4 fill with the model's last four different skills.
 *   REPRODUCTION  pressing a key casts the copy, and empties the slot.
 *   MOTIVATION    a copy pays ×0.8, or ×1.0 when the model's original was
 *                 REWARDED (a crit, a right answer): vicarious reinforcement.
 *
 * A copy keeps the original's EFFECTS (taunt, cleanse, shield, vulnerability,
 * a heal) at the motivation rate, but its NUMBER is Bandura's own palette
 * base, never the original's. So copying Erikson's 405 Virtue cannot break the
 * budget, and copying a healer's 0-damage heal heals for Bandura's base.
 * Solo, with no teammate to watch, he models the BOSS: its blows fill his
 * slots as plain strikes. That is the Bobo doll study (1961): children who
 * watched aggression reproduced it.
 *
 *   LMB  Modeled Aggression       the damage basic
 *   E    Self-Efficacy            self heal + 20% self mitigation
 *   R    Bobo Doll                an inflatable decoy: the boss's single-target
 *                                 blows hit the doll for 4 s, and it rebounds
 *                                 half of what it took at the boss
 *   F    Reciprocal Determinism   the Mark cash-out, split across the triad:
 *                                 person (self mitigation), behaviour (team
 *                                 Amp), environment (boss vulnerability)
 *
 * ★ Every number is DERIVED on the flex row (doc 08 §3): base 85 → weight
 * 0.85 → 80.75/s = 4,845/min, DPS shares 25 / 40 / 9 / 6 / 20, no beat
 * cycle. tools/sim-check.mjs scenario 13 re-derives every one:
 *
 *   S5 basic     25% = 1211/min ÷ 24.1             = 50.3 → 50
 *   S1 palette   40% = 1938/min ÷ 7.5 = 258.4 per reproduction at the
 *                reference mix: half motivated (×1.0), 45% not (×0.8), 5%
 *                empty rehearsals (×0.5) → mean ×0.885 → base 292:
 *                motivated 292 · unmotivated 234 · rehearsal 146
 *   S2           9% heal = 436/min ÷ 5             = 87.2 → 87, + 20% self
 *                mitigation for 6 s (the DPS-row E)
 *   S3           6% = 291/min ÷ 2.4                = 121, AOE
 *   S4           20% = 969 at 1/min: 30% direct 291, 70% over 6 Marks × 1.25
 *                foreign mix = 678 ÷ 7.5 = 90 per Mark
 *
 * The Bobo rebound (half of at most two absorbed 100-point blows a cast) and
 * the triad riders are utility on top, like Ainsworth's Exploration window.
 */
export const BANDURA_MODELING: ModelingSpec = {
  slots: 4,
  unmotivatedMult: 0.8,
  motivatedMult: 1.0,
  emptyMult: 0.5,
  // Attention follows who is doing well NOW: a burst ten seconds ago counts half.
  salienceHalfLifeS: 10,
  // Unrehearsed copies fade (retention is not permanent); 20 s is about
  // thirteen GCDs, so a slot is only lost by ignoring it.
  retentionMs: 20_000,
};

export const BANDURA: Hero = {
  id: "bandura",
  displayName: "Bandura — The Mirror",
  theory: "Social learning: observational learning (attention, retention, reproduction, motivation), modeling, self-efficacy, reciprocal determinism",
  role: "flex",
  kit: "palette",
  // Role weight, not the basic's damage (that is basic.base).
  baseDamage: 85,
  modeling: BANDURA_MODELING,
  /** S5 · 1211/min ÷ 24.1 = 50. */
  basic: {
    id: "bandura.modeled-aggression",
    name: "Modeled Aggression",
    base: 50,
    cooldownMs: 600,
    focusCost: 0,
    effects: [],
  },
  // S1 · the four Retention slots. No answer tags: whatever he reproduces is
  // "right" during Shapeshift (the chain-kit rule — he copies, he does not
  // diagnose). The sim swaps in the copied skill's name and effects per cast.
  palette: [1, 2, 3, 4].map((n) => ({
    id: `bandura.observe-${n}`,
    name: `Retention ${n}`,
    base: 292,
    markType: "modeling" as const,
    effects: [{ kind: "modeling.reproduce", magnitude: n - 1 }],
  })),
  /** S2 · Self-Efficacy: 87 self heal + 20% self mitigation, the DPS-row E. */
  defense: {
    id: "bandura.self-efficacy",
    name: "Self-Efficacy",
    base: 0,
    heal: 87,
    mitigation: { magnitude: 0.2, durationMs: 6_000, target: "self" },
    cooldownMs: 12_000,
    focusCost: 20,
    effects: [],
  },
  /** S3 · Bobo Doll: 121 AOE, and the decoy for 4 s. */
  chain: {
    id: "bandura.bobo-doll",
    name: "Bobo Doll",
    base: 121,
    aoeRadius: AOE_MAP_WIDE_M,
    cooldownMs: 25_000,
    focusCost: 30,
    effects: [{ kind: "decoy", magnitude: 0.5, durationMs: 4_000, target: "boss" }],
  },
  /** S4 · Reciprocal Determinism: 291 direct + 90 per Mark, and the triad. */
  ultimate: {
    id: "bandura.reciprocal-determinism",
    name: "Reciprocal Determinism",
    base: 291,
    cooldownMs: 60_000,
    focusCost: 50,
    perMark: 90,
    foreignMarkBonus: 0.5,
    maxMarksConsumed: 6,
    effects: [
      { kind: "mitigation.grant", magnitude: 0.15, durationMs: 6_000, target: "self" },
      { kind: "team.amp", magnitude: 0.06, durationMs: 6_000, target: "team", label: "Reciprocal Determinism", icon: "triad" },
      { kind: "vulnerability", magnitude: 0.08, durationMs: 6_000, target: "boss", icon: "triad" },
    ],
  },
  // Observational learning and self-efficacy are among the best-supported
  // ideas in psychology; the Bobo doll studies' realism has been questioned.
  evidenceStatus: "contemporary",
};
