/**
 * Psyrena shared data model.
 *
 * This package is imported by BOTH the Babylon client (prediction, display) and
 * the Colyseus server (authority), exactly as specified in
 * `06-technical-architecture.md`. One definition, no dual-implementation drift.
 *
 * Design rule from doc 06: adding a hero or a boss is adding DATA, not code.
 * If you find yourself writing a `switch (heroId)` anywhere, the model is wrong.
 */

export type Role = "tank" | "healer" | "dps" | "support" | "control" | "flex";

export type HeroId =
  | "pavlov"
  | "skinner"
  | "kohlberg"
  | "bronfenbrenner"
  | "vygotsky"
  | "freud"
  | "erikson"
  | "piaget"
  | "maslow"
  | "seligman"
  | "csikszentmihalyi"
  | "bandura"
  | "beck"
  | "ainsworth";

/** Which dimension of the boss's state a palette entry answers. */
export type PhaseAxis =
  | "age"
  | "behavior"
  | "distortion"
  | "pressure"
  | "attachment"
  | "need"
  | "flow"
  | "deficit";

export type MarkType =
  | "analysis"
  | "judgment"
  | "schema"
  | "crisis"
  | "reflex"
  | "conditioning"
  | "systems"
  | "scaffold"
  | "need"
  | "flourish"
  | "flow"
  | "reframe"
  | "bond"
  | "reinforcement"
  | "modeling";

/** Kit archetype — see `02-combat-system.md`. Chain kits are the on-ramp. */
export type KitArchetype = "palette" | "chain";

export interface Effect {
  kind: string;
  magnitude?: number;
  durationMs?: number;
  /**
   * Gate: the rider fires only while the CASTER carries this state; the cast
   * itself still resolves, this effect just does nothing. The ability-side
   * twin of `PaletteEntry.requiresBossState`. First user: Pavlov's
   * *Spontaneous Recovery* Pairing refund, live only while he is
   * "extinguished" (his own ultimate's `conditioning.reset` puts him there).
   */
  requiresSelfState?: string;
  target?: "self" | "ally" | "team" | "boss";
  /**
   * Display name and buff-tile icon for an effect whose generic kind needs
   * the skill's own words — a `team.amp` is Ainsworth's "Exploration" but
   * Bandura's "Reciprocal Determinism". Omit for the kind's default.
   */
  label?: string;
  icon?: string;
}

/**
 * Mitigation granted by an ability — doc 08 §1.1.
 *
 * Additive with every other live source, then hard-capped at
 * `COMBAT.maxMitigation`. Skills only; gear never contributes.
 */
export interface MitigationGrant {
  /** Fraction of incoming damage removed, 0..1 before the cap. */
  magnitude: number;
  durationMs: number;
  target: "self" | "team";
}

/**
 * Damage over time (2026-10-24): part of a cast's damage paid as ticks after
 * impact instead of all at once. The SHARE is moved, not added — the cast's
 * total is unchanged, so the budget derivations (doc 08) still hold.
 *
 * With `zoneRadius` the ticks belong to a patch of GROUND at the impact point:
 * each tick lands on every hostile inside it at that moment, so a monster that
 * walks in mid-way takes the rest. Without it, the ticks ride the hostiles the
 * hit struck. NIGHTMARE is one target standing still, so in a boss fight the
 * two shapes deliver the same numbers.
 */
export interface OverTime {
  /** Fraction of the cast's damage paid as ticks, 0..1. */
  share: number;
  durationMs: number;
  /** Ticks across the duration. Default: one per second. */
  ticks?: number;
  /** Ground-zone radius in metres; omit for a DoT on whatever was struck. */
  zoneRadius?: number;
  /** Name floated with each tick in the boss fight ("Identity Crisis"). */
  label: string;
}

