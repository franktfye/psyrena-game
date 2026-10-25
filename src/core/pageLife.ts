/**
 * Is the page on its way out?
 *
 * Set by main.ts on `pagehide` (and before its own deliberate navigations),
 * just before it disposes the engine — which disposes every scene, which runs
 * every scene's teardown. Teardown that tells the SERVER "I left" (a boss
 * fight's `/end`, a Dream Siege `/leave`) must not run then: a reload is not a
 * leave, and posting one turned a refresh into giving up the seat mid-fight
 * (and, in combat, a deserter lock). The server's presence grace decides
 * whether the player really left; the tab cannot know.
 */
let unloading = false;

export function markUnloading(): void {
  unloading = true;
}

export function isUnloading(): boolean {
  return unloading;
}
