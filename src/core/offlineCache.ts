/// <reference types="vite/client" />
/**
 * Register public/sw.js, the repeat-boot cache (see that file for what it
 * caches and what it deliberately leaves to the network).
 *
 * Production builds only: under `vite dev` nothing is content-hashed and a
 * cache-first worker would pin stale modules across edits.
 */

function enabled(): boolean {
  return import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext;
}

/**
 * `?nosw` is the field escape hatch, like `?gfx=webgl2` in core/engine.ts: it
 * unregisters the worker and deletes its caches. Called FIRST in main(),
 * before login or any scene — a player whose boot is broken by a bad cache
 * never reaches the post-boot registration, so the cure cannot live there.
 * Returns true when it fired, so the caller can skip registering again.
 */
export async function clearOfflineCacheIfRequested(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !new URLSearchParams(location.search).has("nosw")) return false;
  try {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    for (const key of await caches.keys()) if (key.startsWith("psy-")) await caches.delete(key);
    console.info("[sw] unregistered and caches cleared (?nosw)");
  } catch (err) {
    console.warn("[sw] ?nosw cleanup failed:", err);
  }
  return true;
}

/**
 * Called once the village is up, so registration and the worker's first
 * fetches never compete with the boot for bandwidth.
 */
export async function registerOfflineCache(): Promise<void> {
  if (!enabled() || new URLSearchParams(location.search).has("nosw")) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    // A failed registration costs repeat-boot speed, never the game.
    console.warn("[sw] registration failed:", err);
  }
}