export interface Ability {
  id: string;
  name: string;
  base: number;
  /**
   * Flat healing delivered on cast, through the same pipeline as damage —
   * doc 08 §1: "a heal is a hit with the sign flipped". Separate from `base`
   * because an ability can do both (tank ultimates pay 75% damage / 25% heal).
   */
  heal?: number;
  /**
   * Who `heal` lands on. Omit for "self" — the DPS row's self-heal shape.
   *
   * "team" means the number is the TOTAL delivered, split across the living
   * party (doc 08 §4.3 quotes Seligman's team heals that way: "85 split across
   * the team (~28 each in a 3-stack)"). Quoting the total is what keeps the
   * budget honest — a per-head number would silently scale with team size.
   */
  healTarget?: "self" | "team";
  /** Mitigation this ability grants on cast. See `MitigationGrant`. */
  mitigation?: MitigationGrant;
  /**
   * Radius in metres over which this ability applies its damage. Omit for
   * single-target. `AOE_MAP_WIDE_M` means every valid target on the map.
   */
  aoeRadius?: number;
  /**
   * Radius in metres of a PERSISTENT ZONE this ability drops on the ground,
   * as distinct from `aoeRadius` (which is the reach of one instant hit).
   *
   * Heroes stand inside it to get whatever the zone's effect grants; Pavlov's
   * *Extinction* dome is the first. The zone's magnitude and lifetime ride the
   * effect entry, not this field — this is only how big it is.
   */
  zoneRadius?: number;
  /** Damage over time — see `OverTime`. */
  overTime?: OverTime;
  cooldownMs: number;
  focusCost: number;
  effects: Effect[];
}

export interface PaletteEntry {
  id: string; // "freud.stage.oral"
  name: string;
  /**
   * Which axis of the boss's state this entry answers, and with what tag.
   *
   * ⚠️ OPTIONAL since Pavlov (2026-08-03), and only for **chain kits**. Doc 02
   * splits the roster in two: palette kits *diagnose* the boss (answer or eat
   * a Fixation), chain kits *run a sequence* — there is nothing to be wrong
   * about, which is exactly why the chain kit is the beginner on-ramp. A chain
   * hero's S1 entries therefore carry no answer tag, and the resolver treats a
   * missing pair as "always correct" rather than "never correct".
   */
  answersAxis?: PhaseAxis;
  answersTag?: string; // "age.infant" — server compares to the boss's live phase
  /**
   * Several tags this entry answers, when one button covers more than one
   * form. Piaget's Preoperational stage spans ages 2 to 7, which NIGHTMARE
   * shows as two forms (toddler and child), so his four stages answer five
   * forms. When present the sim matches the live form's tag against this
   * list instead of the button's position (`answersTag` stays for display).
   */
  answersTags?: string[];
  base: number;
  markType: MarkType;
  /**
   * Gate: castable only while the boss carries this state, greyed otherwise.
   * Pavlov's CS is gated on "conditioned" — the state his own UCS/NS pairing
   * loop puts the boss into. Omit for an always-available entry.
   */
  requiresBossState?: string;
  /**
   * Focus this entry costs, when it differs from the flat palette scaffold
   * (`PALETTE_FOCUS_COST` in shared/fight/costs.ts). Erikson's two keys cost
   * more and a completed pair refunds (`PsychosocialSpec.pairFocusRefund`), so
   * correct play nets exactly the scaffold price and wrong play pays extra.
   */
  focusCost?: number;
  /**
   * A cooldown of this entry's own, on top of the GCD. Absent = the GCD is
   * the only pacing (the bar draws a 3 s display scaffold). The server already
   * reads it (server/fight.mjs `cooldownSecondsFor`); the sim enforces it too,
   * so offline play keeps the same pacing. First user: Ainsworth's
   * Disorganized, whose team immunity would otherwise run on the GCD.
   */
  cooldownMs?: number;
  /**
   * Gate: castable only after this many OTHER palette entries were cast
   * within the window — Ainsworth's Disorganized is contradictory strategies,
   * so it needs two different styles behind it first.
   */
  requiresVariety?: { distinct: number; withinMs: number };
  /**
   * Bar transform: while this entry's gate is open, it REPLACES the ability
   * with the given id on the action bar instead of occupying a slot of its
   * own. The base may be another palette entry or the kit's BASIC attack —
   * Pavlov's CS rides his bell (`pavlov.ns`), so a conditioned boss turns
   * the attack button itself into the payoff.
   *
   * Doc 03 already writes Pavlov this way ("this same button becomes…"), and it
   * is what lets a 7-ability kit fit the five-input template without a sixth
   * key. Omit for an entry that owns its own slot.
   */
  transformsFrom?: string;
  /** Damage over time — see `OverTime`. */
  overTime?: OverTime;
  effects: Effect[];
}

export interface UltimateAbility extends Ability {
  /** Damage contributed per Mark consumed. */
  perMark: number;
  /** The one cross-consumption constant. Consuming another hero's Marks pays more. */
  foreignMarkBonus: number;
  /**
   * Maximum Marks this ultimate will consume.
   *
   * NOT in the original doc — doc 02 says ultimates "consume all Marks", but the
   * Mark board caps at 10 and five heroes each own a Mark-consuming ultimate, so
   * "consume all" means exactly one player per team can ever cash out and the
   * other four F keys are dead. Capping consumption lets two staggered cash-outs
   * share a window. See `07-open-design-issues.md#p-3`.
   */
  maxMarksConsumed: number;
}

