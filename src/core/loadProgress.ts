/**
 * Scene-load progress — a unit counter behind the #boot overlay's bar.
 *
 * Every awaited asset load (glb import, environment texture, shader compile)
 * registers itself as one unit via trackLoad(); the bar shows settled/total.
 * Units register dynamically as a scene factory discovers work, so the total
 * grows while loading — the DOM side (main.ts) clamps the displayed percent
 * to be monotonic per scene so the bar never visibly runs backwards.
 *
 * This is deliberately count-based, not byte-based: the loads funnel through
 * half a dozen wrappers that only know "one asset", and a bar that moves in
 * honest chunks beats a byte-perfect one that needs every call site to thread
 * Content-Length through. resetLoadProgress() runs at the top of every scene
 * switch (main.ts go()).
 */

type ProgressListener = (settled: number, total: number) => void;

let total = 0;
let settled = 0;
let listener: ProgressListener | null = null;

export function onLoadProgress(cb: ProgressListener | null): void {
  listener = cb;
}

export function resetLoadProgress(): void {
  total = 0;
  settled = 0;
  listener?.(0, 0);
}

/**
 * Count one unit of load work; settles (success OR failure — every load here
 * has a fallback, and a failed asset must not wedge the bar) when the promise
 * does. Returns a promise with the original's semantics.
 */
export function trackLoad<T>(p: Promise<T>): Promise<T> {
  total++;
  listener?.(settled, total);
  return p.finally(() => {
    settled++;
    listener?.(settled, total);
  });
}
