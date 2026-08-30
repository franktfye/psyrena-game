import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import type { Scene } from "@babylonjs/core/scene";
import { BUDGET } from "./budget";
import { estimateTextureBytes } from "./assets";

const MB = 1024 * 1024;

/** localStorage key remembering whether the stats panel is open across reloads. */
const HUD_OPEN_KEY = "psyrena.perfHud";

interface HeapCapableperformance extends Performance {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
}

/**
 * On-screen budget readout.
 *
 * Deliberately a plain DOM overlay rather than Babylon GUI: a GUI texture would
 * add draw calls and texture memory to the very numbers it is trying to report.
 *
 * IMPORTANT — what you are actually measuring. In Chrome the renderer process
 * (JS heap, DOM) and the GPU process (textures, buffers) are separate. `RSS` on
 * the renderer process does not include texture memory at all, which is why
 * "my scene is small but the tab still dies" is such a common trap. Cross-check
 * this HUD against Chrome's task manager (Shift+Esc) "GPU memory" column.
 */
export class PerfHud {
  private readonly root: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private instrumentation: SceneInstrumentation | null = null;
  private accum = 0;
  private lowFpsSeconds = 0;
  /** Panel visibility. Hidden by default — most players never want raw stats. */
  private visible: boolean;

  constructor() {
    // Same guard style as sfx.ts: localStorage can be absent (SSR, some
    // privacy modes), and the HUD must not take the boot down with it.
    this.visible = typeof localStorage !== "undefined" && localStorage.getItem(HUD_OPEN_KEY) === "1";

    this.root = document.createElement("div");
    this.root.id = "perf-hud";
    this.root.style.cssText = [
      // Top-RIGHT: top-left belongs to the player frame (avatar/HP/MP), per
      // the raid-game convention the rest of the HUD follows. Offset below the
      // 28px toggle icon (8px inset + 28px icon + 6px gap) so the icon never
      // covers the panel's first row.
      "position:fixed",
      "top:calc(42px + env(safe-area-inset-top, 0px))",
      "right:calc(8px + env(safe-area-inset-right, 0px))",
      "z-index:10",
      "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
      "color:#a8f0ff",
      "background:rgba(4,10,18,.72)",
      "border:1px solid rgba(120,220,255,.28)",
      "border-radius:6px",
      "padding:8px 10px",
      "pointer-events:none",
      "white-space:pre",
      "backdrop-filter:blur(4px)",
      this.visible ? "display:block" : "display:none",
    ].join(";");
    document.body.appendChild(this.root);

    // The one interactive piece: a small always-visible icon that shows/hides
    // the stats panel. pointer-events:auto because the panel itself is
    // deliberately click-through and this button must not be.
    this.toggle = document.createElement("button");
    this.toggle.id = "perf-hud-toggle";
    this.toggle.textContent = "📈";
    this.toggle.title = "Performance stats";
    this.toggle.style.cssText = [
      "position:fixed",
      "top:calc(8px + env(safe-area-inset-top, 0px))",
      "right:calc(8px + env(safe-area-inset-right, 0px))",
      "z-index:11",
      "width:28px",
      "height:28px",
      "background:rgba(4,10,18,.72)",
      "border:1px solid rgba(120,220,255,.28)",
      "border-radius:6px",
      "font-size:14px",
      "line-height:1",
      "cursor:pointer",
      "pointer-events:auto",
      "backdrop-filter:blur(4px)",
      "display:grid",
      "place-content:center",
      "padding:0",
      `opacity:${this.visible ? "1" : ".55"}`,
    ].join(";");
    this.toggle.addEventListener("click", () => this.setVisible(!this.visible));
    document.body.appendChild(this.toggle);
  }

  private setVisible(on: boolean): void {
    this.visible = on;
    this.root.style.display = on ? "block" : "none";
    this.toggle.style.opacity = on ? "1" : ".55";
    // Force the next update() past the 4 Hz throttle so reopening shows fresh
    // numbers immediately instead of whatever text was frozen at hide time.
    if (on) this.accum = 1;
    if (typeof localStorage !== "undefined") {
      if (on) localStorage.setItem(HUD_OPEN_KEY, "1");
      else localStorage.removeItem(HUD_OPEN_KEY);
    }
  }

  attach(scene: Scene): void {
    this.instrumentation?.dispose();
    this.instrumentation = new SceneInstrumentation(scene);
    this.instrumentation.captureFrameTime = true;
  }

  /** Call once per frame. Recomputes at 4 Hz to keep the HUD itself cheap. */
  update(scene: Scene, dtSeconds: number, backend: string): void {
    const engine = scene.getEngine();
    const fps = engine.getFps();

    // The breach timer keeps running while hidden — it is instrumentation, not
    // presentation, and reopening should show a breach that happened unseen.
    this.lowFpsSeconds = fps < BUDGET.targetFps * 0.9 ? this.lowFpsSeconds + dtSeconds : 0;

    // Hidden panel: skip the DOM text rebuild entirely. SceneInstrumentation
    // (re-bound in attach()) keeps counting regardless, so nothing goes stale.
    if (!this.visible) return;

    this.accum += dtSeconds;
    if (this.accum < 0.25) return;
    this.accum = 0;

    const tex = estimateTextureBytes(engine);
    const texMB = tex.bytes / MB;
    const drawCalls = this.instrumentation?.drawCallsCounter.current ?? 0;
    const heap = (performance as HeapCapableperformance).memory;
    const heapMB = heap ? heap.usedJSHeapSize / MB : NaN;

    const tris = scene.getActiveMeshes().length > 0 ? scene.getTotalVertices() : 0;

    this.root.textContent = [
      `backend   ${backend}`,
      row("fps", fps.toFixed(0), BUDGET.targetFps, "min"),
      row("draws", String(drawCalls), BUDGET.drawCallsArena, "max"),
      row("tex MB", texMB.toFixed(1), BUDGET.gpuMemoryMB, "max"),
      `textures  ${tex.count}`,
      Number.isNaN(heapMB)
        ? "heap MB   n/a (Chrome only)"
        : row("heap MB", heapMB.toFixed(0), BUDGET.jsHeapMB, "max"),
      row("particles", String(scene.particleSystems.length), BUDGET.particleSystems, "max"),
      `verts     ${(tris / 1000).toFixed(0)}k`,
      this.lowFpsSeconds > 2 ? "\n!! sustained fps breach" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  dispose(): void {
    this.instrumentation?.dispose();
    this.instrumentation = null;
    this.root.remove();
    this.toggle.remove();
  }
}

function row(label: string, value: string, limit: number, dir: "min" | "max"): string {
  const n = Number(value);
  const over = dir === "max" ? n > limit : n < limit;
  const flag = over ? " <-- OVER" : "";
  return `${label.padEnd(9)} ${value.padStart(6)} / ${limit}${flag}`;
}
