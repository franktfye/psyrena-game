#!/usr/bin/env node
// Checks a survival map's geometry (docs/survival-design.md §12):
//   - every walkable cell is reachable from the start (no sealed pockets);
//   - start and spawns stand on walkable ground, with a path to the start;
//   - no walkable passage is narrower than MIN_WIDTH (the fighting rule);
//   - the boss square is at least 30 × 30 m of open floor;
//   - push-out leaves a body outside every solid box.
// Prints a map preview with --png <out.png>.
//
//   node --experimental-strip-types tools/verify-survival-map.mjs [--png out.png]

import { OLD_KOWLOON } from "../shared/survival/map/oldKowloon.ts";
import { buildWalkGrid, solidBoxes, flowField, pushOut, cellOf, snapToWalkable } from "../shared/survival/map/layout.ts";

const MIN_WIDTH = 9;
const map = OLD_KOWLOON;
const grid = buildWalkGrid(map);
const boxes = solidBoxes(grid);
const { n, walk } = grid;
const fail = [];

const dist = flowField(grid, [map.start]);
let walkable = 0, unreached = 0;
for (let i = 0; i < n * n; i++) {
  if (!walk[i]) continue;
  walkable++;
  if (dist[i] === 0xffff) unreached++;
}
if (unreached) fail.push(`${unreached} walkable cells cannot reach the start`);
if (!walk[cellOf(grid, map.start.x, map.start.z)]) fail.push("start is inside a solid cell");
for (const s of map.spawns) {
  const c = cellOf(grid, s.x, s.z);
  if (!walk[c]) fail.push(`spawn ${s.x},${s.z} is solid`);
  else if (dist[c] === 0xffff) fail.push(`spawn ${s.x},${s.z} has no path to the start`);
}

// Narrowest passage: for each walkable cell, the open run through it along x
// and along z; the smaller of the two is the corridor width there. Corners of
// obstacles inside squares are excluded (squares are open floor by design).
let narrow = 0;
const runX = (ix, iz) => { let a = ix, b = ix; while (a > 0 && walk[iz * n + a - 1]) a--; while (b < n - 1 && walk[iz * n + b + 1]) b++; return b - a + 1; };
const runZ = (ix, iz) => { let a = iz, b = iz; while (a > 0 && walk[(a - 1) * n + ix]) a--; while (b < n - 1 && walk[(b + 1) * n + ix]) b++; return b - a + 1; };
const narrowAt = [];
for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
  if (!walk[iz * n + ix]) continue;
  const w = Math.max(runX(ix, iz), runZ(ix, iz));
  if (w < MIN_WIDTH) { narrow++; if (narrowAt.length < 5) narrowAt.push(`${ix - map.half},${iz - map.half}`); }
}
if (narrow) fail.push(`${narrow} walkable cells sit in a passage narrower than ${MIN_WIDTH} m (e.g. ${narrowAt.join(" ")})`);

const boss = map.squares.find((s) => s.role === "boss");
if (!boss || boss.x1 - boss.x0 < 30 || boss.z1 - boss.z0 < 30) fail.push("boss square smaller than 30 × 30 m");

// Push-out sanity, as movement really happens, and EXHAUSTIVE (random samples
// once missed a seam between two solid boxes): from 16 points in every
// walkable cell, a 0.6 m step (one tick at sprint speed and more) in 8
// directions, then push-out; no body may end inside a box. Then the teleport
// case: any point snaps to walkable ground.
pushCheck: for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
  if (!walk[iz * n + ix]) continue;
  for (let sidx = 0; sidx < 16; sidx++) {
    const ox = -map.half + ix + ((sidx % 4) + 0.5) / 4;
    const oz = -map.half + iz + (Math.floor(sidx / 4) + 0.5) / 4;
    for (let d = 0; d < 8; d++) {
      const p = { x: ox + Math.cos((d * Math.PI) / 4) * 0.6, z: oz + Math.sin((d * Math.PI) / 4) * 0.6 };
      pushOut(p, 0.4, boxes, map.half);
      const inside = boxes.find((b) => p.x > b.x0 + 0.05 && p.x < b.x1 - 0.05 && p.z > b.z0 + 0.05 && p.z < b.z1 - 0.05);
      if (inside) { fail.push(`push-out left a body inside box ${JSON.stringify({ x0: inside.x0, x1: inside.x1, z0: inside.z0, z1: inside.z1 })} (from ${ox},${oz})`); break pushCheck; }
    }
  }
}
for (let k = 0; k < 2000; k++) {
  const q = snapToWalkable(grid, (Math.random() * 2 - 1) * map.half, (Math.random() * 2 - 1) * map.half);
  if (!walk[cellOf(grid, q.x, q.z)]) { fail.push(`snapToWalkable returned a solid cell ${q.x},${q.z}`); break; }
}

console.log(`${map.id}: ${2 * map.half} × ${2 * map.half} m, ${walkable} m² walkable, ${boxes.length} solid boxes, ${map.spawns.length} spawns`);
const pngAt = process.argv.indexOf("--png");
if (pngAt > 0) {
  const { PNG } = await import("pngjs").catch(() => ({ PNG: null }));
  const out = process.argv[pngAt + 1];
  const s = 6;
  const W = n * s;
  const px = Buffer.alloc(W * W * 3, 255);
  const put = (ix, iz, rgb) => { for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) { const o = (((n - 1 - iz) * s + a) * W + ix * s + b) * 3; px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; } };
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const x = ix - map.half + 0.5, z = iz - map.half + 0.5;
    const sq = map.squares.find((r) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1);
    put(ix, iz, !walk[iz * n + ix] ? [70, 70, 80] : sq?.role === "boss" ? [230, 200, 120] : sq ? [170, 210, 170] : [235, 235, 235]);
  }
  for (const sp of map.spawns) put(Math.floor(sp.x + map.half), Math.floor(sp.z + map.half), [220, 40, 40]);
  put(Math.floor(map.start.x + map.half), Math.floor(map.start.z + map.half), [40, 90, 230]);
  // Raw PPM if pngjs is absent; convert with any image tool.
  const { writeFileSync } = await import("node:fs");
  if (PNG) { const png = new PNG({ width: W, height: W }); for (let i = 0; i < W * W; i++) { png.data[i * 4] = px[i * 3]; png.data[i * 4 + 1] = px[i * 3 + 1]; png.data[i * 4 + 2] = px[i * 3 + 2]; png.data[i * 4 + 3] = 255; } writeFileSync(out, PNG.sync.write(png)); }
  else writeFileSync(out.replace(/\.png$/, ".ppm"), Buffer.concat([Buffer.from(`P6 ${W} ${W} 255\n`), px]));
  console.log(`preview: ${out}`);
}
if (fail.length) {
  console.error("FAILED:\n  " + fail.join("\n  "));
  process.exit(1);
}
console.log("ok");