/**
 * A hero's threat stance — the ONLY way a hero banks threat above 1× per point
 * of damage (doc 02's hate system, rewritten 2026-08-03).
 *
 * Before this, `THREAT.tank` handed every tank an automatic 5× forever, which
 * made holding aggro a property of the character-select screen rather than
 * something a player does. A stance is a toggle: on, the hero pulls; off, the
 * hero is a normal damage dealer who can hand aggro away on purpose. Pavlov's
 * *Discrimination* is the first, and the fallback is gone — a tank without a
 * stance banks 1×, same as everyone.
 */
export interface ThreatStance {
  id: string; // "pavlov.discrimination"
  name: string; // "Discrimination"
  /** Threat banked per point of damage while held. Replaces `THREAT.damage`. */
  multiplier: number;
  /**
   * True when the stance costs nothing and holds until toggled off — the
   * shape a "passive you activate" takes. A false here would mean a stance on
   * a timer, which nothing uses yet.
   */
  toggle: boolean;
}

/**
 * Piaget's stages as a sequence the sim watches — the shape of
 * `PIAGET_DEVELOPMENT` in shared/heroes/piaget.ts, which documents the price.
 * The palette's entries ARE the stages, in order; this only says what
 * completing them in order is worth.
 */
export interface DevelopmentSpec {
  /** Focus refunded when the last stage lands right after the first three, in order. */
  sequenceFocusRefund: number;
  /** A run lapses if the next stage does not follow within this many ms. */
  stepWindowMs: number;
}

/**
 * Bandura's observational learning, as data — `BANDURA_MODELING` in
 * shared/heroes/bandura.ts documents every number. The four processes map to
 * the engine: ATTENTION picks the model (the most salient teammate, or the
 * one the player taps), RETENTION fills the palette slots with the model's
 * casts, REPRODUCTION is pressing a slot, MOTIVATION is the multiplier a
 * reproduction pays (full when the model's original was rewarded).
 */
export interface ModelingSpec {
  /** Retention slots — the palette keys that hold copies. */
  slots: number;
  /** Multiplier on a copy whose original was NOT reinforced. */
  unmotivatedMult: number;
  /** Multiplier on a copy whose original was reinforced (crit, right answer). */
  motivatedMult: number;
  /** Pressing an empty slot: rehearsal, at this fraction. Never a dead key. */
  emptyMult: number;
  /** Salience decays with this half-life, so attention follows who is doing well NOW. */
  salienceHalfLifeS: number;
  /** A retained copy fades after this long unrehearsed. */
  retentionMs: number;
}

/** One quality tier of a bell↔food pairing — see `ConditioningSpec.pairing`. */
export interface PairingQuality {
  /** Probability the pairing takes at all. */
  chance: number;
  /** Pairings banked when it does. */
  pairings: number;
}

/**
 * The classical-conditioning loop, as data the sim runs — the shape of
 * `PAVLOV_CONDITIONING` in shared/heroes/pavlov.ts, which documents every
 * field's derivation. On `Hero.conditioning`; only chain kits carry one.
 */
export interface ConditioningSpec {
  ucrWindowS: number;
  /**
   * Pairings needed to condition, drawn fresh (uniform, inclusive) at the
   * start of every conditioning cycle rather than fixed — so the player cannot
   * count the loop out. `min` and `max` bracket the draw; `min === max` pins it.
   */
  pairingsToCondition: { min: number; max: number };
  conditionedWindowS: number;
  pairing: {
    delay: PairingQuality;
    simultaneous: PairingQuality;
    backward: PairingQuality;
  };
  backwardGraceS: number;
  crStaggerS: number;
  crStaggerEveryNthBell: number;
  spontaneousRecoveryPairings: number;
}

/**
 * The operant-conditioning engine, as data the sim runs — the shape of
 * `SKINNER_REINFORCEMENT` in shared/heroes/skinner.ts, which documents every
 * number's derivation from the healer budget (docs 03 §7 / 08 §3). On
 * `Hero.reinforcement`, the same pattern as `ConditioningSpec` on Pavlov.
 *
 * Two toggles pick the live quadrant: the CONTINGENCY (E) chooses which team
 * behavior earns a consequence, the CONSEQUENCE (R) chooses what it pays.
 * Every proc also banks an Approximation (Shaping's fuel), and every point of
 * effective healing feeds Response Strength (the heal-fueled basic).
 */
