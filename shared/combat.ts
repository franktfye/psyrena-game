/**
 * The one damage pipeline.
 *
 *   Hit = Base x Beat x (1 + 0.06 x Marks) x (1 + Amp) x Gear x Format
 *
 * Six multiplications per hit, per `02-combat-system.md`. Everything in the
 * game — damage, healing, shields, buffs — resolves through this function.
 * There is no second pipeline, and there must never be one.
 */

export const COMBAT = {
  /** Damage the boss takes per Mark stack. */
  markBonus: 0.06,
  /** Mark board ceiling. */
  maxMarks: 10,
  /** Team amplification ceiling. */
  maxAmp: 0.5,
  /** Full best-in-slot gear multiplier. Deliberately tiny — the 12% Rule. */
  maxGear: 1.12,
  /** Bonus for an ultimate consuming another hero's Mark type. */
  crossConsumptionBonus: 0.5,
  /** Skill cast landed on the hero's payoff beat. */
  payoffBeatBonus: 0.25,
  /** Overheal-to-Amp conversion: this many points of overheal = +1% Amp. */
  overhealPerAmpPercent: 1000,
  /**
   * Mitigation hard cap — doc 08 §1.1, resolves 07 S-8.
   *
   * `damage taken = incoming × (1 − Mitigation)`. Sources are SKILLS ONLY:
   * gear contributes 0 so the 12% Rule stays damage-side. Additive, then
   * clamped here. Piaget alone stacks 0.35 (0.10 palette rider + 0.25 E), so
   * the 5 points of headroom are deliberate — two tanks must not trivially cap.
   */
  maxMitigation: 0.4,
  /** Critical hits: chance per player hit, and the damage multiplier. */
  critChance: 0.15,
  critMult: 1.5,
} as const;

/**
 * Seconds each beat of the 3-beat cycle holds before the next one comes up.
 *
 * The cycle is a CLOCK, not a player input — doc 02: "Basic attacks cycle
 * automatically: beat 1 (×0.8) → beat 2 (×1.0) → beat 3 (×1.5) → repeat", and
 * the Haste stat is defined as "speeds the 3-beat cycle", which only means
 * something if a period exists to speed up. No period was ever written down;
 * this is it.
 *
 * 1.5 s is chosen to match the GCD, which makes the boss-math sheet's core
 * assumption true by construction rather than by hope: the payoff beat occupies
 * exactly one GCD slot in three, so a player who routes skills into it lands
 * roughly half their casts on it (the sheet's `referenceExecution.payoff = 0.5`)
 * without being able to park on it. It also puts 1.78 full cycles inside the 8 s
 * palette window — reliably one payoff chance per window, rarely two — and makes
 * doc 02's "telegraphed one beat early" exactly one GCD of warning.
 */
export const BEAT_PERIOD_S = 1.5;

/**
 * Canon standing height, in metres, that hero glbs are normalised to at load
 * (both the hub and arena loaders scale the rig's bounding height to this).
 * Per-hero overrides correct for rig proportions: Skinner's mesh is far
 * narrower than the others (bind width/height 0.78 vs Freud's 0.96), which
 * made him read a full head taller at equal height — he stands at 90%.
 */
export const HERO_HEIGHT_M = 1.8;
export const HERO_HEIGHT_OVERRIDES: Record<string, number> = {
  skinner: HERO_HEIGHT_M * 0.9,
};
export function heroHeightM(heroId: string): number {
  return HERO_HEIGHT_OVERRIDES[heroId] ?? HERO_HEIGHT_M;
}

/**
 * Radius, in metres, standing for "every valid target on the map".
 *
 * A finite number rather than Infinity so the value survives JSON round-trips
 * into the server schema. Any arena is far smaller than this.
 */
export const AOE_MAP_WIDE_M = 1000;

/**
 * Resolve a set of active mitigation magnitudes into the term the damage
 * pipeline uses. Additive, then capped — doc 08 §1.1.
 */
