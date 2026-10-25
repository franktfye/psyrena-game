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
import { ERIKSON, ERIKSON_PSYCHOSOCIAL } from "@shared/heroes/erikson";
import { AINSWORTH } from "@shared/heroes/ainsworth";
import { PIAGET, PIAGET_DEVELOPMENT } from "@shared/heroes/piaget";
import { BANDURA, BANDURA_MODELING } from "@shared/heroes/bandura";
import { COMBAT, BEAT_PERIOD_S } from "@shared/combat";
import { overTimeText, reachText } from "./skillText";

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
      `Deals ${FREUD.chain.base} damage to all enemies. ${overTimeText(FREUD.chain)} For 8 sec your next 3 stage casts are corrected automatically when wrong, though the Marks they place count at half value. Costs ${FREUD.chain.focusCost} Focus. ${FREUD.chain.cooldownMs / 1000} sec cooldown.`,
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
      `Deals ${PAVLOV.chain.base} damage${reachText(PAVLOV.chain)}. Taunts the boss for ${(PAVLOV.chain.effects.find((e) => e.kind === "taunt")?.durationMs ?? 0) / 1000} sec. The boss takes ${pct(PAVLOV.chain.effects.find((e) => e.kind === "vulnerability")?.magnitude ?? 0)} increased damage for ${(PAVLOV.chain.effects.find((e) => e.kind === "vulnerability")?.durationMs ?? 0) / 1000} sec. Costs ${PAVLOV.chain.focusCost} Focus. ${PAVLOV.chain.cooldownMs / 1000} sec cooldown.`,
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

/**
 * Erikson's six buttons. Keys 1 and 2 relabel themselves on every press (the
 * stage and virtue they cast next), so their copy describes the rotation, and
 * the full chart lives in the character page below.
 */
const ERIKSON_CHART = ERIKSON_PSYCHOSOCIAL.stages
  .map((st, i) => `${i + 1}. ${st.crisis} (${st.age}): ${st.virtue}`)
  .join(" · ");

