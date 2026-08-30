#!/usr/bin/env node
/**
 * Build the Pavlov hero clip set from a Tripo rig-and-animate export into the
 * engine's clip vocabulary (idle/walk/run/cast/cast_e/cast_r/cast_f/hit/death/
 * jump_start — the keys arenaHero.ts and createHeroAnimator resolve).
 *
 *   node tools/build-pavlov-hero.mjs in.glb out.glb [--spec probe|final]
 *
 * ★ 2026-08-04: retargeted onto the SECOND Tripo pass
 * (assets/work/pavlov/tripo-out/pavlov-animation.glb) — same 622 426-vertex
 * Pavlov mesh, re-rigged on a UE-style skeleton (root/pelvis/spine_01…) and
 * exported with NINE NAMED clips instead of the first pass's nine unnamed
 * NlaTrack.* groups. Because the source clips are now one-action-each, every
 * entry below takes the WHOLE clip: no `t0`/`t1`, no cutting a motion off in
 * the middle. The window machinery is kept because it is what synthesizes
 * exact boundary keys, and `--probe` may still want it.
 *
 * Slicing (when a window IS given): each new clip copies the source channels
 * restricted to a time window, with exact boundary keys synthesized by
 * lerp/nlerp so a cut in the middle of a sparse span doesn't shift the pose.
 * Locomotion/jump clips are made in-place by removing the LINEAR DRIFT of the
 * root-translation node (fit a+b*t per axis, subtract b*t): net travel goes,
 * bob/lean stays, and it works whatever world axis the rig's forward maps to.
 *
 * One source clip may feed two outputs (Melee_Hook serves both E and R) —
 * the spec is keyed by OUTPUT name, so duplicates are just two entries.
 *
 * This writes raw appended buffers; run tools/optimize-hero-glb.mjs after
 * (any gltf-transform pass repacks and drops the slack).
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

const [inPath, outPath, specFlag] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: build-pavlov-hero.mjs in.glb out.glb [--probe]");
  process.exit(2);
}
const PROBE = specFlag === "--probe";

// output name -> { src, inPlace?, t0?, t1? }. Omit the window and the whole
// source clip is copied — the default now that the source is one action per
// clip. The nine sources are: Backflip, Chop_Tree, Death_A, Hit_Knockback,
// Idle_FoldArms, Jog, Melee_Hook, NinjaJump_Idle, Walk.
const FINAL = {
  idle: { src: "Idle_FoldArms" },
  run: { src: "Jog", inPlace: true },
  walk: { src: "Walk", inPlace: true },
  // The bell arm-swing: NS (LMB) and UCS/CS (1) both play it. 0.96 s, which
  // is what a 2 s bell cadence has room for.
  cast: { src: "Chop_Tree" },
  // Both non-ultimate skills take the hook — a short forward jab that reads
  // as presenting something at arm's length. E and R differ by speed ratio,
  // not by clip (arenaHero.ts), and 0.46 s is short enough that the ratio
  // floor there is what keeps E legible.
  cast_e: { src: "Melee_Hook" },
  cast_r: { src: "Melee_Hook" },
  // F Extinction gets its own clip — the one skill big enough to earn a
  // full-body 2 s takeover, and the reason `cast_f` exists as a lookup.
  cast_f: { src: "NinjaJump_Idle" },
  hit: { src: "Hit_Knockback" },
  death: { src: "Death_A" },
  // The only clip that leaves the ground. No `jump_land` in this export; the
  // animators already treat a missing landing clip as "blend straight back
  // into locomotion", so the lookup simply finds nothing.
  jump_start: { src: "Backflip", inPlace: true },
};
const PROBE_EXTRA = {};
const SPEC = PROBE ? { ...FINAL, ...PROBE_EXTRA } : FINAL;

const { json: j, bin } = parseGlb(inPath);
const COMP = { 5126: Float32Array };
function readAcc(i) {
  const a = j.accessors[i];
  if (!COMP[a.componentType]) throw new Error(`accessor ${i}: componentType ${a.componentType}`);
  const bv = j.bufferViews[a.bufferView];
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const arr = new COMP[a.componentType](a.count * width);
  for (let k = 0; k < arr.length; k++) arr[k] = bin.readFloatLE(off + k * 4);
  return { arr, width, type: a.type };
}

const extraChunks = [];
let extraLen = 0;
function pushAcc(arr, type) {
  const buf = Buffer.alloc(arr.length * 4);
  for (let k = 0; k < arr.length; k++) buf.writeFloatLE(arr[k], k * 4);
  const byteOffset = bin.length + extraLen;
  extraChunks.push(buf);
  extraLen += buf.length;
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const count = arr.length / width;
  j.bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length });
  const acc = { bufferView: j.bufferViews.length - 1, componentType: 5126, count, type };
  if (type === "SCALAR") {
    acc.min = [Math.min(...arr)];
    acc.max = [Math.max(...arr)];
  }
  j.accessors.push(acc);
  return j.accessors.length - 1;
}

const lerpN = (a, b, t, w) => {
  const out = new Array(w);
  for (let c = 0; c < w; c++) out[c] = a[c] + (b[c] - a[c]) * t;
  if (w === 4) {
    // nlerp with hemisphere fix — adjacent keys, good enough at cut points
    let dot = 0;
    for (let c = 0; c < 4; c++) dot += a[c] * b[c];
    if (dot < 0) for (let c = 0; c < 4; c++) out[c] = a[c] + (-b[c] - a[c]) * t;
    const l = Math.hypot(...out) || 1;
    for (let c = 0; c < 4; c++) out[c] /= l;
  }
  return out;
};

// The node whose translation carries net travel. "Hip" was the first Tripo
// rig's name for it, "pelvis" is the second's — and on both it is the ONLY
// node with a translation channel, so that is the check, with the names as a
// fast path. Getting this wrong silently ships sliding locomotion.
const hipIndex = (() => {
  const byName = j.nodes.findIndex((n) => n.name === "Hip" || n.name === "pelvis");
  if (byName >= 0) return byName;
  for (const a of j.animations)
    for (const ch of a.channels) if (ch.target.path === "translation") return ch.target.node;
  return -1;
})();
if (hipIndex < 0) throw new Error("no root-translation node found — in-place clips would slide");
const newAnims = [];
for (const [name, s] of Object.entries(SPEC)) {
  const src = j.animations.find((a) => a.name === s.src);
  if (!src) throw new Error(`no source animation ${s.src}`);
  // No window given → the whole clip, boundaries taken from the accessors so
  // a source that starts at t=0.042 is not silently shifted to 0.
  if (s.t0 === undefined || s.t1 === undefined) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const sam of src.samplers) {
      const acc = j.accessors[sam.input];
      if (acc.min) lo = Math.min(lo, acc.min[0]);
      if (acc.max) hi = Math.max(hi, acc.max[0]);
    }
    s.t0 = s.t0 ?? lo;
    s.t1 = s.t1 ?? hi;
  }
  const anim = { name, channels: [], samplers: [] };
  for (const ch of src.channels) {
    const sam = src.samplers[ch.sampler];
    const { arr: times } = readAcc(sam.input);
    const { arr: vals, width, type } = readAcc(sam.output);
    const key = (i) => Array.from(vals.slice(i * width, (i + 1) * width));
    const sample = (t) => {
      if (t <= times[0]) return key(0);
      if (t >= times[times.length - 1]) return key(times.length - 1);
      let i = 0;
      while (times[i + 1] < t) i++;
      const span = times[i + 1] - times[i] || 1;
      return lerpN(key(i), key(i + 1), (t - times[i]) / span, width);
    };
    const outT = [s.t0];
    const outV = [sample(s.t0)];
    for (let i = 0; i < times.length; i++) {
      if (times[i] > s.t0 + 1e-4 && times[i] < s.t1 - 1e-4) {
        outT.push(times[i]);
        outV.push(key(i));
      }
    }
    outT.push(s.t1);
    outV.push(sample(s.t1));
    if (s.inPlace && ch.target.node === hipIndex && ch.target.path === "translation") {
      // least-squares line fit per axis; subtract only the b*t drift
      const n = outT.length;
      const mt = outT.reduce((a2, b2) => a2 + b2, 0) / n;
      for (let c = 0; c < 3; c++) {
        const mv = outV.reduce((a2, v) => a2 + v[c], 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (outT[i] - mt) * (outV[i][c] - mv);
          den += (outT[i] - mt) ** 2;
        }
        const b2 = den > 1e-8 ? num / den : 0;
        for (let i = 0; i < n; i++) outV[i][c] -= b2 * (outT[i] - outT[0]);
      }
    }
    const flatT = new Float32Array(outT.map((t) => t - s.t0));
    const flatV = new Float32Array(outV.flat());
    const sIdx = anim.samplers.length;
    anim.samplers.push({
      input: pushAcc(flatT, "SCALAR"),
      interpolation: sam.interpolation ?? "LINEAR",
      output: pushAcc(flatV, type),
    });
    anim.channels.push({ sampler: sIdx, target: { ...ch.target } });
  }
  newAnims.push(anim);
  console.log(`${name}: ${s.src} [${s.t0}..${s.t1}] ${anim.channels.length}ch`);
}
j.animations = newAnims;
j.buffers[0].byteLength = bin.length + extraLen;
writeGlb(outPath, j, Buffer.concat([bin, ...extraChunks]));
console.log("wrote", outPath);
