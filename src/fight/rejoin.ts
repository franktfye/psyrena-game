/**
 * Coming back to a fight after a reload (GET /api/rejoin, server/app.mjs).
 *
 * The server keeps a boss session and a party Dream Siege running while a tab
 * reloads; this is how the next page finds its way back in. The auth flow asks
 * once after login (`fetchRejoin`); main.ts then routes straight to the arena
 * or to Old Kowloon instead of the village. For the arena, the pending rejoin
 * is set right before `go("arena")` and read by the scene: the fight driver
 * re-attaches to the live session (no fresh-attempt `/end`), and the countdown
 * and the party ready barrier are skipped — the fight is already under way.
 */

export type RejoinInfo =
  | { kind: "boss"; key: string; roomId: number | null; difficulty: string; phase: string }
  | { kind: "survival"; session: number; difficulty: string };

let pendingArena: Extract<RejoinInfo, { kind: "boss" }> | null = null;

/** Set by `enterRejoin` (ui/rejoinScreen.ts) right before `go("arena")`. */
export function setArenaRejoin(info: Extract<RejoinInfo, { kind: "boss" }>): void {
  pendingArena = info;
}

/** The arena scene's read: is this build a rejoin? (Cleared by `clearArenaRejoin` when the scene is up.) */
export function arenaRejoin(): Extract<RejoinInfo, { kind: "boss" }> | null {
  return pendingArena;
}

export function clearArenaRejoin(): void {
  pendingArena = null;
}
