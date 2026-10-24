import type { Hero } from "../types";

/**
 * Pavlov — "The Conditioner". The free starter hero, and as of 2026-08-03 a
 * TANK (was Control, base 85) — doc 03 §8, rewritten alongside this file.
 *
 * ★ Every number here is derived, not authored. Same formula the role contract
 * (doc 08 §3) uses for Freud, at the tank's weight instead of the DPS's:
 *
 *     base = (budget × role weight × share) ÷ (casts per second × beat factor)
 *
 * with budget 95, weight 0.65 → **61.75 reference DPS**, beat factor **1.0
 * throughout** (he has no beat cycle — see `beats`), and none on the ultimate
 * either (F is quoted per cast — check it against Freud's 1140 and Piaget's 167/52/185, which fall out
 * of the same arithmetic). Cast rates are the sheet's: S1 7.5/min · S2 5/min ·
 * S3 2.4/min · S4 1/min · S5 24.1/min.
 *
 * ⚠️ The per-cast numbers are NOT the ones doc 08 §4.2 published for Piaget
 * (35 basic, 144 on S1). Since 2026-08-04 Pavlov has no beat cycle, so every
 * slot derives at beat factor 1.0 rather than 1.2/1.1 and each base is
 * correspondingly higher. The SLOT TOTALS still match the row exactly — which
 * is what the boss HP curve is built from — and two tanks on one contract row
 * still agree about how much budget there is, only not about how it is cut.
 *
 * TWO DELIBERATE DEPARTURES from the published tank row, both flagged in
 * doc 03 §8 and neither of which moves the total:
 *
 *   1. **S2 and S3 swap shares** — E carries the 15% (as a TEAM heal, not the
 *      row's self-heal) and R carries the 5% damage. The row's E+R total is
 *      20% either way, which is the bucket `admin/boss-math`'s optimizer
 *      actually checks (`mix.er`), so nothing drifts. Pavlov's heal is on E
 *      (*Spontaneous Recovery* — a rest period restores the response) and his
 *      utility is on R (*Generalization*); forcing the theory into the row's
 *      slot order would have cost the kit its whole reason for existing.
 *   2. **S1 pays out lumpy** — the slot's 144.08-per-cast budget is spent as
 *      three cheap UCS casts (93) that bank the conditioning, then one CS
 *      (298) that cashes it in. See the palette note. The slot is on budget to
 *      +0.12%; what changes is that it *feels* like a payoff.
 *
 * The boss's HP curve is derived from these budgets, so the same warning
 * `freud.ts` carries applies here: change the sheet and re-export, never this
 * file alone.
 */

/**
 * The conditioning loop — Pavlov's whole skill ceiling, as data.
 *
 * The fight sim reads this; nothing is hardcoded in scene or UI code. Numbers
 * are doc 03 §8's ("Pairing timing — the skill ceiling"), including its one
 * deliberate inaccuracy: strictly, backward conditioning (food, then bell)
 * barely produces learning at all, and we let it work at 20% so the printed
 * beginner order is playable. The accurate order pays double.
 */
