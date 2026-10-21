import type { Hero } from "../types";

/**
 * Mary Ainsworth — "The Safe Haven". TANK, base 65, palette kit.
 *
 * Design (Frank, 2026-10-18): keys 1–4 are the four attachment styles, each a
 * different skill, and each one acts out that style's REUNION, which is what
 * the Strange Situation actually classifies:
 *
 *   1  Secure        comfort, then let go: lifts Fixation off the team and
 *                    opens a short team damage window (Exploration)
 *   2  Avoidant      looks calm, isn't: the biggest hit, sheds threat, and
 *                    for 4 s every hit she takes bleeds out over 4 s instead
 *                    of landing (Sroufe & Waters 1977: heart rate rises)
 *   3  Ambivalent    the taunt: the boss locks on, the team takes less, and
 *                    healing on her is halved while it lasts
 *   4  Disorganized  approach, freeze, shield: every OTHER teammate is immune
 *                    to the boss for 3 s. Needs two different styles inside
 *                    8 s first (contradictory strategies) and has its own
 *                    30 s cooldown. Main & Solomon (1990), not Ainsworth's own
 *                    A/B/C, and the codex says so.
 *
 *   LMB  Sensitivity        her sensitivity scale: a basic that lands within
 *                           1.5 s of a teammate being hit also heals them
 *   E    Safe Haven         team heal + team mitigation + lifts Fixation
 *   R    Strange Situation  separation and reunion: she sheds half her
 *                           threat, and the boss, read, takes +15%
 *   F    Earned Security    the Mark cash-out with a team heal, cleanse and
 *                           a team window (Main & Hesse's term, credited)
 *   Stance  Proximity Maintenance  the 6× threat toggle
 *
 * No `answersAxis` on the four styles: NIGHTMARE has no attachment tags, so
 * the entries are always correct in Shapeshift, like a chain kit's. The
 * `attachment` axis stays in the types for the boss that grows them.
 *
 * ★ Every number is DERIVED, on the tank row exactly as Pavlov's are (doc 08
 * §3: budget 95 × weight 0.65, flat kit, no beat cycle), and with his
 * documented E/R swap: E carries the 15% as a team heal, R the 5% damage.
 * tools/sim-check.mjs scenario 10 re-derives every one:
 *
 *   S5 basic     25% ÷ 24.1/min           = 38.43 → 38
 *   S1 palette   35% ÷ 7.5/min = 172.9/cast, 1296.6/min, spent by style at
 *                the reference cadence 2 : 2 : 2 : 1.5 per minute (key 4 is
 *                capped by its 30 s cooldown, so it is priced at 1.5) with
 *                weights 1.0 : 1.3 : 0.9 : 0.5 (Avoidant hits hardest, the
 *                immunity is mostly utility) → x = 1296.6 / 7.15 = 181.3:
 *                Secure 181 · Avoidant 236 · Ambivalent 163 · Disorganized 91
 *   S2 heal      15% ÷ 5/min              = 111.15 → 111 (team total)
 *   S3           5% ÷ 2.4/min             = 77.19 → 77
 *   S4           20% at 1/min = 741: 75% damage (30% direct 167, 70% over
 *                6 Marks × 1.25 foreign mix = 52 per Mark), 25% heal 185
 *
 * Strange Situation's +15% for 15 s on a 25 s cooldown is the sheet's
 * assumed attack buff at its 0.60 coverage, the same line Generalization
 * holds, so the boss HP curve is sourced whichever tank is in the party.
 */
export const AINSWORTH: Hero = {
  id: "ainsworth",
  displayName: "Ainsworth — The Safe Haven",
  theory: "Attachment: the secure base and safe haven, the Strange Situation, sensitivity, and the attachment styles",
  role: "tank",
  kit: "palette",
  // Role weight, not the basic's damage (that is basic.base).
  baseDamage: 65,
  /**
   * S5 · Sensitivity. 2 s like Pavlov's bell: the slot's 24.1/min share
   * needs ≤ 2.49 s, and a faster basic would out-cast its own budget.
   * The answering heal is a token: what it pays is the lesson (promptness).
   */
  basic: {
    id: "ainsworth.sensitivity",
    name: "Sensitivity",
    base: 38,
    cooldownMs: 2_000,
    focusCost: 0,
    effects: [{ kind: "sensitivity.respond", magnitude: 25, durationMs: 1_500, target: "ally" }],
  },
  palette: [
    {
      id: "ainsworth.secure",
      name: "Secure",
      base: 181,
      markType: "bond",
      effects: [
        { kind: "team.cleanse", target: "team" },
        { kind: "team.amp", magnitude: 0.05, durationMs: 4_000, target: "team" },
      ],
    },
    {
      id: "ainsworth.avoidant",
      name: "Avoidant",
      base: 236,
      markType: "bond",
      effects: [
        { kind: "threat.drop", magnitude: 0.25, target: "self" },
        { kind: "self.stagger", magnitude: 4, durationMs: 4_000, target: "self" },
        { kind: "mitigation.grant", magnitude: 0.15, durationMs: 4_000, target: "self" },
      ],
    },
    {
      id: "ainsworth.ambivalent",
      name: "Ambivalent",
      base: 163,
      markType: "bond",
      effects: [
        { kind: "taunt", durationMs: 4_000, target: "boss" },
        { kind: "mitigation.grant", magnitude: 0.1, durationMs: 4_000, target: "team" },
        { kind: "heal.cut.self", magnitude: 0.5, durationMs: 4_000, target: "self" },
      ],
    },
    {
      id: "ainsworth.disorganized",
      name: "Disorganized",
      base: 91,
      markType: "bond",
      cooldownMs: 30_000,
      requiresVariety: { distinct: 2, withinMs: 8_000 },
      effects: [{ kind: "team.immunity", durationMs: 3_000, target: "team" }],
    },
  ],
  /** S2 · the tank-E shape: team heal total + 25% team mitigation, plus the cleanse. */
  defense: {
    id: "ainsworth.safe-haven",
    name: "Safe Haven",
    base: 0,
    heal: 111,
    healTarget: "team",
    mitigation: { magnitude: 0.25, durationMs: 6_000, target: "team" },
    cooldownMs: 12_000,
    focusCost: 20,
    effects: [{ kind: "team.cleanse", target: "team" }],
  },
  /** S3 · separation (threat shed) and reunion (the boss, read, takes +15%). */
  chain: {
    id: "ainsworth.strange-situation",
    name: "Strange Situation",
    base: 77,
    cooldownMs: 25_000,
    focusCost: 30,
    effects: [
      { kind: "threat.drop", magnitude: 0.5, target: "self" },
      { kind: "vulnerability", magnitude: 0.15, durationMs: 15_000, target: "boss" },
    ],
  },
  ultimate: {
    id: "ainsworth.earned-security",
    name: "Earned Security",
    base: 167,
    heal: 185,
    healTarget: "team",
    cooldownMs: 60_000,
    focusCost: 50,
    perMark: 52,
    foreignMarkBonus: 0.5,
    maxMarksConsumed: 6,
    effects: [
      { kind: "team.cleanse", target: "team" },
      { kind: "team.amp", magnitude: 0.08, durationMs: 8_000, target: "team" },
    ],
  },
  threatStance: {
    id: "ainsworth.proximity-maintenance",
    name: "Proximity Maintenance",
    multiplier: 6,
    toggle: true,
  },
  // The Strange Situation and attachment classification are among the most
  // replicated measures in developmental psychology; the styles' long-run
  // predictions are more debated, and Disorganized is a later addition.
  evidenceStatus: "contemporary",
};