export const ERIKSON_SKILL_LORE: SkillLore[] = [
  {
    id: "erikson.relations",
    name: "Significant Relations",
    key: "LMB",
    summary:
      "Your add-on attack. You get one after every Life Stage and one after every Virtue. It is named for the people who matter most at the current stage.",
    numbers: () =>
      `Deals ${ERIKSON.basic.base} damage. Available once after each key 1 and once after each key 2, never more. No Focus cost. It never eats your global cooldown.`,
    howToUse:
      "Press 1, then this. Press 2, then this. The rhythm is 1, attack, 2, attack. An add-on you skip is gone, so do not save it.",
    theory: `Erikson charted a widening radius of significant relations across the life cycle: ${ERIKSON_PSYCHOSOCIAL.stages.map((st) => st.relations).join(", ")}. Each stage is lived among more people than the last.`,
  },
  {
    id: "erikson.stage",
    name: "Life Stage",
    key: "1",
    summary:
      "Casts the stage you are in. The button shows its name, and the line above the bar shows the whole crisis and its age.",
    numbers: () =>
      `Deals ${ERIKSON.palette[0]!.base} damage and arms the stage's virtue for key 2. Costs ${ERIKSON.palette[0]!.focusCost} Focus.`,
    howToUse:
      "Always press 1 before 2. Pressing 1 twice casts the same stage again and does not move you on.",
    theory: `Erikson described eight psychosocial stages, each a crisis between two poles that a person meets at a typical age: ${ERIKSON_CHART}.`,
  },
  {
    id: "erikson.virtue",
    name: "Virtue",
    key: "2",
    summary:
      "Answers the stage with its virtue. Stage and virtue together complete the pair: your biggest hit, one virtue banked, and the next stage comes up.",
    numbers: () =>
      `After key 1: deals ${ERIKSON.palette[1]!.base} damage, banks 1 virtue (up to ${ERIKSON_PSYCHOSOCIAL.maxVirtues}) and returns ${ERIKSON_PSYCHOSOCIAL.pairFocusRefund} Focus. Without a stage armed: deals ${Math.round(ERIKSON.palette[1]!.base * ERIKSON_PSYCHOSOCIAL.unmatchedVirtueMult)}, banks nothing and returns nothing. Costs ${ERIKSON.palette[1]!.focusCost} Focus.`,
    howToUse:
      "Read the virtue on the button as you press it. A complete pair pays part of its own Focus back, so the right order keeps you casting. After stage 8 the cycle starts again at stage 1, so every press teaches the next row of the chart.",
    theory:
      "Each stage, met well, leaves a basic virtue behind: Hope, Will, Purpose, Competence, Fidelity, Love, Care and Wisdom. Erikson's point was a favourable balance between the two poles, not a perfect score, and that the stages build on one another in order.",
  },
  {
    id: "erikson.moratorium",
    name: "Psychosocial Moratorium",
    key: "E",
    summary: "Your one defensive button. Step back, recover, and come back to the crisis.",
    numbers: () =>
      `Restores ${ERIKSON.defense.heal} health to you and reduces your damage taken by ${pct(ERIKSON.defense.mitigation?.magnitude ?? 0)} for ${(ERIKSON.defense.mitigation?.durationMs ?? 0) / 1000} sec. Costs ${ERIKSON.defense.focusCost} Focus. ${ERIKSON.defense.cooldownMs / 1000} sec cooldown.`,
    howToUse: "Press it when the boss turns on you. Your stage and banked virtues wait for you.",
    theory:
      "Erikson's moratorium is the delay a society grants young people before adult commitments: time to try out roles without being held to them. Here it is a pause in the fight.",
  },
  {
    id: "erikson.identity-crisis",
    name: "Identity Crisis",
    key: "R",
    summary: "Shakes every enemy at once.",
    numbers: () =>
      `Deals ${ERIKSON.chain.base} damage to every enemy. ${overTimeText(ERIKSON.chain)} Costs ${ERIKSON.chain.focusCost} Focus. ${ERIKSON.chain.cooldownMs / 1000} sec cooldown.`,
    howToUse: "Press it on cooldown. Against a crowd it hits every one of them.",
    theory:
      "Erikson coined the term identity crisis for the adolescent struggle between a coherent sense of self and role confusion. James Marcia later measured it as four identity statuses, the most tested part of the stage model.",
  },
  {
    id: "erikson.life-review",
    name: "Life Review",
    key: "F",
    summary: "Looks back on every virtue you have banked and turns them into one blow.",
    numbers: () =>
      `Deals ${ERIKSON.ultimate.base} damage plus ${ERIKSON.ultimate.perMark} for every banked virtue, up to ${ERIKSON.ultimate.maxMarksConsumed}, then spends them. Your stage does not reset. Costs ${ERIKSON.ultimate.focusCost} Focus. ${ERIKSON.ultimate.cooldownMs / 1000} sec cooldown.`,
    howToUse: "Bank virtues with 1 and 2, then press F when it comes off cooldown.",
    theory:
      "Erikson's last stage, Integrity vs Despair, is a look back over one's one and only life. Robert Butler named the process life review in 1963, and reminiscence work with older adults grew from it.",
  },
];

const AIN = AINSWORTH;
const ainStyle = (id: string) => AIN.palette.find((p) => p.id === id)!;
const ainFx = (id: string, kind: string) => ainStyle(id).effects.find((e) => e.kind === kind);
const ainSec = (ms?: number): number => (ms ?? 0) / 1000;

/**
 * Ainsworth's buttons. Keys 1–4 are the four attachment styles, each acting
 * out its Strange Situation reunion; the stance sits on 5 because her
 * palette fills 1–4 (arenaHero.ts stanceKey).
 */
