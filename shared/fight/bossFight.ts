/**
 * The boss fight sim — client authority until the Colyseus room exists.
 *
 * Everything the design docs call "server-owned" lives here, driven by DATA
 * out of `shared/bosses/nightmare.ts` (boss script) and `shared/heroes/*`
 * (the player kit): boss HP, the phase script, the hate/threat table, the
 * Mark board, team Amp, the P2 palette-answer check with Fixation, the P2
 * armor-bypass debuff, Fortress regen, outgoing damage, and the enrage.
 *
 * The sim owns no rendering and no DOM. It talks to the scene through
 * `FightHooks` (boss visuals, world chat, player vitals/buffs, action-bar
 * locks) and exposes `snapshot()` for the boss frame. When the real server
 * lands, this whole module is replaced by snapshot application and the hooks
 * stay — same split as `shared/` vs the sim everywhere else.
 *
 * ★ 2026-08-09 — N INPUT-DRIVEN ACTORS (shared/fight/ACTOR-CONTRACT.md).
 * The fight used to be "one real player + N scripted allies", and ~25 kit
 * fields sat flat on the class because there was only ever one player. They
 * now live on an ACTOR record, one per combatant, and a party is simply
 * several actors with `input: true` sharing one boss, one Mark pool and one
 * threat table. What stayed on the class is what the DESIGN says is shared:
 * boss HP and phase, Marks, Amp, the wound stacks, vulnerability, taunt and
 * the Extinction dome (doc 02 — Marks and Amp are team resources).
 *
 * Scripted allies (`SimAllySpec`) are actors with `input: false`: same GCD
 * rotation off the stats sheet as before, so the practice pit and the balance
 * harnesses see identical numbers. The legacy constructor and every legacy
 * method still work and act on the PRIMARY actor (actor 0).
 */

import {
  COMBAT,
  THREAT,
  applyMitigation,
  overhealToAmp,
  resolveHit,
  resolveMitigation,
  resolveUltimate,
  type MatchFormat,
} from "../combat.ts";
import type { BossFightScript, FightPhaseId, SimAllySpec } from "../bosses/nightmare.ts";
import type { Effect, Hero, OverTime } from "../types.ts";
import {
  castAddon,
  castLifeStage,
  castVirtue,
  psychosocialStart,
  type PsychosocialHudState,
  type PsychosocialState,
} from "./psychosocial.ts";

export type { PsychosocialHudState } from "./psychosocial.ts";

export type FightPhaseState = "idle" | FightPhaseId | "dead";

/**
 * What the sim needs from the scene/HUD layer.
 *
 * Every player-specific hook carries an OPTIONAL trailing `actorId`: with one
 * real player there is nothing to route, so the client's implementations
 * ignore it; with a party the server uses it to send the event to the right
 * client. Optional because it must never break an existing implementation.
 */
export interface FightHooks {
  /** World-chat announcement (phase warnings, entries, enrage, wipes). */
  announce(text: string): void;
  /** Drive the boss model into a phase (nightmare.setPhase). */
  setBossPhase(phase: FightPhaseState): void;
  /**
   * The boss lands a real outgoing hit — drive the attack animation/FX
   * ("threat" = single-target swing at the hate target, "all" = raid AOE).
   */
  bossStrike(targets: "threat" | "all"): void;
  /** Damage the player (writes the player store → HUD HP bar). */
  damagePlayer(amount: number, actorId?: string): void;
  healPlayer(amount: number, actorId?: string): void;
  /**
   * A combatant took damage (post-mitigation) — float the number over their
   * head, player and sim allies alike. `isPlayer` still means "the primary
   * actor", so existing HUDs are untouched; `actorId` is how a party client
   * recognises itself without matching on display names.
   */
  combatantDamaged?(name: string, amount: number, isPlayer: boolean, actorId?: string): void;
  /**
   * A combatant received healing — player and sim allies alike, so the green
   * +N floats over whichever head actually got topped up. `effective` is what
   * the HP bar gained (overheal already became Amp upstream); `attempted` is
   * what the source paid before the cap — the practice pit floats THAT, since
   * nothing in there damages the player and every real heal lands as 0.
   * `label` names the paying skill/schedule so a meter can attribute the tick.
   */
  combatantHealed?(
    name: string,
    effective: number,
    attempted: number,
    isPlayer: boolean,
    label: string,
    actorId?: string
  ): void;
  /**
   * A combatant hit 0 HP. They stay down where they fell — there is no
   * mid-fight rez — so the scene layer plays the death pose here.
   */
  combatantDied?(name: string, isPlayer: boolean, actorId?: string): void;
  /**
   * A sim ally (practice bot) fired its GCD cast — the scene layer plays the
   * bot rig's cast gesture. "heal" = the healer topping someone up, "damage"
   * = everything else; the layer picks the clip, the sim stays art-blind.
   */
  allyCast?(name: string, action: "heal" | "damage", actorId?: string): void;
  /**
   * ~1 s of Shapeshift-wound DoT ticked on the boss — float it with the
   * wound's name, so the bleed that carries P3 is visible damage, not a
   * silently shrinking HP bar. `actorId` is set when the tick belongs to one
   * actor's ultimate rather than to the team-wide wound bleed.
   */
  dotTick?(label: string, amount: number, actorId?: string): void;
  /**
   * Buff/debuff indicator, top-left HUD (player store). `icon` is a semantic
   * key ("fixation", "denial", "team_amp"…) — the arena layer maps it to tile
   * art; the sim never knows asset URLs. `id` pins a stable tile identity for
   * state readouts whose NAME changes while the tile is the same thing (the
   * operant quadrant) — without it the layer keys tiles on the name.
   * `durationMs: Infinity` is legal and means "until replaced or removed".
   * `desc` is the effect explained in a sentence — the body of the tile's
   * hover/tap popup; the sim writes it because the sim owns the magnitudes.
   */
  playerBuff(
    name: string,
    durationMs: number,
    kind?: "buff" | "debuff",
    icon?: string,
    id?: string,
    desc?: string,
    actorId?: string
  ): void;
  /** Sublimation rider: boss damage converted into the player's Focus pool. */
  gainFocus?(amount: number, actorId?: string): void;
  /**
   * A Defense Mechanism rider actually fired (Denial blocked a Fixation,
   * Projection reflected a hit, …) — float its name over the boss like a
   * damage tick, but slower to fade.
   */
  defenseProc?(name: string, actorId?: string): void;
  /** Fixation: lock a palette sub-skill on the action bar. */
  lockPaletteSlot(paletteIndex: number, ms: number, actorId?: string): void;
  /**
   * The chain-kit conditioning loop moved (pairing banked, CONDITIONED
   * reached/consumed/decayed, extinction reset). The bar layer uses it to
   * swap the bell (NS) button for CS (`PaletteEntry.transformsFrom`) and back —
   * the sim stays ignorant of which button shows what.
   */
  conditioningChanged?(state: ConditioningHudState, actorId?: string): void;
  /**
   * The operant toggles moved (Skinner's E/R — contingency × consequence).
   * The bar layer swaps the toggle buttons' faces and names the live
   * quadrant; the sim stays ignorant of icons, same as conditioning.
   */
  operantChanged?(state: OperantHudState, actorId?: string): void;
  /**
   * Erikson's rotation moved (stage armed, pair completed, add-on granted or
   * spent, virtues released). The bar relabels keys 1/2/LMB from it — the
   * stage and virtue names ARE the lesson, so they must track the sim exactly.
   */
  psychosocialChanged?(state: PsychosocialHudState, actorId?: string): void;
  /**
   * Bandura's model or retention slots moved (a copy retained, reproduced or
   * faded; attention shifted to a new model). The bar relabels keys 1–4 with
   * the copied skills' names and icons — the copies ARE his kit.
   */
  modelingChanged?(state: ModelingHudState, actorId?: string): void;
  /** Hit reaction on the hero model, when one is rigged. */
  playerHitReaction(actorId?: string): void;
  /**
   * A fight beat that only the sim can see happened — the scene layer maps it
   * to a sound (or ignores it). Semantic names, no asset knowledge, same
   * art-blindness contract as the rest of these hooks. Beats that already
   * have a structural hook (bossStrike, setBossPhase, combatantDied,
   * fightEnd) don't repeat here.
   */
  sfxEvent?(name: SfxName, actorId?: string): void;
  /**
   * The attempt ended — victory (boss dead) or defeat (every hero down),
   * with the attempt's accumulated stats. The arena layer reports this to
   * the server and routes the party (defeat → back to the village); the sim
   * itself stays oblivious to networks and scenes. After a defeat the sim is
   * frozen — there is no in-arena reset.
   */
  fightEnd?(stats: FightEndStats): void;
}

/** The sim-visible beats `FightHooks.sfxEvent` names. */
export type SfxName =
  | "vr.jackpot"
  | "skillcheck.correct"
  | "skillcheck.wrong"
  | "hot.tick"
  | "operant.proc"
  | "shapeshift"
  | "phase.warning";

/** What the bar layer needs to know about the conditioning loop, no more. */
export interface ConditioningHudState {
  pairings: number;
  /**
   * The most this cycle could need — `pairingsToCondition.max`, NOT the rolled
   * target. The roll stays hidden from the HUD on purpose (see pavlov.ts); this
   * is here so a bar layer can size a meter, not so it can predict CS.
   */
  needed: number;
  /** CS is castable — the boss carries CONDITIONED. */
  conditioned: boolean;
  /** Post-Extinction: the response is unlearned until he rebuilds (or E). */
  extinguished: boolean;
}

/**
 * What the bar layer needs to know about the operant toggles, no more.
 * E × R named together is the live quadrant ("Positive Reinforcement", …) —
 * the four-quadrant matrix taught by pressing two buttons.
 */
export interface OperantHudState {
  contingency: "positive" | "negative";
  consequence: "reinforcement" | "punishment";
}

/** One attempt's reckoning, handed to `FightHooks.fightEnd`. */
/** One retained copy, as the bar shows it (`modelingChanged`). */
export interface RetainedView {
  /** The copied skill's id ("freud.stage.oral") — the bar draws ITS icon. */
  id: string;
  name: string;
  /** Hero whose icon set the copy's icon lives in; "boss" for a modeled blow. */
  heroId: string;
  /** The original was reinforced: this copy pays the full rate. */
  motivated: boolean;
}

export interface ModelingHudState {
  /** Who Bandura is watching; null = nobody to watch, so he models the boss. */
  model: { id: string; name: string } | null;
  /** True when the player picked the model rather than salience. */
  pinned: boolean;
  slots: (RetainedView | null)[];
}

export interface FightEndStats {
  win: boolean;
  durationMs: number;
  /** Total boss HP lost / duration in seconds (allies and DoTs included). */
  dps: number;
  /** Total healing done TO the player(s) — every input-driven actor. */
  healing: number;
  /** Total HP the player(s) lost. */
  damageTaken: number;
}

/**
 * One actor's share of the attempt.
 *
 * `FightEndStats` is the TEAM's reckoning and stays exactly that — the number a
 * solo player has always been scored on. A party needs the same three numbers
 * per person, because three players in one session did three different amounts
 * of work and paying them the team's total would pay the AFK one the same as
 * the tank. Read at fight end by whoever settles it (server/fight.mjs).
 */
export interface ActorStats {
  /** Damage this actor dealt to the boss, before any team-wide DoT. */
  damageDealt: number;
  /** Effective healing this actor put out, to anyone (overheal excluded). */
  healing: number;
  /** HP this actor lost. */
  damageTaken: number;
}

/** Difficulty multipliers applied at setup; Standard is exactly {1, 1}. */
export interface FightDifficultyMult {
  hpMult: number;
  dmgMult: number;
}

/** Account-state scalars one actor brings: gear set, pet stats, hero HP. */
export interface ActorLoadout {
  gear?: number;
  petDamage?: number;
  petHealing?: number;
  hpMult?: number;
}

/** Coffee Shop consumables one actor brings. */
export interface ActorPotions {
  damage?: number;
  healing?: number;
}

/**
 * One combatant, as the caller declares it.
 *
 * The party case is several of these with `input: true` — three players, three
 * heroes, three independent kit states, one boss. A scripted ally is the same
 * record with `input: false` and a `script`.
 */
export interface ActorSpec {
  /** Stable id. The user id for a real player, "bot:0" for a scripted ally. */
  id: string;
  /** Display name — what threat rows, ally bars and announces show. */
  name: string;
  /** This actor's own kit. Three players = three different heroes. */
  hero: Hero;
  /** true = driven by cast intents; false = scripted ally on a GCD timer. */
  input: boolean;
  /** Throughput numbers for a scripted ally. Required when input === false. */
  script?: SimAllySpec;
  loadout?: ActorLoadout;
  potions?: ActorPotions;
}

/**
 * `ActorSpec` with the hero optional — the shape the constructor works in.
 *
 * A scripted ally arriving through the LEGACY constructor is a `SimAllySpec`
 * and nothing else: the stats sheet never had a `Hero` behind it. Callers of
 * `forParty` always have one, which is why the public spec requires it.
 */
type ActorInit = Omit<ActorSpec, "hero"> & { hero?: Hero };

/** Result of a player cast that produces a projectile — damage lands on impact. */
export interface PendingHit {
  damage: number;
  /** Critical hit — the HUD pops it larger and shinier. */
  crit: boolean;
  /** Apply one Analysis Mark on land (palette casts). */
  appliesMark: boolean;
  /** Correct P2 answer — apply one armor-bypass debuff stack on land. */
  grantsDebuffStack: boolean;
  /**
   * Marks applied on land when `appliesMark` — default 1. CS carries 3
   * (`mark.grant` magnitude); palette-kit casts leave it unset.
   */
  markCount?: number;
  /**
   * Radius in metres this hit spreads over. Absent/0 = single target.
   * `landHit` fans the damage across every hostile inside it.
   */
  aoeRadius?: number;
  /**
   * The share of this hit paid later, in ticks (`OverTime`). `damage` above is
   * the impact part only; `total` here is already priced by the same cast
   * (beat, Marks, gear, crit). `landHit` opens the tick train.
   */
  overTime?: PendingOverTime;
}

export interface PendingOverTime {
  total: number;
  ticks: number;
  periodS: number;
  zoneRadius?: number;
  label: string;
}

/** Split a priced hit into its impact part and its over-time part. */
export function splitOverTime(damage: number, spec: OverTime | undefined): { damage: number; overTime?: PendingOverTime } {
  if (!spec || spec.share <= 0 || damage <= 0) return { damage };
  const share = Math.min(1, spec.share);
  const ticks = Math.max(1, spec.ticks ?? Math.round(spec.durationMs / 1000));
  return {
    damage: damage * (1 - share),
    overTime: { total: damage * share, ticks, periodS: spec.durationMs / 1000 / ticks, zoneRadius: spec.zoneRadius, label: spec.label },
  };
}

/**
 * A hostile the player's hits can land on.
 *
 * NIGHTMARE fields exactly one — the boss, at the arena origin, which every
 * cast auto-aims onto. The list exists so AOE is real plumbing rather than a
 * flag we honour later: when a phase spawns adds they join here and
 * `PendingHit.aoeRadius` immediately starts to matter.
 */
interface HostileTarget {
  id: string;
  /** Metres from the AOE's origin. The boss is the origin, hence 0. */
  distanceM: number;
}

export interface ThreatRow {
  name: string;
  role: string;
  value: number;
  isPlayer: boolean;
  alive: boolean;
}

export interface FightSnapshot {
  bossName: string;
  hp: number;
  hpMax: number;
  phase: FightPhaseState;
  phaseName: string;
  /** What the current phase rolls into ("" when dead) — the HUD's heads-up. */
  nextPhaseName: string;
  phaseRemainingS: number;
  enrageRemainingS: number;
  enraged: boolean;
  /** Live P2 armor-bypass debuff stacks on the boss. */
  debuffStacks: number;
  marks: number;
  amp: number;
  /** The player's live mitigation term, 0..COMBAT.maxMitigation — doc 08 §1.1. */
  mitigation: number;
  /** Current P2 form, 0-based; -1 outside P2. */
  p2Stage: number;
  threat: ThreatRow[];
  allies: { name: string; role: string; hpPct: number; alive: boolean }[];
}

/** One actor's row in the HUD — the half `snapshot()` never carried. */
export interface ActorView {
  id: string;
  name: string;
  role: string;
  hp: number;
  hpMax: number;
  alive: boolean;
  threat: number;
  mitigation: number;
}

/**
 * Operant engine (Skinner) book-keeping ABOUT one combatant, kept per engine
 * OWNER — live Approximation expiry times, damage dealt toward the next
 * Positive proc, and the start of the current no-damage-taken streak
 * (Negative).
 *
 * Keyed by owner because two Skinners in one party each watch the same team
 * with their own toggles; a single flat record would have them silently
 * spending each other's progress. It hangs off the combatant rather than a
 * parallel map so a dead ally's book-keeping dies with them.
 */
interface OperantWatch {
  approx: number[];
  posProgress: number;
  /** -1 = no streak started yet (the engine seeds it on its first look). */
  cleanSince: number;
}

/**
 * One combatant in the fight — a real player, or a scripted ally.
 *
 * Everything below the "per-actor kit state" line used to sit flat on the
 * class, because the class only ever had one player to hold it for. It is all
 * one actor's kit talking to ITSELF: nothing here is readable or spendable by
 * a teammate. Team resources (Marks, Amp, wound stacks, vulnerability, taunt,
 * the dome) deliberately stayed on `BossFight` — see doc 02.
 */