export function resolveMitigation(magnitudes: readonly number[]): number {
  const raw = magnitudes.reduce((sum, m) => sum + m, 0);
  return Math.min(Math.max(raw, 0), COMBAT.maxMitigation);
}

/** `damage taken = incoming × (1 − Mitigation)`. The only defensive formula. */
export function applyMitigation(incoming: number, mitigation: number): number {
  return incoming * (1 - Math.min(Math.max(mitigation, 0), COMBAT.maxMitigation));
}

/**
 * Threat ("hate") — who the boss swings at.
 *
 * Threat is damage-derived only: every point of damage a hero deals banks
 * threat at `damage`, scaled by that hero's THREAT STANCE if they hold one
 * (`ThreatStance` in shared/types.ts). Healing generates none here (doc 02 has
 * no healing-threat rule yet). The boss attacks the highest-threat living hero;
 * AoE phases hit everyone regardless.
 *
 * ★ CHANGED 2026-08-03 — the automatic `tank: 5.0` is GONE.
 *
 * It gave every hero whose data said `role: "tank"` a permanent 5× with no
 * button attached, so "hold aggro" was decided at character select and a tank
 * could never *choose* to drop it. Pavlov's *Discrimination* replaces it: the
 * same 500%-class multiplier, but as a stance the player turns on — which is
 * the whole point of a passive you have to activate, and it makes deliberately
 * shedding aggro (the discrimination half of the theory: respond to THIS bell,
 * not that one) a real play instead of an impossibility.
 *
 * The migration cost is real and deliberate: a tank with no stance authored
 * yet banks 1× like everyone else. Piaget and Ainsworth need theirs
 * (*Centration* and *Proximity Maintenance* — doc 07 #s-9); until then the
 * fight sim's AI allies hold their stance open from the first swing
 * (`SimAllySpec.threatStance`), so nothing regresses in a live fight.
 */
export const THREAT = {
  /** Threat banked per point of damage dealt, with no stance held. */
  damage: 1.0,
} as const;

export type MatchFormat = "solo" | "match";

/** Damage/score multiplier by format. Doc 01. */
export const FORMAT_MODIFIER: Record<MatchFormat, number> = {
  solo: 0.8,
  match: 1.0,
};

/** Multiplier applied to all POSITIVE effects by format. Doc 02. */
export const BUFF_STRENGTH: Record<MatchFormat, number> = {
  solo: 0.8,
  match: 1.0,
};

export interface HitContext {
  /** Fixed per hero/skill. Never changes with gear or level. */
  base: number;
  /** Current beat multiplier: 0.8 | 1.0 | 1.5. */
  beat: number;
  /** Marks currently on the boss, 0..10. */
  marks: number;
  /** Team amplification, 0..0.50. */
  amp: number;
  /** Gear multiplier, 1.00..1.12. */
  gear: number;
  /** Room-level format constant. */
  format: MatchFormat;
  /** True when this is a skill (not a basic attack) cast on the payoff beat. */
  onPayoffBeat?: boolean;
  /** True for skills, false for basic attacks. See BEAT_APPLIES_TO_SKILLS. */
  isSkill?: boolean;
}

/**
 * ⚠️ UNRESOLVED DESIGN CONTRADICTION — must be settled before any tuning pass.
 *
 * `02-combat-system.md` states BOTH of these, and they disagree:
 *
 *   (a) line ~27: Beat (0.8/1.0/1.5) is a term in the formula for EVERY hit.
 *   (b) line ~66: "Skills cast on the payoff beat gain +25%."
 *
 * The worked example applies x1.5 to a palette skill, i.e. reading (a) — which
 * makes (b) dead text. Every balance number in the game hangs off this, and so
 * does the headline "skill is worth 3.4x, gear 1.12x" claim.
 *
 * This flag makes the ambiguity explicit and switchable rather than silently
 * baked in. Current default follows the worked example so existing numbers
 * reproduce. The recommendation in `07-open-design-issues.md#p-1` is to flip it
 * to `false`: Beat scales basics only, skills get the flat +25%. That preserves
 * the timing skill without making every off-beat skill cast feel punishing.
 */
