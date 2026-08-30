import { Scene } from "@babylonjs/core/scene";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { estimateTextureBytes } from "./assets";

export type SceneFactory = (engine: AbstractEngine) => Promise<Scene>;

/**
 * Exactly one scene is alive at a time. Ever.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Psyrena's core loop is hub -> arena -> hub, every 10-20 minutes, for a whole
 * session. If a scene transition leaks *anything* — a texture, a material, an
 * observer, a particle system — memory climbs monotonically and the tab dies
 * after roughly two hours. It will not show up in a ten-minute playtest, and it
 * will show up in every stream and every review.
 *
 * So: transitions go through here, and only through here. Never call
 * `new Scene(engine)` in gameplay code.
 */
export class SceneManager {
  private current: Scene | null = null;
  private currentName = "<none>";

  constructor(private readonly engine: AbstractEngine) {}

  get active(): Scene | null {
    return this.current;
  }

  get activeName(): string {
    return this.currentName;
  }

  async switchTo(name: string, factory: SceneFactory): Promise<Scene> {
    this.disposeCurrent();

    const scene = await factory(this.engine);
    this.current = scene;
    this.currentName = name;
    return scene;
  }

  /**
   * Tear down the live scene and drain the engine-level caches.
   *
   * `scene.dispose()` alone is NOT sufficient. Babylon keeps an engine-scoped
   * internal texture cache and a compiled-effect cache that both outlive the
   * scene, which is the single most common source of the slow leak described
   * above. Draining them is the whole point of this method.
   */
  disposeCurrent(): void {
    if (!this.current) return;

    this.current.dispose();
    this.current = null;
    this.currentName = "<none>";

    this.engine.clearInternalTexturesCache();
    this.engine.releaseEffects();
  }

  /** Bytes currently attributable to loaded textures. See assets.ts. */
  textureFootprint(): number {
    return estimateTextureBytes(this.engine).bytes;
  }
}

export interface SoakResult {
  cycles: number;
  baselineBytes: number;
  finalBytes: number;
  driftRatio: number;
  passed: boolean;
}

/**
 * Scene-transition soak test.
 *
 * Run N hub<->arena cycles and assert texture memory returns to baseline. This
 * is cheap to write, runs headless, and catches the leak the day it is
 * introduced instead of two months later. Wire it into CI at M1 — retrofitting
 * a leak hunt into a finished game is miserable.
 *
 * `tolerance` is fractional drift over baseline (0.05 = allow 5%).
 */
export async function soakSceneTransitions(
  manager: SceneManager,
  scenes: Array<{ name: string; factory: SceneFactory }>,
  cycles = 20,
  tolerance = 0.05
): Promise<SoakResult> {
  // Warm up once so one-time engine allocations are not counted as a leak.
  for (const s of scenes) await manager.switchTo(s.name, s.factory);
  const baselineBytes = manager.textureFootprint();

  for (let i = 0; i < cycles; i++) {
    for (const s of scenes) {
      await manager.switchTo(s.name, s.factory);
    }
  }

  const finalBytes = manager.textureFootprint();
  const driftRatio = baselineBytes === 0 ? 0 : (finalBytes - baselineBytes) / baselineBytes;

  return {
    cycles,
    baselineBytes,
    finalBytes,
    driftRatio,
    passed: driftRatio <= tolerance,
  };
}
