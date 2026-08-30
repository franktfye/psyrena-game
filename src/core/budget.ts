/**
 * Psyrena performance budget — the single source of truth.
 *
 * These numbers are mirrored in `06-technical-architecture.md#performance-budget`.
 * If you change one, change both. The perf HUD reads from here, so a budget
 * breach is visible on screen the moment it happens rather than in a bug report
 * two months later.
 *
 * Rationale for the whole file: this is a browser game whose core loop is
 * hub -> arena -> hub every 10-20 minutes for an entire session. Memory that
 * leaks per transition is fatal; memory that is merely large is survivable.
 */

export const BUDGET = {
  /** GPU-resident texture + buffer memory, steady state, desktop. */
  gpuMemoryMB: 400,

  /** JS heap (Chrome `performance.memory.usedJSHeapSize`). */
  jsHeapMB: 250,

  /** Download to first playable frame: engine chunk + hub + starter hero. */
  initialDownloadMB: 30,

  /** Draw calls per frame inside a boss arena at full 5v1 + adds. */
  drawCallsArena: 400,

  /** Rendered triangles per frame inside a boss arena. */
  trianglesArena: 1_500_000,

  /** Simultaneously alive particle systems. VFX is the real frame-rate budget. */
  particleSystems: 40,

  /** Target frame rate. Below this for 2s in a row, the HUD flags it. */
  targetFps: 60,
} as const;

/**
 * Hard spatial limits. The arena is a FIXED size — it is not authored per boss.
 * Every boss reskins the same volume. This is a design constraint, not just a
 * perf one: fixed arenas make the two-team mirrored rooms in `04-bosses.md`
 * nearly free, because both rooms share identical geometry and diverge only on
 * the seeded phase FSM.
 */
export const ARENA = {
  /** Playable floor, metres. Combat needs boss + telegraphs + floor, nothing else. */
  playableExtent: 40,

  /** Fog starts here. Beyond it the world is a gradient, not geometry. */
  fogStart: 25,

  /** Fully fogged. NEVER author geometry past this distance. */
  fogEnd: 60,

  /** Camera far plane. Anything further cannot be seen, so it must not exist. */
  cameraFar: 80,
} as const;

/**
 * Hub caps.
 *
 * NOTE: `01-game-overview.md` currently specifies ~30 players per hub instance.
 * 30 skinned characters wearing unique cosmetics is the single largest memory
 * and draw-call item in the entire game, and it sits in the one place where no
 * gameplay happens. This scaffold targets 12. See
 * `07-open-design-issues.md#p-2-hub-population-cap`.
 */
export const HUB = {
  maxPlayers: 12,
  playableExtent: 60,
  fogEnd: 90,
} as const;

/**
 * Texture authoring rules. This table is the reason the whole 14-hero roster
 * fits in ~60 MB and never needs streaming.
 *
 * A 2048x2048 RGBA8 texture costs ~22 MB resident with mips. The same texture
 * at 1024x1024 transcoded to BC7 costs ~1.4 MB. That factor of ~16 is the
 * difference between shipping and crashing the tab.
 */
export const TEXTURE_RULES = {
  /** Hero albedo/normal/ORM. Three maps per hero at this size = ~4.2 MB. */
  heroMaxSize: 1024,

  /** Arena set dressing. Tiling + trim sheets, not unique unwraps. */
  environmentMaxSize: 2048,

  /** VFX ramps, masks, noise. Small, and shared across every hero. */
  vfxMaxSize: 512,

  /** UI atlas. One atlas for the whole HUD. */
  uiMaxSize: 2048,
} as const;

export type BudgetKey = keyof typeof BUDGET;
