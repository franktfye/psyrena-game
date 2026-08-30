#!/usr/bin/env node
/**
 * Post-export cleanup pass for hero/prop GLBs: resample → dedup → prune via
 * the global gltf-transform CLI, then report where the bytes live.
 *
 *   node tools/optimize-hero-glb.mjs in.glb          # in-place, saves in.glb.bak
 *   node tools/optimize-hero-glb.mjs in.glb out.glb
 *
 * Why this exists: exporters (tripo anim retarget among them) can emit
 * bufferViews far larger than the accessor data inside them. freud.glb
 * shipped with 25 MB of such dead padding — 78 bufferViews of ~326 KB each
 * backing 8-byte accessors — and ANY gltf-transform write repacks buffers
 * and drops it. So every GLB must pass through here (or any other
 * gltf-transform stage, e.g. the simplify/UASTC runbooks) before public/.
 * The "waste" column in the report is the tell: file bytes no accessor or
 * image actually references. Anything above ~5% deserves a look.
 *
 * simplify and UASTC are deliberately NOT run here — both change the look
 * and want per-asset ratios; see assets/work/<asset>/README.md runbooks.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

function stats(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
  const comp = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const num = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const accBytes = (a) => a.count * comp[a.componentType] * num[a.type];

  const animAcc = new Set();
  for (const an of json.animations ?? [])
    for (const s of an.samplers) {
      animAcc.add(s.input);
      animAcc.add(s.output);
    }
  let animBytes = 0;
  for (const i of animAcc) animBytes += accBytes(json.accessors[i]);

  let meshBytes = 0;
  let tris = 0;
  for (const m of json.meshes ?? [])
    for (const p of m.primitives) {
      for (const i of Object.values(p.attributes)) meshBytes += accBytes(json.accessors[i]);
      if (p.indices !== undefined) {
        meshBytes += accBytes(json.accessors[p.indices]);
        tris += json.accessors[p.indices].count / 3;
      }
    }

  let imageBytes = 0;
  for (const im of json.images ?? [])
    if (im.bufferView !== undefined) imageBytes += json.bufferViews[im.bufferView].byteLength;

  let referenced = imageBytes;
  for (const a of json.accessors ?? []) if (a.bufferView !== undefined) referenced += accBytes(a);
  const binBytes = (json.buffers ?? []).reduce((s, b) => s + b.byteLength, 0);

  return {
    file: statSync(path).size,
    tris: Math.round(tris),
    clips: (json.animations ?? []).length,
    meshBytes,
    animBytes,
    imageBytes,
    waste: Math.max(0, binBytes - referenced),
  };
}

const mb = (n) => (n / 1e6).toFixed(2).padStart(7) + " MB";
function report(label, s) {
  console.log(
    `${label.padEnd(7)} ${mb(s.file)} | mesh ${mb(s.meshBytes)} (${s.tris} tris) | ` +
      `anim ${mb(s.animBytes)} (${s.clips} clips) | tex ${mb(s.imageBytes)} | waste ${mb(s.waste)}`,
  );
}

const [input, output = input] = process.argv.slice(2);
if (!input) {
  console.error("usage: node tools/optimize-hero-glb.mjs in.glb [out.glb]");
  process.exit(1);
}

const before = stats(input);
if (output === input) copyFileSync(input, input + ".bak");
const run = (args) => execFileSync("gltf-transform", args, { stdio: ["ignore", "ignore", "inherit"] });
run(["resample", input, output]);
run(["dedup", output, output]);
run(["prune", output, output]);
const after = stats(output);

report("before", before);
report("after", after);
console.log(`${basename(output)}: ${mb(before.file).trim()} -> ${mb(after.file).trim()}`);
if (after.waste > after.file * 0.05)
  console.warn(`WARNING: ${mb(after.waste).trim()} still unreferenced after repack — inspect bufferViews`);
