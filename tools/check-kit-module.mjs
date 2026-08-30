#!/usr/bin/env node
/**
 * Measure a village kit .glb the way the engine will see it.
 *
 * Two things about a generated module are invisible until it is in the scene, and
 * both shipped wrong in the first facade kit:
 *
 *  1. PROPORTIONS. `loadVillageProp` normalises ONE axis and lets the model's own
 *     proportions decide the other two, so a module can be the right height and
 *     the wrong shape. The sign bracket landed 2.05 m tall against a 0.50 m
 *     target; the awning landed 1.03 m thick against 0.25 m.
 *  2. ALBEDO. V5 asked for matte charcoal and the bakes came back near-white, at
 *     three to nine times the albedo of the brick they mount on — which reads as
 *     white plates stuck to the buildings under a midday key light.
 *
 * This prints both, in the same units the engine uses, so a regenerated module
 * can be accepted or rejected before it is copied into `public/`.
 *
 * Usage:
 *   check-kit-module.mjs <module.glb> <axis> <metres> [--yaw]
 *
 *   axis    height | width | depth   — which axis loadVillageProp drives
 *   --yaw   apply KIT_FACE_YAW (-90 deg about Y), i.e. every module except
 *           hvac and pilaster
 *
 * Albedo needs the `ktx` CLI (KTX-Software) on PATH to transcode KTX2 bakes; the
 * proportion report works without it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [file, axis, metresArg, ...rest] = process.argv.slice(2);
if (!file || !["height", "width", "depth"].includes(axis) || !metresArg) {
  console.error("usage: check-kit-module.mjs <module.glb> <height|width|depth> <metres> [--yaw]");
  process.exit(2);
}
const metres = Number(metresArg);
const yaw = rest.includes("--yaw");

// ---------------------------------------------------------------------------
// GLB parsing — JSON chunk plus the BIN chunk offset, no dependencies.
// ---------------------------------------------------------------------------

function readGlb(p) {
  const buf = fs.readFileSync(p);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${p} is not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  return { json, buf, binStart: 20 + jsonLen + 8 };
}

/** Local->world scale of the node carrying the mesh (tripo ships identity). */
function nodeScale(json) {
  const s = [1, 1, 1];
  for (const n of json.nodes ?? []) {
    if (n.mesh !== undefined && n.scale) {
      for (let i = 0; i < 3; i++) s[i] = Math.abs(n.scale[i]);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Proportions
// ---------------------------------------------------------------------------

const { json, buf, binStart } = readGlb(file);
const prim = json.meshes[0].primitives[0];
const acc = json.accessors[prim.attributes.POSITION];
const s = nodeScale(json);

let size = {
  x: (acc.max[0] - acc.min[0]) * s[0],
  y: (acc.max[1] - acc.min[1]) * s[1],
  z: (acc.max[2] - acc.min[2]) * s[2],
};
// KIT_FACE_YAW is -90 deg about Y, which swaps the X and Z extents.
if (yaw) size = { x: size.z, y: size.y, z: size.x };

const driven = axis === "height" ? size.y : axis === "width" ? size.x : size.z;
if (!(driven > 1e-6)) throw new Error("degenerate bbox on the driven axis");
const scale = metres / driven;
const out = { width: size.x * scale, height: size.y * scale, depth: size.z * scale };

console.log(`${path.basename(file)}  (drive ${axis} -> ${metres} m${yaw ? ", face-yawed" : ""})`);
console.log(
  `  in-world:  W ${out.width.toFixed(2)}  H ${out.height.toFixed(2)}  D ${out.depth.toFixed(2)}  m`
);

// ---------------------------------------------------------------------------
// Albedo — 95th-percentile LINEAR luminance of the texels that are actually used.
//
// The 95th percentile, not the mean: a bake is mostly unused UV gutter plus dark
// recesses, and what reads as a "white plate" in the scene is the bright cluster.
// Linear, not sRGB, because that is the space the shader multiplies in and the
// space `PALETTE`/`VILLAGE_DAY` albedo values are written in.
// ---------------------------------------------------------------------------

function baseColorImage() {
  const mat = json.materials?.[0];
  const ti = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (ti === undefined) return null;
  const tex = json.textures[ti];
  const src = tex.source ?? tex.extensions?.KHR_texture_basisu?.source;
  if (src === undefined) return null;
  const img = json.images[src];
  const bv = json.bufferViews[img.bufferView];
  return {
    mime: img.mimeType ?? "",
    bytes: buf.subarray(binStart + (bv.byteOffset ?? 0), binStart + (bv.byteOffset ?? 0) + bv.byteLength),
  };
}

const img = baseColorImage();
if (!img) {
  console.log("  albedo:    no baseColorTexture (untextured module)");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kitcheck-"));
  try {
    let png;
    if (img.mime.includes("ktx2")) {
      const k = path.join(tmp, "base.ktx2");
      fs.writeFileSync(k, img.bytes);
      const dir = path.join(tmp, "base.png");
      execFileSync("ktx", ["extract", "--transcode", "rgba8", "--all", k, dir], { stdio: "pipe" });
      png = path.join(dir, "output_level0.png");
    } else {
      png = path.join(tmp, `base.${img.mime.includes("png") ? "png" : "jpg"}`);
      fs.writeFileSync(png, img.bytes);
    }
    // PNG/JPEG decode is the one thing node has no builtin for; PIL is already a
    // dependency of every other script in this directory.
    const py = `
import numpy as np
from PIL import Image
a = np.asarray(Image.open(${JSON.stringify(png)}).convert("RGB"), dtype=np.float64) / 255.0
lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
w = [0.2126, 0.7152, 0.0722]
srgb_l = (a * w).sum(2)
lin_l = (lin * w).sum(2)
vis = lin_l[srgb_l > 0.06]          # drop the unused UV gutter
print("%.3f %.3f" % (np.percentile(vis, 95), (srgb_l[srgb_l > 0.06] > 0.75).mean() * 100))
`;
    const res = execFileSync("python3", ["-c", py], { encoding: "utf8" }).trim().split(/\s+/);
    const p95 = Number(res[0]);
    const pctWhite = Number(res[1]);
    // Reference points, all linear: brick shells ~0.10, VILLAGE_DAY.shell 0.30,
    // VILLAGE_DAY.marble 0.52.
    //
    // BOTH bounds matter, and the lower one was learned the hard way: this script
    // originally only flagged bright modules, so it passed a regenerated sign
    // bracket at 0.082 — darker than the brick behind it — and a 2.5 x 2.1 m blank
    // panel read as a black hole punched in the facade. "Too dark to sit on the
    // wall" is the same authoring error as "too bright", just mirrored.
    const verdict =
      p95 > 0.55
        ? "TOO BRIGHT — reads as a white plate on the wall"
        : p95 < 0.12
          ? "TOO DARK — at or below the brick, reads as a hole in the wall"
          : "in range";
    console.log(`  albedo:    p95 linear ${p95.toFixed(3)}  (${pctWhite.toFixed(1)}% of texels > 0.75 sRGB)`);
    console.log(`             brick ~0.10 | shell 0.30 | marble 0.52  ->  ${verdict}`);
    if (p95 > 0.32 || p95 < 0.28) {
      const f = 0.3 / p95;
      console.log(
        `  KIT_ALBEDO_TINT factor to land 0.30: ${f.toFixed(2)} (${f < 1 ? "scales down" : "scales up"})`
      );
    }
  } catch (err) {
    console.log(`  albedo:    could not measure (${err.message.split("\n")[0]})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
