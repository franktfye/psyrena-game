import { Engine } from "@babylonjs/core/Engines/engine";
import type { EngineOptions } from "@babylonjs/core/Engines/thinEngine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

// DynamicTexture's engine methods live in side-effect modules, and there is a
// SEPARATE one per backend. `Engines/engine` drags the WebGL2 copy in for free,
// which is why the fallback path has always worked and hid this; nothing pulls
// the WebGPU copy, so on that backend `engine.createDynamicTexture` is simply
// undefined. Every DynamicTexture in vfx/ and the scenes then throws
// "engine.createDynamicTexture is not a function" during scene construction —
// an uncaught TypeError that main()'s handler turns into a dead "failed: …"
// boot screen. Safari 26 enables WebGPU by default, so a secure-context iPhone
// takes exactly this path and never gets a game.
//
// Import both explicitly. Whichever backend createEngine settles on, the
// methods are there.
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture";

export type Backend = "webgpu" | "webgl2";

export interface EngineHandle {
  engine: AbstractEngine;
  backend: Backend;
  /**
   * The canvas the engine actually renders into.
   *
   * Usually the one that was passed in — but NOT when the WebGPU attempt had
   * to be abandoned, because that path replaces the element (see
   * `freshCanvas`). Callers must bind resize/context-loss handlers to THIS
   * canvas rather than the one they looked up, or they are listening to a
   * detached element.
   */
  canvas: HTMLCanvasElement;
}

/**
 * One-line backend + compressed-texture-caps summary of the engine we actually
 * got. main() appends it to the fatal "failed: …" boot message, because that
 * message is all the diagnostics a phone screenshot carries — Safari on the
 * failing iPhone has no visible console, and the difference between
 * "webgl2 astc=1" and "webgl2 astc=0" is the difference between a memory bug
 * and a texture-inflation bug (no compressed format → every KTX2 decodes to
 * RGBA8 at 4x the resident size, and iOS kills the GL context under the load).
 */
let lastGfxSummary = "no engine yet";
export function gfxSummary(): string {
  return lastGfxSummary;
}

/**
 * True on devices where GPU + tab memory is the scarce resource — in practice
 * phones. iOS is the enforcer here: Safari responds to memory pressure by
 * killing the WebGL context outright, which surfaces as gl.createBuffer()
 * returning null mid-boot ("Unable to create uniform buffer") and a dead black
 * screen. Scenes consult this to shed the pure-luxury allocations (MSAA
 * targets, full-res glow) before that line is reached.
 *
 * Chrome exposes navigator.deviceMemory; Safari never does, so Apple devices
 * are classed by UA — iPhone/iPod are the small-RAM class, while iPads have
 * reported a desktop-Mac UA since iPadOS 13 and therefore (correctly) keep
 * desktop quality.
 */
export function isMemoryConstrainedDevice(): boolean {
  const dm = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof dm === "number") return dm <= 4;
  return /iPhone|iPod/.test(navigator.userAgent);
}

/**
 * Swap in a brand-new canvas element in place of `old`, carrying its
 * attributes (id, class, inline style) and DOM position across.
 *
 * This exists for one reason, and it is the difference between an iPhone
 * booting and not. A canvas element's context type is decided by its FIRST
 * successful `getContext()` and is then permanent: once WebGPU init has
 * claimed `<canvas id="app">`, that element can never hand back a WebGL2
 * context again. Safari does not report this as a clean `null` — it returns a
 * context object that is already lost, which is exactly the field report this
 * was written for:
 *
 *   failed: WebGL context dead on arrival [webgl2 astc=0 … lost=1
 *   maxTex=null secure=1]
 *
 * Read that string back: `secure=1` means the page WAS a secure context, so
 * WebGPU was attempted; `lost=1 maxTex=null` means the WebGL2 fallback got a
 * corpse. Nothing was out of memory — the fallback was simply asking a canvas
 * that had already been spoken for. iPads escape it because WebGPU succeeds
 * there and the fallback never runs.
 *
 * So the fallback must not reuse the element. Listeners on the old canvas are
 * dropped with it, which is safe here only because `createEngine` runs before
 * anything binds to it — hence `EngineHandle.canvas`, so callers bind to the
 * survivor.
 */