export const PAVLOV_CONDITIONING = {
  /** Seconds the boss stays in the visible UCR state after a UCS lands. */
  ucrWindowS: 4,
  /**
   * Pairings needed before the boss shows CONDITIONED and CS lights up —
   * **rolled fresh for every cycle**, uniform over 1..3 inclusive.
   *
   * ★ 2026-08-04: was a flat 3 against a delay pairing worth 2, i.e. always
   * exactly two clean bell→food cycles. Learning that arrives on a schedule is
   * a chore to execute and, worse, it is not what acquisition looks like: the
   * curve is noisy, and one animal takes a trial where another takes several.
   * Now every pairing banks 1 (see `pairing` below) and the target is hidden,
   * so a clean bell→food has a **1-in-3 chance of conditioning outright** and
   * takes at most three. Same skilled-play expectation as before — E[target]
   * is 2, which is what `ceil(3 / 2)` already was — so the loop did not get
   * faster for a player ringing the bell properly, only less predictable.
   *
   * Measured on the live sim (200 runs × 4 min, bell held to overlap the
   * food): 5.06 UCS : 2.44 CS per minute, against 5.00 : 2.50 before. The
   * S1 cadence is written down as that 5.0 : 2.5, and `pavlov.ucs`/`pavlov.cs`
   * below are derived from it — bonded, see the palette note. Ringing on
   * cooldown without aiming for the food came out at 4.20 : 3.30, a hair
   * SLOWER than the 4.00 : 3.50 it used to be, because the masher's stray
   * simultaneous pairings are worth 1 now instead of racing a delay worth 2.
   *
   * ⚠️ No distribution with a 1-in-3 chance at one pairing can average 3 (the
   * ceiling is 1/3·1 + 2/3·3 = 2.33), so this trade is structural, not a knob:
   * you cannot have the first pairing sometimes land AND keep the old rate.
   */
  pairingsToCondition: { min: 1, max: 3 },
  /** Seconds the CONDITIONED state holds before it decays back to nothing. */
  conditionedWindowS: 20,
  /**
   * What a bell (an NS basic) is worth, by WHEN it rang relative to the food.
   * `chance` is the probability the pairing takes at all; `pairings` is what it
   * banks when it does.
   *
   * ★ Every tier banks 1 since the target went random: with a 1..3 roll, one
   * pairing IS the unit the roll counts, and a delay worth 2 would have made
   * the first bell→food a 2-in-3 outright condition instead of the 1-in-3 the
   * design calls for. The accurate order still pays — it pays in CERTAINTY
   * (chance 1.0 against 0.6 and 0.2), which is the same lesson in the currency
   * the roll now uses.
   */
  pairing: {
    /** NS first, still ringing when the UCS lands. The real thing. */
    delay: { chance: 1.0, pairings: 1 },
    /** NS rung inside the boss's UCR window. */
    simultaneous: { chance: 0.6, pairings: 1 },
    /** NS rung within `backwardGraceS` of the UCR fading. Barely conditioning. */
    backward: { chance: 0.2, pairings: 1 },
  },
  /**
   * Seconds after the UCR window fades in which a bell still rolls a BACKWARD
   * pairing. Bells later than this pair NOTHING.
   *
   * Without the bound, "after the UCR faded" is every bell for the rest of the
   * fight: 24.1 NS/min × 0.2 = ~4.8 pairings/min banked with no food ever
   * presented — ~1.6 free CS/min against an S1 budget of 1.875 total. Backward
   * conditioning means "food, then bell", not "bell, eventually".
   */
  backwardGraceS: 3,
  /**
   * The Conditioned Response debuff CS leaves behind: a bell that provokes the
   * flinch staggers the boss's next cast by this long.
   *
   * Doc 03 also gave that flinch bonus damage. Dropped: the S1 share is fully
   * spent on UCS + CS above, and free damage riding a basic is exactly how
   * kits drift off contract. The stagger is utility and costs no budget.
   */
  crStaggerS: 0.75,
  /**
   * How many bells it takes to provoke one flinch, once CR is up.
   *
   * ★ 3 because the trigger USED to be "the bell landed on the ×1.5
   * Anticipation beat" — one beat in three. The bell went flat
   * (`PAVLOV.basic.ignoresBeats`) and took that gate with it, so the rate is
   * restated here as what it always effectively was. Deterministic, not a
   * roll: a player who can count to three can plan around the flinch, and an
   * educational game should not hide a teachable rhythm behind RNG.
   *
   * ⚠️ Bonded to `crStaggerS` and to the basic's 2 s cooldown. At every 3rd
   * bell and 2 s a cast, this is 0.75 s of stagger per 6 s ≈ 12.5% off the
   * boss's cast rate — exactly the old number. Drop it to 1 and it triples.
   */
  crStaggerEveryNthBell: 3,
  /** Pairings *Spontaneous Recovery* hands back after the response is gone. */
  spontaneousRecoveryPairings: 1,
} as const;

