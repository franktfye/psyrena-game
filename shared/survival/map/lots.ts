/**
 * Building lots along a survival map's street frontage (docs/survival-design.md
 * §12). Pure geometry, deterministic, no engine: the scene instances a model
 * per lot, and tools/verify-survival-map.mjs draws them on the map preview.
 */
import type { Rect, WalkGrid } from "./layout.ts";

/** Deterministic little RNG so the town is the same town on every client. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Lot {
  /** Centre of the building footprint. */
  x: number;
  z: number;
  /** Frontage length (along the street) and depth (into the block). */
  len: number;
  depth: number;
  /** Yaw that turns a +Z-facing facade to face the street. */
  yaw: number;
  corner: boolean;
}

export const inside = (r: Rect, x: number, z: number) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;

/**
 * Every stretch of solid-box edge that faces walkable ground becomes a row of
 * lots. At a convex corner both rows run into the corner square and overlap.
 */
export function frontageLots(grid: WalkGrid, boxes: Rect[], reserved: Rect[], lotDepth: number): Lot[] {
  const { n, half, walk } = grid;
  const open = (x: number, z: number) => {
    const ix = Math.floor(x + half);
    const iz = Math.floor(z + half);
    return ix >= 0 && iz >= 0 && ix < n && iz < n && walk[iz * n + ix] === 1;
  };
  const rand = rng(1971);
  const lots: Lot[] = [];

  for (const b of boxes) {
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    // Four edges: outward normal, the axis we run along, and the yaw facing out.
    const edges = [
      { nx: 0, nz: 1, along: "x", fixed: b.z1, a0: b.x0, a1: b.x1, depthMax: d, yaw: 0 },
      { nx: 0, nz: -1, along: "x", fixed: b.z0, a0: b.x0, a1: b.x1, depthMax: d, yaw: Math.PI },
      { nx: 1, nz: 0, along: "z", fixed: b.x1, a0: b.z0, a1: b.z1, depthMax: w, yaw: Math.PI / 2 },
      { nx: -1, nz: 0, along: "z", fixed: b.x0, a0: b.z0, a1: b.z1, depthMax: w, yaw: -Math.PI / 2 },
    ] as const;
    for (const e of edges) {
      const depth = Math.min(lotDepth, e.depthMax);
      // Cell centres just outside this edge.
      const outside = (t: number) =>
        e.along === "x" ? open(t, e.fixed + e.nz * 0.5) : open(e.fixed + e.nx * 0.5, t);
      // Walk the edge in 1 m steps collecting open runs.
      let t = e.a0;
      while (t < e.a1) {
        while (t < e.a1 && !outside(t + 0.5)) t++;
        if (t >= e.a1) break;
        let u = t;
        while (u < e.a1 && outside(u + 0.5)) u++;
        let r0 = t;
        let r1 = u;
        // Convex corners (the perpendicular edge is open at this end too): run
        // the row right into the corner, 0.3 m short of it. The perpendicular
        // row does the same, so the corner square holds two overlapping
        // buildings — each street sees a facade, each side wall is buried in
        // the other building, and the inset keeps facade and side wall from
        // sharing a plane (no z-fighting at the corner).
        const perpOpen = (end: number, sign: number) =>
          e.along === "x"
            ? open(end + sign * 0.5, e.fixed - e.nz * 0.5)
            : open(e.fixed - e.nx * 0.5, end + sign * 0.5);
        if (r0 === e.a0 && perpOpen(e.a0, -1)) r0 += 0.3;
        if (r1 === e.a1 && perpOpen(e.a1, 1)) r1 -= 0.3;
        // Split the run into lots.
        let s = r0;
        while (r1 - s >= 6) {
          let len = 7 + rand() * 5;
          if (r1 - s - len < 6) len = r1 - s;
          const mid = s + len / 2;
          const cx = e.along === "x" ? mid : e.fixed - e.nx * (depth / 2);
          const cz = e.along === "x" ? e.fixed - e.nz * (depth / 2) : mid;
          if (!reserved.some((r) => inside(r, cx, cz))) {
            lots.push({ x: cx, z: cz, len, depth, yaw: e.yaw, corner: false });
          }
          s += len;
        }
        t = u;
      }
    }
  }
  return lots;
}

