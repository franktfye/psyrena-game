import { Scene } from "@babylonjs/core/scene";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";

/**
 * Soft-gradient sprite bakes shared by the arena black-hole backdrop
 * (scenes/lookdevArena.ts) and the plaza portal (vfx/blackHolePortal.ts).
 * Moved here verbatim when the portal needed the same recipe at 1/27 scale.
 */

/** Clamped smoothstep — the only easing these bakes need. */
export function sstep(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
}

/** Deterministic value noise in [0,1] — hash lattice + smooth interpolation. */
export function vnoise(x: number, y: number): number {
  const h = (ix: number, iy: number): number => {
    const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Two octaves is enough for gas wisps at these on-screen sizes. */
export function fbm(x: number, y: number): number {
  return 0.65 * vnoise(x, y) + 0.35 * vnoise(x * 2.3 + 17.1, y * 2.3 + 9.7);
}

/**
 * Soft ring sprite: a white gaussian band (tight inner sigma, wide outer
 * feather) broken up by noise wisps. RGB and alpha both carry the band, so
 * the emissive read and the blend fade out together — there is no radius at
 * which the ring "ends", which is what makes it read as fog instead of a
 * solid hoop.
 */
export function createSoftRingTexture(
  scene: Scene,
  name: string,
  size: number,
  ringR: number,
  sigmaIn: number,
  sigmaOut: number,
  noiseAmt: number
): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, false);
  const ctx = tex.getContext();
  ctx.clearRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 centre → 1 at edge
      const d = r - ringR;
      const s = d < 0 ? sigmaIn : sigmaOut;
      let a = Math.exp(-(d * d) / (2 * s * s));
      if (noiseAmt > 0) a *= 1 - noiseAmt + noiseAmt * fbm(dx * 7 + 11.3, dy * 7 - 4.9);
      // Wide sigmas never reach zero on their own — kill the band before the
      // mesh rim or the disc edge reappears as a faint hard arc.
      a *= 1 - sstep(0.82, 0.99, r);
      const v = Math.round(255 * Math.min(1, a));
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.hasAlpha = true;
  tex.update(true);
  return tex;
}
