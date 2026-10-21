/**
 * "Old Kowloon in the Fog": the survival map (docs/survival-design.md §12).
 * 110 × 110 m, about 4× the village's area. +z is north (the harbour).
 *
 *   z  55 ┌─────────────── water ───────────────┐
 *      44 │ blk │  promenade 11 m (waterfront)   │
 *      32 │ blk │ blk │ blk │ blk │ blk │ blk   │
 *      20 ├─────── cross street 12 m ───────────┤
 *         │ blk │ ┌ TEMPLE SQUARE ┐ │ blk │ WET │
 *         │TRAM │ │  34 × 34 boss │ │     │ MKT │
 *     -14 │ blk │ └───────────────┘ │ blk │     │
 *     -23 ├─────── side street 9 m ─────────────┤
 *     -32 │ blk │ blk │ main │ blk │ blk │ blk   │
 *     -55 └──────── retaining wall ─────────────┘
 *         -55   -38  -29   -7  7   29  38      55   x
 *
 * Nothing walkable is narrower than 9 m (verify: tools/verify-survival-map.mjs).
 */
import type { MapDef } from "./layout.ts";

export const OLD_KOWLOON: MapDef = {
  id: "oldKowloon",
  half: 55,
  streets: [
    { name: "Main Road", x0: -7, x1: 7, z0: -55, z1: 46 },
    { name: "Waterfront Promenade", x0: -55, x1: 55, z0: 44, z1: 55 },
    { name: "Cross Street", x0: -55, x1: 55, z0: 20, z1: 32 },
    { name: "South Lane", x0: -55, x1: 55, z0: -32, z1: -23 },
    { name: "West Lane", x0: -38, x1: -29, z0: -55, z1: 44 },
    { name: "East Lane", x0: 29, x1: 38, z0: -55, z1: 44 },
  ],
  squares: [
    { name: "Temple Square", role: "boss", x0: -17, x1: 17, z0: -14, z1: 20 },
    { name: "Wet Market", role: "elite", x0: 29, x1: 49, z0: -10, z1: 10 },
    { name: "Tram Terminus", role: "elite", x0: -49, x1: -29, z0: -23, z1: -3 },
  ],
  obstacles: [
    // Banyans in the temple square's north corners, clear of the fighting floor.
    { name: "Banyan NW", x0: -16, x1: -12, z0: 15, z1: 19 },
    { name: "Banyan NE", x0: 12, x1: 16, z0: 15, z1: 19 },
    // Tram terminus: the shelter along the south edge, a parked tram mid-square.
    { name: "Tram Shelter", x0: -47, x1: -37, z0: -22, z1: -19 },
    { name: "Tram", x0: -47, x1: -38, z0: -10, z1: -7.4 },
    // A minibus pulled up on the cross street's north kerb.
    { name: "Minibus", x0: 40, x1: 46, z0: 29.6, z1: 31.8 },
  ],
  spawns: [
    { x: -53, z: 26 }, { x: 53, z: 26 },      // cross street ends
    { x: -53, z: -27.5 }, { x: 53, z: -27.5 }, // south lane ends
    { x: -33.5, z: -53 }, { x: 33.5, z: -53 }, // west / east lane, south ends
    { x: 0, z: -53 },                          // main road at the retaining wall
    { x: -53, z: 49.5 }, { x: 53, z: 49.5 },   // promenade ends
  ],
  start: { x: 0, z: 3 },
  bossGates: [
    { x0: -17, x1: 17, z0: 19, z1: 21 },   // north: the square's whole edge on the cross street
    { x0: -7, x1: 7, z0: -15, z1: -13 },   // south: the main road mouth
  ],
};