function freshCanvas(old: HTMLCanvasElement): HTMLCanvasElement {
  if (!old.isConnected || typeof document === "undefined") return old;
  const replacement = document.createElement("canvas");
  for (const attr of Array.from(old.attributes)) {
    replacement.setAttribute(attr.name, attr.value);
  }
  old.replaceWith(replacement);
  return replacement;
}

/**
 * WebGPU-first with a WebGL2 fallback, from one codebase.
 *
 * WebGPU buys us compute-shader particles (the VFX budget is the tight one for
 * this game) and materially better draw-call throughput. WebGL2 is the fallback
 * for Safari and older Chrome, and for SBC/embedded GPUs where WebGPU is not
 * reliably available. Both paths render the same scene graph.
 *
 * Development currently happens on a discrete-GPU desktop, which means the
 * WebGPU path is the one that gets exercised by default — do not treat the
 * WebGL2 branch as covered just because the app runs locally. Test it by
 * launching Chrome with `--disable-features=WebGPU` (or `--disable-gpu`).
 */
export async function createEngine(
  canvas: HTMLCanvasElement,
  onStatus: (msg: string) => void = () => undefined
): Promise<EngineHandle> {
  /**
   * Did anything get as far as touching the canvas with WebGPU? Only then does
   * the WebGL2 path below need a fresh element — a swap is cheap but it drops
   * listeners and re-enters layout, so it is not done speculatively.
   */
  let webgpuTouchedCanvas = false;
  // `?gfx=webgl2` forces the fallback path. The WebGL2 branch is the one that
  // never gets exercised on a dev desktop, and it is the branch every older
  // phone takes — it needs to be reachable without changing the URL scheme.
  const forced = new URLSearchParams(location.search).get("gfx");

  // iOS home-screen web apps (Web.app) get WebGL2, not WebGPU. Observed on
  // device (iOS 26, 2026-08): in standalone mode WebGPU initializes cleanly,
  // the scene builds, the DOM HUD is fully interactive — and the canvas is
  // pure black, because the WebGPU swapchain never composites into the view.
  // The identical build presents fine in Safari proper on the same phone.
  // There is no error to catch anywhere in that failure, so it must be gated
  // up front rather than handled. `?gfx=webgpu` bypasses the gate to retest
  // per iOS release; drop the gate when Apple fixes presentation in Web.app.
  //
  // iPads are included: they report a desktop-Mac UA (hence the
  // maxTouchPoints test), and standalone mode there is the same Web.app
  // runtime, so there is no reason to expect it composites where the iPhone
  // does not.
  const standalone =
    window.matchMedia?.("(display-mode: fullscreen), (display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  const appleTouchDevice =
    /iPhone|iPod|iPad/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

  /**
   * The iPhone gets WebGL2, full stop — not just in a home-screen web app.
   *
   * Every iPhone boot failure in this project has had a WebGPU attempt
   * upstream of it, and each fix has only moved the failure:
   *
   *   1. WebGPU init claimed the canvas and failed → the WebGL2 fallback was
   *      handed an already-lost context (`lost=1 maxTex=null`). Fixed by
   *      swapping in a fresh canvas.
   *   2. With a fresh canvas, WebGL2 STILL came back born-lost on the boot
   *      after a hero switch — so the canvas was never the whole story. A
   *      WebGPU device and a WebGL2 context are competing for the same scarce
   *      pool on a phone, and asking for the second while the first is being
   *      torn down is a race this device loses.
   *
   * There is no version of this where attempting WebGPU on an iPhone pays for
   * itself: it is one boot path with two backends' worth of allocation on the
   * one device class with the least headroom. Not attempting it removes the
   * canvas swap, the 8 s init watchdog, and the double allocation in a single
   * stroke — and it means the caps line finally reports the TRUTH, because a
   * context that is not born lost reports its real formats.
   *
   * iPads keep WebGPU. They report a desktop-Mac UA, they have the memory for
   * it, and WebGPU has always succeeded there — which is exactly why the iPad
   * never showed any of this.
   *
   * `?gfx=webgpu` still overrides, to retest per iOS release.
   */
  const iPhoneClass = /iPhone|iPod/.test(navigator.userAgent);
  const webgpuBlocked = (standalone && appleTouchDevice) || iPhoneClass ? forced !== "webgpu" : false;
  if (webgpuBlocked) {
    console.info(
      `[engine] ${iPhoneClass ? "iPhone" : "iOS home-screen web app"}: using WebGL2 only ` +
        "(?gfx=webgpu to override)"
    );
  }

  const supportsWebGPU =
    forced !== "webgl2" && !webgpuBlocked && (await WebGPUEngine.IsSupportedAsync);

  if (supportsWebGPU) {
    onStatus("creating engine (webgpu)…");
    // Set BEFORE the constructor, not after a successful init: the whole point
    // is to cover the paths where init throws or hangs having already claimed
    // the canvas, and on those we never reach a line after `initAsync`.
    webgpuTouchedCanvas = true;
    let attempt: WebGPUEngine | null = null;
    try {
      const engine = (attempt = new WebGPUEngine(canvas, {
        antialias: true,
        stencil: true,
        // NOT optional, despite reading like a nice-to-have.
        //
        // Babylon requests the GPUDevice with no `requiredFeatures` unless this
        // is set, and a device requested with none has NO compressed-texture
        // features enabled — verified: the adapter advertises bc/astc/etc2 and
        // the resulting device enables exactly zero. Babylon then reports
        // caps.astc/bptc/etc2 as undefined, the KTX2 transcoder is told the
        // device understands no compressed format, and every texture inflates
        // to uncompressed RGBA8: the village hub goes from ~105 MB of resident
        // texture memory to ~273 MB.
        //
        // That is what makes this a *phone* bug rather than a wasted-VRAM bug.
        // Safari 26 ships WebGPU on by default, so an iPhone on HTTPS takes
        // this path, and 273 MB of textures on top of a ~180 MB JS heap is
        // squarely in the range where iOS kills the tab outright.
        //
        // It also silently undoes assets.ts's whole KTX2 effort — see the
        // useRGBAIfOnlyBC1BC3AvailableWhenUASTC note there.
        enableAllFeatures: true,
      }));
      // Watchdog on initAsync. requestDevice() (and on some builds the
      // clear-quad shader compile inside initAsync) can HANG rather than
      // reject — seen on iOS where WebGPU exists but the environment is
      // hostile to it (e.g. a home-screen web app). An await with no timeout
      // turns that into a permanently black boot screen with no error
      // anywhere; a thrown timeout lands in the catch below and gets the
      // player the WebGL2 game instead. 8 s is generous — a healthy init is
      // sub-second even on a phone.
      //
      // Init that hangs (or throws) AFTER claiming the canvas's 'webgpu'
      // context used to poison the fallback — see `freshCanvas`. The catch
      // below now replaces the element, so a timeout here genuinely does hand
      // the player the WebGL2 game.
      const initResult = await Promise.race([
        engine.initAsync().then(() => "ok" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8000)),
      ]);
      if (initResult === "timeout") {
        throw new Error("WebGPU init timed out after 8s");
      }
      const caps = engine.getCaps();
      lastGfxSummary = `webgpu astc=${+!!caps.astc} bptc=${+!!caps.bptc} etc2=${+!!caps.etc2} s3tc=${+!!caps.s3tc}`;
      console.info(`[engine] ${lastGfxSummary}`);
      return { engine, backend: "webgpu", canvas };
    } catch (err) {
      // `IsSupportedAsync` only proves requestAdapter() resolved; it says
      // nothing about requestDevice() succeeding. Without this catch a WebGPU
      // init failure is terminal — main()'s handler prints "failed: …" and the
      // player never gets a game, even though the WebGL2 path below would have
      // worked perfectly. Falling through is always better than not booting.
      console.warn("[engine] WebGPU init failed, falling back to WebGL2:", err);
      // Hand the half-built engine's GPU objects back before asking the driver
      // for a second context. Disposing something that never finished init can
      // itself throw (the timeout path leaves `initAsync` still running), and a
      // throw here would turn a recoverable fallback into a dead boot.
      try {
        attempt?.dispose();
      } catch (disposeErr) {
        console.warn("[engine] disposing the failed WebGPU engine threw:", disposeErr);
      }
      onStatus("webgpu failed — trying webgl2…");
    }
  } else if (forced !== "webgl2" && !webgpuBlocked) {
    // WebGPU requires a secure context, so this is the branch every phone on a
    // plain-HTTP LAN/tailnet URL takes — the dev desktop on localhost (always
    // a secure context) never sees it. Say so, or "why is my phone on WebGL2
    // when Safari 26 ships WebGPU" costs someone an afternoon.
    console.info(
      `[engine] WebGPU unavailable (secureContext=${window.isSecureContext}) — WebGL2 fallback`
    );
  }

  onStatus("creating engine (webgl2)…");
  // A canvas WebGPU has already touched cannot produce a WebGL2 context — see
  // `freshCanvas` for the field report this line answers. Everything from here
  // down, and everything main() binds afterwards, must use `surface`.
  let surface = webgpuTouchedCanvas ? freshCanvas(canvas) : canvas;
  if (surface !== canvas) {
    console.info("[engine] WebGPU had claimed the canvas — swapped in a fresh one for WebGL2");
  }

  /**
   * The driver's own explanation for a refused context.
   *
   * `webglcontextcreationerror` is the ONLY place a browser says why
   * getContext failed or handed back something dead — nothing else in the
   * platform surfaces it, and `isContextLost()` alone cannot tell "the GPU
   * process is wedged" from "you asked for attributes I will not give you".
   * On a phone this string is the whole diagnosis, and it rides into
   * `lastGfxSummary` so it reaches us on the boot screen.
   */
  let creationError = "";
  const watchCreation = (target: HTMLCanvasElement): void => {
    target.addEventListener(
      "webglcontextcreationerror",
      (e) => {
        creationError = (e as WebGLContextEvent).statusMessage || "(no statusMessage)";
        console.error(`[engine] context creation refused: ${creationError}`);
      },
      { once: true }
    );
  };

  /**
   * Attribute sets, richest first.
   *
   * A context can be refused for what you ASKED for rather than for what is
   * available — antialias and a high-performance preference are the two a
   * memory-pressured mobile driver is most likely to decline. Retrying with a
   * humbler request costs one frame of quality and can be the difference
   * between a game and a black screen, so each retry drops something.
   */
  const ATTRS: EngineOptions[] = [
    {
      stencil: true,
      // Never allocate a second full-screen buffer we don't read back from.
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      // Do not silently fall back to a software rasteriser: better to know.
      failIfMajorPerformanceCaveat: false,
      antialias: true,
    },
    // No MSAA, no power preference — the two most-refused requests gone.
    { stencil: true, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false, antialias: false },
    // Bare minimum. Stencil goes too; nothing in the render path needs it more
    // than it needs to exist at all.
    { stencil: false, preserveDrawingBuffer: false, antialias: false },
  ];

  const makeEngine = (target: HTMLCanvasElement, attrs: EngineOptions): Engine => {
    watchCreation(target);
    return new Engine(
      target,
      true,
      attrs,
      // adaptToDeviceRatio=false. We control resolution scaling ourselves via
      // engine.setHardwareScalingLevel so a 4K display doesn't quadruple our
      // fragment cost by default.
      false
    );
  };

  /**
   * How long to wait before asking a second time for a context that came back
   * dead, and how many times to ask.
   *
   * A born-lost context is not always terminal. The commonest cause on a phone
   * is simply that the PREVIOUS page has not been torn down yet — reloading is
   * how this app re-picks a hero, so the outgoing document's context and its
   * textures can still be resident when the incoming one asks. Safari frees
   * them a moment later. Dying instantly turns a transient overlap into a dead
   * boot the player can only escape by force-quitting the browser, and the
   * whole cost of being wrong is one second.
   */
  const LOST_RETRY_MS = 700;
  const LOST_ATTEMPTS = 3;

  let attrsUsed = 0;
  let engine = makeEngine(surface, ATTRS[0]!);
  const isLost = (e: Engine): boolean =>
    !!(e as unknown as { _gl?: WebGLRenderingContext })._gl?.isContextLost();

  for (let attempt = 2; attempt <= LOST_ATTEMPTS && isLost(engine); attempt++) {
    console.warn(
      `[engine] WebGL2 context born lost — retrying ${attempt}/${LOST_ATTEMPTS} in ${LOST_RETRY_MS} ms ` +
        `(previous page may still hold the GPU${creationError ? `; driver said: ${creationError}` : ""})`
    );
    onStatus(`graphics busy — retrying (${attempt}/${LOST_ATTEMPTS})…`);
    // Give the dead one back before asking again, or each attempt adds another
    // corpse to the pool we are already failing to allocate from.
    try {
      engine.dispose();
    } catch {
      /* a dead context throws on the way out; it is going away regardless */
    }
    await new Promise((resolve) => setTimeout(resolve, LOST_RETRY_MS));
    surface = freshCanvas(surface);
    // Ask for less each time round — see ATTRS.
    attrsUsed = Math.min(attempt - 1, ATTRS.length - 1);
    engine = makeEngine(surface, ATTRS[attrsUsed]!);
  }

  // Mirror the WebGPU branch's caps log — but with the extra bits that tell
  // three failures apart, because on a phone this line is read off a
  // screenshot of the boot screen:
  //   lost=1                → Safari handed us a context that was ALREADY dead
  //                           (wedged GPU process, too many leaked contexts) —
  //                           every cap reads 0 as an artifact, not a fact.
  //                           Historically this ALSO meant "WebGPU already owns
  //                           this canvas", which is a different bug entirely;
  //                           `freshCanvas` now rules that cause out before we
  //                           ever get here, so a surviving lost=1 really is
  //                           the device.
  //   pvrtc=1, rest 0       → old-iOS device: Babylon's KTX2 decoder can still
  //                           transcode to PVRTC, textures stay compressed.
  //   all 0, lost=0         → genuinely no compressed format: every KTX2
  //                           inflates to RGBA8 at 4x resident size, which on
  //                           an iPhone is what kills the context mid-boot.
  //   secure=0              → WebGPU never had a chance (plain-HTTP tailnet
  //                           URL); HTTPS would move this device off WebGL2
  //                           entirely.
  const caps = engine.getCaps();
  const gl = (engine as unknown as { _gl: WebGLRenderingContext })._gl;
  const bornLost = gl.isContextLost();
  lastGfxSummary =
    `webgl2 astc=${+!!caps.astc} bptc=${+!!caps.bptc} etc2=${+!!caps.etc2} etc1=${+!!caps.etc1} ` +
    `s3tc=${+!!caps.s3tc} pvrtc=${+!!caps.pvrtc} lost=${+bornLost} maxTex=${caps.maxTextureSize} ` +
    `secure=${+window.isSecureContext} attrs=${attrsUsed}` +
    // The driver's own words, when it gave any. Worth more than every flag
    // before it — those are all artifacts once the context is dead.
    (creationError ? ` why="${creationError}"` : "");
  console.info(`[engine] ${lastGfxSummary}`);
  console.info(`[engine] extensions: ${gl.getSupportedExtensions()?.join(" ") ?? "none"}`);

  if (bornLost) {
    // Fail loudly NOW rather than letting boot limp on until some random gl
    // call throws "Unable to create uniform buffer" three screens later.
    //
    // Everything recoverable has now been tried: WebGPU never touched the
    // canvas on the devices where that mattered, and a transient overlap with
    // the previous page has been waited out across every retry above. What is
    // left really is the browser's GPU process, which only closing tabs or
    // restarting the browser brings back.
    throw new Error(
      `WebGL context dead on arrival after ${LOST_ATTEMPTS} attempts — close other tabs or restart the browser`
    );
  }

  return { engine, backend: "webgl2", canvas: surface };
}