export const AINSWORTH_SKILL_LORE: SkillLore[] = [
  {
    id: "ainsworth.sensitivity",
    name: "Sensitivity",
    key: "LMB",
    summary: "Your basic attack, and an answer to a teammate's signal.",
    numbers: () => {
      const e = AIN.basic.effects[0]!;
      return `Deals ${AIN.basic.base} damage. If a teammate was hit in the last ${ainSec(e.durationMs)} sec, it also heals them ${e.magnitude}. No Focus cost. ${ainSec(AIN.basic.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Attack right after a teammate takes a hit. Promptness is the whole skill.",
    theory:
      "Ainsworth rated mothers on sensitivity: noticing a baby's signals, reading them correctly, and answering promptly and appropriately. Sensitive care was the strongest early predictor of a secure baby in her Baltimore study.",
  },
  {
    id: "ainsworth.secure",
    name: "Secure",
    key: "1",
    summary: "Comfort, then let go: the team recovers and goes out exploring.",
    numbers: () =>
      `Deals ${ainStyle("ainsworth.secure").base} damage and places a Bond Mark. Lifts Fixation off every teammate, and the whole team deals ${pct(ainFx("ainsworth.secure", "team.amp")?.magnitude ?? 0)} more damage for ${ainSec(ainFx("ainsworth.secure", "team.amp")?.durationMs)} sec.`,
    howToUse: "Your steady key. Press it after someone misreads the boss, or to open a damage window.",
    theory:
      "In the Strange Situation a secure baby is upset when the mother leaves, goes to her when she returns, is soothed quickly and goes back to playing. The caregiver is a secure base to explore from.",
  },
  {
    id: "ainsworth.avoidant",
    name: "Avoidant",
    key: "2",
    summary: "Looks calm, isn't: your hardest hit, and the pain arrives later.",
    numbers: () => {
      const st = ainFx("ainsworth.avoidant", "self.stagger");
      return `Deals ${ainStyle("ainsworth.avoidant").base} damage and places a Bond Mark. You shed ${pct(ainFx("ainsworth.avoidant", "threat.drop")?.magnitude ?? 0)} of your threat and take ${pct(ainFx("ainsworth.avoidant", "mitigation.grant")?.magnitude ?? 0)} less damage for ${ainSec(st?.durationMs)} sec, and every hit in that time bleeds out over ${st?.magnitude} sec instead of landing at once.`;
    },
    howToUse: "Press it before a big hit lands on you, then heal through the bleed.",
    theory:
      "An avoidant baby barely reacts when the mother leaves and ignores her when she returns. It looks like calm, but Sroufe and Waters (1977) found these babies' heart rates rose on reunion: the distress was there, just not shown.",
  },
  {
    id: "ainsworth.ambivalent",
    name: "Ambivalent",
    key: "3",
    summary: "The taunt: cling to the boss's attention, and refuse to be soothed.",
    numbers: () => {
      const t = ainFx("ainsworth.ambivalent", "taunt");
      return `Deals ${ainStyle("ainsworth.ambivalent").base} damage and places a Bond Mark. ${overTimeText(ainStyle("ainsworth.ambivalent"))} The boss locks onto you for ${ainSec(t?.durationMs)} sec, the team takes ${pct(ainFx("ainsworth.ambivalent", "mitigation.grant")?.magnitude ?? 0)} less damage, and healing on you is cut ${pct(ainFx("ainsworth.ambivalent", "heal.cut.self")?.magnitude ?? 0)} while it lasts.`;
    },
    howToUse: "Press it when the boss is on a teammate. Tell your healer before you do.",
    theory:
      "An ambivalent, or resistant, baby is very upset at the separation and seeks the mother on her return, then pushes her away and stays hard to soothe. Wanting contact and resisting it at once is the pattern.",
  },
  {
    id: "ainsworth.disorganized",
    name: "Disorganized",
    key: "4",
    summary: "Approach, freeze, shield: everyone else is untouchable for a moment.",
    numbers: () => {
      const d = ainStyle("ainsworth.disorganized");
      const im = d.effects.find((e) => e.kind === "team.immunity");
      return `Deals ${d.base} damage and places a Bond Mark. Every other teammate is immune to the boss for ${ainSec(im?.durationMs)} sec. You are not. Needs ${d.requiresVariety?.distinct} different styles cast in the last ${ainSec(d.requiresVariety?.withinMs)} sec. ${ainSec(d.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Mix two other styles first, then save it for the moment before the team would be hit hard.",
    theory:
      "Mary Main and Judith Solomon (1990) added this fourth pattern for babies who fit none of Ainsworth's three: they freeze, or approach and turn away at the same time. In long-term studies it is the strongest early predictor of dissociation later on.",
  },
  {
    id: "ainsworth.proximity-maintenance",
    name: "Proximity Maintenance",
    key: "5",
    summary: "Your tank stance: stay close, and the boss stays on you.",
    numbers: () =>
      `Toggle. While held you bank ${AIN.threatStance?.multiplier}x threat per point of damage. Free, no cooldown.`,
    howToUse: "Hold it while you tank. Drop it, or use Avoidant or Strange Situation, to hand the boss over.",
    theory:
      "Bowlby described attachment behaviour as keeping close to the attachment figure: proximity maintenance. Ainsworth's observations showed how a baby keeps that closeness, by watching, following and calling.",
  },
  {
    id: "ainsworth.safe-haven",
    name: "Safe Haven",
    key: "E",
    summary: "Gather the team in: heal, shelter and clear their heads.",
    numbers: () =>
      `Heals ${AIN.defense.heal}, split across the team, and the team takes ${pct(AIN.defense.mitigation?.magnitude ?? 0)} less damage for ${ainSec(AIN.defense.mitigation?.durationMs)} sec. Lifts Fixation off everyone. Costs ${AIN.defense.focusCost} Focus. ${ainSec(AIN.defense.cooldownMs)} sec cooldown.`,
    howToUse: "Press it before the boss's team-wide attack lands.",
    theory:
      "A safe haven is where a frightened child runs for comfort; a secure base is where it explores from. Ainsworth used both ideas to describe what a sensitive caregiver gives.",
  },
  {
    id: "ainsworth.strange-situation",
    name: "Strange Situation",
    key: "R",
    summary: "Step away, come back, and see how the boss reacts.",
    numbers: () => {
      const v = AIN.chain.effects.find((e) => e.kind === "vulnerability");
      return `Deals ${AIN.chain.base} damage${reachText(AIN.chain)}. You shed ${pct(AIN.chain.effects.find((e) => e.kind === "threat.drop")?.magnitude ?? 0)} of your threat, and the boss takes ${pct(v?.magnitude ?? 0)} more damage from everyone for ${ainSec(v?.durationMs)} sec. Costs ${AIN.chain.focusCost} Focus. ${ainSec(AIN.chain.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Press it on cooldown. It also passes the boss to a teammate when you need a breather.",
    theory:
      "Ainsworth's laboratory procedure: about twenty minutes, eight short episodes in which a mother leaves and returns and a stranger comes in. How a one-year-old greets the mother on her return classifies its attachment.",
  },
  {
    id: "ainsworth.earned-security",
    name: "Earned Security",
    key: "F",
    summary: "Cash in the team's Marks, heal everyone, and make the team secure.",
    numbers: () => {
      const amp = AIN.ultimate.effects.find((e) => e.kind === "team.amp");
      return `Deals ${AIN.ultimate.base} damage plus ${AIN.ultimate.perMark} for every Mark consumed, up to ${AIN.ultimate.maxMarksConsumed}. Heals the team ${AIN.ultimate.heal}, lifts Fixation, and the team deals ${pct(amp?.magnitude ?? 0)} more damage for ${ainSec(amp?.durationMs)} sec. Costs ${AIN.ultimate.focusCost} Focus. ${ainSec(AIN.ultimate.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Build Marks with 1 to 4, then press F for a big hit and a team-wide recovery.",
    theory:
      "Earned security is Mary Main and Erik Hesse's term from the Adult Attachment Interview: adults who describe a hard childhood but tell it coherently, and are secure now. Attachment is not destiny.",
  },
];


const PIA = PIAGET;
const piaStage = (id: string) => PIA.palette.find((p) => p.id === id)!;
const piaFx = (id: string) => piaStage(id).effects[0]!;
const piaSec = (ms?: number): number => (ms ?? 0) / 1000;

/**
 * Piaget's buttons. Keys 1–4 are his four stages in order, each healing the
 * way a child at that stage thinks; in order they refund Focus.
 */
export const PIAGET_SKILL_LORE: SkillLore[] = [
  {
    id: "piaget.assimilation",
    name: "Assimilation",
    key: "LMB",
    summary: "Your basic attack: fitting the boss into a schema you already have.",
    numbers: () => `Deals ${PIA.basic.base} damage. No Focus cost. ${piaSec(PIA.basic.cooldownMs)} sec cooldown.`,
    howToUse: "Fill the gaps between heals with it. A healer with nothing to heal should still be hitting.",
    theory:
      "Assimilation is taking in something new through a schema you already have: a toddler who knows dogs calls every four-legged animal a dog.",
  },
  {
    id: "piaget.sensorimotor",
    name: "Sensorimotor",
    key: "1",
    summary: "Circular Reaction: a heal over time on whoever is lowest.",
    numbers: () =>
      `Heals the most wounded teammate ${piaFx("piaget.sensorimotor").magnitude} over ${piaSec(piaFx("piaget.sensorimotor").durationMs)} sec and places a Schema Mark. Recast it and a second heal runs alongside. Costs ${piaStage("piaget.sensorimotor").focusCost} Focus. Answers an infant.`,
    howToUse: "Start every sequence with it: it is stage one, and the heal lands while you cast the rest.",
    theory:
      "Birth to about two. Infants learn through their senses and actions, and repeat what worked again and again (circular reactions). By the end of the stage they know an object still exists when it is hidden.",
  },
  {
    id: "piaget.preoperational",
    name: "Preoperational",
    key: "2",
    summary: "Centration: the whole heal on one teammate, nobody else.",
    numbers: () =>
      `Heals the most wounded teammate ${piaFx("piaget.preoperational").magnitude} at once and places a Schema Mark. Costs ${piaStage("piaget.preoperational").focusCost} Focus. Answers a toddler or a child.`,
    howToUse: "Your emergency button. When one teammate is in trouble, put everything on them.",
    theory:
      "About two to seven. Children use symbols and pretend play, but think egocentrically and centre on one feature at a time, which is why the taller glass always seems to hold more.",
  },
  {
    id: "piaget.concrete",
    name: "Concrete Operational",
    key: "3",
    summary: "Conservation: the team's health shared out evenly, then a team heal.",
    numbers: () =>
      `Shares the team's health out evenly (everyone ends at the same fraction, the total unchanged), then heals the team ${piaFx("piaget.concrete").magnitude}, split across everyone. Places a Schema Mark. Costs ${piaStage("piaget.concrete").focusCost} Focus. Answers a schoolchild.`,
    howToUse: "Press it when one teammate is low and the others are healthy: the healthy ones carry the hurt one.",
    theory:
      "About seven to eleven. Children reason logically about real things. They grasp conservation: an amount stays the same when it changes shape, poured into another glass or rolled out into a sausage.",
  },
  {
    id: "piaget.formal",
    name: "Formal Operational",
    key: "4",
    summary: "Hypothetical: a shield before the hit lands.",
    numbers: () =>
      `Shields the team for ${piaFx("piaget.formal").magnitude} in total, split across everyone, for ${piaSec(piaFx("piaget.formal").durationMs)} sec. Whatever is left when it fades becomes team Amp. Places a Schema Mark. Costs ${piaStage("piaget.formal").focusCost} Focus; after 1, 2 and 3 in order it refunds ${PIAGET_DEVELOPMENT.sequenceFocusRefund}. Answers an adolescent.`,
    howToUse: "Cast it before the boss's big hits, not after. It finishes the sequence, so it also earns the Focus refund.",
    theory:
      "About eleven onward. Adolescents reason about the abstract and the hypothetical: what would happen if, and how to test it.",
  },
  {
    id: "piaget.accommodation",
    name: "Accommodation",
    key: "E",
    summary: "A team shield and less damage for everyone.",
    numbers: () => {
      const sh = PIA.defense.effects.find((e) => e.kind === "shield.team");
      return `Shields the team for ${sh?.magnitude} in total for ${piaSec(sh?.durationMs)} sec, and everyone takes ${pct(PIA.defense.mitigation?.magnitude ?? 0)} less damage for ${piaSec(PIA.defense.mitigation?.durationMs)} sec. Costs ${PIA.defense.focusCost} Focus. ${piaSec(PIA.defense.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Press it when the whole raid is about to be hit, in Terror above all.",
    theory:
      "Accommodation is changing a schema to fit something it cannot absorb: the toddler learns that a cow is not a dog after all. Assimilation and accommodation together are how, for Piaget, all knowledge is built.",
  },
  {
    id: "piaget.object-permanence",
    name: "Object Permanence",
    key: "R",
    summary: "The lowest teammate cannot die for a few seconds, then is healed.",
    numbers: () => {
      const e = PIA.chain.effects[0]!;
      return `The most wounded teammate cannot drop below 1 health for ${piaSec(e.durationMs)} sec, then is healed ${e.magnitude}. Costs ${PIA.chain.focusCost} Focus. ${piaSec(PIA.chain.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Save it for the moment someone is about to fall. It buys time for your other heals.",
    theory:
      "Knowing an object still exists when you cannot see it. Piaget hid a toy under a cloth: young infants stop looking, older ones search. Later studies found signs of it months earlier than he thought.",
  },
  {
    id: "piaget.equilibration",
    name: "Equilibration",
    key: "F",
    summary: "Spend the Schema Marks on a big team heal and a cleanse.",
    numbers: () => {
      const eq = PIA.ultimate.effects.find((e) => e.kind === "equilibration.release");
      return `Heals the team ${PIA.ultimate.heal} plus ${eq?.magnitude} for every Mark consumed, up to ${PIA.ultimate.maxMarksConsumed}, and lifts Fixation off everyone. Overheal becomes team Amp. Costs ${PIA.ultimate.focusCost} Focus. ${piaSec(PIA.ultimate.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Build Marks with your stages, then press it when the team is hurt, or full, for an Amp window.",
    theory:
      "Equilibration is the drive to balance assimilation and accommodation. When a schema fails, the mind is out of balance, and restoring it is what moves a child up to the next stage.",
  },
];

const BAN = BANDURA;
const banSec = (ms?: number): number => (ms ?? 0) / 1000;

/** Bandura's buttons. Keys 1–4 hold copies of his model's skills. */
export const BANDURA_SKILL_LORE: SkillLore[] = [
  {
    id: "bandura.modeled-aggression",
    name: "Modeled Aggression",
    key: "LMB",
    summary: "Your basic attack: a punch you learned by watching.",
    numbers: () => `Deals ${BAN.basic.base} damage. No Focus cost. ${banSec(BAN.basic.cooldownMs)} sec cooldown.`,
    howToUse: "Fill the gaps while your model fills your slots.",
    theory:
      "In the Bobo doll studies, children who watched an adult hit an inflatable doll hit it too, often with the same words and moves, and more so when the adult had been rewarded.",
  },
  ...BAN.palette.map((p, i) => ({
    id: p.id,
    name: `Retention ${i + 1}`,
    key: String(i + 1),
    summary: "A copy of a skill your model cast. Press it to reproduce it.",
    numbers: () => {
      const m = BANDURA_MODELING;
      return `Pays ${Math.round(p.base * m.motivatedMult)} if your model was rewarded for the original (a crit or a right answer), ${Math.round(p.base * m.unmotivatedMult)} if not, and carries the original's effects. A copied heal heals for that much instead. Empty, it rehearses for ${Math.round(p.base * m.emptyMult)}. Copies fade after ${m.retentionMs / 1000} sec, and a press spends the copy. Costs 8 Focus.`;
    },
    howToUse:
      "Watch the caption: it names your model. Press starred copies first, they pay full. Tap the caption to pin a different teammate.",
    theory:
      i === 0
        ? "Attention: we copy models who stand out, who are competent, successful or like us. Your model is the teammate doing the most right now."
        : i === 1
          ? "Retention: what we saw has to be remembered to be copied. Unrehearsed, it fades."
          : i === 2
            ? "Reproduction: turning the memory back into action. Copying is not perfect, so an ordinary copy pays less than the original."
            : "Motivation: we copy what we saw rewarded. That is vicarious reinforcement, and it is why a starred copy pays full.",
  })),
  {
    id: "bandura.self-efficacy",
    name: "Self-Efficacy",
    key: "E",
    summary: "Heal yourself and take less damage.",
    numbers: () =>
      `Heals you ${BAN.defense.heal} and you take ${pct(BAN.defense.mitigation?.magnitude ?? 0)} less damage for ${banSec(BAN.defense.mitigation?.durationMs)} sec. Costs ${BAN.defense.focusCost} Focus. ${banSec(BAN.defense.cooldownMs)} sec cooldown.`,
    howToUse: "Your one defensive button. Press it before a hit you can see coming.",
    theory:
      "Self-efficacy is your belief that you can do a thing, and it predicts whether you try, how hard, and for how long. It grows from your own successes, from watching others succeed, from encouragement, and from a calm body.",
  },
  {
    id: "bandura.bobo-doll",
    name: "Bobo Doll",
    key: "R",
    summary: "A decoy the boss cannot resist, which hits back.",
    numbers: () => {
      const e = BAN.chain.effects[0]!;
      return `Deals ${BAN.chain.base} damage${reachText(BAN.chain)}. For ${banSec(e.durationMs)} sec the boss's single-target blows hit the doll instead of your tank, and it rebounds ${pct(e.magnitude ?? 0)} of them at the boss. Costs ${BAN.chain.focusCost} Focus. ${banSec(BAN.chain.cooldownMs)} sec cooldown.`;
    },
    howToUse: "Give your tank a breather in Onslaught, or save a teammate the boss is about to finish.",
    theory:
      "The inflatable clown from Bandura's 1961 to 1963 experiments with Dorothea and Sheila Ross. It is round-bottomed, so it always bounces back up to be hit again.",
  },
  {
    id: "bandura.reciprocal-determinism",
    name: "Reciprocal Determinism",
    key: "F",
    summary: "Cash in the Marks, and buff the person, the behaviour and the environment.",
    numbers: () =>
      `Deals ${BAN.ultimate.base} damage plus ${BAN.ultimate.perMark} for every Mark consumed, up to ${BAN.ultimate.maxMarksConsumed}. For 6 sec: you take 15 percent less damage, the team deals 6 percent more, and the boss takes 8 percent more. Costs ${BAN.ultimate.focusCost} Focus. ${banSec(BAN.ultimate.cooldownMs)} sec cooldown.`,
    howToUse: "Press it with a full Mark board, at the start of a damage window.",
    theory:
      "Bandura's model of how a person, their behaviour and their environment all shape each other at once. None of the three is simply the cause of the others.",
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
    ERIKSON_SKILL_LORE.find((s) => s.id === id) ??
    AINSWORTH_SKILL_LORE.find((s) => s.id === id) ??
    PIAGET_SKILL_LORE.find((s) => s.id === id) ??
    BANDURA_SKILL_LORE.find((s) => s.id === id) ??
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
  erikson: ERIKSON_SKILL_LORE,
  ainsworth: AINSWORTH_SKILL_LORE,
  piaget: PIAGET_SKILL_LORE,
  bandura: BANDURA_SKILL_LORE,
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
    "He reads the boss by its age band, the same axis Piaget and Kohlberg answer. That overlap is deliberate. When Freud cannot name what he is looking at, somebody else on the team usually can.",
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

export const ERIKSON_CHARACTER = {
  codename: "The Life Cycle",
  realName: "Erik Homburger Erikson",
  lifespan: "1902 to 1994",

  /** The hero as Psyrena presents him. */
  inGame: [
    "Erikson enters Psyrena as The Life Cycle, a damage dealer whose rotation is his theory. Press 1 for the stage, 2 for its virtue, and an add-on attack after each. The buttons name every stage, its age and its virtue as you go, so a run through the cycle is a run through the chart.",
    "He never has to read the boss. His match is between his own two keys, which makes him a calm, steady damage dealer for a player who is still learning the fight. The skill is in the rhythm: keep 1, attack, 2, attack going, and cash the virtues in with Life Review.",
    "He wears a charcoal jacket and an open collar, with a glowing hourglass charm at his hip. Time is the axis his whole theory runs on.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Erik Erikson was a German born American psychoanalyst. He trained in Vienna under Anna Freud, never earned a university degree, and went on to teach at Harvard. His book Childhood and Society, in 1950, set out the eight stages of psychosocial development, and he coined the term identity crisis. Gandhi's Truth won him a Pulitzer Prize in 1970.",
    "Where Freud's stages end in adolescence, Erikson's run from birth to old age, and they are social rather than sexual: each is a crisis between a person and the people around them. His wife and collaborator Joan Erikson later proposed a ninth stage for very old age.",
    "The stage model is still taught everywhere, but it is hard to test as a whole, and critics have questioned how universal its order and ages are across cultures. Its parts have fared better: James Marcia's identity statuses and later research on generativity turned his ideas into measurable questions.",
  ],

  /**
   * Shown as a standing notice on the codex. Doc 07 C-1: influential and
   * still in use, but loosely testable as a whole model.
   */
  evidenceNote:
    "Erikson's eight stages are a framework more than a tested law. They shape how developmental psychology is taught, and parts of them, identity and generativity above all, are active research. Erikson is flagged Contested throughout the game for that reason.",
} as const;

export const AINSWORTH_CHARACTER = {
  codename: "The Safe Haven",
  realName: "Mary Dinsmore Salter Ainsworth",
  lifespan: "1913 to 1999",

  /** The hero as Psyrena presents her. */
  inGame: [
    "Ainsworth enters Psyrena as The Safe Haven, a tank whose four number keys are the four attachment styles. Each one acts out how a child greets a parent coming back: Secure lets the team recover and go exploring, Avoidant hides the pain and pays it later, Ambivalent clings to the boss's attention and refuses comfort, and Disorganized freezes, then shields everyone but herself.",
    "She holds the boss with Proximity Maintenance and hands it off with Avoidant or Strange Situation. Her basic attack rewards answering a teammate's hit quickly, which is what she meant by sensitivity.",
    "She wears a teal cardigan with gold trim and a glowing heart-in-shield at her collar and hip. A safe haven is where you run when you are frightened.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Mary Ainsworth was an American-Canadian developmental psychologist. She was born in Ohio, grew up in Toronto, took her doctorate there under William Blatz, and served in the Canadian Women's Army Corps in the Second World War, rising to major. In London she worked with John Bowlby, whose attachment theory she spent her life testing.",
    "She watched mothers and babies at home in Uganda, then in Baltimore, and built the Strange Situation to see the patterns in a laboratory. Patterns of Attachment, in 1978, set out the secure, avoidant and ambivalent styles. Mary Main and Judith Solomon later added disorganized attachment.",
    "The Strange Situation is one of the most replicated procedures in developmental psychology. How common each style is varies between cultures, and how strongly infant attachment predicts adult life is still argued. Her measures of sensitive care remain in use today.",
  ],

  /** Contemporary: an active, measured research field. */
  evidenceNote:
    "Attachment research is live, contemporary science. The Strange Situation and the sensitivity scales are still used, and the theory guides parenting and foster-care work. What is debated is how much the styles vary across cultures and how strongly they predict later life. Ainsworth is flagged Contemporary for that reason.",
} as const;


export const PIAGET_CHARACTER = {
  codename: "The Constructor",
  realName: "Jean William Fritz Piaget",
  lifespan: "1896 to 1980",

  /** The hero as Psyrena presents him. */
  inGame: [
    "Piaget enters Psyrena as The Constructor, a healer whose four number keys are his four stages of cognitive development. Each heals the way a child at that stage thinks: the infant repeats what worked, the preschooler fixes on one thing, the schoolchild knows an amount survives a change of shape, and the adolescent plans for what has not happened yet.",
    "The stages come in an order that cannot be skipped, and the kit pays for knowing it: cast them 1, 2, 3, 4 and the last one refunds Focus. When the boss shapeshifts there is nothing to heal, so his stages answer its age instead, Preoperational covering both the toddler and the child.",
    "He wears his beret, round gold spectacles and a charcoal three piece suit with emerald piping, a glowing spiral at his lapel and a charm of stacked building blocks at his hip. Knowledge, for Piaget, is built, one block at a time.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Jean Piaget was a Swiss psychologist from Neuchâtel. He published his first scientific paper, on an albino sparrow, at about ten, and took a doctorate on molluscs. Scoring reasoning tests in Alfred Binet's laboratory in Paris, he noticed that children of the same age made the same wrong answers, and spent the rest of his life asking why.",
    "He watched his own three children closely from birth, and built the theory of four stages, schemas, assimilation, accommodation and equilibration. He called his field genetic epistemology, the study of how knowledge develops, and founded a research centre for it in Geneva in 1955.",
    "His core findings replicate: children do pass through these kinds of thinking in this order, and conservation and object permanence are real. Later research found that infants and young children are more capable, earlier, than his methods showed, that the stages are less sharply divided, and that schooling and culture matter more than he allowed.",
  ],

  /** Contested: the sequence holds, the ages and the clean stages do not. */
  evidenceNote:
    "Piaget's stage sequence and his core phenomena hold up and are still taught everywhere. The ages are earlier and the stages less discrete than he proposed, and culture and schooling play a bigger part. Piaget is flagged Contested throughout the game for that reason.",
} as const;

export const BANDURA_CHARACTER = {
  codename: "The Mirror",
  realName: "Albert Bandura",
  lifespan: "1925 to 2021",

  /** The hero as Psyrena presents him. */
  inGame: [
    "Bandura enters Psyrena as The Mirror, a flex hero who has no fixed skills of his own. His four number keys fill with copies of what his model casts, and the four steps of observational learning are the controls: attention picks the model, retention holds the copies, reproduction is the key press, and motivation decides the power, full when the model was rewarded.",
    "Alone, he has nobody to watch but the boss, so he copies its blows. In a party he copies whoever is doing best, or whoever you pin, and a copied heal heals, a copied taunt taunts. His Bobo doll gives the tank a breather, and Reciprocal Determinism lifts the person, the behaviour and the environment at once.",
    "He wears a slate grey suit with silver piping, rectangular glasses, and a tie of glowing cyan squares, with a mirror at his lapel and another at his hip.",
  ],

  /** The historical figure, including what modern evidence says. */
  historical: [
    "Albert Bandura was a Canadian-American psychologist, born in Mundare, Alberta, a town of about four hundred people whose high school had two teachers. At the University of British Columbia he took his first psychology course because it fitted his car-pool timetable. He did his doctorate at Iowa and spent his career at Stanford.",
    "His Bobo doll experiments of the early 1960s showed that children learn behaviour by watching it, without being rewarded themselves. From them he built social learning theory, later social cognitive theory, with its idea of reciprocal determinism, and in 1977 introduced self-efficacy, one of the most studied ideas in psychology. He received the National Medal of Science in 2015.",
    "Observational learning and self-efficacy are strongly supported and widely used, in education, health and therapy. The Bobo doll studies themselves have been criticised: the doll was made to be hit, and play aggression toward a toy may not say much about real violence.",
  ],

  /** Contemporary: the theory is live and applied. */
  evidenceNote:
    "Observational learning and self-efficacy are live, contemporary science, applied in classrooms, clinics and health programmes. What is debated is how far the Bobo doll studies speak to real aggression. Bandura is flagged Contemporary for that reason.",
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
  erikson: ERIKSON_CHARACTER,
  ainsworth: AINSWORTH_CHARACTER,
  piaget: PIAGET_CHARACTER,
  bandura: BANDURA_CHARACTER,
};
