/**
 * Written copy for the playable heroes: the characters, the people, and the
 * skills — Freud's set first, Pavlov's below it, Skinner's below that,
 * `CHARACTERS`/`skillLoreFor` to resolve any of them by hero id.
 *
 * One module, two readers. The hover bubble on the action bar and the codex
 * panel behind the avatar both pull from here, so a skill can never describe
 * itself one way on the button and another way in the book.
 *
 * Numbers are read off `shared/heroes/*` at render time rather than typed
 * into the prose, because the kits are derived from the boss math sheet and
 * get retuned. Copy that restates a number is copy that goes stale.
 *
 * House style (matches the WoW tooltip register): effect first, second
 * person, short sentences, and no dash characters anywhere in player-facing
 * text — separate clauses with periods or the "·" dot instead.
 */

import { FREUD } from "@shared/heroes/freud";
import { PAVLOV, PAVLOV_CONDITIONING } from "@shared/heroes/pavlov";
import { SKINNER, SKINNER_REINFORCEMENT } from "@shared/heroes/skinner";
import { COMBAT, BEAT_PERIOD_S } from "@shared/combat";

// Palette cost and cooldown are hardcoded on the bar scaffold, not on the kit:
// 8 Focus (FOCUS_COST in src/fight/arenaCombat.ts) and a 3 s per-stage cooldown
// (slot cooldownMs there). Fixation's numbers are likewise fight constants
// (FIXATION_* in src/fight/bossFight.ts). If those move, move these literals.
const PALETTE_FOCUS_COST = 8;
const PALETTE_COOLDOWN_S = 3;
const FIXATION_LOCK_S = 10;
const FIXATION_PENALTY_S = 6;
const FIXATION_DAMAGE_CUT = 0.3;

export interface SkillLore {
  /** Action bar slot id, or the shared prefix for the palette wheel. */
  id: string;
  name: string;
  /** Key badge as the bar shows it. */
  key: string;
  /** One sentence, the headline of the bubble. */
  summary: string;
  /** The live numbers line. Built from the kit, never typed by hand. */
  numbers: () => string;
  /** What a player should actually do with it. */
  howToUse: string;
  /** The psychology underneath, in a sentence or two. */
  theory: string;
}

const pct = (v: number): string => `${Math.round(v * 100)} percent`;
/**
 * "3" -> "third". Small because the codex writes prose, not a stat block: a
 * tuned constant should read as a sentence ("every third bell"), and spelling
 * it out here keeps the number derived from the kit rather than typed twice.
 */
const ordinal = (n: number): string =>
  ["zeroth", "first", "second", "third", "fourth", "fifth"][n] ?? `${n}th`;