interface FightActor {
  /** Stable id — the user id for a player, "bot:N" for a scripted ally. */
  id: string;
  name: string;
  role: "tank" | "healer" | "dps";
  /**
   * Driven by cast intents (a real player) vs. the scripted GCD rotation.
   * This — not `isPlayer` — gates the "player" hooks and the attempt stats,
   * so a party routes vitals to three clients instead of one.
   */
  input: boolean;
  /**
   * The primary actor (actor 0). `isPlayer` is what the HUD contract has
   * always meant by "me", and `snapshot().allies` is still "everyone else",
   * so existing single-player HUD code needs no edit.
   */
  isPlayer: boolean;
  /**
   * This actor's kit. null only for a scripted ally built from the legacy
   * constructor, which is handed a `SimAllySpec` and no `Hero` — such an
   * actor runs `spec` throughput and no kit logic at all.
   */
  hero: Hero | null;
  /** Throughput sheet for a scripted ally; null for an input-driven actor. */
  spec: SimAllySpec | null;
  /** Scripted-ally GCD clock (sim seconds). Unused by input actors. */
  nextCastAt: number;

  hp: number;
  hpMax: number;
  alive: boolean;
  threat: number;
  /**
   * This actor's own share of the attempt — see `ActorStats`. The team-wide
   * `stat*` fields on the class answer "how did the ATTEMPT go"; these answer
   * "what did THIS player do", which is the question a party payout asks.
   */
  statDealt: number;
  statHealed: number;
  statTaken: number;
  /**
   * Threat banked per point of damage dealt — `THREAT.damage` unless this
   * combatant is holding a threat stance (shared/types.ts `ThreatStance`).
   *
   * ★ 2026-08-03: this used to be read off `role === "tank"`, which handed
   * every tank a permanent 5× nobody pressed. Stances replaced it; a tank with
   * no stance authored yet banks 1× like everyone else. AI allies hold theirs
   * open from the first swing (see the constructor), so the sim's hate table
   * is unchanged — only the player's is now a choice.
   */
  threatMult: number;
  /** Operant book-keeping about THIS combatant, keyed by engine owner id. */
  watched: Map<string, OperantWatch>;

  // ---- per-actor kit state -------------------------------------------------
  /**
   * Account-state scalars (docs/09): the gear term (1.00..1.12, clamped at
   * COMBAT.maxGear inside resolveHit), the Coffee Shop cups, and the pet's
   * Attack/Healing stats. Per actor because they are one player's inventory —
   * a teammate's latte never sweetens your hits. Kept off `resolveHit`'s
   * HitContext on purpose: a consumable is account state, not part of the
   * doc-02 pipeline, so it applies the way Fixation does — as a scalar on the
   * resolved hit.
   */
  gear: number;
  potionDamage: number;
  potionHeal: number;
  petDamage: number;
  petHeal: number;

  /** Free Association half-value Marks accumulate here until one completes. */
  markFraction: number;
  freeAssocLeft: number;
  freeAssocUntil: number; // the 8 s buff window bounds the 3 charges
  fixationUntil: number;
  /**
   * Live mitigation grants — doc 08 §1.1. Additive, capped at
   * COMBAT.maxMitigation. Owned by the granting actor: "self" protects only
   * them, "team" protects the whole party (see `mitigationFor`).
   */
  mitigations: { magnitude: number; until: number; target: "self" | "team" }[];
  // Defense Mechanism riders — one active per cast, a new cast replaces it.
  absorbNextHit: boolean;
  denialUntil: number; // Fixation immunity window (sim seconds)
  reflectNextHit: boolean;
  reflectMagnitude: number;
  redirectNextHit: boolean;
  focusNextHit: boolean;

  // ---- classical conditioning (chain kits, `Hero.conditioning`) ------------
  // All timers in sim seconds; -1 = never. The data behind every number is
  // PAVLOV_CONDITIONING — the sim only ever reads this actor's
  // `hero.conditioning`. Two Pavlovs condition the boss independently: the
  // loop is a relationship between ONE trainer and the boss.
  ucrUntil: number; // boss showing the UCR tell
  lastNsAt: number; // last bell, for the delay pairing (bell first, then food)
  pairings: number;
  /**
   * Pairings this cycle needs — rolled from `pairingsToCondition` the moment
   * the first one banks, so the target is fresh per cycle and unknowable in
   * advance. 0 means "not rolled yet"; every reset drops it back to 0.
   */
  pairingTarget: number;
  conditionedUntil: number;
  condWasActive: boolean; // decay edge detection for the HUD hook
  extinguished: boolean;
  srRefundUsed: boolean; // Spontaneous Recovery refunds ONCE per extinction
  crActive: boolean; // Conditioned Response landed — bells stagger the boss
  crBells: number; // bells rung since CR came up; every Nth one flinches it

  // ---- operant engine (Skinner, `Hero.reinforcement`) ----------------------
  // The two toggles, Response Strength (heal-fueled basic), and the
  // interval-schedule tickers. The toggles are this player's stance, not a
  // team setting — two Skinners can run opposite quadrants.
  contingency: "positive" | "negative";
  consequence: "reinforcement" | "punishment";
  rsAccum: number; // effective healing banked toward the next RS stack
  rsStacks: number[]; // per-stack expiry times (rolling record)
  // Interval windows self-stack: one entry per live cast, capped at
  // schedules.maxStacks (a fresh cast past the cap replaces the oldest).
  fiTickers: { nextAt: number; until: number }[];
  viTickers: { nextRollAt: number; until: number }[];

  // ---- life-cycle rotation (Erikson, `Hero.psychosocial`) ------------------
  // null for every other kit. The rules are shared/fight/psychosocial.ts.
  psycho: PsychosocialState | null;

  /**
   * Dream Analysis payout: the total is fixed at cast, but nothing lands
   * until the eye reaches the boss (`landUltimate`) — then it deals its
   * damage in ticks, one float per tick, instead of one instant slab.
   */
  ultTicks: { perTick: number; left: number; nextAt: number } | null;
  /** Live damage-over-time trains this actor opened (`OverTime`), one per landed cast. */
  dots: { perTick: number; left: number; periodS: number; nextAt: number; label: string }[];

  // ---- attachment effects (Ainsworth's kit, but generic effect kinds) ----
  /** `team.immunity`: boss hits on this actor land nowhere until then. */
  immuneUntil: number;
  /** `self.stagger`: hits taken until then are deferred, not dropped. */
  staggerUntil: number;
  /** Seconds a deferred hit bleeds out over. */
  staggerSpreadS: number;
  /** Deferred hits still bleeding: per-second rate and what is left. */
  staggerPool: { perS: number; left: number }[];
  /** Bled damage not yet applied — flushed twice a second, not per frame. */
  staggerAccum: number;
  staggerFlushAt: number;
  /** `heal.cut.self`: healing received is cut by `healCut` until then. */
  healCutUntil: number;
  healCut: number;
  /** Last time a hit actually took HP (Sensitivity answers it). */
  lastHitAt: number;
  /** Recent palette casts, for `requiresVariety` gates. */
  styleLog: { id: string; t: number }[];
  /** Per-entry ready time for palette entries with their own `cooldownMs`. */
  paletteReadyAt: Map<string, number>;

  // ---- development effects (Piaget's kit, generic kinds) -------------------
  /** `shield.team`: absorb pools on THIS actor, spent before HP. */
  shields: { left: number; until: number; label: string }[];
  /** `heal.hot`: heal-over-time trains landing on THIS actor. */
  hots: { perTick: number; left: number; nextAt: number; periodS: number; src: FightActor | null; label: string }[];
  /** `ally.undying`: HP cannot fall below 1 until then; `undyingHeal` lands after. */
  undyingUntil: number;
  undyingHeal: { amount: number; src: FightActor | null; label: string } | null;
  /** Piaget's invariant sequence: stages cast in order so far, and when. */
  seqStep: number;
  seqAt: number;

  // ---- observational learning (Bandura, `Hero.modeling`) -------------------
  /** How noticeable this actor is as a model — decays, see `salienceOf`. */
  salience: number;
  salienceAt: number;
  /** Retention slots (Bandura only; empty for everyone else). */
  retained: (RetainedSkill | null)[];
  /** A model the player picked (party frame tap); null = salience decides. */
  modelPin: string | null;
  /** Last model reported to the HUD, so attention shifts are announced once. */
  modelSeen: string | null;
  /** simT of this actor's last RESOLVED ultimate — see `ultimateResolvedAs`. */
  lastUltAt: number;
  /** Next once-a-second attention re-check (Bandura). */
  attentionAt: number;
}

/** A skill Bandura has watched and kept, ready to reproduce. */
interface RetainedSkill {
  view: RetainedView;
  effects: readonly Effect[];
  /** The original healed rather than hit: the copy heals for his base. */
  heals: boolean;
  until: number;
}

interface MarkInstance {
  until: number; // sim seconds
}

interface DebuffInstance {
  until: number;
}

/** P2 form names — the doll order in nightmareBoss.ts, as age words. The
 *  design rule (doc 04) is that cues never name the palette answer outright. */
const P2_FORMS = ["an infant", "a toddler", "a child", "a schoolchild", "an adolescent"] as const;

/** The answer tag of each P2 form, same order — `PaletteEntry.answersTags`. */
const P2_TAGS = ["age.infant", "age.toddler", "age.child", "age.school", "age.adolescent"] as const;

/**
 * The plain effect kinds `applySharedEffects` resolves. A defense carrying
 * any of these pays them as part of its guaranteed floor rather than rolling
 * them as a Freud-style rider, and they are what Bandura can copy.
 */
const SHARED_KINDS = new Set([
  "mitigation.grant", "taunt", "team.cleanse", "team.amp", "threat.drop", "self.stagger",
  "heal.cut.self", "team.immunity", "vulnerability",
  "heal.hot", "heal.single", "conservation", "shield.team", "ally.undying",
]);
/**
 * Healing SHAPES: kinds whose magnitude is the heal itself. A Bandura copy of
 * one keeps the shape and swaps in his own number (bandura.ts).
 */
const HEAL_SHAPE_KINDS = new Set(["heal.hot", "heal.single", "conservation", "shield.team", "ally.undying"]);
/** Kinds whose magnitude is not an amount (a spread in seconds) — copies leave it. */
const UNSCALED_MAGNITUDE = new Set(["self.stagger"]);

/** The P2 armor-bypass debuff's display name — announces, DoT floats. */
const WOUND_NAME = "Shapeshift Wound";

/** Fixation, doc 02: wrong palette answer locks the sub-skill and cuts damage. */
const FIXATION_LOCK_MS = 10_000;
const FIXATION_PENALTY_S = 6;
const FIXATION_DAMAGE_MULT = 1 - 0.3;
/** Free Association (R): casts that cannot be wrong, at half-value Marks. */
const FREE_ASSOC_CASTS = 3;
/** Dream Analysis (F): the payout lands in this many ticks, one per period. */
const ULT_TICKS = 5;
const ULT_TICK_PERIOD_S = 0.6;
/** Enrage: outgoing damage multiplier once the timer runs out. */
const ENRAGE_OUTGOING_MULT = 10;

/** Ability id → the semantic icon key the buff layer maps to tile art. */
const iconSlug = (id: string): string => (id.split(".").pop() ?? id).replace(/-/g, "_");

const roleOf = (role: string): "tank" | "healer" | "dps" =>
  role === "tank" ? "tank" : role === "healer" ? "healer" : "dps";

/** "Sigmund Freud — The Analyst" → "Sigmund Freud". */
const shortName = (displayName: string): string => displayName.split(" — ")[0] ?? displayName;

export class BossFight {
  private readonly script: BossFightScript;
  private readonly hooks: FightHooks;
  private readonly format: MatchFormat = "match";

  private hp: number;
  private readonly hpMax: number;
  private phase: FightPhaseState = "idle";
  private phaseT = 0;
  private cyclesDone = 0; // completed p1→p4 rotations; enrage counts these
  private engaged = false;
  private enraged = false;
  private warned = false; // 5 s phase-change warning fired for this phase
  private nextOutgoingAt = 0;

  /**
   * Everyone in the fight, primary first. `actors[0]` is what every legacy
   * method operates on; `actors.slice(1)` is what `snapshot().allies` reports.
   */
  private readonly actors: FightActor[];

  // ---- TEAM state: shared by the whole party, by design (doc 02) -----------
  private marks: MarkInstance[] = [];
  private debuffs: DebuffInstance[] = [];
  private ampEvents: { amp: number; until: number }[] = [];
  private p2Stage = -1;
  private vulnUntil = -1; // Generalization: boss takes +vulnMagnitude
  private vulnMagnitude = 0;
  private tauntUntil = -1; // boss forced onto `tauntActorId`, threat ignored
  /** Who the live taunt points the boss at — boss state, so it lives here. */
  private tauntActorId: string | null = null;
  private domeUntil = -1; // Extinction dome: boss outgoing × (1 − domeCut)
  private domeCut = 0;
  /**
   * Bobo Doll: single-target blows land on the decoy until then; at the end
   * it rebounds `decoyRebound` of what it absorbed at the boss, credited to
   * the owner. Where the boss is swinging is boss state, like the taunt.
   */
  private decoyUntil = -1;
  private decoyRebound = 0;
  private decoyAbsorbed = 0;
  private decoyOwnerId: string | null = null;
  /** Party wiped — the sim freezes; the arena layer routes back to town. */
  private over = false;
  // Wound-DoT float batching: per-frame ticks are sub-pixel numbers, so the
  // damage accumulates and floats once a second like a real DoT tick.
  private dotAccum = 0;
  private nextDotFloatAt = 0;

  private simT = 0;

  // ---- attempt stats (for the fight-end report) ----------------------------
  private statDamageDealt = 0; // boss HP lost, any source
  private statDamageTaken = 0; // HP lost by input-driven actors
  private statHealing = 0; // healing done TO input-driven actors
  private engageSimT = -1; // simT at first engage; -1 = not engaged yet

  private readonly dmgMult: number;
  /** Boss outgoing scale for under-sized teams — see the constructor note. */
  private readonly sizeMult: number;

  /**
   * The legacy shape: one real player plus scripted allies.
   *
   * `party` is the N-actor door (`forParty` is the only caller) — TypeScript
   * has no second constructor, and every field below is `readonly`, so the
   * party path has to arrive here rather than mutate a half-built object.
   * When it is present the four player-shaped arguments are ignored.
   */
  constructor(
    script: BossFightScript,
    playerHero: Hero,
    allies: SimAllySpec[],
    hooks: FightHooks,
    difficulty: FightDifficultyMult = { hpMult: 1, dmgMult: 1 },
    potions: ActorPotions = {},
    loadout: ActorLoadout = {},
    party?: ActorSpec[]
  ) {
    this.script = script;
    this.hooks = hooks;
    this.dmgMult = difficulty.dmgMult;

    const specs: ActorInit[] =
      party ??
      [
        {
          id: "player",
          name: shortName(playerHero.displayName),
          hero: playerHero,
          input: true,
          loadout,
          potions,
        },
        ...allies.map((spec, i) => ({
          id: `bot:${i}`,
          name: shortName(spec.displayName),
          // A legacy ally is a stats-sheet stand-in, not a kit — the sim reads
          // `script` for its throughput and never touches a Hero for it.
          input: false,
          script: spec,
          // Bots stand in for equally-progressed teammates: they ride the
          // player's gear term, which is exactly what the docs/09 receipts
          // (tools/loadout-sim-check.mjs) were measured against.
          loadout: { gear: loadout.gear ?? 1.0 },
        })),
      ];

    const teamSize = Math.min(5, Math.max(1, specs.length)) as 1 | 2 | 3 | 4 | 5;
    // Boss pressure was tuned for the 3-player sheet corner: one 100-dmg hit
    // per 2 s eaten by a 5×-threat tank under a dedicated healer. Under-sized
    // teams have neither, so outgoing scales to hold the per-head pressure of
    // that corner constant — a solo run faces a third of the swing, not a
    // third of the boss's patience (enrage is unchanged). A real 3-stack now
    // counts as three heads, which is the whole point of the actor list.
    this.sizeMult = Math.min(1, teamSize / 3);
    this.hpMax = Math.round(script.hpByTeamSize[teamSize] * difficulty.hpMult);
    this.hp = this.hpMax;

    this.actors = specs.map((spec, i) => this.makeActor(spec, i === 0));
    // A reinforcement kit opens with a live quadrant (Positive/Reinforcement)
    // before any button is pressed — put its readout up from the first frame.
    for (const a of this.actors) if (a.input) this.emitOperant(a);
    // …and so does a life-cycle kit: stage 1 is up before the first press.
    for (const a of this.actors) if (a.input) this.emitPsychosocial(a);
    // …and an observational kit: four empty slots and a model to watch.
    for (const a of this.actors) if (a.input && a.hero?.modeling) this.emitModeling(a, false);
  }

  /**
   * Build a fight with N input-driven actors — the party case.
   *
   * Everything else (Marks, Amp, threat, the boss) is shared exactly as it is
   * for one player; the only difference is that several actors can cast.
   */
  static forParty(
    script: BossFightScript,
    actors: ActorSpec[],
    hooks: FightHooks,
    difficulty: FightDifficultyMult = { hpMult: 1, dmgMult: 1 }
  ): BossFight {
    const primary = actors[0];
    if (!primary) throw new Error("BossFight.forParty needs at least one actor");
    return new BossFight(script, primary.hero, [], hooks, difficulty, {}, {}, actors);
  }