/**
 * Give the GPU back, now, before the next page asks for it.
 *
 * Navigating away does NOT promptly free a WebGL context on iOS Safari. The
 * outgoing page keeps its context and everything resident in it — for the
 * village that is ~70 MB of textures plus buffers — while the incoming page
 * creates a second context and loads the whole set again. Two villages do not
 * fit, and the second one loses: the new context is refused or arrives
 * already dead, which is a black screen with the boot screen's escape buttons
 * on it.
 *
 * That is not a hypothetical navigation. "Switch Character" in the left dock
 * IS a `location.reload()` (see the note there — a reload is the only honest
 * way to re-pick a hero), so the one flow most likely to be used twice in a
 * session is the one that stacks two contexts. Booting once and dying on the
 * hero switch is the signature.
 *
 * `engine.dispose()` alone is not enough: Babylon only calls `loseContext()`
 * when the engine was created with `loseContextOnDispose`, which would also
 * arm it on paths that do not want it. Ask explicitly instead — it is the
 * strongest hint a page can give a driver that it is done.
 *
 * Callers MUST expect their `webglcontextlost` handler to fire as a result;
 * main() gates its "ran out of GPU memory" message on an unloading flag so a
 * deliberate release is not reported as a crash.
 */
export function releaseGraphics(engine: AbstractEngine): void {
  const gl = (engine as unknown as { _gl?: WebGLRenderingContext })._gl;
  try {
    // Stop drawing before tearing the drawing surface down, or the in-flight
    // frame lands on freed objects and throws on the way out of the page.
    engine.stopRenderLoop();
  } catch {
    /* nothing was running */
  }
  try {
    engine.dispose();
  } catch (err) {
    // A half-built engine can throw here, and a throw on the way out of the
    // page would skip the loseContext below — which is the part that matters.
    console.warn("[engine] dispose on unload threw:", err);
  }
  try {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    /* WebGPU (no _gl), or an extension the browser withholds */
  }
}

