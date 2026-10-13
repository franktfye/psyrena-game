/**
 * Psyrena service worker — repeat boots without the network.
 *
 * Registered by src/core/offlineCache.ts in production builds only. It handles
 * exactly two kinds of request and lets everything else through untouched:
 *
 *  1. Vite's content-hashed chunks (the list in /immutable-assets.json):
 *     cache-first, forever. Their bytes cannot change under the same name.
 *  2. 3D payloads from public/ (GLB, KTX2, HDR/ENV, wasm transcoders, images):
 *     stale-while-revalidate. Served from cache instantly, refreshed in the
 *     background (usually a 304), so a re-exported model reaches a player on
 *     their next boot.
 *
 * Deliberately NOT handled: navigations (the shell must come from the network
 * so a deploy is picked up — it is tiny and served no-cache with an ETag),
 * /api/*, Range requests, and audio/video. Safari's media pipeline probes
 * with Range and is notoriously fragile behind a service worker, and the OST
 * is the biggest thing on disk.
 *
 * Kill switch: load any page with ?nosw — offlineCache.ts unregisters this
 * worker and deletes its caches. To retire it for everyone, replace this file
 * with one whose activate handler calls self.registration.unregister().
 */
const VERSION = "v1";
const IMMUTABLE = `psy-immutable-${VERSION}`;
const RUNTIME = `psy-runtime-${VERSION}`;
const RUNTIME_EXT = /\.(glb|gltf|bin|ktx2|hdr|env|wasm|webp|png|jpg)$/i;

/** Pathnames of the current build's hashed files; refreshed per navigation. */
let immutableList = null;
async function loadImmutableList() {
  try {
    const res = await fetch("/immutable-assets.json", { cache: "no-cache" });
    if (res.ok) immutableList = new Set((await res.json()).map((n) => `/${n}`));
  } catch {
    // Offline: keep whatever list we had.
  }
  return immutableList ?? new Set();
}

/** Drop hashed chunks the current build no longer references. */
async function pruneImmutable() {
  const list = await loadImmutableList();
  if (!list.size) return;
  const cache = await caches.open(IMMUTABLE);
  for (const req of await cache.keys()) {
    if (!list.has(new URL(req.url).pathname)) await cache.delete(req);
  }
}

function cacheable(res) {
  return res.ok && res.status === 200 && res.type === "basic";
}

async function cacheFirst(req) {
  const cache = await caches.open(IMMUTABLE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request).then(async (res) => {
    if (cacheable(res)) await cache.put(event.request, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => undefined));
    return hit;
  }
  return refresh;
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("psy-") && key !== IMMUTABLE && key !== RUNTIME) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    event.waitUntil(pruneImmutable());
    return;
  }
  if (url.search) return;
  // Decide synchronously whether to claim the request at all. Hashed chunks
  // sit flat in /assets/ (public/assets/** always has a subdirectory), so
  // anything else that is not a 3D payload goes to the network untouched.
  const flatAsset = /^\/assets\/[^/]+$/.test(url.pathname);
  if (!flatAsset && !RUNTIME_EXT.test(url.pathname)) return;
  event.respondWith(
    (async () => {
      const list = immutableList ?? (await loadImmutableList());
      if (list.has(url.pathname)) return cacheFirst(req);
      if (RUNTIME_EXT.test(url.pathname)) return staleWhileRevalidate(event);
      return fetch(req);
    })()
  );
});
