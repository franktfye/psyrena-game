#!/usr/bin/env node
/**
 * Transplant animation clips from a retargeted export into a shipped hero glb
 * whose SKELETON matches by bone NAME but not by node table.
 *
 *   node tools/merge-retargeted-anims.mjs target.glb source.glb out.glb \
 *     "SrcClip:out_name[@inplace],SrcClip2:other_name"
 *
 * Why this exists: merge-glb-animations.mjs demands byte-identical node
 * tables — the right contract when both glbs come from the same Tripo rig
 * task. The 2026-08 retarget passes (Tripo for Pavlov, mesh2motion for
 * Skinner) ship the same UE-style bone names on a DIFFERENT node table:
 * an extra scene root, and (Pavlov) 28 finger bones the shipped 39-node rig
 * never had. So this tool rebinds each channel to the target node carrying
 * the same bone name and DROPS channels whose bone has no counterpart —
 * finger curls the shipped rig cannot express anyway.
 *
 * A mapping's output name REPLACES any existing clip of that name (the
 * orphaned data is left for gltf-transform prune — run
 * tools/optimize-hero-glb.mjs after, as with every glb headed for public/).
 * `@inplace` strips net travel from every translation channel. The
 * build-*-hero.mjs specs least-squares-detrend, which is right for CYCLIC
 * clips (walk/run) — but on one-shots with asymmetric curves it tilts the
 * whole track and can leave the END pose further from the start than the raw
 * clip (a jump_land with 0.06 net came out 0.46 displaced). One-shots want
 * their boundary poses to agree so blending out lands on the locomotion pose,
 * so this pins endpoints instead: subtract the first→last ramp per axis.
 * Net travel goes to exactly zero, bob/dip keeps its shape.
 *
 * Translation keys are always REBASED onto the target rig's stance: rotation
 * channels transplant cleanly (same bone names, same root frame), but pelvis
 * translations are authored against the SOURCE rig's standing hip height —
 * mesh2motion's library rig stands with its hip at ~0.87, the shipped heroes
 * at ~0.47, so raw keys hover the whole character ~0.4 off the ground. Each
 * key becomes  ref + (key − src_rest) × |ref|/|src_rest|,  where src_rest is
 * the source pelvis rest translation (grounded clips hold exactly this — see
 * Defend/NinjaJump_Idle) and ref is the pelvis translation on the first key
 * of the target's own `idle`, the one pose known to stand on the ground.
 */
import { readFileSync, writeFileSync } from "node:fs";

function parseGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
  const binHeader = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binHeader);
  const bin = Buffer.from(buf.slice(binHeader + 8, binHeader + 8 + binLen));
  return { json, bin };
}
function writeGlb(path, json, bin) {
  const pad4 = (n) => (n + 3) & ~3;
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  const bh = 20 + jsonBuf.length;
  out.writeUInt32LE(binPadded.length, bh);
  out.writeUInt32LE(0x004e4942, bh + 4);
  binPadded.copy(out, bh + 8);
  writeFileSync(path, out);
}

const [targetPath, sourcePath, outPath, mapArg] = process.argv.slice(2);
if (!mapArg) {
  console.error(
    'usage: merge-retargeted-anims.mjs target.glb source.glb out.glb "Src:out[@inplace],..."',
  );
  process.exit(2);
}
const mappings = mapArg.split(",").map((entry) => {
  const [src, spec] = entry.split(":");
  const [outName, flag] = spec.split("@");
  return { src, outName, inPlace: flag === "inplace" };
});

const target = parseGlb(targetPath);
const source = parseGlb(sourcePath);
const tj = target.json;
const sj = source.json;

const targetByName = new Map();
tj.nodes.forEach((n, i) => {
  if (n.name) targetByName.set(n.name, i);
});

function readAcc(j, bin, i) {
  const a = j.accessors[i];
  if (a.componentType !== 5126) throw new Error(`accessor ${i}: componentType ${a.componentType}`);
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  const bv = j.bufferViews[a.bufferView];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const arr = new Float32Array(a.count * width);
  for (let k = 0; k < arr.length; k++) arr[k] = bin.readFloatLE(off + k * 4);
  return { arr, width, type: a.type };
}

// Pin endpoints: subtract the first→last ramp per axis so the clip ends on
// the pose it started from (see the header for why this beats detrending on
// one-shots).
function stripDrift(times, vals, width) {
  const n = times.length;
  if (n < 2) return;
  const t0 = times[0];
  const span = times[n - 1] - t0;
  if (span < 1e-9) return;
  for (let axis = 0; axis < width; axis++) {
    const rate = (vals[(n - 1) * width + axis] - vals[axis]) / span;
    for (let k = 0; k < n; k++) vals[k * width + axis] -= rate * (times[k] - t0);
  }
}