export const SKILL_LORE: SkillLore[] = [
  {
    id: "freud.basic",
    name: "Id, Ego, Superego",
    key: "LMB",
    summary:
      "Your basic attack. It rides a beat that cycles through Id, Ego and Superego on its own, and the Superego beat hits hardest.",
    numbers: () =>
      `Deals ${FREUD.basic.base} damage, multiplied by the current beat: ${(FREUD.beats ?? []).map((b) => `${b.name} x${b.multiplier}`).join(" · ")}. The beat advances by itself every ${BEAT_PERIOD_S} sec. Costs ${FREUD.basic.focusCost} Focus. ${FREUD.basic.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Keep swinging and let the beat do the work. Save your expensive casts for the Superego beat. The readout on the button always shows which beat is live.",
    theory:
      "Freud split the psyche into three agencies. The id wants, the ego negotiates, the superego judges. Judgment hits hardest.",
  },
  {
    id: "freud.stage",
    name: "Psychosexual Stages",
    key: "1 to 5",
    summary:
      "Five stage casts. Each deals damage and places an Analysis Mark. Only while the boss shapeshifts do the stages become an answer: match the form, or a wrong match afflicts you with Fixation.",
    numbers: () =>
      `Deals ${FREUD.palette[0]?.base ?? 0} damage and places an Analysis Mark. The boss takes ${pct(COMBAT.markBonus)} increased damage from everyone for each Mark, up to ${COMBAT.maxMarks} Marks. During the boss's Shapeshift transformation only: the stage matching the boss's current form also wounds it, and a wrong match is punished — Fixation locks that stage for ${FIXATION_LOCK_S} sec and lowers your damage by ${pct(FIXATION_DAMAGE_CUT)} for ${FIXATION_PENALTY_S} sec. Outside the transformation there is no right or wrong stage. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "Outside the transformation, weave stages freely to build Marks. When the boss starts shapeshifting, watch the diagnosis panel and cast the stage that matches. A wrong guess only ever punishes you, never your team, so guessing while you learn is safe.",
    theory:
      "Oral, Anal, Phallic, Latency, Genital. Freud held that a conflict left unresolved at any stage leaves a person fixated there, still trying to settle it years later.",
  },
  {
    id: "freud.defense",
    name: "Defense Mechanism",
    key: "E",
    summary:
      "Heal yourself and take reduced damage for a short window. Every cast also grants one of six defense mechanisms at random.",
    numbers: () =>
      `Restores ${FREUD.defense.heal} health and reduces damage taken by ${pct(FREUD.defense.mitigation?.magnitude ?? 0)} for ${(FREUD.defense.mitigation?.durationMs ?? 0) / 1000} sec. Costs ${FREUD.defense.focusCost} Focus. ${FREUD.defense.cooldownMs / 1000} sec cooldown. ` +
      `One bonus effect rides along at random. Repression absorbs the next hit entirely. Denial makes you immune to Fixation for the window. Projection reflects 40 percent of the next hit back at the boss. Displacement makes the next hit miss you completely. Sublimation turns the next hit's damage into Focus instead of health loss. Regression doubles the heal.`,
    howToUse:
      "Press it whenever the boss is swinging at you. The heal and the damage reduction are guaranteed, so it is never a wasted press. Treat the random bonus as a free gift on top.",
    theory:
      "Repression, denial, projection, displacement, sublimation, regression. The ego defends itself without asking permission, which is exactly why you never get to pick which one surfaces.",
  },
  {
    id: "freud.free-association",
    name: "Free Association",
    key: "R",
    summary:
      "Deal damage to every enemy on the map. For a short time your next 3 stage casts cannot be wrong.",
    numbers: () =>
      // The 8 sec charge window is the literal in castChain (bossFight.ts).
      `Deals ${FREUD.chain.base} damage to all enemies. For 8 sec your next 3 stage casts are corrected automatically when wrong, though the Marks they place count at half value. Costs ${FREUD.chain.focusCost} Focus. ${FREUD.chain.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Cast it when the boss shifts forms faster than you can read them, then spend the three safe casts while you catch up. It is also your best button when extra enemies join the fight.",
    theory:
      "Freud asked patients to speak without editing themselves, trusting that the unguarded remark is the honest one. On the couch there are no wrong answers.",
  },
  {
    id: "freud.dream-analysis",
    name: "Dream Analysis",
    key: "F",
    summary:
      "Your ultimate. Consume the Analysis Marks on the boss for massive damage. The payout lands in five ticks as the eye unfolds.",
    numbers: () =>
      // foreignMarkBonus exists in the pipeline (shared/combat resolveUltimate)
      // but no current ally places Marks, so quoting it here would coach the
      // player to wait for Marks that cannot come. Reinstate the line when a
      // second Mark-placing hero ships.
      `Deals ${FREUD.ultimate.base} damage, plus ${FREUD.ultimate.perMark} for every Analysis Mark consumed, up to ${FREUD.ultimate.maxMarksConsumed} Marks. Costs ${FREUD.ultimate.focusCost} Focus. ${FREUD.ultimate.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Wait for a deep Mark board before you press it. Casting on an empty board wastes most of its value. Your stage casts are what fill the board, so diagnose first, cash out second.",
    theory:
      "Freud called the dream the royal road to the unconscious. What surfaces depends on what was buried, which is why the payoff scales with what the whole team set up rather than with what you did alone.",
  },
];

/**
 * Per-stage copy for the five palette keys. The codex keeps the shared
 * "Psychosexual Stages" entry (the wheel is one skill); the tooltip on each
 * numbered button describes ITS stage — which boss form it answers, and what
 * the stage meant in the theory. Form words follow the P2 announcements in
 * fight/bossFight.ts ("NIGHTMARE takes the form of an infant…").
 */
export const STAGE_DETAIL: Record<string, { form: string; span: string; theory: string }> = {
  "freud.stage.oral": {
    form: "an infant",
    span: "birth to about 18 months",
    theory:
      "Pleasure centers on the mouth: feeding, sucking, biting. Freud tied fixation here to dependency and to habits that keep the mouth busy.",
  },
  "freud.stage.anal": {
    form: "a toddler",
    span: "about 18 months to 3 years",
    theory:
      "The battle over control, fought at toilet training. Fixation here was said to produce the obsessively tidy or the defiantly messy.",
  },
  "freud.stage.phallic": {
    form: "a child",
    span: "about 3 to 6 years",
    theory:
      "The stage of the Oedipus complex. The conflict resolves through identification with the same sex parent, and the superego is born of it.",
  },
  "freud.stage.latency": {
    form: "a schoolchild",
    span: "about 6 years to puberty",
    theory:
      "The drives go quiet. Energy flows into school, friendships and skills — the calm between the early storms and adolescence.",
  },
  "freud.stage.genital": {
    form: "an adolescent",
    span: "puberty onward",
    theory:
      "Mature sexuality and adult relationships. For Freud the healthy endpoint: the person who can love and work.",
  },
};

const STAGE_LORE: SkillLore[] = FREUD.palette.map((p, i) => {
  const d = STAGE_DETAIL[p.id];
  const shared = (): SkillLore => SKILL_LORE.find((s) => s.id === "freud.stage")!;
  return {
    id: p.id,
    name: p.name,
    key: String(i + 1),
    summary: d
      ? `Stage ${i + 1} of 5. The correct answer when the boss takes the form of ${d.form} (${d.span}). Right: damage plus an Analysis Mark. Wrong: Fixation.`
      : shared().summary,
    numbers: () => shared().numbers(),
    howToUse: d
      ? `Cast it the moment the boss shifts into ${d.form}. Any other form makes this the wrong answer, and a wrong answer costs only you, never your team.`
      : shared().howToUse,
    theory: d?.theory ?? shared().theory,
  };
});

/**
 * Pavlov's six buttons and the stance. Same register as Freud's set; numbers
 * ride shared/heroes/pavlov.ts and PAVLOV_CONDITIONING at render time.
 */
export const PAVLOV_SKILL_LORE: SkillLore[] = [
  {
    id: "pavlov.ns",
    name: "NS · Neutral Stimulus",
    key: "LMB",
    summary:
      "Your basic attack, and the bell. One button, one number, no beat to time. On its own it means almost nothing — rung into the window a UCS opens, it banks the Pairings that teach the boss to respond. Once the boss is CONDITIONED, this very button becomes the CS.",
    numbers: () =>
      `Deals a flat ${PAVLOV.basic.base} damage. Pavlov has no beat cycle at all — every cast he makes pays its base, every time, which is what a neutral stimulus means. Rung inside a live UCR window: ${pct(PAVLOV_CONDITIONING.pairing.simultaneous.chance)} chance to bank ${PAVLOV_CONDITIONING.pairing.simultaneous.pairings} Pairing. Rung just before the UCS lands: ${PAVLOV_CONDITIONING.pairing.delay.pairings} Pairings, guaranteed. Rung after the window faded: ${pct(PAVLOV_CONDITIONING.pairing.backward.chance)} chance, and only within ${PAVLOV_CONDITIONING.backwardGraceS} sec. Each pairing that takes returns ${PAVLOV.palette[0]?.effects.find((e) => e.kind === "pairing.focus")?.magnitude ?? 0} Focus — a bell outside every window returns none. No Focus cost. ${PAVLOV.basic.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Keep ringing between casts — there is no good or bad moment on the clock. The only timing that matters is ORDER: ring the bell, then present the food while the ring still hangs. That is the delay pairing, and it is the only one that never fails to take.",
    theory:
      "The neutral stimulus. A bell means nothing to a dog until it has been paired with food. The tiny damage number is the definition, drawn in numbers: nothing has been learned yet.",
  },
  {
    id: "pavlov.ucs",
    name: "UCS · Unconditioned Stimulus",
    key: "1",
    summary:
      "The food. Deals real damage, opens the UCR window your bell pairs into, shields the whole team a little, and pays Focus back for every pairing you land.",
    numbers: () =>
      `Deals ${PAVLOV.palette[0]?.base ?? 0} damage. The boss shows its UCR for ${PAVLOV_CONDITIONING.ucrWindowS} sec. Grants the team ${pct(PAVLOV.palette[0]?.effects.find((e) => e.kind === "mitigation.grant")?.magnitude ?? 0)} reduced damage taken for 4 sec. Every Pairing that lands returns ${PAVLOV.palette[0]?.effects.find((e) => e.kind === "pairing.focus")?.magnitude ?? 0} Focus; a bell that misses the window pairs nothing and returns nothing. It takes ${PAVLOV_CONDITIONING.pairingsToCondition.min}-${PAVLOV_CONDITIONING.pairingsToCondition.max} Pairings to condition the boss, and how many is rolled fresh each time — so a single clean Pairing has a 1-in-${PAVLOV_CONDITIONING.pairingsToCondition.max} chance of doing it outright. Once CONDITIONED, the boss holds it for ${PAVLOV_CONDITIONING.conditionedWindowS} sec and your bell becomes CS. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "Lead with the bell, then press this while the bell still rings. Acquisition is noisy in the lab and it is noisy here: one Pairing sometimes lights CS outright, sometimes it takes three, and you are never told which run you are on. Each one that lands hands back Focus — timed well, the loop nearly pays for itself. There is no wrong time to feed, only wasted windows.",
    theory:
      "The unconditioned stimulus. Food needs no teaching. The dog salivates because that is what food does, and the response you are about to steal already exists.",
  },
  {
    id: "pavlov.cs",
    name: "CS · Conditioned Stimulus",
    key: "LMB",
    summary:
      "The payoff. Castable only while the boss is CONDITIONED. It hits three times harder than the UCS, places three Conditioning Marks, and teaches the Conditioned Response.",
    numbers: () =>
      `Deals ${PAVLOV.palette[1]?.base ?? 0} damage. Places ${PAVLOV.palette[1]?.effects.find((e) => e.kind === "mark.grant")?.magnitude ?? 0} Conditioning Marks: the boss takes ${pct(COMBAT.markBonus)} increased damage from everyone per Mark, up to ${COMBAT.maxMarks} Marks. From the first CS onward, every ${ordinal(PAVLOV_CONDITIONING.crStaggerEveryNthBell)} bell you ring staggers the boss's next attack by ${PAVLOV_CONDITIONING.crStaggerS} sec. Consumes CONDITIONED. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "It replaces the bell on the same button while CONDITIONED is up — the NS face becomes CS — and the state decays after 20 sec. Cash it before the decay, then start ringing and banking again.",
    theory:
      "The conditioned stimulus. The bell alone now does what only food could do. This is the learning itself, which is why the Marks come from CS and never from UCS.",
  },
  {
    id: "pavlov.spontaneous-recovery",
    name: "Spontaneous Recovery",
    key: "E",
    summary:
      "Your defensive button. Heals the whole team and blunts incoming damage. After an Extinction, it also restores one free Pairing.",
    numbers: () =>
      `Restores ${PAVLOV.defense.heal} health, split across the living team. Reduces the team's damage taken by ${pct(PAVLOV.defense.mitigation?.magnitude ?? 0)} for ${(PAVLOV.defense.mitigation?.durationMs ?? 0) / 1000} sec. After your ultimate wiped the conditioning: refunds ${PAVLOV_CONDITIONING.spontaneousRecoveryPairings} Pairing, once per Extinction. Costs ${PAVLOV.defense.focusCost} Focus. ${PAVLOV.defense.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Press it into raid damage rather than hoarding it. The heal is small on purpose: a tank's budget buys mitigation first. After Extinction it is your fast way back into the loop.",
    theory:
      "Pavlov noticed an extinguished response returns on its own after a rest period. The dog has not forgotten. It was only persuaded to wait.",
  },
  {
    id: "pavlov.generalization",
    name: "Generalization",
    key: "R",
    summary:
      "A flying clock joins the fight. The boss turns on you, and takes increased damage from everyone while the clock ticks.",
    numbers: () =>
      `Deals ${PAVLOV.chain.base} damage. Taunts the boss for ${(PAVLOV.chain.effects.find((e) => e.kind === "taunt")?.durationMs ?? 0) / 1000} sec. The boss takes ${pct(PAVLOV.chain.effects.find((e) => e.kind === "vulnerability")?.magnitude ?? 0)} increased damage for ${(PAVLOV.chain.effects.find((e) => e.kind === "vulnerability")?.durationMs ?? 0) / 1000} sec. Costs ${PAVLOV.chain.focusCost} Focus. ${PAVLOV.chain.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "This is your taunt. Save it for the moment an ally overdraws threat, or weave it on cooldown for the team damage. The vulnerability is most of what you give the team, so keep its uptime high.",
    theory:
      "A response conditioned to one bell fires for similar sounds too. A ticking metronome was one of Pavlov's actual instruments. Similar enough, and the boss responds.",
  },
  {
    id: "pavlov.extinction",
    name: "Extinction",
    key: "F",
    summary:
      "Your ultimate. Ring the bell with no food until the response dies. A dome where the boss's blows barely land, paid for with your own conditioning.",
    numbers: () =>
      `Deals ${PAVLOV.ultimate.base} damage, plus ${PAVLOV.ultimate.perMark} for every Mark consumed, up to ${PAVLOV.ultimate.maxMarksConsumed} Marks. Heals the team for ${PAVLOV.ultimate.heal}, split. For ${(PAVLOV.ultimate.effects.find((e) => e.kind === "zone.extinction")?.durationMs ?? 0) / 1000} sec the boss deals ${pct(PAVLOV.ultimate.effects.find((e) => e.kind === "zone.extinction")?.magnitude ?? 0)} less damage to everyone in the dome. Wipes your Pairings, CONDITIONED and the Conditioned Response. Costs ${PAVLOV.ultimate.focusCost} Focus. ${PAVLOV.ultimate.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Press it into the boss's biggest damage window, ideally with Marks banked. Everything you taught is unlearned, so follow with Spontaneous Recovery to restart the loop at a discount.",
    theory:
      "Present the conditioned stimulus without the unconditioned one, again and again, and the response fades. Extinction is not damage to the dog. It is the learning running backward.",
  },
  {
    id: "pavlov.discrimination",
    name: "Discrimination",
    key: "4",
    summary:
      "Your stance. While held, everything you do commands the boss's attention. Drop it to hand that attention away on purpose.",
    numbers: () =>
      `While active you bank ${PAVLOV.threatStance?.multiplier ?? 1}x threat per point of damage dealt. Dropped, you bank 1x like everyone else, and the threat you already built does not fade. Toggled on 4, or by tapping the button. No cost, no cooldown, and it never eats your global cooldown.`,
    howToUse:
      "Hold it whenever you want the boss on you, which as the tank is most of the time. Drop it early when handing the boss to another tank: banked threat lingers, so shedding aggro takes lead time.",
    theory:
      "The other half of the learning: the dog responds to THIS bell and not that one. Attention is trainable, in both directions.",
  },
];

/**
 * Skinner's eight buttons. Same register again; numbers ride
 * shared/heroes/skinner.ts and SKINNER_REINFORCEMENT at render time. The
 * schedules share the palette scaffold's cost and cooldown, like every
 * palette does.
 */
export const SKINNER_SKILL_LORE: SkillLore[] = [
  {
    id: "skinner.response-rate",
    name: "Response Rate",
    key: "LMB",
    summary:
      "Your basic attack, and your report card. Its damage is your healing history. Reinforce your team and it grows. Stop, and it extinguishes.",
    numbers: () =>
      `Deals ${SKINNER.basic.base} damage, increased by ${pct(SKINNER_REINFORCEMENT.responseStrength.damagePerStack)} for every Response Strength stack. You bank 1 stack per ${SKINNER_REINFORCEMENT.responseStrength.healPerStack} effective healing you deliver, up to ${SKINNER_REINFORCEMENT.responseStrength.maxStacks} stacks (+${pct(SKINNER_REINFORCEMENT.responseStrength.damagePerStack * SKINNER_REINFORCEMENT.responseStrength.maxStacks)}) over a rolling ${SKINNER_REINFORCEMENT.responseStrength.durationMs / 1000} sec window. Skinner has no beat cycle. Every hit pays flat. No Focus cost. ${SKINNER.basic.cooldownMs / 1000} sec cooldown, and it never eats your global cooldown.`,
    howToUse:
      "Weave it constantly. It is free, it is off the global cooldown, and it never delays a heal. Do not fish for damage directly. Heal well and the stacks feed themselves.",
    theory:
      "Skinner refused to guess at inner states and measured response rate instead: how often a behavior occurs, as a function of its reinforcement history. A rate no longer reinforced falls. That is extinction, and it happens to this button whenever you stop healing.",
  },
  {
    id: "skinner.fixed-ratio",
    name: "Fixed Ratio",
    key: "1",
    summary:
      "The dependable pellet. One press, one fixed heal for the whole team. The same amount every time, no variance at all.",
    numbers: () =>
      `Restores ${SKINNER_REINFORCEMENT.schedules.fixedRatio.teamTotal} health, split evenly across the living team. Always exactly that amount. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "Your default schedule for steady, readable damage. All four schedules pay the same on average, so press this one whenever you have no reason to gamble and nothing to plan around.",
    theory:
      "A fixed ratio schedule reinforces after a set count of responses, without fail, and produces high, steady rates of work. It is also why this kit has no beat cycle: a fixed schedule that varied with a beat would not be fixed.",
  },
  {
    id: "skinner.variable-ratio",
    name: "Variable Ratio",
    key: "2",
    summary:
      "The slot machine. A small heal on whoever is lowest, with a chance of a jackpot. On average it pays exactly what Fixed Ratio pays.",
    numbers: () =>
      `Restores ${SKINNER_REINFORCEMENT.schedules.variableRatio.low} health to the lowest health living teammate, Skinner included. ${pct(SKINNER_REINFORCEMENT.schedules.variableRatio.highChance)} chance to restore ${SKINNER_REINFORCEMENT.schedules.variableRatio.high} instead. The average payout equals a Fixed Ratio cast exactly. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "Press it to gamble on a save, when someone is deep in the red and the steady pellet will not arrive in time. The jackpot is variance, not value. Notice how much you want to press it anyway. That is the schedule working on you.",
    theory:
      "Variable ratio schedules produce the fastest, most extinction resistant responding Skinner ever measured. It is the mathematics of the slot machine, which is why casinos run on it.",
  },
  {
    id: "skinner.fixed-interval",
    name: "Fixed Interval",
    key: "3",
    summary:
      "Payout on a clock. A heal that ticks for the whole team on a fixed period, for a fixed duration, no matter what anyone does.",
    numbers: () =>
      `Restores ${SKINNER_REINFORCEMENT.schedules.fixedInterval.tickTeamTotal} health to the whole team every ${SKINNER_REINFORCEMENT.schedules.fixedInterval.periodMs / 1000} sec for ${SKINNER_REINFORCEMENT.schedules.fixedInterval.durationMs / 1000} sec. Each cast opens its own window — up to ${SKINNER_REINFORCEMENT.schedules.maxStacks} can tick at once. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "Cast it just before damage you can see coming. Scripted boss hits, a phase you know by heart. The ticks land through the hit instead of scrambling after it. Stack a second or third window ahead of a burst you know is heavy.",
    theory:
      "A fixed interval schedule reinforces the first response after a set time. Subjects learn the clock and their effort scallops, idle after payout, busy just before the next. Timing this cast to the boss's script is the same scallop, performed by you.",
  },
  {
    id: "skinner.variable-interval",
    name: "Variable Interval",
    key: "4",
    summary:
      "Payout at random moments. A long running team heal that ticks when it feels like it, and evens out over time.",
    numbers: () =>
      `For ${SKINNER_REINFORCEMENT.schedules.variableInterval.durationMs / 1000} sec, each second has a ${pct(SKINNER_REINFORCEMENT.schedules.variableInterval.tickChancePerSec)} chance to restore ${SKINNER_REINFORCEMENT.schedules.variableInterval.tickTeamTotal} health to the whole team. Each cast opens its own window, up to ${SKINNER_REINFORCEMENT.schedules.maxStacks} rolling at once. Costs ${PALETTE_FOCUS_COST} Focus. ${PALETTE_COOLDOWN_S} sec cooldown.`,
    howToUse:
      "Lay it down before movement chaos, when dodging will keep your hands off the schedule keys. It heals while you run. Stack windows early rather than letting them lapse.",
    theory:
      "Variable interval schedules produce slow, famously steady responding. When the moment of payout cannot be predicted, checking in constantly is the only strategy that works.",
  },
  {
    id: "skinner.contingency",
    name: "Contingency",
    key: "E",
    summary:
      "A free toggle. It picks which behavior the chamber rewards: Positive reinforces the damage your allies deal, Negative reinforces the damage they avoid.",
    numbers: () =>
      `Positive: each ally procs once per ${SKINNER_REINFORCEMENT.positiveDamagePerProc} damage dealt. Negative: each ally procs once per ${SKINNER_REINFORCEMENT.negativeCleanSeconds} sec spent taking no damage. Every proc pays the current Consequence and banks 1 Approximation on that ally, up to ${SKINNER_REINFORCEMENT.approximation.capPerAlly} per ally. An Approximation left unreinforced for ${SKINNER_REINFORCEMENT.approximation.durationMs / 1000} sec decays. No cost. ${SKINNER.defense.cooldownMs / 1000} sec cooldown, off the global cooldown.`,
    howToUse:
      "Match the toggle to the comp. Positive feeds damage heavy teams that never stop swinging. Negative pays out when the fight is about dodging, or when the team's damage is too thin to proc Positive. Flip it per phase, not once per fight.",
    theory:
      "The contingency is the IF of operant conditioning: which behavior a consequence hangs on. Positive reinforcement adds a reward for acting. Negative reinforcement rewards through what fails to happen, the aversive that never arrives.",
  },
  {
    id: "skinner.consequence",
    name: "Consequence",
    key: "R",
    summary:
      "The second free toggle. It picks what a proc pays: Reinforcement feeds the ally a heal, Punishment blunts the hits that follow instead.",
    numbers: () =>
      `Reinforcement: a proc restores ${SKINNER_REINFORCEMENT.procHeal.positive} health under Positive, ${SKINNER_REINFORCEMENT.procHeal.negative} under Negative. Punishment: a proc grants ${pct(SKINNER_REINFORCEMENT.procMitigation.magnitude)} reduced damage taken for ${SKINNER_REINFORCEMENT.procMitigation.durationMs / 1000} sec. Either way the proc still banks its Approximation. No cost. ${SKINNER.chain.cooldownMs / 1000} sec cooldown, off the global cooldown.`,
    howToUse:
      "Flip to Punishment BEFORE a burst. Mitigation only counts if it is already running when the hit lands, while healing works fine afterward. So Punishment leads the damage and Reinforcement cleans up behind it. E and R together are a four cell matrix, and the HUD names the live cell.",
    theory:
      "Reinforcement makes a behavior more likely, punishment makes it less. Crossed with adding or removing a stimulus, they form the four quadrant matrix of operant conditioning. Skinner himself distrusted punishment: it suppresses behavior without teaching a better one.",
  },
  {
    id: "skinner.shaping",
    name: "Shaping",
    key: "F",
    summary:
      "Your ultimate. A holo pigeon hops teammate to teammate, healthiest first, cashing every banked Approximation, and each landing is bigger than the last, so the deepest heal falls on whoever needs it most.",
    numbers: () =>
      `Restores ${SKINNER.ultimate.heal} health to the whole team, plus ${SKINNER_REINFORCEMENT.shaping.perApproximation} for every Approximation consumed, up to ${SKINNER_REINFORCEMENT.approximation.capPerAlly} per ally. Healing past full health converts to team Amp. Consumes no Marks. Skinner's economy is Approximations, banked on allies. Costs ${SKINNER.ultimate.focusCost} Focus. ${SKINNER.ultimate.cooldownMs / 1000} sec cooldown.`,
    howToUse:
      "Cash it on a full board, and remember the board decays. Keep procs flowing right up to the press. On a topped off team the overheal becomes team Amp, so a full board on a full team is a damage window, not a waste.",
    theory:
      "Shaping builds a behavior by reinforcing successive approximations, each step a little closer to the target. Skinner shaped pigeons to play ping pong and, in Project Pigeon, to steer a missile, one small approximation at a time.",
  },
];

/** Look up the lore for a bar slot id, whoever's kit it belongs to. Each
 *  palette stage gets its own entry; anything else with the stage prefix
 *  falls back to the shared one. */
export function loreFor(slotId: string): SkillLore | null {
  // Skinner's E/R faces mount with quadrant-suffixed slot ids
  // ("skinner.contingency-positive-reinforcement" — the full E × R cell,
  // since either flip repaints both faces) because the bar's replaceSlot
  // refuses same-id swaps; the lore entry lives under the base id, so strip
  // every quadrant suffix before looking anything up.
  const id = slotId.replace(/(?:-(?:positive|negative|reinforcement|punishment))+$/, "");
  return (
    STAGE_LORE.find((s) => s.id === id) ??
    SKILL_LORE.find((s) => s.id === id) ??
    PAVLOV_SKILL_LORE.find((s) => s.id === id) ??
    SKINNER_SKILL_LORE.find((s) => s.id === id) ??
    SKILL_LORE.find((s) => id.startsWith(s.id)) ??
    null
  );
}

/** The codex's per-hero skill list — the shared stage entry for Freud, the
 *  seven real buttons for Pavlov, the eight for Skinner. Freud's set is the
 *  fallback for an unknown id, matching CHARACTERS below. */
const HERO_SKILL_LORE: Record<string, SkillLore[]> = {
  freud: SKILL_LORE,
  pavlov: PAVLOV_SKILL_LORE,
  skinner: SKINNER_SKILL_LORE,
};

export function skillLoreFor(heroId: string): SkillLore[] {
  return HERO_SKILL_LORE[heroId] ?? SKILL_LORE;
}

export const CHARACTER = {
  codename: "The Analyst",
  realName: "Sigmund Freud",
  lifespan: "1856 to 1939",

  /** The hero as Psyrena presents him. */
  inGame: [
    "Freud enters Psyrena as The Analyst, a damage dealer who wins by diagnosis rather than by rotation. He brings his own century with him: a black three piece suit and a full grey beard, worn under a charcoal overcoat with glowing trim on the lapels and a smoke grey lens over one eye.",
    "He is the highest ceiling and the highest risk hero on the roster. No other hero punishes a misread as hard, and none of them pays out as spectacularly when the read is right. Most damage dealers ask whether you can execute a sequence. Freud asks whether you actually know the theory.",
    "He reads the boss by its age band, the same axis Erikson, Piaget and Kohlberg answer. That overlap is deliberate. When Freud cannot name what he is looking at, somebody else on the team usually can.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Sigmund Freud was an Austrian neurologist and the founder of psychoanalysis. He argued that most of mental life runs out of sight of the person living it, that childhood shapes adult character, and that dreams, slips of the tongue and unguarded speech are ways of reading what somebody cannot say directly.",
    "The ideas the game borrows are all his: the psychosexual stages, the division of the psyche into id, ego and superego, and the catalogue of defense mechanisms that his daughter Anna Freud later set out in full. He also gave the clinic the practice of listening at length to a patient's own words, which outlived almost everything else he proposed.",
    "His mark on the twentieth century is difficult to overstate, and it reaches well past the clinic into literature, film and ordinary speech. The science is a separate question. Most of his specific claims, the psychosexual stages among them, are not supported by modern evidence, and they are taught today as the history of the field rather than as live theory.",
  ],

  /**
   * Shown as a standing notice on the codex. Doc 07 C-1: a game that promises
   * a player can pass a quiz on the theory owes them the evidence status too.
   */
  evidenceNote:
    "Psyrena teaches these ideas because they shaped the field and because they make a good kit, not because they are current science. Freud is flagged Historical throughout the game for exactly that reason.",
} as const;

export const PAVLOV_CHARACTER = {
  codename: "The Conditioner",
  realName: "Ivan Petrovich Pavlov",
  lifespan: "1849 to 1936",

  /** The hero as Psyrena presents him. */
  inGame: [
    "Pavlov enters Psyrena as The Conditioner, the free starter and a tank who wins by teaching. His kit is one loop drawn in buttons: ring the bell, present the food, and cash the learned response in once the boss has been conditioned. Nothing in it can be answered wrongly, which is exactly why a first timer can clear a fight with him.",
    "The floor is low and the ceiling is real. Anyone can mash the loop and land near budget. A player who orders it properly, bell first and food while the bell still rings, banks Pairings twice as fast, and the whole kit accelerates around that one habit of timing.",
    "His companion Druzhok is named for one of Pavlov's own dogs. The game draws him as a German Shepherd so he reads at a distance across the Pet Park; the real laboratory dogs were mixed breed strays, and the codex owes them that correction.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Ivan Pavlov was a Russian physiologist, awarded the 1904 Nobel Prize for his work on digestion. The conditioned reflex was found on the way: dogs in his laboratory began salivating at the signals that preceded food, and Pavlov spent the rest of his career measuring exactly how such learning is built, generalized, discriminated and extinguished.",
    "Every mechanic in the kit is one of his findings. Pairing order matters, which is the delay versus backward distinction. Extinguished responses recover after rest. Responses spread to similar stimuli and can be trained back to only one. He insisted on measurement over introspection, and that insistence became a founding habit of behavioral science.",
    "Classical conditioning replicates, in species from sea slugs to people, and it still carries clinical weight: exposure therapy for phobias and PTSD is extinction, applied with care. The vocabulary this kit teaches is the field's working vocabulary today.",
  ],

  /**
   * Shown as a standing notice on the codex. Doc 07 C-1: the contrast case
   * to Freud — the roster's first Contemporary flag.
   */
  evidenceNote:
    "Classical conditioning is live, replicated, contemporary science, taught here in its own working vocabulary. Pavlov is flagged Contemporary throughout the game, the deliberate contrast to Freud's Historical.",
} as const;

export const SKINNER_CHARACTER = {
  codename: "The Reinforcer",
  realName: "Burrhus Frederic Skinner",
  lifespan: "1904 to 1990",

  /** The hero as Psyrena presents him. */
  inGame: [
    "Skinner enters Psyrena as The Reinforcer, the roster's first healer, and his kit is one idea turned around: the operant chamber with his own party inside it. Every heal is a pellet, earned by behaving, delivered on a schedule he chooses. He dresses in a fitted jacket and thick dark rimmed glasses, a holo chamber projector on his belt, and holographic pigeons circle him where other heroes carry weapons.",
    "The floor could not be lower: press any schedule and the team gets fed, and every schedule pays the same on average, so there is no wrong button. The ceiling is everything above that. Matching the two toggles to the comp and the phase, keeping Response Strength rolling so his own damage never extinguishes, and cashing Shaping on a full board of Approximations separate a Skinner who keeps a team alive from one who carries it.",
    "The pigeons are not decoration. Skinner's real pigeons, fed on random schedules, developed superstitious rituals, turning and bobbing as if the movement had earned the food, and his slot machine schedule lays the same trap for you. The radical behaviorist certainty he speaks with is a period voice, the man as his century heard him, not a claim the game makes about current doctrine.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Burrhus Frederic Skinner was an American psychologist and the central figure of behaviorism's second act. In the operant chamber that came to carry his name, he measured how consequences shape behavior, and with Charles Ferster he mapped the schedules of reinforcement, showing that when a reward arrives matters as much as what the reward is.",
    "He was an engineer of his own ideas. He shaped pigeons step by step until they played ping pong, and in the wartime Project Pigeon trained them to guide a missile from inside its nose cone. His teaching machines broke learning into small, immediately reinforced steps, an idea that returned decades later in instructional software.",
    "His radical behaviorism went further, holding that thoughts and feelings are behavior too, and that a science of the person needs reinforcement histories rather than a mind. Chomsky's review of Verbal Behavior became a founding document of the cognitive revolution, and psychology moved past the claim while keeping the methods. The operant tools never stopped working.",
  ],

  /**
   * Shown as a standing notice on the codex. Doc 07 C-1: Contemporary for
   * the tools, with the philosophical claim flagged as the contested part.
   */
  evidenceNote:
    "Operant conditioning is live, applied, contemporary science. It underwrites applied behavior analysis in the clinic and echoes through behavioral economics. Skinner is flagged Contemporary for those tools, even though radical behaviorism as a complete account of the mind remains contested.",
} as const;

/** One shape for every card — the codex renders whoever is selected. */
export interface HeroCharacter {
  codename: string;
  realName: string;
  lifespan: string;
  inGame: readonly string[];
  historical: readonly string[];
  evidenceNote: string;
}

export const CHARACTERS: Record<string, HeroCharacter> = {
  freud: CHARACTER,
  pavlov: PAVLOV_CHARACTER,
  skinner: SKINNER_CHARACTER,
};
