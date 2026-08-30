/**
 * Client half of the fight-ready barrier (server/app.mjs releaseFightBarrier).
 *
 * Called at the tail of the arena scene factory — after every model import and
 * shader warm-up — so "ready" genuinely means "this player's fight can render
 * its first frame". The boot overlay is still up while this waits, which is
 * the entire UX: the overlay's status line becomes "waiting for teammates…"
 * and the countdown/sim clock (both driven off the scene's render observables)
 * cannot tick until the factory returns.
 *
 * Failure design: every branch falls through to "just start". A party fight
 * that begins a few seconds unsynced is mildly unfair; a loading screen that
 * never ends is a lost player. The server carries a 45 s timeout, this side
 * a 60 s one on top, and any API/stream error skips the wait entirely.
 */

import { postFightReady } from "../net/economy";
import type { FightReadyInfo, FightStartInfo } from "../net/social";

/** The slice of SocialClient this gate borrows (reached via window.psyrena). */
interface SocialLike {
  onFightReady: ((info: FightReadyInfo) => void) | null;
  onFightStart: ((info: FightStartInfo) => void) | null;
}

const CLIENT_TIMEOUT_MS = 60_000;

/**
 * Wait for the party barrier. Resolves to the party's roomId when this player
 * is in a real multi-member party (the arena uses it to join the party's
 * presence session and show teammates), or null for solo runs and every
 * failure path.
 */
export async function awaitPartyFightStart(setStatus: (msg: string) => void): Promise<number | null> {
  const social = (window as unknown as { psyrena?: { social?: SocialLike } }).psyrena?.social;

  let released: (() => void) | null = null;
  const releasedPromise = new Promise<void>((resolve) => {
    released = resolve;
  });
  // Subscribe BEFORE posting ready: a teammate's own POST can complete the
  // barrier in the gap between our POST and our listener, and a missed
  // `fightStart` would leave us idling out the whole client timeout.
  if (social) {
    social.onFightReady = (info) => setStatus(`waiting for teammates… ${info.ready}/${info.total}`);
    social.onFightStart = () => released?.();
  }
  const cleanup = (): void => {
    if (!social) return;
    social.onFightReady = null;
    social.onFightStart = null;
  };

  try {
    const status = await postFightReady();
    if (status.solo) {
      cleanup();
      return null;
    }
    const roomId = status.roomId ?? null;
    if (!social || (status.ready ?? 0) >= (status.total ?? 1)) {
      cleanup();
      return roomId;
    }
    setStatus(`waiting for teammates… ${status.ready ?? 0}/${status.total ?? 0}`);
    const timer = setTimeout(() => released?.(), CLIENT_TIMEOUT_MS);
    await releasedPromise;
    clearTimeout(timer);
    return roomId;
  } catch (err) {
    console.warn("[fight] ready barrier unavailable, starting unsynced:", err);
    return null;
  } finally {
    cleanup();
  }
}
