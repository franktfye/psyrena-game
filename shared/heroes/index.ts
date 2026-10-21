import type { Hero } from "../types";
import { FREUD } from "./freud.ts";
import { PAVLOV } from "./pavlov.ts";
import { SKINNER } from "./skinner.ts";
import { ERIKSON } from "./erikson.ts";
import { AINSWORTH } from "./ainsworth.ts";

/**
 * The playable roster — every hero whose kit is authored data, keyed by id.
 *
 * This is the ONLY place a hero id becomes a `Hero` object. Scenes, bars and
 * codex pages resolve `profile.selectedHero` through `heroById` instead of
 * importing FREUD directly, so shipping the next hero is one line here plus
 * their data file (shared/types.ts: "adding a hero is adding DATA, not code").
 * `ROSTER` in src/ui/authFlow.ts lists everyone for the PICKER, including the
 * unshipped; this map is the subset that can actually enter a fight.
 */
export const HEROES: Record<string, Hero> = {
  freud: FREUD,
  pavlov: PAVLOV,
  skinner: SKINNER,
  erikson: ERIKSON,
  ainsworth: AINSWORTH,
};

/**
 * Resolve a hero id to its kit, falling back to Freud — the fallback keeps a
 * stale `selectedHero` (a hero un-shipped after being picked) playable rather
 * than crashing the arena.
 */
export function heroById(id: string | undefined): Hero {
  return (id !== undefined ? HEROES[id] : undefined) ?? FREUD;
}