// Grounded pelvis reference: target idle's first translation key vs the
// source pelvis rest — see the header note on rebasing.
function pelvisRef(j, bin, viaIdle) {
  if (!viaIdle) {
    const t = j.nodes.find((n) => n.name === "pelvis")?.translation;
    if (!t) throw new Error("source has no pelvis rest translation");
    return t;
  }
  const idle = (j.animations ?? []).find((a) => a.name === "idle");
  for (const ch of idle?.channels ?? []) {
    if (ch.target.path !== "translation") continue;
    if (j.nodes[ch.target.node]?.name !== "pelvis") continue;
    const { arr } = readAcc(j, bin, idle.samplers[ch.sampler].output);
    return [arr[0], arr[1], arr[2]];
  }
  throw new Error("target idle has no pelvis translation channel to rebase against");
}
const rebaseTo = pelvisRef(tj, target.bin, true);
const rebaseFrom = pelvisRef(sj, source.bin, false);
const rebaseScale =
  Math.hypot(...rebaseTo) / Math.hypot(...rebaseFrom);

function rebase(vals, width) {
  if (width !== 3) return;
  for (let k = 0; k < vals.length; k += 3)
    for (let a = 0; a < 3; a++)
      vals[k + a] = rebaseTo[a] + (vals[k + a] - rebaseFrom[a]) * rebaseScale;
}

let bin = target.bin;
function appendAccessor(arr, type, withMinMax) {
  const pad = (4 - (bin.length % 4)) % 4;
  const byteOffset = bin.length + pad;
  const data = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  bin = Buffer.concat([bin, Buffer.alloc(pad), data]);
  tj.bufferViews.push({ buffer: 0, byteOffset, byteLength: arr.byteLength });
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const acc = {
    bufferView: tj.bufferViews.length - 1,
    componentType: 5126,
    count: arr.length / width,
    type,
  };
  if (withMinMax) {
    const min = Array(width).fill(Infinity);
    const max = Array(width).fill(-Infinity);
    for (let k = 0; k < arr.length; k++) {
      min[k % width] = Math.min(min[k % width], arr[k]);
      max[k % width] = Math.max(max[k % width], arr[k]);
    }
    acc.min = min;
    acc.max = max;
  }
  tj.accessors.push(acc);
  return tj.accessors.length - 1;
}

tj.animations ??= [];
for (const { src, outName, inPlace } of mappings) {
  const anim = (sj.animations ?? []).find((a) => a.name === src);
  if (!anim) throw new Error(`${sourcePath}: no clip named ${src}`);

  const replaced = tj.animations.findIndex((a) => a.name === outName);
  if (replaced >= 0) tj.animations.splice(replaced, 1);

  const channels = [];
  const samplers = [];
  const dropped = [];
  for (const ch of anim.channels) {
    const boneName = sj.nodes[ch.target.node]?.name;
    const targetNode = targetByName.get(boneName);
    if (targetNode === undefined) {
      dropped.push(boneName);
      continue;
    }
    const s = anim.samplers[ch.sampler];
    const input = readAcc(sj, source.bin, s.input);
    const output = readAcc(sj, source.bin, s.output);
    if (ch.target.path === "translation") {
      rebase(output.arr, output.width);
      if (inPlace) stripDrift(input.arr, output.arr, output.width);
    }
    samplers.push({
      input: appendAccessor(input.arr, "SCALAR", true),
      output: appendAccessor(output.arr, output.type, false),
      interpolation: s.interpolation ?? "LINEAR",
    });
    channels.push({
      sampler: samplers.length - 1,
      target: { node: targetNode, path: ch.target.path },
    });
  }
  tj.animations.push({ name: outName, channels, samplers });
  const note = [
    replaced >= 0 ? "replaced" : "new",
    inPlace ? "in-place" : null,
    dropped.length ? `dropped ${dropped.length} channels (${[...new Set(dropped)].length} bones)` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`${src} -> ${outName}: ${channels.length} channels (${note})`);
}

tj.buffers[0].byteLength = bin.length;
writeGlb(outPath, tj, bin);
console.log(`wrote ${outPath} (${(bin.length / 1e6).toFixed(1)} MB bin — run optimize-hero-glb.mjs)`);