export interface ReinforcementSpec {
  /** E "Positive": damage an ally must DEAL to earn one proc. */
  positiveDamagePerProc: number;
  /** E "Negative": seconds an ally must spend taking NO damage per proc. */
  negativeCleanSeconds: number;
  /**
   * R "Reinforcement": heal per proc, keyed by the active contingency — the
   * rarer contingency pays the richer pellet so both land on the same slot
   * budget (docs 03 §7: 20 at ~34 procs/min vs 34 at ~20 procs/min).
   */
  procHeal: { positive: number; negative: number };
  /** R "Punishment": mitigation per proc (doc 08 §1.1 unit, capped 0.40). */
  procMitigation: { magnitude: number; durationMs: number };
  /** Approximation stacks — Shaping's fuel; they extinguish unreinforced. */
  approximation: { capPerAlly: number; durationMs: number };
  /**
   * Response Strength: 1 stack per `healPerStack` EFFECTIVE healing delivered
   * (overheal is excluded — it already pays out as Amp), each boosting the
   * basic by `damagePerStack`, expiring individually — a rolling record of
   * reinforcement history. basic.base is authored at HALF the slot budget so
   * the slot only reaches it at the reference ~5 average stacks.
   */
  responseStrength: {
    healPerStack: number;
    damagePerStack: number;
    maxStacks: number;
    durationMs: number;
  };
  /** The four schedules on keys 1–4 — equal EV per cast, by design. */
  schedules: {
    fixedRatio: { teamTotal: number };
    variableRatio: { low: number; high: number; highChance: number };
    fixedInterval: { tickTeamTotal: number; periodMs: number; durationMs: number };
    variableInterval: { tickTeamTotal: number; tickChancePerSec: number; durationMs: number };
    /** Concurrent windows one interval schedule may keep alive (self-stack cap). */
    maxStacks: number;
  };
  /** Shaping (F): heal per Approximation consumed, on the ally carrying it. */
  shaping: { perApproximation: number };
}

/**
 * One row of Erikson's stage chart (*Identity and the Life Cycle*, 1959) — what
 * the bar shows while this stage is up.
 */
export interface PsychosocialStage {
  /** The crisis, both poles: "Trust vs Mistrust". */
  crisis: string;
  /** The syntonic pole alone, for a button face too small for the crisis. */
  short: string;
  /** Rough age band, as the chart is usually taught: "0 to 1½" (player-facing, so no dashes). */
  age: string;
  /** The basic virtue the stage yields: "Hope". */
  virtue: string;
  /** Radius of significant relations — the basic attack's name: "Mother". */
  relations: string;
}

/**
 * Erikson's life-cycle rotation, as data the sim runs — the shape of
 * `ERIKSON_PSYCHOSOCIAL` in shared/heroes/erikson.ts. On `Hero.psychosocial`,
 * the same data-not-code pattern as `conditioning` / `reinforcement`; the
 * state machine itself is shared/fight/psychosocial.ts.
 */
export interface PsychosocialSpec {
  /** The eight stages, in life order. The rotation walks them and loops. */
  stages: PsychosocialStage[];
  /** A Virtue cast with no stage armed pays `virtue.base × this`. */
  unmatchedVirtueMult: number;
  /** Virtue stacks bank up to this many; Life Review spends them. */
  maxVirtues: number;
  /**
   * Focus returned by a completed pair (key 1 then key 2). Budget-neutral by
   * construction: the two keys' `focusCost`s minus this equal two scaffold
   * palette casts — `tools/sim-check.mjs` scenario 8 holds that line.
   */
  pairFocusRefund: number;
}

export interface Beat {
  name: string; // "Id" | "Ego" | "Superego"
  multiplier: number; // 0.8 | 1.0 | 1.5
}

