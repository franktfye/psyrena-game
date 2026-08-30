#!/usr/bin/env node
/**
 * Stitch two clips into one: A plays whole, then B is appended (optionally
 * repeated) after a blend gap. Written for Pavlov's death (2026-08-04):
 * `Death_A`'s collapse followed by `Sleeping`'s breathing loop, baked as ONE
 * clip because the arena/village animators play `death` once and hold the
 * final frame — a baked composite needs no code and works everywhere.
 *
 *   node tools/stitch-clips.mjs a.glb CLIP_A b.glb CLIP_B out.glb \
 *     --name death [--gap 0.4] [--repeat 3]
 *
 * The two glbs may be different FILES but must be the same RIG: channels are
 * matched by node NAME, and the script refuses on a name mismatch. The output
 * is a copy of b.glb with the composite clip added (replacing any clip of the
 * same name). The seam is not authored: the gap between A's last key and B's
 * first key is left to glTF LINEAR interpolation, which IS the crossfade —
 * with the usual quaternion hemisphere fix (B's whole track is negated per
 * joint when the seam dot-product is negative, q ≡ -q).
 *
 * `--repeat` appends B's keys N times end-to-end (first key of each repeat
 * skipped — a loop clip's first and last keys are the same pose). Repeats are
 * for "the pose breathes for a while, then freezes": long enough that the
 * freeze lands after the camera has moved on.
 *
 * `--cut-a SECONDS` drops A's keys past that time, and exists because WHERE
 * you leave A decides what the seam blend reads as. Death_A ends face-DOWN
 * and Sleeping lies face-UP — stitched whole, the gap is a corpse rolling
 * over. Cut at the kneeling apex (~2.8 s) and the same blend is a backward
 * fall into the supine pose instead.
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

const NUM = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function readAcc(g, i) {
  const a = g.json.accessors[i];
  const bv = g.json.bufferViews[a.bufferView];
  const n = NUM[a.type];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = bv.byteStride ?? n * 4;
  const out = [];
  for (let k = 0; k < a.count; k++) {
    const el = [];
    for (let c = 0; c < n; c++) el.push(g.bin.readFloatLE(base + k * stride + c * 4));
    out.push(el);
  }
  return out;
}

/** Clip → Map "nodeName/path" → {times:[...], values:[[..],..]} */
function channels(g, clipName) {
  const anim = g.json.animations?.find((a) => a.name === clipName);
  if (!anim) throw new Error(`clip "${clipName}" not found (have: ${g.json.animations?.map((a) => a.name).join(", ")})`);
  const out = new Map();
  for (const ch of anim.channels) {
    if (ch.target.node === undefined) continue;
    const s = anim.samplers[ch.sampler];
    if ((s.interpolation ?? "LINEAR") === "CUBICSPLINE") throw new Error("CUBICSPLINE not supported");
    out.set(`${g.json.nodes[ch.target.node].name}/${ch.target.path}`, {
      times: readAcc(g, s.input).map((t) => t[0]),
      values: readAcc(g, s.output),
    });
  }
  return out;
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--") && !/^[\d.]+$/.test(a));
const [aPath, aClip, bPath, bClip, outPath] = positional;
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const outName = opt("--name");
const gap = parseFloat(opt("--gap", "0.4"));
const repeat = parseInt(opt("--repeat", "1"), 10);
const cutA = opt("--cut-a") ? parseFloat(opt("--cut-a")) : Infinity;
if (!outPath || !outName) {
  console.error(
    "usage: stitch-clips.mjs a.glb CLIP_A b.glb CLIP_B out.glb --name NAME [--gap 0.4] [--repeat 3] [--cut-a 2.8]"
  );
  process.exit(2);
}

const A = parseGlb(aPath);
const B = parseGlb(bPath);
const chA = channels(A, aClip);
const chB = channels(B, bClip);

if (cutA !== Infinity)
  for (const c of chA.values()) {
    const n = c.times.filter((t) => t <= cutA).length;
    c.times = c.times.slice(0, Math.max(1, n));
    c.values = c.values.slice(0, Math.max(1, n));
  }

const durA = Math.max(...[...chA.values()].map((c) => c.times[c.times.length - 1]));
const durB = Math.max(...[...chB.values()].map((c) => c.times[c.times.length - 1]));

const keys = new Set([...chA.keys(), ...chB.keys()]);
const onlyA = [...keys].filter((k) => !chB.has(k));
const onlyB = [...keys].filter((k) => !chA.has(k));
if (onlyA.length || onlyB.length)
  console.warn(`unpaired channels — A-only: ${onlyA.join(", ") || "none"}; B-only: ${onlyB.join(", ") || "none"}`);

const byName = new Map(B.json.nodes.map((n, i) => [n.name, i]));

// Build composite tracks. B is appended `repeat` times starting at durA+gap;
// each repeat drops its first key (same pose as the previous repeat's last).
const tracks = [];
for (const key of keys) {
  const [nodeName, path] = key.split("/");
  const ti = byName.get(nodeName);
  if (ti === undefined) throw new Error(`node "${nodeName}" missing in ${bPath} — not the same rig`);
  const a = chA.get(key);
  const bTrack = chB.get(key);
  const times = [];
  const values = [];
  if (a) {
    times.push(...a.times);
    values.push(...a.values);
  }
  if (bTrack) {
    let bValues = bTrack.values;
    if (path === "rotation" && a) {
      const la = a.values[a.values.length - 1];
      const fb = bTrack.values[0];
      if (la[0] * fb[0] + la[1] * fb[1] + la[2] * fb[2] + la[3] * fb[3] < 0)
        bValues = bValues.map((q) => q.map((v) => -v));
    }
    for (let r = 0; r < repeat; r++) {
      const off = durA + gap + r * durB - bTrack.times[0];
      for (let k = r === 0 ? 0 : 1; k < bTrack.times.length; k++) {
        times.push(bTrack.times[k] + off);
        values.push(bValues[k]);
      }
    }
  }
  tracks.push({ ti, path, times, values });
}

// Append accessors to B's BIN.
let bin = B.bin;
const j = B.json;
function push(flat, type, withMinMax) {
  const buf = Buffer.alloc(flat.length * 4);
  flat.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  const pad = (4 - (bin.length % 4)) % 4;
  if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  j.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: buf.length });
  bin = Buffer.concat([bin, buf]);
  const acc = { bufferView: j.bufferViews.length - 1, componentType: 5126, count: flat.length / NUM[type], type };
  if (withMinMax) {
    acc.min = [Math.min(...flat)];
    acc.max = [Math.max(...flat)];
  }
  j.accessors.push(acc);
  return j.accessors.length - 1;
}

const samplers = [];
const chans = [];
for (const t of tracks) {
  const input = push(t.times, "SCALAR", true);
  const output = push(t.values.flat(), t.path === "rotation" ? "VEC4" : "VEC3", false);
  samplers.push({ input, output, interpolation: "LINEAR" });
  chans.push({ sampler: samplers.length - 1, target: { node: t.ti, path: t.path } });
}
const clip = { name: outName, samplers, channels: chans };
const existing = j.animations.findIndex((an) => an.name === outName);
if (existing >= 0) j.animations[existing] = clip;
else j.animations.push(clip);

j.buffers[0].byteLength = bin.length;
writeGlb(outPath, j, bin);
console.log(
  `${aClip} (${durA.toFixed(2)}s) + ${gap}s gap + ${repeat}×${bClip} (${durB.toFixed(2)}s) → "${outName}" ` +
    `${(durA + gap + repeat * durB).toFixed(2)}s, ${chans.length} channels`
);
