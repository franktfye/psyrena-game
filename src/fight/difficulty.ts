/**
 * Fight difficulty — chosen in the rooms panel, remembered in localStorage,
 * read by the arena when the fight sim is built, and reported back with the
 * fight result. localStorage is the whole transport: the panel and the arena
 * never meet (a scene switch sits between them), and the choice must survive
 * a reload anyway.
 */

// The multipliers themselves are a RULE, and the server builds the fight now,
// so they live in shared/. What stays here is the client's memory of which one
// the player picked.
export {
  DIFFICULTY,
  DIFFICULTY_ORDER,
  type FightDifficulty,
  type DifficultySpec,
} from "@shared/fight/difficulty";
import type { FightDifficulty } from "@shared/fight/difficulty";

const KEY = "psyrena_difficulty";

export function getDifficulty(): FightDifficulty {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "hard" || v === "nightmare") return v;
  } catch {
    // private mode — fall through to the default
  }
  return "standard";
}

export function setDifficulty(d: FightDifficulty): void {
  try {
    localStorage.setItem(KEY, d);
  } catch {
    // private mode — the choice just won't persist
  }
}
