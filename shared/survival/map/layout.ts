/**
 * Survival map geometry, shared by the client scene and the server session
 * (docs/survival-design.md §12.2). Positions are server-authoritative, so
 * solidity cannot live only in the scene graph the way the village's
 * `collectStaticColliders` does: the map is DATA, and both sides derive the
 * same solid boxes from it.
 *
 * Authoring is by what is WALKABLE: street and square rectangles. Everything
 * else inside the map bounds is solid. That is rasterised on a 1 m grid and
 * merged into axis-aligned boxes, which are the colliders (player push-out,
 * server position clamp) and the blocks the scene lines with buildings.
 * Hostiles path on the same grid with a flow field.
 *
 * Coordinates: metres, ground plane x/z, map centred on the origin.
 */

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /**
   * Solid boxes only (set by `solidBoxes`): which faces border walkable
   * ground. A body that ends up inside a box leaves through an OPEN face —
   * never through a seam shared with a neighbouring solid box (it would be
   * pushed straight back) or past the map edge.
   */
  open?: { x0: boolean; x1: boolean; z0: boolean; z1: boolean };
}

export interface MapDef {
  id: string;
  /** Half the side of the square map: bounds are [-half, half] on x and z. */
  half: number;
  /** Walkable ground. Overlaps are fine. */
  streets: Array<Rect & { name: string }>;
  /** Named open areas (also walkable): the boss arena and the elite squares. */
  squares: Array<Rect & { name: string; role: "boss" | "elite" | "spawnHub" }>;
  /**
   * Solid things placed INSIDE walkable space (a tram shelter, a banyan tree).
   * They become colliders and are subtracted from the walk grid.
   */
  obstacles: Array<Rect & { name: string }>;
  /** Where hostiles appear: alley mouths and street ends, inside the fog. */
  spawns: Array<{ x: number; z: number }>;
  /** Party start. */
  start: { x: number; z: number };
  /** Openings of the boss square that a fog wall closes during boss waves. */
  bossGates: Rect[];
}

/** Grid resolution of the walk grid and the flow field. */
export const CELL = 1;

export interface WalkGrid {
  n: number;          // cells per side
  half: number;
  walk: Uint8Array;   // 1 = walkable, row-major [iz * n + ix]
}

const inRect = (r: Rect, x: number, z: number) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1;

export function buildWalkGrid(map: MapDef): WalkGrid {
  const n = Math.round((2 * map.half) / CELL);
  const walk = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -map.half + (ix + 0.5) * CELL;
      const z = -map.half + (iz + 0.5) * CELL;
      const open = map.streets.some((r) => inRect(r, x, z)) || map.squares.some((r) => inRect(r, x, z));
      const blocked = map.obstacles.some((r) => inRect(r, x, z));
      walk[iz * n + ix] = open && !blocked ? 1 : 0;
    }
  }
  return { n, half: map.half, walk };
}

/**
 * Merge the solid cells into axis-aligned boxes (greedy: grow each run along x,
 * then extend it down z while the whole run stays solid). Gives a few dozen
 * boxes for a street grid, which is what push-out iterates per frame.
 */
export function solidBoxes(grid: WalkGrid): Rect[] {
  const { n, half, walk } = grid;
  const used = new Uint8Array(n * n);
  const out: Rect[] = [];
  const solid = (ix: number, iz: number) => walk[iz * n + ix] === 0 && !used[iz * n + ix];
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      if (!solid(ix, iz)) continue;
      let w = 1;
      while (ix + w < n && solid(ix + w, iz)) w++;
      let h = 1;
      outer: while (iz + h < n) {
        for (let k = 0; k < w; k++) if (!solid(ix + k, iz + h)) break outer;
        h++;
      }
      for (let dz = 0; dz < h; dz++) for (let k = 0; k < w; k++) used[(iz + dz) * n + ix + k] = 1;
      const walkAt = (cx: number, cz: number) => cx >= 0 && cz >= 0 && cx < n && cz < n && walk[cz * n + cx] === 1;
      const anyX = (cx: number) => { for (let k = 0; k < h; k++) if (walkAt(cx, iz + k)) return true; return false; };
      const anyZ = (cz: number) => { for (let k = 0; k < w; k++) if (walkAt(ix + k, cz)) return true; return false; };
      out.push({
        x0: -half + ix * CELL, x1: -half + (ix + w) * CELL,
        z0: -half + iz * CELL, z1: -half + (iz + h) * CELL,
        open: { x0: anyX(ix - 1), x1: anyX(ix + w), z0: anyZ(iz - 1), z1: anyZ(iz + h) },
      });
    }
  }
  return out;
}

/**
 * Push a circle (a hero, a hostile) out of every solid box and back inside
 * the map. Mutates `p`. Two passes settle a corner between two boxes.
 */
