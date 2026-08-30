/**
 * Overhead teammate HP bars — the healer's field readout.
 *
 * A healer plays watching the party, not the top-left corner, so when the
 * player's hero holds the healer role every teammate wears a thin health bar
 * above their head — consistently, for the whole fight, not only when a hit
 * lands. Same plain-DOM projection as the damage numbers (vfx/damageNumbers):
 * crisp at any DPI, zero draw calls, reprojected every frame because the
 * camera orbits.
 *
 * The fallen keep their bar — dimmed and empty over the body — so the healer
 * reads "down", not "gone".
 */

import type { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

export interface AllyBars {
  /** Per-frame: reproject the anchors and repaint the fills. */
  update(allies: { name: string; hpPct: number; alive: boolean }[]): void;
  dispose(): void;
}

/** Bar footprint, px. Thin on purpose — a readout, not a nameplate. */
const BAR_W = 46;
const BAR_H = 5;

export function createAllyBars(scene: Scene, anchors: Map<string, Vector3>): AllyBars {
  const identity = Matrix.Identity();
  const bars = new Map<string, { root: HTMLDivElement; fill: HTMLDivElement }>();

  for (const name of anchors.keys()) {
    const root = document.createElement("div");
    root.title = name;
    root.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      // Under the damage numbers (30) — a float should never hide behind a bar.
      "z-index:15",
      "pointer-events:none",
      "transform:translate(-50%, -100%)",
      `width:${BAR_W}px`,
      `height:${BAR_H}px`,
      "background:linear-gradient(180deg,#050403,#141009)",
      "border:1px solid #0a0805",
      "outline:1px solid rgba(87,69,31,.8)",
      "border-radius:2px",
      "overflow:hidden",
      "will-change:left, top",
    ].join(";");
    const fill = document.createElement("div");
    fill.style.cssText = [
      "height:100%",
      "width:100%",
      "background:linear-gradient(180deg,#76d95e,#3fae2a 55%,#267a17)",
      "box-shadow:inset 0 -1px 1px rgba(0,0,0,.35)",
    ].join(";");
    root.appendChild(fill);
    document.body.appendChild(root);
    bars.set(name, { root, fill });
  }

  return {
    update(allies) {
      const cam = scene.activeCamera;
      const engine = scene.getEngine();
      const canvas = engine.getRenderingCanvas();
      const rect = canvas?.getBoundingClientRect();
      const w = engine.getRenderWidth();
      const h = engine.getRenderHeight();
      if (!cam || !canvas || !rect || w <= 0 || h <= 0) return;
      scene.updateTransformMatrix();
      const transform = scene.getTransformMatrix();
      const viewport = cam.viewport.toGlobal(w, h);
      for (const a of allies) {
        const bar = bars.get(a.name);
        const anchor = anchors.get(a.name);
        if (!bar || !anchor) continue;
        const p = Vector3.Project(anchor, identity, transform, viewport);
        if (p.z < 0 || p.z > 1) {
          bar.root.style.opacity = "0";
          continue;
        }
        bar.root.style.left = `${rect.left + (p.x / w) * rect.width}px`;
        bar.root.style.top = `${rect.top + (p.y / h) * rect.height}px`;
        bar.root.style.opacity = a.alive ? "0.95" : "0.35";
        bar.fill.style.width = `${Math.round(100 * Math.max(0, Math.min(1, a.hpPct)))}%`;
      }
    },
    dispose() {
      for (const b of bars.values()) b.root.remove();
      bars.clear();
    },
  };
}