export const BEAT_APPLIES_TO_SKILLS = true;

export function resolveHit(ctx: HitContext): number {
  const marks = 1 + COMBAT.markBonus * Math.min(ctx.marks, COMBAT.maxMarks);
  const amp = 1 + Math.min(ctx.amp, COMBAT.maxAmp);
  const gear = Math.min(ctx.gear, COMBAT.maxGear);

  let beat: number;
  if (ctx.isSkill && !BEAT_APPLIES_TO_SKILLS) {
    beat = ctx.onPayoffBeat ? 1 + COMBAT.payoffBeatBonus : 1;
  } else {
    beat = ctx.beat;
  }

  return ctx.base * beat * marks * amp * gear * FORMAT_MODIFIER[ctx.format];
}

/**
 * Ultimate damage from a consumed Mark board.
 *
 * `own` and `foreign` are Mark counts by origin. Foreign Marks pay the
 * cross-consumption bonus — the single rule that makes team composition and
 * call-outs matter, per doc 02.
 */
export function resolveUltimate(params: {
  /**
   * The 30% direct share — what you get for pressing F with a thin board
   * (doc 08 §2.1). Rides Amp/Gear/Format like everything else, but NOT Marks:
   * the Marks are the payload, so multiplying by them too would double-dip.
   */
  direct?: number;
  perMark: number;
  own: number;
  foreign: number;
  maxMarksConsumed: number;
  amp: number;
  gear: number;
  format: MatchFormat;
}): { damage: number; marksConsumed: number } {
  const budget = Math.min(params.maxMarksConsumed, params.own + params.foreign);
  // Spend foreign Marks first — they are worth more, so a partial consume
  // should take the valuable ones.
  const foreign = Math.min(params.foreign, budget);
  const own = Math.min(params.own, budget - foreign);

  const markValue = own + foreign * (1 + COMBAT.crossConsumptionBonus);
  const amp = 1 + Math.min(params.amp, COMBAT.maxAmp);
  const gear = Math.min(params.gear, COMBAT.maxGear);
  const scale = amp * gear * FORMAT_MODIFIER[params.format];

  return {
    damage: ((params.direct ?? 0) + params.perMark * markValue) * scale,
    marksConsumed: own + foreign,
  };
}

/** Overheal and expired shield absorption both convert into team Amp. */
export function overhealToAmp(overheal: number, format: MatchFormat): number {
  const raw = overheal / COMBAT.overhealPerAmpPercent / 100;
  return Math.min(raw * BUFF_STRENGTH[format], COMBAT.maxAmp);
}

export interface ScoreInput {
  damage: number;
  mechanics: number;
  survival: number;
  speed: number;
  teamSize: number;
  format: MatchFormat;
  wonMatch: boolean;
}

/** BaseScore weights from `02-combat-system.md`. Mechanics is weighted highest on purpose. */
export const SCORE_WEIGHTS = {
  damage: 0.3,
  mechanics: 0.4,
  survival: 0.2,
  speed: 0.1,
} as const;

export function finalScore(input: ScoreInput): number {
  const base =
    input.damage * SCORE_WEIGHTS.damage +
    input.mechanics * SCORE_WEIGHTS.mechanics +
    input.survival * SCORE_WEIGHTS.survival +
    input.speed * SCORE_WEIGHTS.speed;

  // NOTE: a single global divide by teamSize is not actually fair across all
  // four terms — mechanics events scale with headcount, speed and survival do
  // not. See `07-open-design-issues.md#p-2`.
  const perCapita = base / input.teamSize;

  const modifier =
    input.format === "solo" ? 0.8 : input.wonMatch ? 1.2 : 1.0;

  return perCapita * modifier;
}
