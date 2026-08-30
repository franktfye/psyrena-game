import type { Scene } from "@babylonjs/core/scene";

import { trackLoad } from "./loadProgress";

/**
 * Force shader compilation before the first frame is shown.
 *
 * Babylon compiles a material's shader on first *use*. With ~100 distinct
 * ability VFX across 14 heroes, the first fight otherwise hitches every single
 * time a hero casts something new — which is exactly when the game is being
 * judged. Warm every material up front, behind the loading screen.
 *
 * The hub needs this as badly as the arena does, for a different reason: it is
 * the first scene a player ever sees, so every un-warmed material is a stutter
 * during the one minute that decides whether they stay.
 *
 * Plan this in M1. Retrofitting warmup into a finished VFX library is painful
 * because by then nothing knows the full material set any more.
 */
export async function warmupShaders(scene: Scene, timeoutMs = 20_000): Promise<void> {
  await Promise.all(
    scene.materials.map(
      (m) =>
        // Each material is one unit on the boot progress bar — shader compile
        // is the back half of "loading" and the bar should keep moving there.
        trackLoad(
          new Promise<void>((resolve) => {
          const owner = scene.meshes.find((mesh) => mesh.material === m) ?? scene.meshes[0];
          if (!owner) return resolve();

          // Both guards below exist because this await sits directly in the
          // boot path: `switchTo` cannot return until every material settles,
          // so a single material that never settles means the loading screen
          // stays up forever with no error anywhere. A warm-up is an
          // OPTIMISATION — never let it be the reason the game fails to open.
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };

          // `forceCompilation` calls onError (not onCompiled) when a shader
          // fails to link, so without this the promise is simply dropped.
          const onError = (reason?: string): void => {
            console.error(`[warmup] ${m.name}: shader compilation failed — ${reason ?? "unknown"}`);
            done();
          };

          // And when a material is merely never READY — a texture 404, a KTX2
          // transcode that fails, a missing public/ktx2/ in a fresh worktree —
          // it re-arms a 16 ms poll indefinitely and neither callback ever
          // fires. Only a timeout breaks that one.
          const timer = setTimeout(() => {
            console.warn(`[warmup] ${m.name}: not ready after ${timeoutMs} ms — continuing without it`);
            done();
          }, timeoutMs);

          m.forceCompilation(owner, done, undefined, onError);
        })
        )
    )
  );
}