export const PAVLOV: Hero = {
  id: "pavlov",
  displayName: "Pavlov — The Conditioner",
  theory: "Classical conditioning; UCS/UCR, NS→CS, CR; extinction and spontaneous recovery",
  role: "tank",
  kit: "chain",
  // The loop above, where the sim can find it (Hero.conditioning).
  conditioning: PAVLOV_CONDITIONING,
  // Role WEIGHT (doc 08 §3: tank 65), not the basic attack's damage — that is
  // `basic.base` below, and the two differ by 86% exactly as they do for Freud.
  baseDamage: 65,
  // ★ NO BEAT CYCLE (2026-08-04). Doc 03 gave him Orienting ×0.8 → Arousal
  // ×1.0 → Anticipation ×1.5 — "the reflex arc winding up" — on a clock that
  // multiplied every cast. It is gone, and `Hero.beats` is optional for it.
  //
  // It was never his. The cycle is FREUD's theory made playable: Id/Ego/
  // Superego is a stance you read and time a cast into, and cycle manipulation
  // is his stated identity (doc 02). Pavlov inherited three renamed beats that
  // did the same arithmetic and taught nothing — worse, they taught the
  // opposite of the kit. Classical conditioning is about a stimulus meaning
  // the SAME thing every time; a bell worth ×0.8 now and ×1.5 in three seconds
  // is the one lesson this hero must not give. And the timing that matters
  // here already exists and is far better: the bell against the FOOD, not the
  // bell against a metronome (`PAVLOV_CONDITIONING`).
  //
  // ⚠️ Every base below is therefore derived at beat factor 1.0 instead of 1.2
  // (skills) and 1.1 (basic). That is why they are ~20% and ~10% higher than
  // the figures doc 08 §4.2 published for Piaget: same share of the same
  // budget, spread over casts that no longer average a multiplier above 1.
  // The slot TOTALS are unchanged, which is what the boss HP curve is built
  // from — see tools/sim-check.mjs scenario 4.
  /**
   * S5 · NS — the bell. 25% share ÷ (24.1 casts/min × 1.0) = 38.43 → 38.
   *
   * It comes out tiny, which is the single luckiest thing about this kit: a
   * neutral stimulus is *supposed* to mean nothing yet. The number teaches the
   * definition. What it does instead of damage is bank Pairings when it lands
   * in the boss's UCR window — see `PAVLOV_CONDITIONING`.
   *
   * ★ 35 → 38 when the beat cycle went (see the note on `beats`): losing the
   * cycle loses its 1.1 average, so the slot re-derives at factor 1.0 to pay
   * the same 25% share. Bonded pair — never move one without the other.
   *
   * ★ The 2 s cooldown is a PAIRING CAP, not a feel choice (2026-08-03; was
   * Freud's 600 ms). The budget's 3:1 UCS:CS cadence assumes ~1 pairing per
   * UCS, but at 600 ms up to 7 bells fit one 4 s UCR window — ~3.6 expected
   * pairings per UCS, CONDITIONED off every cast, a 1:1 cadence that pays the
   * S1 slot +36% and mints 11 Marks/min, all by mashing the button he'd mash
   * anyway. At 2 s at most 2 bells fit (~1.2 expected), so mashing lands on
   * the cadence the budget priced, and WHEN you ring — holding the bell so it
   * overlaps the food, the delay pairing — is the whole skill ceiling. 2 s and
   * not 2.49 s (the budgeted rate) so a real rotation keeps ~24% slack to
   * deliver this slot's 24.1/min share.
   */
  basic: {
    id: "pavlov.ns",
    name: "NS — Neutral Stimulus",
    base: 38,
    cooldownMs: 2_000,
    focusCost: 0,
    effects: [{ kind: "pairing.bank", target: "boss" }],
  },
  /**
   * S1 · the conditioning chain, spent across two entries on ONE button.
   *
   * Slot budget: 35% share ÷ (7.5 casts/min × 1.0) = 172.9 per cast, i.e.
   * 1296.75 per minute across 7.5 casts (no beat factor — see `beats`).
   *
   * ★ 2026-08-04 (was 111/359): `pairingsToCondition` became a 1..3 roll
   * averaging 2, so an expected TWO UCS arm one CS and the 7.5 casts run 5.0
   * UCS + 2.5 CS. Solving 5·U + 2.5·C = 1296.75 near the same C = 3.2·U shape
   * gives 13·U = 1296.75 → U = 99.75 → **100**, and C = (1296.75 − 500) ÷ 2.5
   * = 318.7 → **319**. The slot re-multiplies to 1297.5/min, 0.06% over.
   *
   * ⚠️ THE 3:1 CADENCE THIS SLOT USED TO CLAIM WAS NEVER REAL. "Three UCS arm
   * one CS" divides the old fixed target of 3 by one pairing per UCS — but a
   * delay pairing banked TWO, so a player ringing the bell properly always
   * conditioned on the second UCS. Driven through the live sim on that
   * rotation the old numbers measured 5.00 UCS : 2.50 CS, i.e. 2:1, and the
   * 111/359 pair priced for 3:1 therefore paid the slot **1453/min against a
   * 1296.75 budget — +12%** (a bell-masher, banking simultaneous pairings on
   * top, reached +31%). The re-derivation above is what closes that: the same
   * rotation now measures 1285/min, −0.9%. So this edit did not spend budget
   * on the random target; it stopped over-spending. The masher is still +14%,
   * which is the documented ~1.2-pairings-per-UCS slack and a separate fix.
   *
   * ⚠️ `base` on these two is BONDED to the 2:1 cadence, to
   * `PAVLOV_CONDITIONING.pairingsToCondition`, and to the NS cooldown above —
   * the cooldown is what holds pairings-per-UCS near 1. Make CS easier to
   * reach and its share of the 7.5 casts rises, which puts the slot over
   * budget without a single number visibly changing. Move them together in
   * the sheet, or move none of them. `tools/sim-check.mjs` scenario 4 carries
   * the cadence as `CONTRACT.csCadence` and is the check that catches it.
   *
   * ⚠️ Marks come from CS ONLY, never from UCS. A Mark is +6% damage taken for
   * the WHOLE team, so Mark rate is a team-wide damage lever and not this
   * hero's to spend freely. The faster cadence raised it: 2.5 CS/min × 3 =
   * **7.5 Marks/min**, up from 5.6, which is no longer under a palette DPS's
   * 7.5/min but level with it. Left at 3 deliberately — `mark.grant` is bonded
   * to the ultimate's `perMark`/`maxMarksConsumed` derivation, so cutting it to
   * hold the old rate is a separate, sheet-side decision. It also happens to be
   * the theory — the neutral stimulus teaches nothing; the conditioned response
   * is the learning.
   *
   * The slot also carries the kit's only TIMING reward — 5 Focus per pairing
   * that lands, on the UCS entry's `pairing.focus` (see the note there). It
   * moves no damage: Focus is off-contract, and a missed window pays nothing.
   *
   * No `answersAxis`/`answersTag` on either: chain kits do not diagnose the
   * boss (doc 02), so there is nothing here to be wrong about. That is what
   * makes this the hero a first-timer can clear a fight with.
   */
  palette: [
    {
      id: "pavlov.ucs",
      name: "UCS — Unconditioned Stimulus",
      base: 100,
      markType: "conditioning",
      effects: [
        // The boss lurches and salivates: a bright unmissable tell, and the
        // window an NS basic has to pair into. Re-casting refreshes, never stacks.
        { kind: "ucr.window", durationMs: 4_000, target: "boss" },
        // Tank S1 rider, doc 08 §2: 10% team mitigation for 4 s on every cast.
        { kind: "mitigation.grant", magnitude: 0.1, durationMs: 4_000, target: "team" },
        // THE PAIRING REWARD (2026-08-04). Every pairing that actually TAKES
        // hands the caster 5 Focus. It lives on S1 rather than on the bell
        // because the bell is only half of a pairing — the food is what makes
        // the ring mean anything, and a player who never presses this button
        // can never earn a point of it. Miss the window (or ring while the
        // boss is already CONDITIONED, when there is nothing left to learn)
        // and the pairing does not happen, so neither does the Focus.
        //
        // ⚠️ Per pairing EVENT, not per Pairing banked — the delay pairing
        // banks 2 and still pays 5, or the accurate order would earn double
        // twice over (double Pairings AND double Focus) and the beginner order
        // would stop being playable.
        //
        // The economy: banking stops dead while CONDITIONED, so pairing events
        // cannot outrun 3 × the CS rate = 5.6/min ≈ 28 Focus/min against a
        // 120/min pool regen — ~23%, real but not a second resource bar. It
        // costs the DAMAGE budget nothing: Focus is not on the contract, and
        // every slot's share is still spent at the cast rates above.
        { kind: "pairing.focus", magnitude: 5, target: "self" },
      ],
    },
    {
      id: "pavlov.cs",
      name: "CS — Conditioned Stimulus",
      base: 319,
      markType: "conditioning",
      // Greyed out until his own loop puts the boss into CONDITIONED, and it
      // takes over the BELL rather than eating a sixth key (2026-08-08; was
      // the UCS button). NS → CS is the theory drawn on a button: the bell
      // the player has been ringing all fight is the thing that becomes the
      // conditioned stimulus — the food never changes, the signal does. It
      // also keeps UCS pressable while CONDITIONED, so refreshing the UCR
      // window no longer costs access to the payoff.
      requiresBossState: "conditioned",
      transformsFrom: "pavlov.ns",
      effects: [
        { kind: "mark.grant", magnitude: 3, target: "boss" },
        { kind: "conditioned.consume", target: "boss" },
        // The CR debuff: Anticipation-beat basics stagger the boss from here on.
        { kind: "conditioned-response.stagger", magnitude: 0.75, target: "boss" },
      ],
    },
  ],
  /**
   * S2 · *Spontaneous Recovery* — 15% share as HEALING (see departure 1).
   *
   * 15% ÷ (5 casts/min × 1.0) = 111.15 → 111, delivered as a TEAM total (≈37 each
   * in a 3-stack), plus the tank row's 25% team mitigation for 6 s. That pair
   * is doc 08's whole tank-E job — "the team feels his mitigation instead of
   * only him" — and the heal is small on purpose: you asked for a small amount,
   * and 15% of a tank's budget is what small costs.
   *
   * The third rider is the one that makes it Pavlov's: after the response has
   * been extinguished, a rest period brings it back at one free Pairing. It is
   * also his only way back in after F wipes his own conditioning, which is what
   * stops *Extinction* from being a button he presses and then stands around.
   * The `requiresSelfState` gate is that sentence as DATA: ungated, this is
   * 5 free pairings/min from a button he was already pressing — the S1 slot's
   * CS rate climbs 1.875 → 3.125/min and pays +24% over budget.
   */
  defense: {
    id: "pavlov.spontaneous-recovery",
    name: "Spontaneous Recovery",
    base: 0,
    heal: 111,
    healTarget: "team",
    mitigation: { magnitude: 0.25, durationMs: 6_000, target: "team" },
    cooldownMs: 12_000,
    focusCost: 20,
    effects: [
      {
        kind: "pairing.refund",
        magnitude: 1,
        target: "self",
        // Live only after Extinction wiped him (his own F's `conditioning.reset`
        // sets the state) — see the comment above for what ungating it costs.
        requiresSelfState: "extinguished",
      },
    ],
  },
  /**
   * S3 · *Generalization* — 5% share ÷ (2.4 casts/min × 1.0) = 77.19 → 77.
   *
   * A flying clock: similar stimuli, same response. It pulls the boss's
   * attention (8 s taunt) and leaves the boss taking **+15% damage for 15 s**.
   *
   * ★ The 15 s is not a taste call. `admin/boss-math` already ASSUMES a team
   * attack buff of +15% at 60% coverage (`buffs.attack`, effective ×1.09) and
   * has no hero sourcing it — the boss's HP curve is tuned as if someone
   * brings it. 15 s on a 25 s cooldown is a 0.60 duty cycle exactly, so this
   * skill *becomes* that assumption rather than stacking on top of it. Change
   * the duration or the cooldown and the sheet's coverage figure has to move
   * with it, or the boss quietly gets easier.
   *
   * The vulnerability is a BOSS-side damage-taken multiplier (the same term
   * P3 Fortress armor uses), not team Amp — Amp is capped at 0.50 and shared,
   * and spending a debuff out of that pool would make two Pavlovs pointless.
   */
  chain: {
    id: "pavlov.generalization",
    name: "Generalization",
    base: 77,
    // Similar stimuli, same response: the clock's ring reaches everything near the target.
    aoeRadius: 6,
    cooldownMs: 25_000,
    focusCost: 30,
    effects: [
      { kind: "summon.clock", target: "boss" },
      { kind: "taunt", durationMs: 8_000, target: "boss" },
      { kind: "vulnerability", magnitude: 0.15, durationMs: 15_000, target: "boss" },
    ],
  },
  /**
   * S4 · *Extinction* — 20% share = 741 per cast at 1/min, split by the tank's
   * ultimate currency (doc 08 §2.1: 75% damage / 25% team heal), then the
   * damage half split 30% direct / 70% Mark payload:
   *   direct  = 741 × 0.75 × 0.30 = 166.7 → 167
   *   perMark = 741 × 0.75 × 0.70 ÷ (6 Marks × 1.25 foreign-mix) = 51.9 → 52
   *   heal    = 741 × 0.25 = 185.25 → 185, team
   *
   * ⚠️ `perMark` is BONDED to `maxMarksConsumed`, exactly as it is on Freud.
   *
   * THE DOME. Ringing the bell with no food does not hurt the boss — it
   * *unlearns* it. So the dome is a boss-side OUTGOING cut, not player-side
   * mitigation: everything inside takes 60% less from the boss, and the 0.40
   * mitigation cap (doc 08 §1.1) is untouched, which is the only reason a 60%
   * number is sayable at all. It stacks cleanly with Piaget's 35% because they
   * are different terms in different places, and two Pavlovs cannot chain it
   * into invulnerability the way two cap-eating shields would.
   *
   * THE COST. Presenting the CS without the UCS is what extinction *is*, so
   * casting this wipes his own conditioning: Pairings gone, CONDITIONED gone,
   * CS dark until he rebuilds or presses E. Doc 03 §8 bolted an anti-spam
   * counter onto CS to get this effect; here the theory pays for itself.
   */
  ultimate: {
    id: "pavlov.extinction",
    name: "Extinction",
    base: 167,
    heal: 185,
    healTarget: "team",
    zoneRadius: 7,
    cooldownMs: 60_000,
    focusCost: 50,
    perMark: 52,
    foreignMarkBonus: 0.5,
    maxMarksConsumed: 6, // doc 07 #p-3 cap, mirrored in shared/types.ts
    effects: [
      { kind: "zone.extinction", magnitude: 0.6, durationMs: 10_000, target: "team" },
      // Wipes Pairings + CONDITIONED and leaves him "extinguished" — the
      // self-state *Spontaneous Recovery*'s refund is gated on, cleared the
      // next time he reaches CONDITIONED.
      { kind: "conditioning.reset", target: "self" },
    ],
  },
  /**
   * *Discrimination* — the passive you have to switch on.
   *
   * ×6 threat while held, 1× while not. It replaces the blanket `THREAT.tank`
   * 5× that used to apply to anyone whose data said "tank" (see
   * shared/combat.ts): 6× is a literal +500% over the 1× base, and being above
   * the old 5× is deliberate — a player tank should be able to take aggro off
   * an AI one.
   *
   * Discrimination is the half of the theory everyone forgets: the dog learns
   * to respond to THIS bell and not that one. Toggling it off to drop aggro on
   * purpose is the skill expression, and it is only possible because the
   * multiplier is no longer welded to the role.
   */
  threatStance: {
    id: "pavlov.discrimination",
    name: "Discrimination",
    multiplier: 6,
    toggle: true,
  },
  // Classical conditioning is live, replicated, contemporary science — the
  // contrast case to Freud's "historical" (doc 07 #c-1).
  evidenceStatus: "contemporary",
};
