/**
 * Practice mode — a solo player plus two bot teammates (shared/bosses/
 * practiceBots.ts). Same transport story as fight/difficulty.ts: the rooms
 * panel and the arena never meet (a scene switch sits between them), so
 * localStorage carries the choice and survives a mid-fight reload.
 *
 * The flag is set by the Practice button and cleared by every normal
 * Enter-Arena path (villageHub's onEnterArena), so a practice run can never
 * leak into a ranked attempt.
 */

import type { FightDifficulty } from "./difficulty";

const KEY = "psyrena_practice";
const DIFF_KEY = "psyrena_practice_difficulty";

export function isPracticeMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false; // private mode — practice just won't survive a reload
  }
}

export function setPracticeMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // private mode — the in-memory flow still works for this page life
  }
}

/**
 * Practice difficulty — its own choice, NOT the ranked picker's. The bots are
 * calibrated to carry a Standard learning run (shared/bosses/practiceBots.ts),
 * so practice defaults to Standard instead of inheriting whatever Hard or
 * Nightmare the ranked selector last persisted — that inheritance is exactly
 * how a first practice run used to wipe at the one-minute mark.
 */
export function getPracticeDifficulty(): FightDifficulty {
  try {
    const v = localStorage.getItem(DIFF_KEY);
    if (v === "hard" || v === "nightmare") return v;
  } catch {
    // private mode — fall through to the default
  }
  return "standard";
}

export function setPracticeDifficulty(d: FightDifficulty): void {
  try {
    localStorage.setItem(DIFF_KEY, d);
  } catch {
    // private mode — the choice just won't persist
  }
}
