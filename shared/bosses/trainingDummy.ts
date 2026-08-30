/**
 * TRAINING DUMMY — the practice pit's target, as a fight script.
 *
 * WHY THIS EXISTS
 * ---------------
 * The pit used to price a cast by hand: `resolveHit` with `marks: 0, amp: 0`
 * and nothing else, which meant every rider a kit carries — mitigation, Marks,
 * taunt, vulnerability, the UCR window, CONDITIONED, the Extinction dome,
 * wound stacks — did nothing at all. A player could press every button in
 * Pavlov's kit in the pit and never once see the loop the kit is ABOUT, then
 * meet all of it for the first time in a boss fight.
 *
 * So the pit now runs the real sim (`src/fight/bossFight.ts`) against this
 * script instead of a private damage formula. Every hero gets their buffs and
 * debuffs in practice because there is no longer a second implementation to
 * keep in sync — there is one, and this is the target it hits.
 *
 * WHAT A DUMMY IS, IN SCRIPT TERMS
 * --------------------------------
 * A boss that never fights back and never dies:
 *
 *  - `outgoing: null` on every phase — nothing swings at the player, so the
 *    threat table, mitigation and the dome all still COMPUTE (and still show
 *    their buff tiles) without the pit becoming a fight you can lose.
 *  - All four phases identical, so `tick`'s unconditional phase walk has
 *    nothing to announce and no armor/regen step changes the numbers underfoot.
 *    The pit quotes the reference corner, and it must keep quoting it.
 *  - No `skillCheck`, so `p2Stage` is never set and the palette can never
 *    Fixate. A practice range that punished a wrong answer would stop being
 *    one — and doc 02's answer mechanic is a boss's phase, not a hero's kit.
 *  - HP absurd and `enrageCycles` absurd, because `inCombat` gates every cast
 *    on `hp > 0 && !over`: a dummy that reached 0 would make the pit inert.
 *    At 1e9 HP a 100-DPS hero needs ~115 days, so "immortal" is honest here.
 *
 * ⚠️ `heroHp` is quoted from NIGHTMARE_STANDARD deliberately. It is what the
 * healing numbers in the pit are a fraction OF, so a heal that reads "a third
 * of a health bar" here must read the same in the fight.
 */

import type { BossFightScript, FightPhase } from "./nightmare";

/** One inert phase, repeated four times — see the note on identical phases. */
const INERT: Omit<FightPhase, "id" | "name"> = {
  durationS: 3_600,
  dmgTakenMult: 1, // the reference corner: no armor, no shred
  regenPctPerS: 0, // a dummy that healed would make the meter lie
  outgoing: null, // never swings
};

export const TRAINING_DUMMY: BossFightScript = {
  bossId: "training-dummy",
  displayName: "Practice Dummy",
  tier: 1,
  difficulty: "standard",
  enrageCycles: 1_000_000,
  idleS: 0, // engaged the moment the player walks in; the pit has no pull
  hpByTeamSize: { 1: 1e9, 2: 1e9, 3: 1e9, 4: 1e9, 5: 1e9 },
  phases: [
    { id: "p1", name: "Practice", ...INERT },
    { id: "p2", name: "Practice", ...INERT },
    { id: "p3", name: "Practice", ...INERT },
    { id: "p4", name: "Practice", ...INERT },
  ],
  // Never reachable (no `skillCheck` means no P2 stage, so no wound stacks),
  // but the field is required and a zeroed one is the honest way to say so.
  p2Debuff: {
    dotPctMaxHpPerStackPerS: 0,
    durationMs: 0,
    maxStacks: 0,
    bypassesArmor: false,
    ticksOnlyWhileArmored: false,
    armorShredPerStack: 0,
  },
  heroHp: 1_000,
  phaseWarningS: 0,
};