  private makeActor(spec: ActorInit, isPrimary: boolean): FightActor {
    const hero: Hero | null = spec.hero ?? null;
    const sim = spec.script ?? null;
    const loadout = spec.loadout ?? {};
    const potions = spec.potions ?? {};
    // Pet HP stat: the actor's own pool scales with the actor's own loadout.
    const hp = Math.round(this.script.heroHp * (loadout.hpMult ?? 1));
    return {
      id: spec.id,
      name: spec.name,
      role: roleOf(sim ? sim.role : (hero?.role ?? "dps")),
      input: spec.input,
      isPlayer: isPrimary,
      hero,
      spec: sim,
      nextCastAt: 0,
      hp,
      hpMax: hp,
      alive: true,
      threat: 0,
      statDealt: 0,
      statHealed: 0,
      statTaken: 0,
      // A player's stance starts OFF — it is a passive you activate (Pavlov's
      // Discrimination); `setThreatStance` turns it on. AI allies hold theirs
      // open for the whole fight: they have no hands to press it with, and a
      // tank who never taunts would be a regression dressed up as a rules
      // change.
      threatMult: spec.input ? THREAT.damage : (sim?.threatStance?.multiplier ?? THREAT.damage),
      watched: new Map(),
      gear: loadout.gear ?? 1.0,
      potionDamage: potions.damage ?? 1,
      potionHeal: potions.healing ?? 1,
      petDamage: loadout.petDamage ?? 1,
      petHeal: loadout.petHealing ?? 1,
      markFraction: 0,
      freeAssocLeft: 0,
      freeAssocUntil: -1,
      fixationUntil: -1,
      mitigations: [],
      absorbNextHit: false,
      denialUntil: -1,
      reflectNextHit: false,
      reflectMagnitude: 0,
      redirectNextHit: false,
      focusNextHit: false,
      ucrUntil: -1,
      lastNsAt: -1,
      pairings: 0,
      pairingTarget: 0,
      conditionedUntil: -1,
      condWasActive: false,
      extinguished: false,
      srRefundUsed: false,
      crActive: false,
      crBells: 0,
      contingency: "positive",
      consequence: "reinforcement",
      rsAccum: 0,
      rsStacks: [],
      fiTickers: [],
      viTickers: [],
      psycho: hero?.psychosocial ? psychosocialStart() : null,
      ultTicks: null,
      dots: [],
      immuneUntil: -1,
      staggerUntil: -1,
      staggerSpreadS: 0,
      staggerPool: [],
      staggerAccum: 0,
      staggerFlushAt: 0,
      healCutUntil: -1,
      healCut: 0,
      lastHitAt: -1,
      styleLog: [],
      paletteReadyAt: new Map(),
      shields: [],
      hots: [],
      undyingUntil: -1,
      undyingHeal: null,
      seqStep: 0,
      seqAt: -1,
      salience: 0,
      salienceAt: 0,
      retained: hero?.modeling ? Array.from({ length: hero.modeling.slots }, () => null) : [],
      modelPin: null,
      modelSeen: null,
      lastUltAt: -1,
      attentionAt: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Actor lookup
  // -------------------------------------------------------------------------

  /** Actor 0 — what every legacy (no-id) method operates on. */
  private get primary(): FightActor {
    return this.actors[0]!;
  }

  private actorBy(id: string): FightActor | null {
    return this.actors.find((a) => a.id === id) ?? null;
  }

  actorIds(): string[] {
    return this.actors.map((a) => a.id);
  }

  /**
   * Re-resolve one actor's account terms after construction.
   *
   * The party door for server fights: the session is built the moment the
   * FIRST member begins, but a teammate's equipped pet is only declared when
   * THEIR begin arrives, ticks later (server/fight.mjs). HP rescales
   * proportionally, so damage already taken keeps its fraction of the pool
   * rather than being healed away by the upgrade.
   */
  applyLoadout(actorId: string, loadout: ActorLoadout): void {
    const a = this.actorBy(actorId);
    if (!a) return;
    a.gear = loadout.gear ?? 1.0;
    a.petDamage = loadout.petDamage ?? 1;
    a.petHeal = loadout.petHealing ?? 1;
    const hpMax = Math.round(this.script.heroHp * (loadout.hpMult ?? 1));
    if (hpMax !== a.hpMax && a.hpMax > 0) {
      a.hp = Math.min(hpMax, Math.round((a.hp / a.hpMax) * hpMax));
      a.hpMax = hpMax;
    }
  }

  /** Per-actor view for the HUD: the half `snapshot()` never carried. */
  actorView(actorId: string): ActorView | null {
    const a = this.actorBy(actorId);
    if (!a) return null;
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      hp: a.hp,
      hpMax: a.hpMax,
      alive: a.alive,
      threat: a.threat,
      mitigation: this.mitigationFor(a),
    };
  }

  /** One actor's share of the attempt — see `ActorStats`. */
  actorStats(actorId: string): ActorStats | null {
    const a = this.actorBy(actorId);
    if (!a) return null;
    return { damageDealt: a.statDealt, healing: a.statHealed, damageTaken: a.statTaken };
  }

  // -------------------------------------------------------------------------
  // Player casts — called by the action-bar layer. Damage is computed here,
  // applied by the caller when the projectile lands (`landHit`).
  //
  // Each verb comes in two forms: the legacy one, which acts on the primary
  // actor, and an `…As(actorId, …)` one for the party. The legacy form is a
  // one-line delegate so there is exactly one implementation to reason about.
  // -------------------------------------------------------------------------

  /**
   * Hold or drop the player's threat stance — the toggle that replaced the
   * automatic tank 5× (shared/combat.ts `THREAT`, shared/types.ts
   * `ThreatStance`). A hero with no stance authored can only ever bank 1×.
   *
   * Threat already banked is NOT rescaled: dropping the stance stops you
   * climbing, it does not erase the aggro you built. That is what makes
   * shedding aggro a decision with a lead time instead of an instant undo.
   */
  setThreatStance(active: boolean): void {
    this.setThreatStanceAs(this.primary.id, active);
  }

  setThreatStanceAs(actorId: string, active: boolean): void {
    const a = this.actorBy(actorId);
    if (!a) return;
    const stance = a.hero?.threatStance;
    a.threatMult = active && stance ? stance.multiplier : THREAT.damage;
  }

  /** Whether the player is currently holding their stance (bar highlight). */
  get threatStanceActive(): boolean {
    return this.threatStanceActiveFor(this.primary.id);
  }

  threatStanceActiveFor(actorId: string): boolean {
    const a = this.actorBy(actorId);
    const stance = a?.hero?.threatStance;
    return a && stance ? a.threatMult === stance.multiplier : false;
  }

  /**
   * Basic attack (LMB). Damage rides the current beat of the automatic cycle.
   *
   * Reads `basic.base` — NOT `baseDamage`, which is the hero's role weight.
   * Conflating the two paid Freud's LMB 100 where the contract budgets 54.
   */
  castBasic(beat: number): PendingHit | null {
    return this.castBasicAs(this.primary.id, beat);
  }

  castBasicAs(actorId: string, beat: number): PendingHit | null {
    const a = this.actorBy(actorId);
    if (!a?.hero || !this.canAct(a)) return null;
    // Erikson's basic is an ADD-ON: one per Life Stage or Virtue cast. With
    // none banked the press is refused like a gated button — null, no cost.
    if (a.psycho) {
      if (!castAddon(a.psycho)) return null;
      this.emitPsychosocial(a);
    }
    const effBeat = this.beatOf(a, beat);
    const cond = a.hero.conditioning;
    if (cond && a.hero.basic.effects.some((e) => e.kind === "pairing.bank")) {
      // The bell. WHEN it rings decides everything (doc 03 §8):
      //  - inside the UCR window → simultaneous (60%, 1 pairing)
      //  - shortly after it faded → backward (20%, 1) — bounded by the grace
      //  - BEFORE the food, still ringing when UCS lands → delay, resolved in
      //    castPalette when the UCS arrives (100%, 2). `lastNsAt` is the ring.
      a.lastNsAt = this.simT;
      if (this.simT < a.ucrUntil) this.rollPairing(a, "simultaneous");
      else if (a.ucrUntil > 0 && this.simT < a.ucrUntil + cond.backwardGraceS)
        this.rollPairing(a, "backward");
      // The CR debuff: once CS has landed, every Nth bell makes the boss
      // flinch — its next cast slips by crStaggerS. The counter replaces the
      // old "landed on the ×1.5 beat" gate at the same rate; see
      // PAVLOV_CONDITIONING.crStaggerEveryNthBell.
      if (a.crActive) {
        a.crBells++;
        if (a.crBells % cond.crStaggerEveryNthBell === 0) {
          this.nextOutgoingAt += cond.crStaggerS;
          this.hooks.defenseProc?.("Conditioned Response", a.id);
        }
      }
    }
    // Response Strength (Skinner): the basic's base is authored at HALF its
    // slot budget and climbs +20%/stack with healing delivered — the budget
    // is only reached by reinforcing the team (docs 03 §7).
    let basicBase = a.hero.basic.base;
    const rf = a.hero.reinforcement;
    if (rf) {
      a.rsStacks = a.rsStacks.filter((u) => u > this.simT);
      basicBase *= 1 + rf.responseStrength.damagePerStack * a.rsStacks.length;
    }
    // Sensitivity (Ainsworth's sensitivity scale): answer the signal PROMPTLY.
    // A basic within the window after a teammate is hit also heals whoever
    // was hit most recently — sensitivity is timing, not volume.
    const sens = a.hero.basic.effects.find((e) => e.kind === "sensitivity.respond");
    if (sens) {
      const windowS = (sens.durationMs ?? 1_500) / 1000;
      const signal = this.actors
        .filter((c) => c.alive && c.lastHitAt >= 0 && this.simT - c.lastHitAt <= windowS)
        .sort((x, y) => y.lastHitAt - x.lastHitAt)[0];
      if (signal) {
        signal.lastHitAt = -1; // one answer per signal
        this.healCombatant(signal, sens.magnitude ?? 0, "Sensitivity", a);
        this.hooks.defenseProc?.("Sensitivity", a.id);
      }
    }
    const { damage, crit } = this.playerHit(a, basicBase, effBeat, false);
    return { ...splitOverTime(damage, a.hero.basic.overTime), crit, appliesMark: false, grantsDebuffStack: false };
  }

  /**
   * Palette sub-skill (1–5). During Shapeshift this is the answer mechanic:
   * the right stage grants an armor-bypass debuff stack on land; the wrong one
   * is a Fixation — sub-skill locked, −30% damage — unless Free Association
   * is running, which makes any stage "right" at half Mark value.
   *
   * The wound stacks it grants are TEAM property: three players answering the
   * same form stack the same boss debuff.
   */
  castPalette(paletteIndex: number, beat: number): PendingHit | null {
    return this.castPaletteAs(this.primary.id, paletteIndex, beat);
  }

  castPaletteAs(actorId: string, paletteIndex: number, beat: number): PendingHit | null {
    const a = this.actorBy(actorId);
    if (!a?.hero || !this.canAct(a)) return null;
    const entry = a.hero.palette[paletteIndex];
    if (!entry) return null;
    // Gated entries (Pavlov's CS) are dark until the boss carries the state —
    // a null here is "the button is grey", not an error.
    if (entry.requiresBossState && !this.bossStateActive(a, entry.requiresBossState)) return null;
    // Own cooldown (the server holds the same line in cooldownSecondsFor).
    if (this.simT < (a.paletteReadyAt.get(entry.id) ?? -1)) return null;
    // Variety gate: enough DIFFERENT other entries cast inside the window.
    if (entry.requiresVariety) {
      const since = this.simT - entry.requiresVariety.withinMs / 1000;
      const seen = new Set(a.styleLog.filter((s) => s.t >= since && s.id !== entry.id).map((s) => s.id));
      if (seen.size < entry.requiresVariety.distinct) return null;
    }
    a.styleLog = a.styleLog.filter((s) => s.t >= this.simT - 30).concat({ id: entry.id, t: this.simT });
    if (entry.cooldownMs) {
      a.paletteReadyAt.set(entry.id, this.simT + entry.cooldownMs / 1000);
      this.hooks.lockPaletteSlot(paletteIndex, entry.cooldownMs, a.id);
    }

    let grantsDebuffStack = false;
    // Marks: palette kits mint one per cast; chain kits ONLY via an explicit
    // `mark.grant` (Pavlov: 3 on CS, none on UCS — doc: "Marks come from CS
    // ONLY"), which also sets how many.
    const markGrant = entry.effects.find((e) => e.kind === "mark.grant");
    let appliesMark = a.hero.kit === "palette" || markGrant !== undefined;
    const markCount = markGrant?.magnitude ?? 1;
    if (this.phase === "p2" && this.p2Stage >= 0 && !entry.answersAxis) {
      // Chain kits do not diagnose the boss (doc 02) — an entry with no
      // answer pair is ALWAYS correct (shared/types.ts PaletteEntry), so it
      // grants the wound stack and can never Fixate.
      grantsDebuffStack = true;
    } else if (this.phase === "p2" && this.p2Stage >= 0) {
      // By position (Freud's five stages are the five forms in order), or by
      // tag when one button spans several forms (Piaget's Preoperational).
      const correct = entry.answersTags
        ? entry.answersTags.includes(P2_TAGS[this.p2Stage] ?? "")
        : paletteIndex === this.p2Stage;
      if (a.freeAssocLeft > 0 && this.simT < a.freeAssocUntil) {
        a.freeAssocLeft--;
        // Auto-correct: counts as the right answer, but the Mark is halved.
        grantsDebuffStack = true;
        a.markFraction += 0.5;
        appliesMark = false; // the fraction below may still complete one
        this.hooks.sfxEvent?.("skillcheck.correct", a.id);
      } else if (correct) {
        grantsDebuffStack = true;
        this.hooks.sfxEvent?.("skillcheck.correct", a.id);
      } else if (this.simT < a.denialUntil) {
        // Denial rider: the wrong answer happens, the Fixation does not.
        this.hooks.sfxEvent?.("skillcheck.wrong", a.id);
        this.hooks.defenseProc?.("Denial", a.id);
        this.hooks.announce(`${a.name}'s Denial shrugs off the misread — no Fixation.`);
      } else {
        // Fixation — lock the sub-skill, cut the caster's damage. The penalty
        // is the CASTER's alone; a teammate's misread never dims your bar.
        this.hooks.sfxEvent?.("skillcheck.wrong", a.id);
        a.fixationUntil = this.simT + FIXATION_PENALTY_S;
        this.hooks.lockPaletteSlot(paletteIndex, FIXATION_LOCK_MS, a.id);
        this.hooks.playerBuff(
          "Fixation — damage −30%",
          FIXATION_PENALTY_S * 1000,
          "debuff",
          "fixation",
          undefined,
          `You misread the boss's form. All damage you deal is cut 30% for ${FIXATION_PENALTY_S} s, and the misused skill is locked for ${FIXATION_LOCK_MS / 1000} s.`,
          a.id
        );
        this.hooks.announce(
          `${a.name} misreads the form — Fixation! ${entry.name} locked 10 s.`
        );
      }
    }

    // Bandura's keys hold copies: the slot decides what this cast IS.
    const repro = entry.effects.some((e) => e.kind === "modeling.reproduce") ? this.reproduce(a, entry) : null;
    this.applyPaletteEffects(a, repro ? repro.effects : entry.effects);
    if (a.hero.development) this.advanceSequence(a, paletteIndex);
    const base = repro ? repro.base : this.psychosocialBase(a, entry);
    const { damage, crit } = base > 0 ? this.playerHit(a, base, this.beatOf(a, beat), true) : { damage: 0, crit: false };
    // Watching teammates (Bandura) see the cast — reinforced when it crit or
    // answered the form right, which is what makes the copy "motivated".
    this.observe(a, entry, crit || grantsDebuffStack);
    return { ...splitOverTime(damage, entry.overTime), crit, appliesMark, grantsDebuffStack, markCount };
  }

  /**
   * Piaget's invariant sequence: stage k counts only right after stage k−1,
   * inside the step window. The fourth in a row refunds Focus and the run
   * restarts — the stages cannot be skipped, and the kit pays for knowing it.
   */
  private advanceSequence(a: FightActor, paletteIndex: number): void {
    const dev = a.hero?.development;
    if (!dev) return;
    const inTime = a.seqAt >= 0 && this.simT - a.seqAt <= dev.stepWindowMs / 1000;
    if (paletteIndex === 0) a.seqStep = 1;
    else if (inTime && paletteIndex === a.seqStep) a.seqStep += 1;
    else a.seqStep = 0;
    a.seqAt = this.simT;
    const stages = a.hero!.palette.length;
    if (a.seqStep >= stages) {
      a.seqStep = 0;
      this.hooks.gainFocus?.(dev.sequenceFocusRefund, a.id);
      this.hooks.defenseProc?.(`Invariant sequence +${dev.sequenceFocusRefund} Focus`, a.id);
      this.hooks.playerBuff("Invariant Sequence", 1, "buff", "invariant_sequence", "invariant_sequence", "", a.id);
      return;
    }
    // The run so far, as a tile: which stage comes next is the lesson.
    const next = a.hero!.palette[a.seqStep]?.name ?? "";
    this.hooks.playerBuff(
      a.seqStep > 0 ? `Invariant Sequence ${a.seqStep}/${stages}` : "Invariant Sequence",
      a.seqStep > 0 ? dev.stepWindowMs : 1,
      "buff",
      "invariant_sequence",
      "invariant_sequence",
      `Stages come in an order that cannot be skipped. ${a.seqStep}/${stages} in sequence; next: ${next}. All ${stages} in order refunds ${dev.sequenceFocusRefund} Focus.`,
      a.id
    );
  }

  // -------------------------------------------------------------------------
  // Observational learning (Bandura)
  // -------------------------------------------------------------------------

  /** Salience now: banked output, halved every `salienceHalfLifeS`. */
  private salienceOf(c: FightActor, halfLifeS: number): number {
    return c.salience * Math.pow(0.5, (this.simT - c.salienceAt) / halfLifeS);
  }

  /** Output makes a combatant noticeable. Fixed 10 s half-life for the bank. */
  private noteSalience(c: FightActor, amount: number): void {
    if (amount <= 0) return;
    c.salience = this.salienceOf(c, 10) + amount;
    c.salienceAt = this.simT;
  }

  /**
   * ATTENTION: who `b` is watching. A pinned model while they live, else the
   * most salient living teammate with a kit; null when there is nobody, which
   * means the boss is the model (the Bobo doll lesson).
   */
  private modelOf(b: FightActor): FightActor | null {
    if (b.modelPin) {
      const pinned = this.actorBy(b.modelPin);
      if (pinned && pinned !== b && pinned.alive && pinned.hero) return pinned;
    }
    const hl = b.hero?.modeling?.salienceHalfLifeS ?? 10;
    let best: FightActor | null = null;
    let bestS = -1;
    for (const c of this.actors) {
      if (c === b || !c.alive || !c.hero) continue;
      const sal = this.salienceOf(c, hl);
      if (sal > bestS) {
        best = c;
        bestS = sal;
      }
    }
    return best;
  }

  /** Pin (or with null, release) the model a Bandura watches — the party-frame tap. */
  setModelAs(actorId: string, modelId: string | null): void {
    const b = this.actorBy(actorId);
    if (!b?.hero?.modeling) return;
    b.modelPin = modelId && modelId !== actorId ? modelId : null;
    this.emitModeling(b);
  }

  /**
   * The party-agnostic pin control: automatic → each living teammate in turn
   * → automatic again. The client never needs teammate ids, so the local
   * sim and the server answer the same tap the same way.
   */
  cycleModelAs(actorId: string): void {
    const b = this.actorBy(actorId);
    if (!b?.hero?.modeling) return;
    const order: (string | null)[] = [null, ...this.actors.filter((c) => c !== b && c.alive && c.hero).map((c) => c.id)];
    const at = order.indexOf(b.modelPin);
    this.setModelAs(actorId, order[(at + 1) % order.length] ?? null);
  }

  modelingFor(actorId: string): ModelingHudState | null {
    const b = this.actorBy(actorId);
    return b?.hero?.modeling ? this.modelingState(b) : null;
  }

  private modelingState(b: FightActor): ModelingHudState {
    const m = this.modelOf(b);
    return {
      model: m ? { id: m.id, name: m.name } : null,
      pinned: b.modelPin !== null && m?.id === b.modelPin,
      slots: b.retained.map((r) => (r && r.until > this.simT ? r.view : null)),
    };
  }

  /**
   * `float` false paints the HUD without the "Watching X" float — the
   * constructor's first paint, which runs before the scene's hooks are fully
   * wired (a float there reaches the damage-number layer mid-construction).
   */
  private emitModeling(b: FightActor, float = true): void {
    const state = this.modelingState(b);
    const seen = state.model?.id ?? "boss";
    if (seen !== b.modelSeen) {
      b.modelSeen = seen;
      if (float) this.hooks.defenseProc?.(state.model ? `Watching ${state.model.name}` : `Watching ${this.script.displayName}`, b.id);
    }
    this.hooks.modelingChanged?.(state, b.id);
  }

  /**
   * RETENTION: every watching Bandura whose model is `caster` keeps the cast.
   * A skill already held is refreshed in place; a new one takes the first
   * empty slot, else replaces the oldest copy.
   */
  private observe(
    caster: FightActor,
    ability: { id: string; name: string; base: number; heal?: number; effects: readonly Effect[] },
    rewarded: boolean
  ): void {
    for (const b of this.actors) {
      const ms = b.hero?.modeling;
      if (!ms || b === caster || !b.alive || this.modelOf(b) !== caster) continue;
      const heals =
        (ability.heal ?? 0) > 0 ||
        (ability.base <= 0 && ability.effects.some((e) => HEAL_SHAPE_KINDS.has(e.kind) || e.kind.startsWith("schedule.")));
      this.retain(b, ms, {
        view: { id: ability.id, name: ability.name, heroId: caster.hero?.id ?? "boss", motivated: rewarded },
        effects: ability.effects.filter((e) => SHARED_KINDS.has(e.kind)),
        heals,
        until: this.simT + ms.retentionMs / 1000,
      });
    }
  }

  private retain(b: FightActor, ms: NonNullable<Hero["modeling"]>, copy: RetainedSkill): void {
    const live = (r: RetainedSkill | null): r is RetainedSkill => r !== null && r.until > this.simT;
    let at = b.retained.findIndex((r) => live(r) && r.view.id === copy.view.id);
    if (at < 0) at = b.retained.findIndex((r) => !live(r));
    if (at < 0) {
      at = 0;
      for (let i = 1; i < b.retained.length; i++) if (b.retained[i]!.until < b.retained[at]!.until) at = i;
    }
    b.retained[at] = copy;
    if (b.retained.length !== ms.slots) b.retained.length = ms.slots;
    this.emitModeling(b);
  }

  /**
   * REPRODUCTION and MOTIVATION: what pressing a slot casts. The copy's
   * number is ALWAYS Bandura's own base × the motivation rate; only its
   * effects come from the original (bandura.ts header).
   */
  private reproduce(a: FightActor, entry: Hero["palette"][number]): { base: number; effects: Effect[] } {
    const ms = a.hero!.modeling!;
    const idx = entry.effects.find((e) => e.kind === "modeling.reproduce")?.magnitude ?? 0;
    const slot = a.retained[idx];
    if (!slot || slot.until <= this.simT) {
      // Rehearsal: an empty slot still swings, at a fraction. Never a dead key.
      a.retained[idx] = null;
      this.hooks.defenseProc?.("Rehearsal", a.id);
      this.emitModeling(a);
      return { base: entry.base * ms.emptyMult, effects: [] };
    }
    a.retained[idx] = null; // reproduced: the slot is spent until the model acts again
    const mult = slot.view.motivated ? ms.motivatedMult : ms.unmotivatedMult;
    const amount = entry.base * mult;
    let hasShape = false;
    const effects: Effect[] = slot.effects.map((e) => {
      if (HEAL_SHAPE_KINDS.has(e.kind)) {
        hasShape = true;
        return { ...e, magnitude: amount, durationMs: e.durationMs };
      }
      return {
        ...e,
        magnitude: e.magnitude === undefined || UNSCALED_MAGNITUDE.has(e.kind) ? e.magnitude : e.magnitude * mult,
        durationMs: e.durationMs === undefined ? undefined : e.durationMs * mult,
      };
    });
    this.hooks.defenseProc?.(`${slot.view.name}${slot.view.motivated ? " — motivated" : ""}`, a.id);
    if (slot.view.motivated) {
      this.hooks.playerBuff(
        "Motivated",
        1_500,
        "buff",
        "motivated",
        "motivated",
        "Vicarious reinforcement: your model was rewarded for this, so your copy pays the full rate.",
        a.id
      );
    }
    this.emitModeling(a);
    if (slot.heals) {
      // A copied heal heals for his number: through its own shape if it had
      // one (a copied Centration is still one target), else across the team.
      if (!hasShape) this.healParty(a, amount, "team", slot.view.name);
      return { base: 0, effects };
    }
    return { base: amount, effects };
  }

  /**
   * Erikson's keys 1 and 2: advance the rotation and say what the cast is
   * worth. Key 1 always pays its base; key 2 pays its base only as the
   * matched half of a pair — pressed with no stage armed it is the weak hit.
   * Every other entry passes straight through.
   */
  private psychosocialBase(a: FightActor, entry: Hero["palette"][number]): number {
    const spec = a.hero?.psychosocial;
    const ps = a.psycho;
    if (!spec || !ps) return entry.base;
    if (entry.effects.some((e) => e.kind === "psychosocial.stage")) {
      castLifeStage(ps);
      this.emitPsychosocial(a);
      return entry.base;
    }
    if (entry.effects.some((e) => e.kind === "psychosocial.virtue")) {
      const { matched, stage } = castVirtue(ps, spec);
      const row = spec.stages[stage]!;
      // The pair, named over the boss — the line the kit exists to teach.
      this.hooks.defenseProc?.(
        matched ? `${row.crisis} → ${row.virtue}` : `${row.virtue} grows from ${row.short}: press 1 first`,
        a.id
      );
      if (matched && spec.pairFocusRefund > 0) {
        this.hooks.gainFocus?.(spec.pairFocusRefund, a.id);
        this.hooks.defenseProc?.(`+${spec.pairFocusRefund} Focus`, a.id);
      }
      if (matched) {
        this.hooks.playerBuff(
          `Virtues ${ps.virtues}/${spec.maxVirtues}`,
          3_600_000,
          "buff",
          "virtues",
          "virtues",
          `Virtues banked by completed stages. Life Review (F) spends them all: ${a.hero!.ultimate.perMark} damage each.`,
          a.id
        );
      }
      this.emitPsychosocial(a);
      return matched ? entry.base : entry.base * spec.unmatchedVirtueMult;
    }
    return entry.base;
  }

  /**
   * Effect kinds any slot may carry — palette, defense floor, chain or
   * ultimate. Hero-engine kinds (pairings, schedules, the operant toggles)
   * stay with their own resolvers; these are the plain ones, and most arrived
   * with Ainsworth's kit, the attachment styles' reunions:
   *
   *  - `mitigation.grant`  self/team damage-taken cut (Pavlov's UCS first)
   *  - `taunt`             the boss locks onto the caster (Generalization first)
   *  - `team.cleanse`      lifts Fixation off every living teammate
   *  - `team.amp`          a team damage window on the overheal Amp term
   *  - `threat.drop`       the caster sheds a share of their threat
   *  - `self.stagger`      hits taken are deferred and bleed out over N s
   *  - `heal.cut.self`     healing the caster receives is cut
   *  - `team.immunity`     boss hits on every OTHER teammate land nowhere
   */
  private applySharedEffects(
    a: FightActor,
    effects: readonly Effect[]
  ): void {
    for (const e of effects) {
      const until = this.simT + (e.durationMs ?? 0) / 1000;
      const secs = (e.durationMs ?? 0) / 1000;
      if (e.kind === "mitigation.grant") {
        a.mitigations.push({ magnitude: e.magnitude ?? 0, until, target: e.target === "team" ? "team" : "self" });
      } else if (e.kind === "taunt") {
        // Where the boss is LOOKING is boss state, so the window and its owner
        // live on the fight, not the actor.
        this.tauntUntil = until;
        this.tauntActorId = a.id;
        this.hooks.announce(`${this.script.displayName} wheels on ${a.name} — taunted!`);
      } else if (e.kind === "team.cleanse") {
        for (const c of this.actors) {
          if (!c.alive || c.fixationUntil <= this.simT) continue;
          c.fixationUntil = -1;
          this.hooks.defenseProc?.("Cleansed", c.id);
          this.hooks.playerBuff("Fixation — damage −30%", 1, "debuff", "fixation", undefined, "", c.id);
        }
      } else if (e.kind === "team.amp") {
        // Rides the overheal Amp term (capped at COMBAT.maxAmp with it), so
        // two damage windows can never stack past what overheal already may.
        this.ampEvents.push({ amp: e.magnitude ?? 0, until });
        const pct = Math.round((e.magnitude ?? 0) * 100);
        this.hooks.playerBuff(
          `${e.label ?? "Exploration"} — team +${pct}%`,
          e.durationMs ?? 0,
          "buff",
          e.icon ?? "exploration",
          e.icon ?? "exploration",
          e.label
            ? `${e.label}: the whole team deals +${pct}% damage for ${secs} s.`
            : `A secure base to explore from: the whole team deals +${pct}% damage for ${secs} s.`,
          a.id
        );
      } else if (e.kind === "threat.drop") {
        a.threat *= 1 - (e.magnitude ?? 0);
      } else if (e.kind === "self.stagger") {
        a.staggerUntil = until;
        a.staggerSpreadS = e.magnitude ?? 4;
        this.hooks.playerBuff(
          "Masked Distress",
          e.durationMs ?? 0,
          "buff",
          "masked_distress",
          undefined,
          `Looks calm, isn't: hits you take for ${secs} s are deferred and bleed out over ${a.staggerSpreadS} s instead of landing at once (Sroufe & Waters, 1977: avoidant infants' heart rates rise on reunion).`,
          a.id
        );
      } else if (e.kind === "heal.cut.self") {
        a.healCutUntil = until;
        a.healCut = e.magnitude ?? 0;
        this.hooks.playerBuff(
          `Resistant — healing received −${Math.round(a.healCut * 100)}%`,
          e.durationMs ?? 0,
          "debuff",
          "resistant",
          "resistant",
          `Wants comfort and resists it: healing you receive is cut ${Math.round(a.healCut * 100)}% for ${secs} s.`,
          a.id
        );
      } else if (e.kind === "team.immunity") {
        let n = 0;
        for (const c of this.actors) {
          if (!c.alive || c === a) continue;
          c.immuneUntil = until;
          n++;
          this.hooks.playerBuff(
            "Sheltered — immune to the boss",
            e.durationMs ?? 0,
            "buff",
            "sheltered",
            "sheltered",
            `${a.name} throws herself in front: the boss's attacks cannot touch you for ${secs} s. She is not covered herself.`,
            c.id
          );
        }
        if (n > 0) this.hooks.announce(`${a.name} shelters the team — ${secs} s of immunity!`);
      } else if (e.kind === "vulnerability") {
        // Boss-side damage-taken term (the P3-armor slot), NOT team Amp —
        // the sheet's assumed attack buff (pavlov.ts S3).
        this.vulnUntil = until;
        this.vulnMagnitude = e.magnitude ?? 0;
        const pct = Math.round(this.vulnMagnitude * 100);
        this.hooks.playerBuff(
          `${e.label ?? "Exposed"} — boss takes +${pct}%`,
          e.durationMs ?? 0,
          "buff",
          e.icon ?? "vulnerability",
          undefined,
          `The boss is exposed: it takes +${pct}% damage from the whole team for ${secs} s.`,
          a.id
        );
      } else if (e.kind === "heal.hot") {
        // Circular Reaction: the most wounded gets the heal in ticks, one a
        // second. Repeating it on them stacks a second train — infants repeat
        // what worked, and so may you.
        const t = this.mostWounded();
        if (!t) continue;
        const ticks = Math.max(1, Math.round(secs));
        t.hots.push({ perTick: (e.magnitude ?? 0) / ticks, left: ticks, nextAt: this.simT + 1, periodS: 1, src: a, label: e.label ?? "Circular Reaction" });
        this.hooks.playerBuff(
          "Circular Reaction",
          e.durationMs ?? 0,
          "buff",
          "circular_reaction",
          "circular_reaction",
          `Healed ${Math.round(e.magnitude ?? 0)} over ${secs} s, a tick each second. Recast to repeat it: a second train runs alongside.`,
          t.id
        );
      } else if (e.kind === "heal.single") {
        // Centration: all of it on one teammate, nobody else.
        const t = this.mostWounded();
        if (t) this.noteReinforcementHealing(a, this.healCombatant(t, e.magnitude ?? 0, e.label ?? "Centration", a));
      } else if (e.kind === "conservation") {
        // Conservation: the team's HP is poured out evenly — the same total,
        // rearranged — and then the heal lands on top. Nobody can die of it:
        // the share is the mean, and the mean of the living is above zero.
        const living = this.actors.filter((c) => c.alive);
        if (living.length > 1) {
          const fracMean = living.reduce((sum, c) => sum + c.hp / c.hpMax, 0) / living.length;
          for (const c of living) c.hp = Math.max(1, Math.min(c.hpMax, fracMean * c.hpMax));
          for (const c of living) if (c.input) this.hooks.healPlayer(0, c.id); // HP bars repaint
          this.hooks.defenseProc?.("Conserved", a.id);
          this.hooks.playerBuff("Conserved", 2_000, "buff", "conserved", "conserved", "Conservation: the team's health was shared out evenly — same total, new shape.", a.id);
        }
        this.healParty(a, e.magnitude ?? 0, "team", e.label ?? "Conservation");
      } else if (e.kind === "shield.team") {
        // Hypothetical / Accommodation: absorb pools split across the living,
        // spent before HP. What is left at expiry pays out as Amp, like overheal.
        const living = this.actors.filter((c) => c.alive);
        const each = ((e.magnitude ?? 0) * a.potionHeal * a.petHeal) / Math.max(1, living.length);
        for (const c of living) {
          c.shields.push({ left: each, until, label: e.label ?? "Shield" });
          this.hooks.playerBuff(
            "Shielded",
            e.durationMs ?? 0,
            "buff",
            "hypothetical",
            "hypothetical",
            `A shield of ${Math.round(each)} absorbs damage before your health for ${secs} s. Whatever is left when it fades becomes team Amp.`,
            c.id
          );
        }
      } else if (e.kind === "ally.undying") {
        // Object Permanence: the teammate is still there even when the bar
        // says otherwise — no lower than 1 HP for the window, then the heal.
        const t = this.mostWounded();
        if (!t) continue;
        t.undyingUntil = until;
        t.undyingHeal = { amount: e.magnitude ?? 0, src: a, label: e.label ?? "Object Permanence" };
        this.hooks.playerBuff(
          "Object Permanence",
          e.durationMs ?? 0,
          "buff",
          "object_permanence",
          "object_permanence",
          `You cannot drop below 1 health for ${secs} s, and then you are healed ${Math.round(e.magnitude ?? 0)}. Still there, even out of sight.`,
          t.id
        );
        this.hooks.announce(`${a.name} holds ${t.name} in mind — Object Permanence!`);
      }
    }
  }

  /** The living combatant with the lowest HP fraction — where a heal is aimed. */
  private mostWounded(): FightActor | null {
    let best: FightActor | null = null;
    for (const c of this.actors) {
      if (!c.alive) continue;
      if (!best || c.hp / c.hpMax < best.hp / best.hpMax) best = c;
    }
    return best;
  }

  /** Non-damage riders a palette entry carries — UCS's window, CS's consume. */
  private applyPaletteEffects(
    a: FightActor,
    effects: readonly Effect[]
  ): void {
    this.applySharedEffects(a, effects);
    const cond = a.hero?.conditioning;
    const rf = a.hero?.reinforcement;
    for (const e of effects) {
      if (e.kind === "ucr.window" && cond) {
        // The food. If a bell was still ringing (rung within its own cooldown
        // — one bell, one ring), this is the DELAY pairing, the real thing.
        a.ucrUntil = this.simT + (e.durationMs ?? 4_000) / 1000;
        if (a.lastNsAt >= 0 && a.hero && this.simT - a.lastNsAt <= a.hero.basic.cooldownMs / 1000) {
          a.lastNsAt = -1; // consumed — a ring pairs once
          this.rollPairing(a, "delay");
        }
        this.hooks.playerBuff(
          "UCR — the boss salivates",
          e.durationMs ?? 4_000,
          "buff",
          "ucr",
          undefined,
          "Unconditioned response window: the food is out and the boss salivates. Ring the bell (basic attack) just before or during this window to bank a Pairing.",
          a.id
        );
      } else if (e.kind === "conditioned.consume" && cond) {
        a.conditionedUntil = -1;
        this.emitConditioning(a);
      } else if (e.kind === "conditioned-response.stagger" && cond) {
        a.crActive = true;
      } else if (e.kind === "schedule.fixed-ratio" && rf) {
        // FR: the whole team, the same pellet, every time. Zero variance.
        this.healParty(a, rf.schedules.fixedRatio.teamTotal, "team", "Fixed Ratio");
      } else if (e.kind === "schedule.variable-ratio" && rf) {
        // VR: the slot machine — usually the FR pellet, 1-in-4 the jackpot,
        // identical EV. Lands on the most-wounded living, Skinner included.
        const s = rf.schedules.variableRatio;
        const jackpot = Math.random() < s.highChance;
        const living = this.actors.filter((c) => c.alive);
        const target = living.sort((x, y) => x.hp / x.hpMax - y.hp / y.hpMax)[0];
        if (target)
          this.noteReinforcementHealing(
            a,
            this.healCombatant(target, jackpot ? s.high : s.low, "Variable Ratio", a)
          );
        if (jackpot) {
          this.hooks.sfxEvent?.("vr.jackpot", a.id);
          this.hooks.defenseProc?.("JACKPOT", a.id);
          this.hooks.announce(`${a.name}'s Variable Ratio hits the JACKPOT — the lever pays out!`);
        }
      } else if (e.kind === "schedule.fixed-interval" && rf) {
        // FI: payout per unit TIME on a fixed clock. Each cast opens its own
        // window; past the cap the OLDEST window is replaced.
        const s = rf.schedules.fixedInterval;
        if (a.fiTickers.length >= rf.schedules.maxStacks) a.fiTickers.shift();
        a.fiTickers.push({ nextAt: this.simT + s.periodMs / 1000, until: this.simT + s.durationMs / 1000 });
        // Stable id: the ×N count renames the tile on every stack, and the
        // buff layer must refresh one tile, not raise a second.
        this.hooks.playerBuff(
          `Fixed Interval ×${a.fiTickers.length} — team heal on the clock`,
          s.durationMs,
          "buff",
          "fixed_interval",
          "fixed_interval",
          `Reinforcement on a fixed clock: each stack heals the team every ${s.periodMs / 1000} s, on schedule, for ${s.durationMs / 1000} s. Recast to stack another clock.`,
          a.id
        );
      } else if (e.kind === "schedule.variable-interval" && rf) {
        // VI: random moments for 20 s. Self-stacks the same way.
        const s = rf.schedules.variableInterval;
        if (a.viTickers.length >= rf.schedules.maxStacks) a.viTickers.shift();
        a.viTickers.push({ nextRollAt: this.simT + 1, until: this.simT + s.durationMs / 1000 });
        this.hooks.playerBuff(
          `Variable Interval ×${a.viTickers.length} — heals from time to time`,
          s.durationMs,
          "buff",
          "variable_interval",
          "variable_interval",
          `Reinforcement at unpredictable moments: each stack pays out team heals at random times for ${s.durationMs / 1000} s. Recast to stack another.`,
          a.id
        );
      }
    }
  }

  /**
   * The multiplier a cast actually pays.
   *
   * A hero with no `beats` has no cycle, so the beat argument every caller
   * passes is ignored and every cast is flat. Neutralised HERE rather than at
   * the call sites so the arena, the hub bar and tools/sim-check.mjs cannot
   * disagree about what a cast is worth.
   */
  private beatOf(a: FightActor, beat: number): number {
    return a.hero?.beats ? beat : 1;
  }

  /**
   * Boss states a gated palette entry can require (`requiresBossState`).
   *
   * Read off the CASTER: "the boss is conditioned" is really "this trainer has
   * conditioned the boss", so one Pavlov's CS window never unlocks another's.
   */
  private bossStateActive(a: FightActor, state: string): boolean {
    if (state === "conditioned") return this.simT < a.conditionedUntil;
    if (state === "ucr") return this.simT < a.ucrUntil;
    return false;
  }

  private rollPairing(a: FightActor, quality: "delay" | "simultaneous" | "backward"): void {
    const cond = a.hero?.conditioning;
    if (!cond || !this.canAct(a)) return;
    if (this.simT < a.conditionedUntil) return; // already learned — nothing to bank
    const spec = cond.pairing[quality];
    if (Math.random() >= spec.chance) return;
    // A pairing TOOK. This — not the bell, not the food — is the moment S1's
    // `pairing.focus` pays out: every early return above is a bell that missed
    // its window, and it leaves with nothing (pavlov.ts, the UCS entry).
    //
    // Once per successful pairing, NOT per Pairing banked: the delay pairing
    // banks 2 and still collects 5. See the data note for why.
    const focus = this.pairingFocus(a);
    if (focus > 0) {
      this.hooks.gainFocus?.(focus, a.id);
      this.hooks.defenseProc?.(`Pairing +${focus} Focus`, a.id);
    }
    this.bankPairings(a, spec.pairings);
  }

  /**
   * How many pairings THIS cycle wants, rolled once and then held.
   *
   * Rolled lazily rather than up front so it is always the live spec that is
   * read, and so an Extinction or a decay simply zeroes it and the next bell
   * draws again. Uniform and inclusive over [min, max].
   */
  private requiredPairings(a: FightActor, cond: NonNullable<Hero["conditioning"]>): number {
    if (a.pairingTarget > 0) return a.pairingTarget;
    const { min, max } = cond.pairingsToCondition;
    const lo = Math.max(1, Math.floor(min));
    const hi = Math.max(lo, Math.floor(max));
    a.pairingTarget = lo + Math.floor(Math.random() * (hi - lo + 1));
    return a.pairingTarget;
  }

  /**
   * Focus one successful pairing pays, read off the S1 palette entry that
   * declares it (`pairing.focus`) — 0 for a hero whose kit does not.
   *
   * Scanned across the whole palette rather than off a fixed index so the
   * reward follows the DATA: move the effect from UCS to CS and the sim
   * follows without an edit here.
   */
  private pairingFocus(a: FightActor): number {
    for (const entry of a.hero?.palette ?? []) {
      const e = entry.effects.find((x) => x.kind === "pairing.focus");
      if (e) return e.magnitude ?? 0;
    }
    return 0;
  }

  private bankPairings(a: FightActor, n: number): void {
    const cond = a.hero?.conditioning;
    if (!cond) return;
    const need = this.requiredPairings(a, cond);
    a.pairings = Math.min(need, a.pairings + n);
    if (a.pairings >= need) {
      a.pairings = 0;
      a.pairingTarget = 0; // next cycle rolls its own
      a.conditionedUntil = this.simT + cond.conditionedWindowS;
      a.extinguished = false;
      this.hooks.playerBuff(
        "CONDITIONED — CS ready",
        cond.conditionedWindowS * 1000,
        "buff",
        "conditioned",
        undefined,
        `The response is learned: the conditioned stimulus is unlocked for ${cond.conditionedWindowS} s. Cast the CS now — the bell alone triggers the full response.`,
        a.id
      );
      this.hooks.announce(`${this.script.displayName} is CONDITIONED — the response is learned!`);
    } else {
      // NO denominator. The target is a hidden 1..3 roll, so "1/3" would be a
      // lie two cycles in three and printing the rolled value would hand the
      // player the answer — the not-knowing is the point (see pavlov.ts).
      this.hooks.playerBuff(
        `Pairing ${a.pairings} banked`,
        cond.conditionedWindowS * 1000,
        "buff",
        "pairing",
        undefined,
        "Bell-and-food pairings banked toward conditioning. The count needed this cycle is hidden (1–3) — keep pairing until CONDITIONED lights.",
        a.id
      );
    }
    this.emitConditioning(a);
  }

  private emitConditioning(a: FightActor): void {
    const cond = a.hero?.conditioning;
    if (!cond) return;
    a.condWasActive = this.simT < a.conditionedUntil;
    this.hooks.conditioningChanged?.(
      {
        pairings: a.pairings,
        needed: cond.pairingsToCondition.max,
        conditioned: a.condWasActive,
        extinguished: a.extinguished,
      },
      a.id
    );
  }

  // -------------------------------------------------------------------------
  // Operant engine (Skinner — the actor's `hero.reinforcement`)
  // -------------------------------------------------------------------------

  /** Live toggle state for the bar's initial paint; null for other heroes. */
  get operant(): OperantHudState | null {
    return this.operantFor(this.primary.id);
  }

  /** Erikson's rotation for one actor, or null for any other kit. */
  psychosocialFor(actorId: string): PsychosocialHudState | null {
    const a = this.actorBy(actorId);
    return a?.psycho ? { ...a.psycho } : null;
  }

  private emitPsychosocial(a: FightActor): void {
    if (!a.psycho) return;
    this.hooks.psychosocialChanged?.({ ...a.psycho }, a.id);
  }

  operantFor(actorId: string): OperantHudState | null {
    const a = this.actorBy(actorId);
    return a?.hero?.reinforcement
      ? { contingency: a.contingency, consequence: a.consequence }
      : null;
  }

  private emitOperant(a: FightActor): void {
    if (!a.hero?.reinforcement) return;
    this.hooks.operantChanged?.({ contingency: a.contingency, consequence: a.consequence }, a.id);
    // The live quadrant, pinned to the buff bar until the next flip. The E/R
    // action faces wear the cell a press would SWITCH to, so this tile is the
    // only readout of the mode currently paying out. Stable id: a flip must
    // repaint this tile, not stack a second one.
    const q = this.quadrant(a);
    this.hooks.playerBuff(q.name, Infinity, "buff", q.icon, "operant_quadrant", q.desc, a.id);
  }

  /** The live quadrant's display name and icon key ("positive_reinforcement"). */
  private quadrant(a: FightActor): { name: string; icon: string; desc: string } {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    // The popup explains what the LIVE cell is paying for and paying with —
    // the two toggles are the whole kit, so this tile is its rulebook.
    const watching =
      a.contingency === "positive"
        ? "allies proc by DEALING damage"
        : "allies proc by staying CLEAN of damage taken";
    const paying =
      a.consequence === "reinforcement"
        ? "each proc heals that ally"
        : "each proc grants damage-taken mitigation";
    return {
      name: `${cap(a.contingency)} ${cap(a.consequence)}`,
      icon: `${a.contingency}_${a.consequence}`,
      desc: `The live operant mode: ${watching}, and ${paying}. Every proc also banks an Approximation for Shaping. E flips the contingency, R flips the consequence.`,
    };
  }

  /** This engine owner's book-keeping about one combatant, created on demand. */
  private watch(c: FightActor, ownerId: string): OperantWatch {
    let w = c.watched.get(ownerId);
    if (!w) {
      w = { approx: [], posProgress: 0, cleanSince: -1 };
      c.watched.set(ownerId, w);
    }
    return w;
  }

  /** Every actor running an operant engine — the observers of team behaviour. */
  private get operantOwners(): FightActor[] {
    return this.actors.filter((a) => a.hero?.reinforcement);
  }

  /**
   * One consequence delivered — an ally emitted the watched behavior. Pays
   * the R toggle's currency and banks an Approximation either way: every
   * quadrant feeds Shaping.
   */
  private operantProc(owner: FightActor, c: FightActor, via: "positive" | "negative"): void {
    const rf = owner.hero?.reinforcement;
    if (!rf || !this.inCombat || !c.alive) return;
    this.hooks.sfxEvent?.("operant.proc", owner.id);
    const q = this.quadrant(owner);
    if (owner.consequence === "reinforcement") {
      this.noteReinforcementHealing(owner, this.healCombatant(c, rf.procHeal[via], q.name, owner));
    } else if (c.input) {
      // Punishment: mitigation lands BEFORE the hit. Grants are per-actor now,
      // so the term goes onto the RECIPIENT's own table — a bot ally still has
      // no mitigation table worth pushing to, hence the input gate.
      c.mitigations.push({
        magnitude: rf.procMitigation.magnitude,
        until: this.simT + rf.procMitigation.durationMs / 1000,
        target: "self",
      });
      this.hooks.playerBuff(
        `${q.name} — damage taken −${Math.round(rf.procMitigation.magnitude * 100)}%`,
        rf.procMitigation.durationMs,
        "buff",
        q.icon,
        undefined,
        `An operant proc landed on you: incoming damage is reduced ${Math.round(rf.procMitigation.magnitude * 100)}% for ${rf.procMitigation.durationMs / 1000} s.`,
        c.id
      );
    }
    // The Approximation — Shaping's fuel, cap per ally, extinguishes in 30 s.
    const w = this.watch(c, owner.id);
    const live = w.approx.filter((u) => u > this.simT);
    live.push(this.simT + rf.approximation.durationMs / 1000);
    while (live.length > rf.approximation.capPerAlly) live.shift();
    w.approx = live;
    if (c.input) {
      this.hooks.playerBuff(
        `Approximation ${live.length}/${rf.approximation.capPerAlly}`,
        rf.approximation.durationMs,
        "buff",
        "approximation",
        undefined,
        `Shaping fuel: successive approximations banked on you (cap ${rf.approximation.capPerAlly}). Shaping (F) consumes every live stack and heals its carrier per stack; each extinguishes after ${rf.approximation.durationMs / 1000} s.`,
        c.id
      );
    }
  }

  /** Positive contingency: damage an ally DEALS accrues toward their procs. */
  private operantDamageDealt(owner: FightActor, c: FightActor, dealt: number): void {
    const rf = owner.hero?.reinforcement;
    if (!rf || dealt <= 0 || owner.contingency !== "positive") return;
    const w = this.watch(c, owner.id);
    w.posProgress += dealt;
    while (w.posProgress >= rf.positiveDamagePerProc) {
      w.posProgress -= rf.positiveDamagePerProc;
      this.operantProc(owner, c, "positive");
    }
  }

  /** Damage one combatant dealt, offered to every live operant engine. */
  private creditDamageDealt(c: FightActor, dealt: number): void {
    for (const owner of this.operantOwners) this.operantDamageDealt(owner, c, dealt);
  }

  /**
   * Effective healing delivered by the KIT (overheal excluded — it already
   * pays out as Amp) banks toward Response Strength: 1 stack per 137, +20%
   * basic damage each, expiring individually — a rolling 15 s record of
   * reinforcement history, worn as a buff.
   */
  private noteReinforcementHealing(a: FightActor, healed: number): void {
    const rf = a.hero?.reinforcement;
    if (!rf || healed <= 0) return;
    const rs = rf.responseStrength;
    a.rsAccum += healed;
    a.rsStacks = a.rsStacks.filter((u) => u > this.simT);
    let gained = false;
    while (a.rsAccum >= rs.healPerStack) {
      a.rsAccum -= rs.healPerStack;
      gained = true;
      // At cap the freshest pellet still refreshes the record — the oldest
      // stack rolls off, exactly like a strip-chart recorder.
      if (a.rsStacks.length >= rs.maxStacks) a.rsStacks.shift();
      a.rsStacks.push(this.simT + rs.durationMs / 1000);
    }
    if (gained && a.rsStacks.length > 0) {
      const latest = a.rsStacks[a.rsStacks.length - 1]!;
      this.hooks.playerBuff(
        `Response Strength ${a.rsStacks.length}/${rs.maxStacks} — basic +${Math.round(
          a.rsStacks.length * rs.damagePerStack * 100
        )}%`,
        (latest - this.simT) * 1000,
        "buff",
        "response_strength",
        undefined,
        `Reinforcement history, worn as damage: +${Math.round(rs.damagePerStack * 100)}% basic-attack damage per stack. A stack banks per ${rs.healPerStack} effective healing delivered and expires on its own ${rs.durationMs / 1000} s clock.`,
        a.id
      );
    }
  }

  /**
   * E — Defense Mechanism.
   *
   * Doc 08 §4.1: a GUARANTEED floor on every cast (heal + self-mitigation),
   * with one of the six mechanisms rolled as a rider ON TOP. It used to be the
   * roll alone, which meant the slot the role contract reserves for "one
   * reliable defensive button" healed on 1 face in 6 and did nothing at all on
   * 4 of them.
   */
  castDefense(): string | null {
    return this.castDefenseAs(this.primary.id);
  }

  castDefenseAs(actorId: string): string | null {
    const a = this.actorBy(actorId);
    if (!a?.hero || !this.canAct(a)) return null;
    const ability = a.hero.defense;

    // Operant toggle (Skinner's E): a free stance flip, no floor, no rider —
    // the 20% slot budget pays out through the proc engine, not the cast.
    if (ability.effects.some((e) => e.kind === "contingency.toggle")) {
      a.contingency = a.contingency === "positive" ? "negative" : "positive";
      this.emitOperant(a);
      return `Contingency: ${a.contingency === "positive" ? "Positive" : "Negative"}`;
    }

    // --- the floor: paid every single cast ----------------------------------
    // healTarget "team" quotes the TOTAL, split across the living (doc 08
    // §4.3) — the tank-E shape. Absent = the DPS row's self-heal.
    if (ability.heal) this.healParty(a, ability.heal, ability.healTarget ?? "self", ability.name);
    if (ability.mitigation) {
      a.mitigations.push({
        magnitude: ability.mitigation.magnitude,
        until: this.simT + ability.mitigation.durationMs / 1000,
        target: ability.mitigation.target,
      });
    }

    // Plain kinds on a defense are part of the floor too (Safe Haven's
    // cleanse), not a rider to roll for.
    const floorKinds = SHARED_KINDS;
    this.applySharedEffects(a, ability.effects.filter((e) => floorKinds.has(e.kind)));

    // --- the rider: flavour on top, never instead of ------------------------
    const pool = ability.effects.filter((e) => !floorKinds.has(e.kind));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const rider = pick?.kind.split(".")[0];
    const label = rider ? `${ability.name}: ${rider}` : ability.name;
    // One rider per cast — the new roll replaces whatever was still up.
    a.absorbNextHit = false;
    a.denialUntil = -1;
    a.reflectNextHit = false;
    a.redirectNextHit = false;
    a.focusNextHit = false;
    const riderWindowS = (ability.mitigation?.durationMs ?? 6_000) / 1000;
    if (pick?.kind === "regression.heal") {
      // The only roll with a cost, and the one that overpays: doubles the heal.
      // It fires at cast, not on a later hit — so its proc floats now.
      this.hooks.defenseProc?.("Regression", a.id);
      this.healCombatant(a, ability.heal ?? 0, ability.name, a);
    } else if (pick?.kind === "repression.absorb") {
      a.absorbNextHit = true;
    } else if (pick?.kind === "denial.debuff-immunity") {
      a.denialUntil = this.simT + riderWindowS;
    } else if (pick?.kind === "projection.reflect") {
      a.reflectNextHit = true;
      a.reflectMagnitude = pick.magnitude ?? 0.4;
    } else if (pick?.kind === "displacement.redirect") {
      a.redirectNextHit = true;
    } else if (pick?.kind === "sublimation.damage-to-focus") {
      a.focusNextHit = true;
    } else if (pick?.kind === "pairing.refund") {
      // Spontaneous Recovery: after extinction, a rest period brings the
      // response back at one free Pairing — gated in DATA (requiresSelfState)
      // and once per extinction, or E-spam mints CS off budget (pavlov.ts).
      const gateOpen = pick.requiresSelfState !== "extinguished" || a.extinguished;
      if (gateOpen && !a.srRefundUsed) {
        a.srRefundUsed = true;
        this.hooks.defenseProc?.("Spontaneous Recovery", a.id);
        this.bankPairings(a, pick.magnitude ?? 1);
      }
    }
    // The tile's window IS the rider's window — the mitigation duration above.
    // Popup: the guaranteed floor first, then what THIS cast's rolled rider
    // does — the roll is the psychoanalytic fantasy, so the popup names it.
    const riderDesc: Record<string, string> = {
      repression: "Repression rider: the next hit is absorbed entirely.",
      denial: "Denial rider: immune to debuffs for the window.",
      projection: `Projection rider: ${Math.round((pick?.magnitude ?? 0.4) * 100)}% of the next hit is thrown back at the boss.`,
      displacement: "Displacement rider: the next hit is redirected — it lands nowhere.",
      sublimation: "Sublimation rider: the next hit converts to Focus instead of damage.",
      regression: "Regression rider: the heal paid out doubled at cast.",
      pairing: "Spontaneous Recovery rider: after extinction, one free Pairing returns.",
    };
    const floorDesc = [
      ability.heal ? `heals ${ability.heal}` : "",
      ability.mitigation
        ? `cuts damage taken ${Math.round(ability.mitigation.magnitude * 100)}% for ${ability.mitigation.durationMs / 1000} s`
        : "",
      ability.effects.some((e) => e.kind === "team.cleanse") ? "lifts Fixation off the whole team" : "",
    ]
      .filter(Boolean)
      .join(" and ");
    this.hooks.playerBuff(
      label,
      ability.mitigation?.durationMs ?? 6_000,
      "buff",
      // A rider-less defense (Erikson's Moratorium) wears its own skill icon;
      // there is no generic "defense" tile, and asking for one 404s on every
      // buff-bar repaint.
      rider ?? iconSlug(ability.id),
      undefined,
      [floorDesc ? `Guaranteed floor: ${floorDesc}.` : "", rider ? riderDesc[rider] ?? "" : ""]
        .filter(Boolean)
        .join(" "),
      a.id
    );
    this.observe(a, ability, false);
    return label;
  }

  /**
   * R — Free Association: damage, plus the next three palette casts cannot be
   * wrong.
   *
   * ★ AOE. The ability carries `aoeRadius` (map-wide for Freud), which
   * `landHit` fans across every hostile in range. NIGHTMARE has only the boss
   * so it resolves as a single hit today; the plumbing is live for the moment
   * a fight brings adds.
   */
  castChain(beat: number): PendingHit | null {
    return this.castChainAs(this.primary.id, beat);
  }

  castChainAs(actorId: string, beat: number): PendingHit | null {
    const a = this.actorBy(actorId);
    if (!a?.hero || !this.canAct(a)) return null;
    const ability = a.hero.chain;
    // Operant toggle (Skinner's R): the other half of the quadrant. No
    // damage, no projectile — the bar reacts through `operantChanged`.
    if (ability.effects.some((e) => e.kind === "consequence.toggle")) {
      a.consequence = a.consequence === "reinforcement" ? "punishment" : "reinforcement";
      this.emitOperant(a);
      return null;
    }
    if (ability.effects.some((e) => e.kind === "palette.auto-correct")) {
      a.freeAssocLeft = FREE_ASSOC_CASTS;
      a.freeAssocUntil = this.simT + 8; // matches the buff's 8 s window
      this.hooks.playerBuff(
        ability.name,
        8_000,
        "buff",
        "free_association",
        undefined,
        `Whatever surfaces is right: your next ${FREE_ASSOC_CASTS} palette casts auto-correct — they count as the correct answer, banking the wound at half Mark credit.`,
        a.id
      );
    }
    // Taunt (Generalization: the boss fixes on the flying clock's owner),
    // threat drops and the rest of the plain kinds resolve in one place. A
    // chain's vulnerability wears the skill's own name and icon, as it did.
    this.applySharedEffects(
      a,
      ability.effects.map((e) => (e.kind === "vulnerability" ? { label: ability.name, icon: iconSlug(ability.id), ...e } : e))
    );
    for (const e of ability.effects) {
      if (e.kind === "decoy") {
        // Bobo Doll: the boss's single-target blows land on the doll.
        this.decoyUntil = this.simT + (e.durationMs ?? 0) / 1000;
        this.decoyRebound = e.magnitude ?? 0;
        this.decoyAbsorbed = 0;
        this.decoyOwnerId = a.id;
        this.hooks.playerBuff(
          ability.name,
          e.durationMs ?? 0,
          "buff",
          iconSlug(ability.id),
          undefined,
          `The boss beats on the doll instead of your tank for ${(e.durationMs ?? 0) / 1000} s, and the doll rebounds ${Math.round(this.decoyRebound * 100)}% of every blow at it.`,
          a.id
        );
        this.hooks.announce(`${a.name} sets up the Bobo doll — ${this.script.displayName} cannot resist it!`);
      }
      // "summon.clock" is scene dressing — the arena layer reads the cast.
    }
    const { damage, crit } = ability.base > 0 ? this.playerHit(a, ability.base, this.beatOf(a, beat), true) : { damage: 0, crit: false };
    this.observe(a, ability, crit);
    return {
      ...splitOverTime(damage, ability.overTime),
      crit,
      appliesMark: false,
      grantsDebuffStack: false,
      aoeRadius: ability.aoeRadius,
    };
  }

  /**
   * F — Dream Analysis: cash out the Mark board.
   *
   * Nothing lands at cast: the eye flies to the boss first, and only
   * `landUltimate` (called when the projectile connects) starts the payout —
   * the total fixed here, dealt in ULT_TICKS ticks by `tick`. Returns the
   * total so the scene layer can size its readout; 0 means the cast fizzled.
   *
   * The Mark board it spends is the TEAM's (doc 02): in a party, whoever
   * presses F first cashes out everyone's Marks.
   */
  castUltimate(): number {
    return this.castUltimateAs(this.primary.id);
  }

  castUltimateAs(actorId: string): number {
    const a = this.actorBy(actorId);
    if (!a?.hero || !this.canAct(a)) return 0;
    const ult = a.hero.ultimate;
    a.lastUltAt = this.simT;
    // Erikson's Life Review spends HIS virtues; every other ultimate spends
    // the team's Mark board.
    const own = a.psycho ? a.psycho.virtues : this.marks.length;
    const resolved = resolveUltimate({
      // The 30% direct share — what pressing F with a thin board is worth.
      direct: ult.base,
      perMark: ult.perMark,
      own,
      foreign: 0, // only Freud's Analysis Marks exist until more heroes land
      maxMarksConsumed: ult.maxMarksConsumed,
      amp: this.amp,
      gear: a.gear,
      format: this.format,
    });
    // Latte + pet Attack scalars on the whole payout — same terms every playerHit pays.
    const damage = resolved.damage * a.potionDamage * a.petDamage;
    const marksConsumed = resolved.marksConsumed;
    if (a.psycho) {
      a.psycho.virtues -= marksConsumed;
      this.emitPsychosocial(a);
      this.hooks.playerBuff(
        `Virtues ${a.psycho.virtues}/${a.hero.psychosocial?.maxVirtues ?? 8}`,
        a.psycho.virtues > 0 ? 3_600_000 : 1,
        "buff",
        "virtues",
        "virtues",
        "Virtues banked by completed stages. Life Review (F) spends them all.",
        a.id
      );
    } else {
      this.marks.splice(0, marksConsumed);
    }
    // Tank ultimates pay 25% of the slot as a team heal alongside the damage.
    if (ult.heal) this.healParty(a, ult.heal, ult.healTarget ?? "self", ult.name);
    // Plain kinds (Earned Security's cleanse and team window) resolve here.
    this.applySharedEffects(a, ult.effects);
    for (const e of ult.effects) {
      if (e.kind === "zone.extinction") {
        // The dome: a boss-side OUTGOING cut (everything inside takes less),
        // deliberately NOT player mitigation — the 0.40 cap never sees it.
        // The sim has no positions, so "inside" is the whole party.
        this.domeUntil = this.simT + (e.durationMs ?? 0) / 1000;
        this.domeCut = e.magnitude ?? 0;
        this.hooks.playerBuff(
          `${ult.name} dome — boss deals −${Math.round(this.domeCut * 100)}%`,
          e.durationMs ?? 0,
          "buff",
          "dome_extinction",
          undefined,
          `Extinction dome: everything the boss deals is cut ${Math.round(this.domeCut * 100)}% for ${(e.durationMs ?? 0) / 1000} s — a boss-side cut, on top of your own mitigation.`,
          a.id
        );
      } else if (e.kind === "shaping.release") {
        // Shaping: consume every live Approximation on the team, healing its
        // carrier per stack — successive approximation cashing out. The 308
        // direct share already landed via `ult.heal` above; this is the 70%
        // payload. Overheal converts to Amp in healCombatant, so a full-HP
        // board is still a raid damage window. Only THIS Skinner's board is
        // consumed — a second one's approximations are their own to spend.
        const rf = a.hero.reinforcement;
        if (rf) {
          let consumed = 0;
          let payloadHealed = 0;
          for (const c of this.actors) {
            const w = this.watch(c, a.id);
            const live = w.approx.filter((u) => u > this.simT);
            w.approx = [];
            if (!c.alive || live.length === 0) continue;
            consumed += live.length;
            payloadHealed += this.healCombatant(
              c,
              live.length * rf.shaping.perApproximation,
              ult.name,
              a
            );
          }
          this.noteReinforcementHealing(a, payloadHealed);
          if (consumed > 0) {
            this.hooks.announce(
              `${a.name} releases Shaping — ${consumed} Approximations, one hop at a time!`
            );
          }
        }
      } else if (e.kind === "equilibration.release") {
        // Equilibration: the Marks pay HEALING — every schema Mark spent is
        // a share of the team heal (the 257 direct share already landed).
        if (marksConsumed > 0) {
          this.healParty(a, (e.magnitude ?? 0) * marksConsumed, "team", ult.name);
          this.hooks.announce(`${a.name} restores equilibrium — ${marksConsumed} schemas settle into a team heal!`);
        }
      } else if (e.kind === "conditioning.reset") {
        // Presenting the CS without the UCS IS extinction: his own loop is
        // wiped — Pairings, CONDITIONED, the CR — until he rebuilds or E.
        a.pairings = 0;
        a.pairingTarget = 0; // rebuilding draws a fresh 1..3
        a.conditionedUntil = -1;
        a.ucrUntil = -1;
        a.crActive = false;
        a.crBells = 0; // the flinch count dies with the response it counted
        a.extinguished = true;
        a.srRefundUsed = false;
        this.hooks.announce(`${a.name} extinguishes the response — the conditioning is unlearned.`);
        this.emitConditioning(a);
      }
    }
    this.hooks.playerBuff(
      ult.name,
      8_000,
      "buff",
      iconSlug(ult.id),
      undefined,
      `${ult.name} is resolving — the ultimate's payout window. Its damage or healing lands over the next moments.`,
      a.id
    );
    if (marksConsumed > 0 && a.psycho) {
      this.hooks.announce(
        `${a.name} looks back on ${marksConsumed} ${marksConsumed === 1 ? "virtue" : "virtues"} — ${ult.name} unfolds for ${Math.round(damage)}!`
      );
    } else if (marksConsumed > 0) {
      // Mark noun and skill name come from the kit — "Analysis Marks — Dream
      // Analysis" for Freud, "Conditioning Marks — Extinction" for Pavlov.
      const markNoun = a.hero.palette[0]?.markType ?? "analysis";
      const markLabel = markNoun.charAt(0).toUpperCase() + markNoun.slice(1);
      this.hooks.announce(
        `${a.name} cashes out ${marksConsumed} ${markLabel} Marks — ${ult.name} unfolds for ${Math.round(damage)}!`
      );
    }
    return damage;
  }

  /**
   * Did `castUltimateAs` just resolve for this actor (this sim tick)? A
   * healer's ultimate deals 0 damage and still happened — Skinner's Shaping,
   * Piaget's Equilibration — so "0 damage" alone cannot mean "fizzled". Both
   * drivers ask this before refusing, or the heal lands with no cooldown.
   */
  ultimateResolvedAs(actorId: string): boolean {
    const a = this.actorBy(actorId);
    return !!a && a.lastUltAt === this.simT && a.lastUltAt >= 0;
  }

  /** The eye reaches the boss: start the tick-by-tick payout of the cast total. */
  landUltimate(total: number): void {
    this.landUltimateAs(this.primary.id, total);
  }

  landUltimateAs(actorId: string, total: number): void {
    const a = this.actorBy(actorId);
    if (!a || !this.inCombat || total <= 0) return;
    a.ultTicks = { perTick: total / ULT_TICKS, left: ULT_TICKS, nextAt: this.simT };
  }

  /**
   * Every hostile a hit can land on.
   *
   * NIGHTMARE fields exactly one. Adds register here when a fight grows them,
   * at which point AOE casts start hitting more than single-target ones with
   * no further change to this file.
   */
  private hostileTargets(): HostileTarget[] {
    return [{ id: this.script.bossId, distanceM: 0 }];
  }

  /** Apply a computed hit when its projectile lands. Returns total damage dealt. */
  landHit(hit: PendingHit): number {
    return this.landHitAs(this.primary.id, hit);
  }

  landHitAs(actorId: string, hit: PendingHit): number {
    const a = this.actorBy(actorId);
    if (!a || !this.inCombat) return 0;
    // AOE fans the same damage across every hostile in range; single-target
    // takes the first. With one hostile on the field these are identical.
    const hostiles = this.hostileTargets();
    const struck = hit.aoeRadius
      ? hostiles.filter((t) => t.distanceM <= hit.aoeRadius!)
      : hostiles.slice(0, 1);
    let dealt = 0;
    for (let i = 0; i < struck.length; i++) dealt += this.damageBoss(hit.damage, false);
    this.addThreat(a, dealt);
    this.creditDamageDealt(a, dealt);
    if (hit.appliesMark) for (let m = 0; m < (hit.markCount ?? 1); m++) this.addMark();
    if (a.markFraction >= 1) {
      a.markFraction -= 1;
      this.addMark();
    }
    if (hit.grantsDebuffStack) this.addDebuffStack();
    // The over-time share: one tick train per struck hostile (one, here).
    const ot = hit.overTime;
    if (ot && ot.total > 0) {
      for (let i = 0; i < struck.length; i++) {
        a.dots.push({ perTick: ot.total / ot.ticks, left: ot.ticks, periodS: ot.periodS, nextAt: this.simT + ot.periodS, label: ot.label });
      }
    }
    return dealt;
  }

  /** The boss visuals report the current Shapeshift form (0-based stage). */
  notifyP2Stage(stage: number): void {
    if (this.phase !== "p2") return;
    if (stage === this.p2Stage) return;
    this.p2Stage = stage;
    const form = P2_FORMS[stage] ?? "something";
    this.hooks.sfxEvent?.("shapeshift");
    this.hooks.announce(`NIGHTMARE takes the form of ${form}…`);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  tick(dt: number): void {
    this.simT += dt;
    if (this.phase === "dead" || this.over) return;

    this.marks = this.marks.filter((m) => m.until > this.simT);
    for (const a of this.actors) {
      // CONDITIONED decaying un-lights the CS button — the bar needs the edge.
      if (a.condWasActive && this.simT >= a.conditionedUntil) this.emitConditioning(a);
      a.mitigations = a.mitigations.filter((m) => m.until > this.simT);
      // Masked Distress bleeding out, batched to two floats a second.
      if (a.staggerPool.length) {
        for (const p of a.staggerPool) {
          const d = Math.min(p.left, p.perS * dt);
          p.left -= d;
          a.staggerAccum += d;
        }
        a.staggerPool = a.staggerPool.filter((p) => p.left > 1e-6);
      }
      if (a.staggerAccum > 0 && (this.simT >= a.staggerFlushAt || a.staggerPool.length === 0)) {
        a.staggerFlushAt = this.simT + 0.5;
        const d = a.staggerAccum;
        a.staggerAccum = 0;
        if (a.alive) this.loseHp(a, d, false);
      }
      this.tickDevelopment(a);
    }
    // Bobo Doll pops: it rebounds its share of everything it soaked.
    if (this.decoyUntil > 0 && this.simT >= this.decoyUntil) {
      this.decoyUntil = -1;
      const owner = this.decoyOwnerId ? this.actorBy(this.decoyOwnerId) : null;
      if (this.decoyAbsorbed > 0 && owner && this.inCombat) {
        const dealt = this.damageBoss(this.decoyAbsorbed * this.decoyRebound, false);
        this.addThreat(owner, dealt);
        this.creditDamageDealt(owner, dealt);
        this.hooks.dotTick?.("Bobo Doll rebound", dealt, owner.id);
      }
      this.decoyAbsorbed = 0;
    }
    this.debuffs = this.debuffs.filter((d) => d.until > this.simT);
    this.ampEvents = this.ampEvents.filter((a) => a.until > this.simT);

    // ---- phase script ------------------------------------------------------
    if (this.phase === "idle") {
      if (this.phaseT >= this.script.idleS) this.enterPhase("p1");
      else this.phaseT += dt;
      return;
    }
    const phase = this.currentPhase();
    if (!phase) return;
    this.phaseT += dt;

    // World-chat warning, once, phaseWarningS before the change.
    const next = this.nextPhaseId(phase.id);
    if (!this.warned && this.phaseT >= phase.durationS - this.script.phaseWarningS) {
      this.warned = true;
      const nextName = next === "dead" ? "" : this.phaseName(next);
      this.hooks.sfxEvent?.("phase.warning");
      this.hooks.announce(
        `${this.script.displayName} stirs — ${nextName} in ${this.script.phaseWarningS} seconds…`
      );
    }
    if (this.phaseT >= phase.durationS) {
      this.enterPhase(next);
      return;
    }

    // ---- boss behaviour inside the phase -----------------------------------
    if (phase.regenPctPerS > 0) {
      this.hp = Math.min(this.hpMax, this.hp + phase.regenPctPerS * this.hpMax * dt);
    }
    // The P2 debuff is the designed Fortress counter: it bypasses armor and
    // (sheet default) ticks ONLY while the boss is armored.
    const armored = phase.dmgTakenMult < 1;
    if (this.debuffs.length > 0 && (armored || !this.script.p2Debuff.ticksOnlyWhileArmored)) {
      const dot =
        this.debuffs.length * (this.script.p2Debuff.dotPctMaxHpPerStackPerS / 100) * this.hpMax * dt;
      this.hp = Math.max(0, this.hp - dot);
      this.statDamageDealt += dot;
      // Per-frame amounts are sub-pixel — batch to one visible tick per second.
      this.dotAccum += dot;
      if (this.simT >= this.nextDotFloatAt) {
        this.hooks.dotTick?.(WOUND_NAME, this.dotAccum);
        this.dotAccum = 0;
        this.nextDotFloatAt = this.simT + 1;
      }
      if (this.hp <= 0) return this.victory();
    }
    // Dream Analysis ticks: one damage float per tick until the payout is out.
    // Each caster's payout runs on its own clock — three ultimates in flight
    // are three independent tick trains.
    for (const a of this.actors) {
      if (!a.ultTicks || this.simT < a.ultTicks.nextAt) continue;
      const dealt = this.damageBoss(a.ultTicks.perTick, false);
      this.addThreat(a, dealt);
      this.creditDamageDealt(a, dealt);
      this.hooks.dotTick?.(a.hero?.ultimate.name ?? "Ultimate", dealt, a.id);
      a.ultTicks.left -= 1;
      a.ultTicks.nextAt += ULT_TICK_PERIOD_S;
      if (a.ultTicks.left <= 0 || !this.inCombat) a.ultTicks = null;
    }
    // Skill DoTs: each train floats its own ticks under its skill's name.
    for (const a of this.actors) {
      if (!a.dots.length) continue;
      for (const d of a.dots) {
        while (d.left > 0 && this.simT >= d.nextAt && this.inCombat) {
          const dealt = this.damageBoss(d.perTick, false);
          this.addThreat(a, dealt);
          this.creditDamageDealt(a, dealt);
          this.hooks.dotTick?.(d.label, dealt, a.id);
          d.left -= 1;
          d.nextAt += d.periodS;
        }
      }
      a.dots = a.dots.filter((d) => d.left > 0);
      if (!this.inCombat) return; // damageBoss already called the victory
    }
    if (phase.outgoing && this.phaseT >= this.nextOutgoingAt) {
      this.nextOutgoingAt += phase.outgoing.periodS;
      this.bossStrike(phase.outgoing.hitDamage, phase.outgoing.targets);
    }

    // ---- operant engine (Skinner) ------------------------------------------
    // One pass per engine OWNER: each Skinner watches the whole team with
    // their own toggles and their own schedule windows.
    for (const owner of this.operantOwners) {
      const rf = owner.hero!.reinforcement!;
      if (!this.inCombat) break;
      // Negative contingency: reinforced for the ABSENCE of damage taken.
      if (owner.contingency === "negative") {
        for (const c of this.actors) {
          if (!c.alive) continue;
          const w = this.watch(c, owner.id);
          if (w.cleanSince < 0) w.cleanSince = this.simT;
          if (this.simT - w.cleanSince >= rf.negativeCleanSeconds) {
            w.cleanSince = this.simT;
            this.operantProc(owner, c, "negative");
          }
        }
      }
      // Fixed Interval: each live window ticks its own fixed clock until it
      // ends — stacked windows tick independently.
      if (owner.fiTickers.length) {
        const s = rf.schedules.fixedInterval;
        for (const t of owner.fiTickers) {
          while (this.simT >= t.nextAt && t.nextAt <= t.until + 1e-6) {
            this.healParty(owner, s.tickTeamTotal, "team", "Fixed Interval");
            this.hooks.sfxEvent?.("hot.tick", owner.id);
            t.nextAt += s.periodMs / 1000;
          }
        }
        owner.fiTickers = owner.fiTickers.filter(
          (t) => this.simT <= t.until && t.nextAt <= t.until + 1e-6
        );
      }
      // Variable Interval: one roll per second PER live window — payout at
      // random moments, stacks roll independently.
      if (owner.viTickers.length) {
        const s = rf.schedules.variableInterval;
        for (const t of owner.viTickers) {
          while (this.simT >= t.nextRollAt && t.nextRollAt <= t.until + 1e-6) {
            if (Math.random() < s.tickChancePerSec) {
              this.healParty(owner, s.tickTeamTotal, "team", "Variable Interval");
              this.hooks.sfxEvent?.("hot.tick", owner.id);
            }
            t.nextRollAt += 1;
          }
        }
        owner.viTickers = owner.viTickers.filter(
          (t) => this.simT <= t.until && t.nextRollAt <= t.until + 1e-6
        );
      }
    }

    // ---- simulated allies ----------------------------------------------------
    for (const ally of this.actors) {
      if (ally.input || !ally.spec) continue;
      if (!ally.alive || this.simT < ally.nextCastAt) continue;
      ally.nextCastAt = this.simT + 1.5; // the GCD caps every hero
      this.allyCast(ally);
    }

    // ---- defeat -------------------------------------------------------------
    // One death is survivable — the fallen lie where they dropped and the
    // rest fight on. The attempt is only lost when EVERY hero is down. With
    // real teammates that is the first time a wipe can be prevented by someone
    // else staying up.
    if (!this.actors.some((c) => c.alive)) this.defeat();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Per-actor upkeep for the development and modeling kinds: heal-over-time
   * ticks, shields expiring into Amp, Object Permanence releasing its heal,
   * and retained copies fading.
   */
  private tickDevelopment(a: FightActor): void {
    if (a.hots.length) {
      for (const h of a.hots) {
        while (h.left > 0 && this.simT >= h.nextAt) {
          if (a.alive) {
            const healed = this.healCombatant(a, h.perTick, h.label, h.src);
            if (h.src) this.noteReinforcementHealing(h.src, healed);
          }
          h.left -= 1;
          h.nextAt += h.periodS;
        }
      }
      a.hots = a.hots.filter((h) => h.left > 0);
    }
    if (a.shields.length && a.shields.some((sh) => sh.until <= this.simT)) {
      // An unspent shield is a heal nobody needed: it pays the team as Amp.
      const spare = a.shields.filter((sh) => sh.until <= this.simT).reduce((sum, sh) => sum + sh.left, 0);
      a.shields = a.shields.filter((sh) => sh.until > this.simT);
      if (spare > 0 && this.inCombat) this.ampEvents.push({ amp: overhealToAmp(spare, this.format), until: this.simT + 5 });
    }
    if (a.undyingHeal && this.simT >= a.undyingUntil) {
      const h = a.undyingHeal;
      a.undyingHeal = null;
      if (a.alive) {
        const healed = this.healCombatant(a, h.amount, h.label, h.src);
        if (h.src) this.noteReinforcementHealing(h.src, healed);
      }
    }
    if (a.hero?.modeling && a.retained.some((r) => r !== null && r.until <= this.simT)) {
      a.retained = a.retained.map((r) => (r && r.until <= this.simT ? null : r));
      this.emitModeling(a);
    }
    // Attention can drift to a new model without anyone casting: re-check
    // once a second and repaint only on a change.
    if (a.hero?.modeling && this.simT >= a.attentionAt) {
      a.attentionAt = this.simT + 1;
      const seen = this.modelOf(a)?.id ?? "boss";
      if (seen !== a.modelSeen) this.emitModeling(a);
    }
  }

  private get inCombat(): boolean {
    return this.phase !== "idle" && this.phase !== "dead" && this.hp > 0 && !this.over;
  }

  /** Casting needs a live fight AND a live caster — the fallen spectate. */
  private canAct(a: FightActor): boolean {
    return this.inCombat && a.alive;
  }

  /**
   * The mitigation term for one combatant — doc 08 §1.1.
   *
   * Self-target grants only protect the actor who cast them; team grants
   * protect everyone, whoever cast them. Additive, then hard-capped at 0.40.
   */
  private mitigationFor(c: FightActor): number {
    const live: number[] = [];
    for (const a of this.actors) {
      for (const m of a.mitigations) {
        if (m.until > this.simT && (m.target === "team" || a === c)) live.push(m.magnitude);
      }
    }
    return resolveMitigation(live);
  }

  private get amp(): number {
    return Math.min(COMBAT.maxAmp, this.ampEvents.reduce((s, e) => s + e.amp, 0));
  }

  private currentPhase() {
    return this.script.phases.find((p) => p.id === this.phase) ?? null;
  }

  /**
   * Exact seconds until the enrage. The enrage fires on completing
   * `enrageCycles` full rotations, and phase durations are fixed, so the
   * countdown is derived: full cycles left plus the remainder of this one.
   * The idle warm-up does not count toward it.
   */
  private enrageRemainingS(): number {
    if (this.enraged) return 0;
    const cycleS = this.script.phases.reduce((a, p) => a + p.durationS, 0);
    const total = this.script.enrageCycles * cycleS;
    if (!this.engaged) return total;
    let elapsed = this.cyclesDone * cycleS;
    const idx = this.script.phases.findIndex((p) => p.id === this.phase);
    if (idx >= 0) {
      for (let i = 0; i < idx; i++) elapsed += this.script.phases[i]!.durationS;
      elapsed += this.phaseT;
    }
    return Math.max(0, total - elapsed);
  }

  private nextPhaseId(id: FightPhaseId): FightPhaseState {
    const order: FightPhaseId[] = ["p1", "p2", "p3", "p4"];
    const i = order.indexOf(id);
    return order[(i + 1) % order.length] ?? "p1";
  }

  private phaseName(id: FightPhaseState): string {
    return this.script.phases.find((p) => p.id === id)?.name ?? id;
  }

  private enterPhase(next: FightPhaseState): void {
    this.phase = next;
    this.phaseT = 0;
    this.warned = false;
    const phase = this.currentPhase();
    this.nextOutgoingAt = phase?.outgoing ? phase.outgoing.periodS : 0;
    if (next === "p2") this.p2Stage = -1; // first doll swap reports stage 0
    if (next !== "p2") this.p2Stage = -1;
    this.hooks.setBossPhase(next);
    if (next === "p1") {
      if (!this.engaged) {
        this.engaged = true;
        this.engageSimT = this.simT;
        this.hooks.announce(
          `${this.script.displayName} has engaged — Phase 1: ${this.phaseName("p1")}!`
        );
      } else {
        // Wrapping from P4 back to P1 completes a full rotation — the enrage
        // counts rotations, not wall-clock time.
        this.cyclesDone += 1;
        if (!this.enraged && this.cyclesDone >= this.script.enrageCycles) {
          this.enraged = true;
          this.hooks.announce(`${this.script.displayName} ENRAGES — its blows become lethal!`);
        } else {
          this.hooks.announce(`Phase 1: ${this.phaseName("p1")} — ${this.script.displayName} presses the attack!`);
        }
      }
    } else if (next === "p2") {
      this.hooks.announce(
        `Phase 2: ${this.phaseName("p2")} — read each form and answer with the matching palette stage!`
      );
    } else if (next === "p3") {
      this.hooks.announce(
        `Phase 3: ${this.phaseName("p3")} — armor blocks 90% of damage; each Shapeshift wound bleeds through AND weakens the armor by 10%!`
      );
    } else if (next === "p4") {
      this.hooks.announce(`Phase 4: ${this.phaseName("p4")} — terror hits the whole raid!`);
    }
  }

  /** Damage the boss through the phase's armor multiplier. */
  private damageBoss(amount: number, bypassesArmor: boolean): number {
    const phase = this.currentPhase();
    let mult = phase && !bypassesArmor ? phase.dmgTakenMult : 1;
    // Shapeshift wounds shred armor: each live stack (a correct P2 palette
    // answer) opens the armored boss up by armorShredPerStack — so beyond the
    // bleed, a wounded Fortress takes real hits again. Only armored phases
    // have armor to shred.
    if (phase && !bypassesArmor && phase.dmgTakenMult < 1 && this.debuffs.length > 0) {
      mult = Math.min(
        1,
        phase.dmgTakenMult + this.script.p2Debuff.armorShredPerStack * this.debuffs.length
      );
    }
    // Generalization's vulnerability: a boss-side damage-taken multiplier,
    // the same term Fortress armor lives in — everyone's hits ride it.
    const vuln = this.simT < this.vulnUntil ? 1 + this.vulnMagnitude : 1;
    const dealt = amount * mult * vuln;
    this.hp = Math.max(0, this.hp - dealt);
    this.statDamageDealt += dealt;
    if (this.hp <= 0) this.victory();
    return dealt;
  }

  /**
   * Full pipeline for a player hit: Base × Beat × Marks × Amp × Gear × Format,
   * then the crit roll.
   *
   * Marks and Amp are read off the TEAM pools; Fixation, the gear term and the
   * account scalars are read off the CASTER. That split is the whole reason a
   * party can share a Mark board without sharing each other's mistakes.
   */
  private playerHit(a: FightActor, base: number, beat: number, isSkill: boolean): { damage: number; crit: boolean } {
    let dmg = resolveHit({
      base,
      beat,
      marks: this.marks.length,
      amp: this.amp,
      gear: a.gear,
      format: this.format,
      isSkill,
    });
    if (this.simT < a.fixationUntil) dmg *= FIXATION_DAMAGE_MULT;
    dmg *= a.potionDamage * a.petDamage; // Latte + pet Attack: flat scalars, like Fixation
    const crit = Math.random() < COMBAT.critChance;
    if (crit) dmg *= COMBAT.critMult;
    return { damage: dmg, crit };
  }

  private addMark(): void {
    if (this.marks.length >= COMBAT.maxMarks) return;
    this.marks.push({ until: this.simT + 20 }); // doc 02: 20 s Mark duration
  }

  private addDebuffStack(): void {
    if (this.debuffs.length >= this.script.p2Debuff.maxStacks) return;
    this.debuffs.push({ until: this.simT + this.script.p2Debuff.durationMs / 1000 });
    this.hooks.announce(
      `A Shapeshift wound opens on ${this.script.displayName} (${this.debuffs.length}/${this.script.p2Debuff.maxStacks}) — it will bleed through Fortress armor and weaken it by 10%.`
    );
  }

  /**
   * Threat, and the attribution that rides with it.
   *
   * Every point of damage that has an author passes through here, which makes
   * this the one honest place to bank "who dealt it". The team's
   * `statDamageDealt` is deliberately wider: it also counts the Shapeshift
   * bleed and Projection's bounce, neither of which belongs to a caster.
   */
  private addThreat(who: FightActor, damageDealt: number): void {
    who.threat += damageDealt * who.threatMult;
    who.statDealt += damageDealt;
    this.noteSalience(who, damageDealt);
  }

  /** The hate system: single-target hits land on the highest-threat hero. */
  private topThreatTarget(): FightActor | null {
    // A live taunt overrides the table entirely — that is what a taunt is.
    if (this.simT < this.tauntUntil && this.tauntActorId) {
      const taunter = this.actorBy(this.tauntActorId);
      if (taunter?.alive) return taunter;
    }
    let best: FightActor | null = null;
    for (const c of this.actors) {
      if (!c.alive) continue;
      if (!best || c.threat > best.threat) best = c;
    }
    return best;
  }

  private bossStrike(hitDamage: number, targets: "threat" | "all"): void {
    // Visual first — the swing/blast animation is the hit's telegraph.
    this.hooks.bossStrike(targets);
    this.modelBossBlow(targets);
    // Extinction's dome cuts the boss's OUTGOING before any player-side
    // mitigation — separate terms, which is why 0.6 can coexist with the cap.
    const dome = this.simT < this.domeUntil ? 1 - this.domeCut : 1;
    const dmg = hitDamage * this.dmgMult * this.sizeMult * dome * (this.enraged ? ENRAGE_OUTGOING_MULT : 1);
    if (targets === "all") {
      for (const c of this.actors) {
        if (c.alive) this.hitCombatant(c, dmg);
      }
      return;
    }
    // Bobo Doll: the single-target blow lands on the doll, and the doll keeps count.
    if (this.simT < this.decoyUntil) {
      this.decoyAbsorbed += dmg;
      this.hooks.defenseProc?.("Bobo Doll", this.decoyOwnerId ?? undefined);
      return;
    }
    const target = this.topThreatTarget();
    if (target) this.hitCombatant(target, dmg);
  }

  /**
   * A Bandura with nobody to watch models the boss: each blow it lands is a
   * strike he retains (the Bobo doll study — aggression watched is aggression
   * learned). Always "motivated": the boss got what it wanted.
   */
  private modelBossBlow(targets: "threat" | "all"): void {
    for (const b of this.actors) {
      const ms = b.hero?.modeling;
      if (!ms || !b.alive || this.modelOf(b) !== null) continue;
      this.retain(b, ms, {
        view: {
          id: targets === "all" ? "boss.terror" : "boss.strike",
          name: targets === "all" ? `${this.script.displayName}'s Terror` : `${this.script.displayName}'s Blow`,
          heroId: "boss",
          motivated: true,
        },
        effects: [],
        heals: false,
        until: this.simT + ms.retentionMs / 1000,
      });
    }
  }

  private hitCombatant(c: FightActor, incoming: number): void {
    // Sheltered (Ainsworth's Disorganized): the hit lands nowhere at all.
    if (this.simT < c.immuneUntil) {
      this.hooks.defenseProc?.("Sheltered", c.id);
      return;
    }
    // The Defense Mechanism riders are the TARGET's own — a scripted ally has
    // no kit and therefore never carries one.
    if (c.absorbNextHit) {
      c.absorbNextHit = false;
      this.hooks.defenseProc?.("Repression", c.id);
      this.hooks.announce(`${c.name}'s Defense Mechanism absorbs the blow!`);
      return;
    }
    if (c.redirectNextHit) {
      c.redirectNextHit = false;
      this.hooks.defenseProc?.("Displacement", c.id);
      this.hooks.announce(`${c.name}'s Displacement redirects the blow — it lands nowhere!`);
      return;
    }
    // The one defensive formula: damage taken = incoming × (1 − Mitigation).
    const dmg = applyMitigation(incoming, this.mitigationFor(c));
    if (c.reflectNextHit) {
      // Projection: part of the (mitigated) hit goes back at the boss; the
      // player still eats the rest of it.
      c.reflectNextHit = false;
      this.hooks.defenseProc?.("Projection", c.id);
      const bounced = this.damageBoss(dmg * c.reflectMagnitude, false);
      this.hooks.announce(
        `Projection throws ${Math.round(bounced)} of the blow back at ${this.script.displayName}!`
      );
    }
    if (c.focusNextHit) {
      // Sublimation: the hit never reaches HP — it becomes Focus instead.
      c.focusNextHit = false;
      this.hooks.defenseProc?.("Sublimation", c.id);
      this.hooks.gainFocus?.(dmg, c.id);
      this.hooks.announce(`Sublimation turns the blow into Focus (+${Math.round(dmg)})!`);
      return;
    }
    // Shields (Hypothetical, Accommodation) soak the mitigated hit first,
    // soonest-expiring first, before any of it reaches the stagger or HP.
    if (c.shields.length) {
      let rest = dmg;
      c.shields.sort((x, y) => x.until - y.until);
      for (const sh of c.shields) {
        if (rest <= 0) break;
        const take = Math.min(sh.left, rest);
        sh.left -= take;
        rest -= take;
      }
      c.shields = c.shields.filter((sh) => sh.left > 1e-6);
      if (rest < dmg) this.hooks.defenseProc?.(`Shield −${Math.round(dmg - rest)}`, c.id);
      if (rest <= 1e-6) return;
      return this.hitAfterShield(c, rest);
    }
    this.hitAfterShield(c, dmg);
  }

  /** The tail of `hitCombatant`, after any shield took its share. */
  private hitAfterShield(c: FightActor, dmg: number): void {
    // Masked Distress (Avoidant): the mitigated hit is deferred, not dropped —
    // it bleeds out over the spread, so the total taken is unchanged.
    if (this.simT < c.staggerUntil && c.staggerSpreadS > 0) {
      c.staggerPool.push({ perS: dmg / c.staggerSpreadS, left: dmg });
      this.hooks.defenseProc?.("Masked Distress", c.id);
      return;
    }
    this.loseHp(c, dmg, true);
  }

  /**
   * HP leaves a combatant: stats, floats, the death edge. `reaction` is a
   * real hit (the flinch plays); the Masked-Distress bleed passes false.
   */
  private loseHp(c: FightActor, dmg: number, reaction: boolean): void {
    const before = c.hp;
    // Object Permanence: still there — the floor is 1 HP while it holds.
    const floor = this.simT < c.undyingUntil ? Math.min(1, before) : 0;
    c.hp = Math.max(floor, c.hp - dmg);
    if (floor > 0 && c.hp === floor && before - dmg < floor) this.hooks.defenseProc?.("Object Permanence", c.id);
    const lost = before - c.hp;
    c.statTaken += lost;
    if (lost > 0) c.lastHitAt = this.simT;
    if (lost > 0) this.hooks.combatantDamaged?.(c.name, lost, c.isPlayer, c.id);
    // A real hit resets the Negative-contingency clean streak — dodging is
    // only reinforced while it is actually happening. Every watching engine's
    // streak breaks, not just the first one's.
    if (lost > 0) for (const owner of this.operantOwners) this.watch(c, owner.id).cleanSince = this.simT;
    if (c.input) {
      this.statDamageTaken += lost;
      this.hooks.damagePlayer(dmg, c.id);
      // The killing blow plays the death pose, not a flinch.
      if (c.hp > 0 && reaction) this.hooks.playerHitReaction(c.id);
    }
    if (c.hp <= 0 && c.alive) {
      c.alive = false;
      this.hooks.announce(`${c.name} has fallen!`);
      this.hooks.combatantDied?.(c.name, c.isPlayer, c.id);
    }
  }

  /**
   * "team" heals split the quoted TOTAL across the living — doc 08 §4.3.
   *
   * Only ever called from PLAYER casts (and the interval tickers those casts
   * arm) — sim allies heal through `healCombatant` directly — so the
   * effective total banks toward the CASTER's Response Strength here, once.
   */
  private healParty(src: FightActor, total: number, target: "self" | "team", label: string): void {
    if (target === "self") {
      this.noteReinforcementHealing(src, this.healCombatant(src, total, label, src));
      return;
    }
    const living = this.actors.filter((c) => c.alive);
    const each = total / Math.max(1, living.length);
    let healed = 0;
    for (const c of living) healed += this.healCombatant(c, each, label, src);
    this.noteReinforcementHealing(src, healed);
  }

  /**
   * Returns the EFFECTIVE healing landed (overheal converts to Amp, not HP).
   *
   * `src` is who PAID for the heal: their Americano and pet-Healing terms
   * scale the amount, because the cup belongs to the caster and not to the
   * patient. A scripted ally's heal passes `null` — bots carry no account
   * state — which is the one call site that rides neither term.
   */
  private healCombatant(c: FightActor, amount: number, label: string, src: FightActor | null): number {
    if (!c.alive) return 0;
    if (src) amount *= src.potionHeal * src.petHeal;
    // Resistant (Ambivalent): comfort offered, comfort resisted.
    if (this.simT < c.healCutUntil) amount *= 1 - c.healCut;
    const missing = c.hpMax - c.hp;
    const healed = Math.min(missing, amount);
    c.hp += healed;
    // Credited to whoever PAID for it, not to the patient — a healer's share of
    // the attempt is the healing they put out, wherever it landed. Overheal is
    // excluded on purpose: it already pays the team as Amp, below.
    if (src) {
      src.statHealed += healed;
      this.noteSalience(src, healed);
    }
    if (amount > 0) this.hooks.combatantHealed?.(c.name, healed, amount, c.isPlayer, label, c.id);
    if (c.input) {
      this.statHealing += healed;
      this.hooks.healPlayer(healed, c.id);
    }
    const overheal = amount - healed;
    if (overheal > 0) {
      // Doc 02: overheal converts to team Amp for 5 s.
      this.ampEvents.push({
        amp: overhealToAmp(overheal, this.format),
        until: this.simT + 5,
      });
      // The live total rides a HUD tile; each event refreshes it and its
      // duration tracks the last expiring event (the id ignores the "+N%").
      // One decimal — a small overheal still reads as "+0.1%", never "+0%".
      const latestUntil = this.ampEvents.reduce((m, e) => Math.max(m, e.until), 0);
      this.hooks.playerBuff(
        `Team Amp +${Math.round(this.amp * 1000) / 10}%`,
        (latestUntil - this.simT) * 1000,
        "buff",
        "team_amp",
        undefined,
        `Overheal converted to attack power: the whole team deals +${Math.round(this.amp * 1000) / 10}% damage. Each new overheal refreshes the 5 s window.`
      );
    }
    return healed;
  }

  /** Simulated ally GCD rotation, straight off the stats sheet. */
  private allyCast(ally: FightActor): void {
    const spec = ally.spec;
    if (!spec) return;
    if (spec.role === "healer" && spec.healBase) {
      // Heal the most-hurt living combatant; DPS only when everyone is up.
      const hurt = this.actors
        .filter((c) => c.alive && c.hp < c.hpMax * 0.95)
        .sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax)[0];
      if (hurt) {
        this.healCombatant(hurt, spec.healBase, ally.name, null);
        this.hooks.allyCast?.(ally.name, "heal", ally.id);
        return;
      }
    }
    this.hooks.allyCast?.(ally.name, "damage", ally.id);
    const base = spec.skillBase > 0 ? spec.skillBase : spec.baseDamage;
    const dmg = resolveHit({
      base,
      beat: 1.0, // sims cast on no particular stance — the player's beats are their own skill
      marks: this.marks.length,
      amp: this.amp,
      gear: ally.gear,
      format: this.format,
      isSkill: spec.skillBase > 0,
    });
    const dealt = this.damageBoss(dmg, false);
    this.addThreat(ally, dealt);
    this.creditDamageDealt(ally, dealt);
  }

  private victory(): void {
    if (this.phase === "dead") return;
    this.hp = 0;
    this.phase = "dead";
    this.hooks.setBossPhase("dead");
    this.hooks.announce(
      `${this.script.displayName} is defeated! The mind is quiet… for now.`
    );
    this.emitFightEnd(true);
  }

  /**
   * Dev/E2E helper (window.psyrenaFight): end the attempt as a win, through
   * the real victory path — announce, fightEnd report, loot box spawn.
   */
  debugKillBoss(): void {
    if (this.phase === "idle" || this.phase === "dead") return;
    this.victory();
  }

  /**
   * Dev/E2E helper (window.psyrenaFight): drop every hero through the real
   * death path — announce + died hooks now, defeat on the next tick's
   * all-dead check, exactly like a lethal raid hit.
   */
  debugKillParty(): void {
    if (!this.inCombat) return;
    for (const c of this.actors) this.debugKill(c);
  }

  /** Dev/E2E helper: kill only the player — death pose, allies fight on. */
  debugKillPlayer(): void {
    if (!this.inCombat) return;
    this.debugKill(this.primary);
  }

  private debugKill(c: FightActor): void {
    if (!c.alive) return;
    c.hp = 0;
    if (c.input) this.hooks.damagePlayer(c.hpMax, c.id);
    c.alive = false;
    this.hooks.announce(`${c.name} has fallen!`);
    this.hooks.combatantDied?.(c.name, c.isPlayer, c.id);
  }

  /** Report the attempt's accumulated stats — an attempt ends the scene now. */
  private emitFightEnd(win: boolean): void {
    if (!this.hooks.fightEnd) return;
    const durationS = Math.max(0.001, this.simT - Math.max(0, this.engageSimT));
    this.hooks.fightEnd({
      win,
      durationMs: durationS * 1000,
      dps: this.statDamageDealt / durationS,
      healing: this.statHealing,
      damageTaken: this.statDamageTaken,
    });
  }

  /**
   * Every hero is down — the attempt is lost. The sim FREEZES rather than
   * resetting: dead heroes stay where they fell, and the arena layer (via
   * `fightEnd`) returns the party to the village and shows the result. The
   * old in-arena wipe→reset loop is gone with the town round-trip.
   */
  private defeat(): void {
    if (this.over) return;
    this.over = true;
    this.emitFightEnd(false);
    this.hooks.announce(
      `The party has fallen — ${this.script.displayName} claims the mindscape.`
    );
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  snapshot(): FightSnapshot {
    const phase = this.currentPhase();
    const threat: ThreatRow[] = this.actors
      .map((c) => ({
        name: c.name,
        role: c.role,
        value: c.threat,
        isPlayer: c.isPlayer,
        alive: c.alive,
      }))
      .sort((a, b) => b.value - a.value);
    return {
      bossName: this.script.displayName,
      hp: this.hp,
      hpMax: this.hpMax,
      phase: this.phase,
      phaseName: this.phase === "idle" ? "Dormant" : this.phase === "dead" ? "Defeated" : (phase?.name ?? ""),
      // Idle rolls into P1; P4 cycles back to P1 (the fight loops until the
      // enrage or a kill). Dead goes nowhere.
      nextPhaseName:
        this.phase === "dead"
          ? ""
          : this.phase === "idle"
            ? this.phaseName("p1")
            : this.phaseName(this.nextPhaseId(this.phase)),
      phaseRemainingS: phase ? Math.max(0, phase.durationS - this.phaseT) : Math.max(0, this.script.idleS - this.phaseT),
      enrageRemainingS: this.enrageRemainingS(),
      enraged: this.enraged,
      debuffStacks: this.debuffs.length,
      marks: this.marks.length,
      amp: this.amp,
      mitigation: this.mitigationFor(this.primary),
      p2Stage: this.phase === "p2" ? this.p2Stage : -1,
      threat,
      // Still "everyone except the primary actor", so single-player HUD code
      // is untouched; a party client reads `actorView` for its own numbers.
      allies: this.actors.slice(1).map((a) => ({
        name: a.name,
        role: a.role,
        hpPct: a.hp / a.hpMax,
        alive: a.alive,
      })),
    };
  }
}