export function pushOut(p: { x: number; z: number }, r: number, boxes: Rect[], half: number): void {
  const lim = half - r;
  // Bounds FIRST, then the boxes, alternating: a step past the map edge at a
  // corner block must not be pushed out of the block and then clamped straight
  // back into it (tools/verify-survival-map.mjs caught exactly that).
  for (let pass = 0; pass < 3; pass++) {
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));
    let moved = false;
    for (const b of boxes) {
      const cx = Math.max(b.x0, Math.min(b.x1, p.x));
      const cz = Math.max(b.z0, Math.min(b.z1, p.z));
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      moved = true;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        p.x += (dx / d) * (r - d);
        p.z += (dz / d) * (r - d);
      } else {
        // Centre inside the box: leave by the nearest OPEN face (see Rect.open).
        // Boxes without flags fall back to "anything but the map edge".
        const shut = (face: "x0" | "x1" | "z0" | "z1", v: number) =>
          (b.open ? !b.open[face] : Math.abs(Math.abs(v) - half) < 1e-6) ? Infinity : 0;
        const exits = [
          p.x - b.x0 + r + shut("x0", b.x0), b.x1 - p.x + r + shut("x1", b.x1),
          p.z - b.z0 + r + shut("z0", b.z0), b.z1 - p.z + r + shut("z1", b.z1),
        ];
        const k = exits.indexOf(Math.min(...exits));
        if (k === 0) p.x = b.x0 - r;
        else if (k === 1) p.x = b.x1 + r;
        else if (k === 2) p.z = b.z0 - r;
        else p.z = b.z1 + r;
      }
    }
    if (!moved) break;
  }
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
}

export function cellOf(grid: WalkGrid, x: number, z: number): number {
  const ix = Math.max(0, Math.min(grid.n - 1, Math.floor((x + grid.half) / CELL)));
  const iz = Math.max(0, Math.min(grid.n - 1, Math.floor((z + grid.half) / CELL)));
  return iz * grid.n + ix;
}

/**
 * Flow field toward a set of targets (the living players): breadth-first
 * distance over walkable cells, 8-connected without corner cutting. A hostile
 * steps toward its lowest-distance neighbour. One field serves every hostile;
 * the server rebuilds it every ~0.5 s (12k cells: well under a millisecond).
 */
export function flowField(grid: WalkGrid, targets: Array<{ x: number; z: number }>): Uint16Array {
  const { n, walk } = grid;
  const INF = 0xffff;
  const dist = new Uint16Array(n * n).fill(INF);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  for (const t of targets) {
    const c = cellOf(grid, t.x, t.z);
    if (walk[c] && dist[c] === INF) {
      dist[c] = 0;
      queue[tail++] = c;
    }
  }
  while (head < tail) {
    const c = queue[head++];
    const ix = c % n;
    const iz = (c - ix) / n;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const jx = ix + dx;
        const jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        const j = jz * n + jx;
        if (!walk[j] || dist[j] !== INF) continue;
        if (dx && dz && (!walk[iz * n + jx] || !walk[jz * n + ix])) continue; // no corner cutting
        dist[j] = dist[c] + 1;
        queue[tail++] = j;
      }
    }
  }
  return dist;
}

/** Unit step direction for a hostile at (x, z) following a flow field. */
export function flowStep(grid: WalkGrid, dist: Uint16Array, x: number, z: number): { x: number; z: number } {
  const { n, half } = grid;
  const c = cellOf(grid, x, z);
  const ix = c % n;
  const iz = (c - ix) / n;
  let best = dist[c];
  let bx = 0;
  let bz = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const jx = ix + dx;
      const jz = iz + dz;
      if ((!dx && !dz) || jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
      const d = dist[jz * n + jx];
      if (d < best) {
        best = d;
        bx = -half + (jx + 0.5) * CELL - x;
        bz = -half + (jz + 0.5) * CELL - z;
      }
    }
  }
  const len = Math.hypot(bx, bz);
  return len > 1e-6 ? { x: bx / len, z: bz / len } : { x: 0, z: 0 };
}

/**
 * Nearest walkable cell centre to (x, z), for positions that arrive somewhere
 * impossible (a teleporting client, a spawn after a layout edit). `pushOut`
 * resolves ordinary movement, which never starts deep inside a block.
 */
export function snapToWalkable(grid: WalkGrid, x: number, z: number): { x: number; z: number } {
  const { n, half, walk } = grid;
  const c = cellOf(grid, x, z);
  if (walk[c]) return { x, z };
  const cx = c % n;
  const cz = (c - cx) / n;
  for (let ring = 1; ring < n; ring++) {
    let best = -1;
    let bestD = Infinity;
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const jx = cx + dx;
        const jz = cz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n || !walk[jz * n + jx]) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = jz * n + jx;
        }
      }
    }
    if (best >= 0) {
      const bx = best % n;
      return { x: -half + (bx + 0.5) * CELL, z: -half + ((best - bx) / n + 0.5) * CELL };
    }
  }
  return { x: 0, z: 0 };
}
