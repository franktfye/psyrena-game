import type { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { isMemoryConstrainedDevice } from "./engine";

/**
 * Device quality tiers — the one place scenes and VFX ask "can this device
 * afford that?" (CLAUDE.md rule 4).
 *
 *   high    desktop recipe: 4x MSAA, half-res glow, full post stack.
 *   medium  what memory-constrained phones have always had (MSAA off,
 *           quarter-res glow) plus quarter-res buffers for the per-hero VFX
 *           glow layers, which used to escape the phone trims entirely.
 *   low     frame rate first: no glow layers, no bloom, grain or chromatic
 *           aberration. Tone mapping, exposure and vignette stay — they are
 *           the grade, and they cost nothing extra (no pipeline → the
 *           materials apply image processing themselves).
 *
 * The backbuffer is already CSS-pixel sized on phones (core/engine.ts,
 * adaptToDeviceRatio=false), so resolution is not a lever here; the per-pass
 * cost of the post stack and glow layers is — each is at least one full-screen
 * read+write, which is what a tiled mobile GPU is worst at.
 *
 * Tier order of precedence:
 *   1. `?quality=low|medium|high`        one boot, for testing
 *   2. localStorage `psyrena.quality`    the player's explicit choice
 *   3. an adaptive step-down recorded by `noteFrame` (expires, see below)
 *   4. device detection
 *
 * The tier is read when a scene BUILDS. An adaptive step-down therefore takes
 * effect at the next scene switch, not mid-frame: scenes own their pipelines,
 * and tearing one down live is exactly the kind of allocation churn that gets
 * an iPhone's GL context killed.
 */
export type QualityTier = "low" | "medium" | "high";

const TIERS: readonly QualityTier[] = ["low", "medium", "high"];
const USER_KEY = "psyrena.quality";
const AUTO_KEY = "psyrena.quality.auto";
/** An adaptive step-down is forgotten after this long — one bad session (a
 *  hot phone, a background download) must not pin a device to low forever. */
const AUTO_TTL_MS = 3 * 24 * 3600 * 1000;

function isTier(v: unknown): v is QualityTier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Safari private mode
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* Safari private mode */
  }
}

/**
 * Phones get a mobile GPU however much RAM they report. A Pixel 8 says
 * deviceMemory=8, which `isMemoryConstrainedDevice` (a memory test, rightly)
 * passes — and which used to hand it the desktop recipe, 4x MSAA included.
 * Android tablets omit "Mobile" from the UA and iPads report a Mac UA; both
 * fall through to the memory test, which matches their hardware better.
 */
function isPhone(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua));
}

function detectTier(): QualityTier {
  const dm = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof dm === "number" && dm <= 2) return "low";
  return isPhone() || isMemoryConstrainedDevice() ? "medium" : "high";
}

function autoTier(): QualityTier | null {
  const raw = storageGet(AUTO_KEY);
  if (!raw) return null;
  const [tier, at] = raw.split("@");
  if (!isTier(tier) || !(Date.now() - Number(at) < AUTO_TTL_MS)) {
    storageSet(AUTO_KEY, null);
    return null;
  }
  return tier;
}

/** The tier a scene built right now should use. */
export function qualityTier(): QualityTier {
  const forced = new URLSearchParams(location.search).get("quality");
  if (isTier(forced)) return forced;
  const user = storageGet(USER_KEY);
  if (isTier(user)) return user;
  const detected = detectTier();
  const auto = autoTier();
  // Adaptive only ever lowers the detected tier.
  return auto && TIERS.indexOf(auto) < TIERS.indexOf(detected) ? auto : detected;
}

/** Persist the player's explicit choice; `null` returns to automatic. */
export function setQualityTier(tier: QualityTier | null): void {
  storageSet(USER_KEY, tier);
  if (tier) storageSet(AUTO_KEY, null);
}

export interface GlowOptions {
  mainTextureRatio?: number;
  blurKernelSize: number;
}

/** Options for a scene's main GlowLayer, or null to not create one. */
export function sceneGlowOptions(): GlowOptions | null {
  switch (qualityTier()) {
    case "high": return { blurKernelSize: 48 };
    case "medium": return { blurKernelSize: 32, mainTextureRatio: 0.25 };
    case "low": return null;
  }
}

/**
 * Options for a hero VFX GlowLayer (the includedOnly ult/heal layers), or null
 * to skip it — the meshes keep their emissive colour, they just don't bloom.
 */
export function vfxGlowOptions(): GlowOptions | null {
  switch (qualityTier()) {
    case "high": return { blurKernelSize: 32 };
    case "medium": return { blurKernelSize: 16, mainTextureRatio: 0.25 };
    case "low": return null;
  }
}

/** MSAA sample count for a scene's DefaultRenderingPipeline. */
export function msaaSamples(): number {
  return qualityTier() === "high" ? 4 : 1;
}

/**
 * Trim a fully configured pipeline to the tier. Call LAST, after the scene has
 * set its art-directed values, so each scene keeps one recipe and the tier
 * only ever subtracts from it.
 */
export function applyPipelineQuality(pipeline: DefaultRenderingPipeline): void {
  pipeline.samples = msaaSamples();
  if (qualityTier() !== "low") return;
  pipeline.bloomEnabled = false;
  pipeline.grainEnabled = false;
  pipeline.chromaticAberrationEnabled = false;
}

// ---- Adaptive step-down --------------------------------------------------

/** Ignore the first seconds of a scene: shader compiles and texture uploads. */
const WARMUP_S = 6;
/** Judge over this window... */
const WINDOW_S = 8;
/** ...and step down if the average frame rate stays below this. */
const MIN_FPS = 40;

let sceneTime = 0;
let windowTime = 0;
let windowFrames = 0;
let slowStreak = 0;
let steppedThisSession = false;

/** Reset the warm-up clock; call after every scene switch. */
export function resetFrameMonitor(): void {
  sceneTime = 0;
  slowStreak = 0;
  windowTime = 0;
  windowFrames = 0;
}

/**
 * Feed one frame's delta (seconds) from the render loop. When a full window
 * averages under MIN_FPS, record one tier lower for the next scene build.
 * At most one step per session, so a device is never thrown from high to low
 * by a single stutter-y boot. Returns the tier stepped down to, if any.
 */
export function noteFrame(dt: number): QualityTier | null {
  if (steppedThisSession || document.hidden || dt <= 0) return null;
  // One long frame is a stall (GC, an alert, a late shader compile) and says
  // nothing about the GPU, so it is dropped rather than allowed to sink the
  // average. Several in a row are not a stall — that is the device's speed,
  // and filtering them would mean the slowest devices are never judged.
  if (dt > 0.25) {
    slowStreak++;
    if (slowStreak < 3) return null;
  } else {
    slowStreak = 0;
  }
  sceneTime += dt;
  if (sceneTime < WARMUP_S) return null;
  windowTime += dt;
  windowFrames++;
  if (windowTime < WINDOW_S) return null;
  const fps = windowFrames / windowTime;
  windowTime = 0;
  windowFrames = 0;
  if (fps >= MIN_FPS) return null;
  // An explicit choice (URL or stored) is the player's call, not ours.
  if (isTier(new URLSearchParams(location.search).get("quality")) || isTier(storageGet(USER_KEY))) return null;
  const current = qualityTier();
  if (current === "low") return null;
  const lower = TIERS[TIERS.indexOf(current) - 1];
  storageSet(AUTO_KEY, `${lower}@${Date.now()}`);
  steppedThisSession = true;
  console.info(`[quality] ${fps.toFixed(0)} fps sustained on ${current}; next scene builds at ${lower}`);
  return lower;
}
