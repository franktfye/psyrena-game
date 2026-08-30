import type { Hero } from "../types";
import { AOE_MAP_WIDE_M } from "../combat.ts";

/**
 * Freud — "The Analyst". First hero. DPS, base 100, palette kit.
 *
 * ★ Numbers are the ROLE CONTRACT's, not doc 03's originals (2026-08-02).
 *
 * `docs/psyrena-boss-math-nightmare-3p.json` derives every base from one
 * formula (doc 08 §3):
 *
 *     base = (budget × role weight × share) ÷ (casts per second × beat factor)
 *
 * at budget 95, weight 1.00, beat factor 1.2 for skills and 1.1 for basics.
 * The five slots below reproduce that derivation exactly and sum back to
 * 95.0000 reference DPS; rounding them to integers (doc 02: "Base | fixed
 * integer") costs 0.075%. The boss's HP curve and its 4-corner clear matrix are
 * derived FROM these numbers, so they are not free to edit — change the sheet
 * and re-export, never this file alone.
 *
 * What moved, and why the old values were wrong:
 *   - basic 100 → 54. `baseDamage` is the role WEIGHT; the sim was reading it
 *     as the basic's damage, paying out 44 DPS where the contract budgets 24.
 *   - palette 180 → 253. Doc 03 put 46% of a hero's damage on the free basic
 *     and 28% on the palette the whole game is about. The contract inverts it.
 *   - E 0 → heal 86 + 20% mitigation. It was a six-sided die on which only one
 *     face healed; a DPS owns exactly one reliable defensive button (doc 08 §4.1).
 *   - R 0 → 119. The slot had a 6% damage share and was paying none of it.
 *   - F +342 direct. Ultimates split 30% direct / 70% Mark payload (doc 08 §2.1);
 *     only the payload existed.
 *
 * Cooldowns and Focus costs are unchanged and already matched the sheet.
 */
export const FREUD: Hero = {
  id: "freud",
  displayName: "Freud — The Analyst",
  theory: "Psychosexual stages; id/ego/superego; defense mechanisms",
  role: "dps",
  kit: "palette",
  // Role weight, NOT the basic attack's damage — see `basic` below.
  baseDamage: 100,
  // Doc 03: Id ×0.8 → Ego ×1.0 → Superego ×1.5. Advanced by a CLOCK
  // (`BEAT_PERIOD_S`), never by a player input — doc 02's automatic cycle.
  beats: [
    { name: "Id", multiplier: 0.8 },
    { name: "Ego", multiplier: 1.0 },
    { name: "Superego", multiplier: 1.5 },
  ],
  // S5 · 25% share ÷ (24.1 casts/min × 1.1 beat factor) = 53.75 → 54.
  basic: {
    id: "freud.basic",
    name: "Id → Ego → Superego",
    base: 54,
    cooldownMs: 600,
    focusCost: 0,
    effects: [],
  },
  // S1 · 40% share ÷ (7.5 casts/min × 1.2 beat factor) = 253.33 → 253.
  palette: [
    { id: "freud.stage.oral", name: "Oral Stage", answersAxis: "age", answersTag: "age.infant", base: 253, markType: "analysis", effects: [] },
    { id: "freud.stage.anal", name: "Anal Stage", answersAxis: "age", answersTag: "age.toddler", base: 253, markType: "analysis", effects: [] },
    { id: "freud.stage.phallic", name: "Phallic Stage", answersAxis: "age", answersTag: "age.child", base: 253, markType: "analysis", effects: [] },
    { id: "freud.stage.latency", name: "Latency Stage", answersAxis: "age", answersTag: "age.school", base: 253, markType: "analysis", effects: [] },
    { id: "freud.stage.genital", name: "Genital Stage", answersAxis: "age", answersTag: "age.adolescent", base: 253, markType: "analysis", effects: [] },
  ],
  /**
   * S2 · 9% share as healing ÷ (5 casts/min × 1.2) = 85.5 → 86, plus the DPS
   * row's 20% self-mitigation for 6 s on a 12 s cooldown.
   *
   * The floor is GUARANTEED on every cast. The six mechanisms still roll, but
   * as riders on top of it rather than instead of it — the psychoanalytic
   * fantasy (you never know which defence surfaces) survives, and the slot
   * does its job every time. 86 is 26% of his 325 HP bar; if doc 08 §6.1's
   * recommendation to author healing as % of max HP lands, that is the number.
   */
  defense: {
    id: "freud.defense",
    name: "Defense Mechanism",
    base: 0,
    heal: 86,
    mitigation: { magnitude: 0.2, durationMs: 6_000, target: "self" },
    cooldownMs: 12_000,
    focusCost: 20,
    // Rider pool — one rolled at random server-side, ON TOP of the floor above.
    effects: [
      { kind: "repression.absorb", target: "self" },
      { kind: "denial.debuff-immunity", target: "self" },
      { kind: "projection.reflect", magnitude: 0.4, target: "self" },
      { kind: "displacement.redirect", target: "self" },
      { kind: "sublimation.damage-to-focus", target: "self" },
      { kind: "regression.heal", magnitude: 0.15, target: "self" },
    ],
  },
  /**
   * S3 · 6% share ÷ (2.4 casts/min × 1.2) = 118.75 → 119.
   *
   * ★ AOE (2026-08-02). Free association ranges over whatever surfaces, so the
   * skill lands on every valid target on the map rather than the current
   * target alone. NIGHTMARE is a single-target fight, so this is inert today
   * and becomes live the moment a boss brings adds — the damage number is
   * unchanged either way, because the contract budgets the slot per cast, not
   * per target hit.
   */
  chain: {
    id: "freud.free-association",
    name: "Free Association",
    base: 119,
    aoeRadius: AOE_MAP_WIDE_M,
    cooldownMs: 25_000,
    focusCost: 30,
    effects: [{ kind: "palette.auto-correct", magnitude: 3, target: "self" }],
  },
  /**
   * S4 · 20% share = 1140 per cast at 1/min, split 30% direct / 70% payload:
   *   direct  = 1140 × 0.30 = 342
   *   perMark = 798 ÷ (6 Marks × 1.25 foreign-mix) = 106.4 → 106
   *
   * ⚠️ `perMark` is BONDED to `maxMarksConsumed`. The payload is a fixed 798 of
   * budget spread across the cap, so moving the cap without re-deriving perMark
   * silently throws the ultimate off budget (at cap 3 it would be ~213 — which
   * is where doc 03's original "200 per Mark" came from; canon was written for
   * a cap of 3.19, not 6). Move both in the sheet, or move neither.
   *
   * Note the ultimate is the one slot Marks do NOT multiply — they are the
   * payload, so double-dipping would be wrong. That costs it ~33% against the
   * rest of the kit at a steady board, and it is already priced into the boss's
   * HP curve. Do not "fix" it.
   */
  ultimate: {
    id: "freud.dream-analysis",
    name: "Dream Analysis",
    base: 342,
    cooldownMs: 60_000,
    focusCost: 50,
    perMark: 106,
    foreignMarkBonus: 0.5,
    maxMarksConsumed: 6, // doc 07 #p-3 cap, mirrored in shared/types.ts
    effects: [{ kind: "summon.dream-ghost", target: "boss" }],
  },
  // Psychosexual stages are taught as history of the field, not current
  // science — the flagship case for surfacing evidence status (doc 07 #c-1).
  evidenceStatus: "historical",
};
