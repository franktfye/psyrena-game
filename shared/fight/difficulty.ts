/**
 * Difficulty multipliers — shared, because the server now builds the fight.
 *
 * Only the DATA lives here. Which difficulty a player picked, and the
 * localStorage that carries it from the rooms panel to the arena, stay in
 * src/fight/difficulty.ts: that is a client preference. What the boss's HP and
 * outgoing get multiplied by is a rule, and rules belong where both sides can
 * read them.
 */

export type FightDifficulty = "standard" | "hard" | "nightmare";

export interface DifficultySpec {
  label: string;
  /** Boss max HP multiplier (hard ×1.5, nightmare ×2.2). */
  hpMult: number;
  /** Boss outgoing damage multiplier. */
  dmgMult: number;
}

export const DIFFICULTY: Record<FightDifficulty, DifficultySpec> = {
  standard: { label: "Standard", hpMult: 1, dmgMult: 1 },
  hard: { label: "Hard", hpMult: 1.5, dmgMult: 1.5 },
  nightmare: { label: "Nightmare", hpMult: 2.2, dmgMult: 2.2 },
};

export const DIFFICULTY_ORDER: FightDifficulty[] = ["standard", "hard", "nightmare"];