export interface Hero {
  id: HeroId;
  displayName: string;
  theory: string;
  role: Role;
  kit: KitArchetype;
  /**
   * ROLE WEIGHT, not a damage number. 100 = a full DPS share of the output
   * budget; tank 65, healer 60, support 75, control/flex 85 (doc 08 §3).
   *
   * ⚠️ This is NOT the basic attack's damage — that lives on `basic.base`, and
   * for Freud the two differ by 86% (weight 100, basic base 54). They were the
   * same field until 2026-08-02, which silently paid every hero's LMB out of
   * thin air; see the note on `basic`.
   */
  baseDamage: number;
  /**
   * The three-beat damage cycle, if this hero has one.
   *
   * OPTIONAL, and absent is a real answer. The cycle is Freud's THEORY made
   * playable — Id/Ego/Superego is a stance you read off the bar and time a
   * cast into — so a hero whose theory says nothing about a rhythm should not
   * inherit one. Pavlov is the first: a bell that means ×0.8 now and ×1.5 in
   * three seconds is teaching the opposite of what a conditioned stimulus IS.
   *
   * ⚠️ Absent changes the hero's DERIVATION, not just their multipliers. A kit
   * on the cycle is budgeted at beat factor 1.2 for skills and 1.1 for basics
   * (the averages); a flat kit is budgeted at 1.0, so every base must be
   * correspondingly HIGHER to pay the same share. `verify-hero-budget.mjs` and
   * `sim-check.mjs` both read this field and swap the factor — delete a beat
   * set without re-deriving and the checks fail, which is the point.
   */
  beats?: [Beat, Beat, Beat];
  /**
   * S5 — the basic attack, on its own base derived from the role contract's
   * 25% share (doc 08 §2). Every role has one; a hero who cannot press LMB is
   * a hero who cannot participate while learning.
   */
  basic: Ability;
  palette: PaletteEntry[]; // Q
  defense: Ability; // E
  chain: Ability; // R
  ultimate: UltimateAbility; // F
  /**
   * The hero's threat stance, if they have one. See `ThreatStance` — heroes
   * without one bank threat at 1×, including tanks.
   */
  threatStance?: ThreatStance;
  /**
   * The conditioning loop this hero's chain kit runs, if any — the sim reads
   * it off the hero rather than importing hero-specific constants, per the
   * "adding a hero is adding DATA" rule at the top of this file.
   */
  conditioning?: ConditioningSpec;
  /**
   * The operant engine this hero runs, if any — Skinner's contingency toggles,
   * schedules, Approximations and Response Strength. Same data-not-code
   * pattern as `conditioning`.
   */
  reinforcement?: ReinforcementSpec;
  /**
   * Erikson's stage → virtue rotation, if this hero runs one. Same pattern
   * again: the sim reads it off the hero.
   */
  psychosocial?: PsychosocialSpec;
  /**
   * Piaget's invariant sequence, if this hero runs one: the four stage keys
   * cast IN ORDER refund Focus (shared/heroes/piaget.ts). Same data-not-code
   * pattern as `psychosocial`.
   */
  development?: DevelopmentSpec;
  /**
   * Bandura's observational-learning engine, if this hero runs one: watch a
   * model, retain their skills, reproduce them (shared/heroes/bandura.ts).
   */
  modeling?: ModelingSpec;
  /**
   * Empirical standing of the underlying theory, surfaced in-game.
   *
   * Pillar 1 promises a player who masters a hero "can pass a quiz question
   * about the theory" — which obliges us to say when a theory is taught as
   * history rather than as current science (psychosexual stages being the
   * obvious case). Cheap to add, strengthens the educational pillar.
   * See `07-open-design-issues.md#c-1`.
   */
  evidenceStatus: "contemporary" | "historical" | "contested";
}

export interface PhaseTag {
  axis: PhaseAxis;
  tag: string;
}

export interface MechanicRef {
  id: string;
  params?: Record<string, number | string | boolean>;
}

export type TransitionRule =
  | { kind: "seeded-random"; pool: string[] }
  | { kind: "scripted"; next: string };

export interface BossPhase {
  id: string; // "regressor.infant"
  acceptedTags: PhaseTag[];
  /** Shown to players. MUST never contain the answer — doc 04 design rule. */
  hudCues: string[];
  windowMs: number; // base 8000, widened by Clarity / Vygotsky ZPD
  mechanics: MechanicRef[];
  next: TransitionRule;
}

export interface BossPhaseScript {
  bossId: string;
  displayName: string;
  tier: 1 | 2 | 3;
  enrageMs: number;
  /**
   * Boss HP by team size.
   *
   * NOT in the original doc, and its absence is a blocking gap: doc 04 tunes
   * The Regressor for a "~6:30 kill" without saying at what team size, while
   * doc 02 divides score by teamSize. Without an explicit curve a 3-stack
   * cannot beat the enrage timer at all. See `07-open-design-issues.md#p-2`.
   */
  hpByTeamSize: Record<3 | 4 | 5, number>;
  phases: BossPhase[];
}
