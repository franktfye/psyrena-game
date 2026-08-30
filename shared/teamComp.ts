/**
 * Team-composition check — the queue's gentle nudge, never a gate.
 *
 * Doc 01's promise is that any party can run anything ("Enter under-strength —
 * the Nightmare will not wait forever"), so this module only *describes* the
 * gap between what a party brought and what a stack of that size usually
 * wants. The rooms panel renders the sentence as a dim hint; nothing anywhere
 * blocks a queue on it.
 *
 * Lives in shared/ (not src/ui) because the recommended template is game
 * data, not presentation — the server matchmaker can read the same table the
 * day it starts packing trios by role instead of FIFO.
 */

import { heroById } from "./heroes/index.ts";
import type { Role } from "./types";

/**
 * Recommended composition by team size. Sizes without a row (solo, duo) have
 * no recommendation and produce no reminder. 5 is forward-looking — rooms cap
 * at 3 today, but the 5-stack template is already agreed (1/1/3).
 */
export const RECOMMENDED_COMP: Record<number, Partial<Record<Role, number>>> = {
  3: { tank: 1, healer: 1, dps: 1 },
  5: { tank: 1, healer: 1, dps: 3 },
};

const ROLE_LABEL: Record<string, string> = {
  tank: "tank",
  healer: "healer",
  dps: "DPS",
  support: "support",
  control: "control",
  flex: "flex",
};

const label = (role: string, n: number): string => {
  const name = ROLE_LABEL[role] ?? role;
  if (n === 1) return name;
  // "DPS" is its own plural; word roles take an s.
  return `${n} ${name === "DPS" ? name : `${name}s`}`;
};

/**
 * One human sentence about the party's role spread, or null when there is
 * nothing worth saying (comp matches, or no template for this size).
 *
 * A PARTIAL party only hears about roles it already has too MANY of — its
 * empty seats might still fill every hole, and nagging a solo host about a
 * missing healer before anyone joined would train players to ignore the hint.
 * A FULL party hears both halves: what is missing and what it is doubled on.
 */
export function compReminder(heroIds: string[], teamSize: number): string | null {
  const want = RECOMMENDED_COMP[teamSize];
  if (!want || heroIds.length === 0) return null;

  const have = new Map<Role, number>();
  for (const id of heroIds) {
    const role = heroById(id).role;
    have.set(role, (have.get(role) ?? 0) + 1);
  }

  const wantText = Object.entries(want)
    .map(([role, n]) => label(role, n))
    .join(" · ");
  const surplus = [...have.entries()]
    .filter(([role, n]) => n > (want[role] ?? 0))
    .map(([role, n]) => label(role, n));
  const missing = Object.entries(want)
    .filter(([role, n]) => (have.get(role as Role) ?? 0) < n)
    .map(([role, n]) => label(role, n - (have.get(role as Role) ?? 0)));

  const full = heroIds.length >= teamSize;
  if (full && missing.length > 0) {
    const surplusNote = surplus.length > 0 ? ` and doubled on ${surplus.join(", ")}` : "";
    return `Comp tip: a ${teamSize}-stack likes ${wantText} — you're short ${missing.join(", ")}${surplusNote}. Works anyway; just saying.`;
  }
  if (!full && surplus.length > 0) {
    return `Comp tip: a ${teamSize}-stack likes ${wantText} — you already have ${surplus.join(", ")}. Works anyway; just saying.`;
  }
  return null;
}
