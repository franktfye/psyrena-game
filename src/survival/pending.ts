/**
 * The run the next Old Kowloon scene build should start. Set by the picker
 * (dock button / village portal) or a party launch (server/survival.mjs push)
 * right before `go("kowloon")`; taken once by the scene.
 * `?survival=lucid|deep|terror` does the same for testing (solo).
 */
import type { DifficultyId } from "@shared/survival/content";

export interface PendingRun {
  difficulty: DifficultyId;
  /** Set for a party run: the server session to mirror. */
  party?: { session: number };
}

let pending: PendingRun | null = null;

export function setPendingRun(d: DifficultyId, party?: { session: number }): void {
  pending = { difficulty: d, party };
}

export function takePendingRun(): PendingRun | null {
  const p = pending;
  pending = null;
  if (p) return p;
  const q = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("survival");
  return q === "lucid" || q === "deep" || q === "terror" ? { difficulty: q } : null;
}
