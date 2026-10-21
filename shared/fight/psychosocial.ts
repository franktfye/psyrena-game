/**
 * Erikson's life-cycle rotation — the whole rule set, as a pure state machine.
 *
 * The player presses `1-2-1-2-…`, with one basic attack after each:
 *
 *   1 Life Stage   casts the CURRENT stage and arms its virtue.
 *   2 Virtue       with a stage armed: the matched pair — full damage, +1
 *                  virtue stack, and the pointer moves to the next stage.
 *                  With nothing armed: a weak hit, no stack, no advance.
 *   LMB            an add-on: ONE basic per Life Stage or Virtue cast. It
 *                  is named after the stage's radius of significant relations.
 *   F Life Review  spends the stacks. The pointer does NOT reset — at the
 *                  reference cadence a player completes ~4 pairs per ultimate
 *                  cooldown, so a reset would hide stages 5–8 from most players,
 *                  and they are the half of the chart a student knows least.
 *
 * After stage 8 the pointer loops to stage 1; stacks stay capped, so a player
 * who never presses F still walks the whole life cycle.
 *
 * Two callers, one rule set: `BossFight` (authoritative, every fight) and the
 * hub's skill bar (cosmetic, the village has no sim) — so the labels a player
 * learns in the village are exactly the ones the fight will show.
 */

import type { PsychosocialSpec } from "../types.ts";

export interface PsychosocialState {
  /** Index into `spec.stages` of the stage key 1 casts next (or has armed). */
  stage: number;
  /** Key 1 was pressed and key 2 has not answered it yet. */
  armed: boolean;
  /** Virtue stacks banked toward Life Review. */
  virtues: number;
  /** One add-on basic is available. */
  addon: boolean;
  /** The stage the pending add-on belongs to — it names the basic. */
  addonStage: number;
}

/** What the bar needs to paint, no more. Same object the hook carries. */
export type PsychosocialHudState = Readonly<PsychosocialState>;

export function psychosocialStart(): PsychosocialState {
  return { stage: 0, armed: false, virtues: 0, addon: false, addonStage: 0 };
}

/** Key 1. Returns the stage index that was cast. */
export function castLifeStage(s: PsychosocialState): number {
  s.armed = true;
  s.addon = true;
  s.addonStage = s.stage;
  return s.stage;
}

/**
 * Key 2. Returns whether it matched (a stage was armed) and which stage it
 * answered — on a match, the one just completed, not the one now up.
 */
export function castVirtue(
  s: PsychosocialState,
  spec: PsychosocialSpec
): { matched: boolean; stage: number } {
  const stage = s.stage;
  s.addon = true;
  s.addonStage = stage;
  if (!s.armed) return { matched: false, stage };
  s.armed = false;
  s.virtues = Math.min(spec.maxVirtues, s.virtues + 1);
  s.stage = (stage + 1) % spec.stages.length;
  return { matched: true, stage };
}

/** LMB. Spends the add-on; false means there is none to spend. */
export function castAddon(s: PsychosocialState): boolean {
  if (!s.addon) return false;
  s.addon = false;
  return true;
}

/** F. Spends every virtue stack; returns how many. */
export function lifeReview(s: PsychosocialState): number {
  const spent = s.virtues;
  s.virtues = 0;
  return spent;
}