/**
 * Clamp render resolution. On a 4K panel a naive 1:1 backbuffer is 4x the
 * fragment work of 1080p for almost no perceived gain in a stylised game that
 * leans on bloom and fog. Call this after creating the engine.
 *
 * Note what "scale 1" means here: the engine is created with
 * `adaptToDeviceRatio = false`, so the backbuffer is sized in CSS pixels, not
 * device pixels. On a phone that is already ~844x390 rather than 3x that — this
 * policy is a ceiling for large desktop panels, and on mobile it is a no-op.
 *
 * IDEMPOTENT ON PURPOSE. `AbstractEngine.setHardwareScalingLevel` calls
 * `resize()` unconditionally, and `resize()` re-reads the canvas bounds and walks
 * every scene and camera. This runs on every `resize` event, and mobile browsers
 * fire those in bursts while their URL bar animates, so re-applying an unchanged
 * scaling level was pure waste in exactly the situation with no frames to spare.
 */
export function applyResolutionPolicy(engine: AbstractEngine, maxHeightPx = 1440): void {
  const dpr = window.devicePixelRatio || 1;
  const nativeHeight = window.innerHeight * dpr;
  const scale = nativeHeight > maxHeightPx ? nativeHeight / maxHeightPx : 1;
  if (engine.getHardwareScalingLevel() === scale) return;
  engine.setHardwareScalingLevel(scale);
}
