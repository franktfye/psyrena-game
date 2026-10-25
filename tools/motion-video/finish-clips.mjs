#!/usr/bin/env node
// Turn m2mr results into game clips on ONE textured hero model.
//
//   node tools/motion-video/finish-clips.mjs <hero> --character character.glb --runs <dir> --out <dir>
//
// <runs>/<clip>/mixamo_character.glb is m2mr's output for each clip; the cut
// for each comes from assets/work/<hero>/anim/specs/<clip>.cut.json (written by
// build-moves.mjs). Writes <out>/<hero>_<clip>.glb (the character + that one
// clip) and <out>/<hero>.glb (the character + every clip), all sharing the
// identical mesh, skeleton and textures of character.glb.
//
// Per clip, following the game's hero-clip contract (arenaHero.ts/villageHub.ts:
// in place, the controller owns translation and the jump arc):
//   - cut: loops take one period from the middle; one-shots their authored span;
//   - heading: m2mr's root heading (the camera looked from 25°) is rotated back
//     so the hero faces +Z, the rig's rest facing;
//   - root: horizontal drift pinned to the rest position (death keeps its fall);
//     height anchored so the clip stands at rest height at its aligned end, and
//     jump halves never rise (the engine flies the arc);
//   - loops: the end-vs-start error is spread over the cycle, so the seam is exact;
//   - units: m2mr writes metres, character.glb is in centimetres.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const [hero, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
if (!hero || !opt.character || !opt.runs || !opt.out) {
  console.error("usage: finish-clips.mjs <hero> --character character.glb --runs <dir> --out <dir> [--clips a,b] [--foot-fix off]");
  process.exit(1);
}
const FPS = 30;
const ORDER = ["idle", "walk", "run", "cast", "cast_e", "cast_r", "cast_f", "hit", "death", "jump_start", "jump_land"];

// ---- glb io ---------------------------------------------------------------------
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString());
  const bh = 20 + jl;
  const bin = buf.subarray(bh + 8, bh + 8 + buf.readUInt32LE(bh));
  return { json, bin };
}
function floats(g, accIndex) {
  const a = g.json.accessors[accIndex];
  if (a.componentType !== 5126 || a.sparse) throw new Error("expected plain float accessors");
  const bv = g.json.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  const stride = bv.byteStride ?? n * 4;
  const out = new Float32Array(a.count * n);
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = g.bin.readFloatLE(base + i * stride + k * 4);
  return { data: out, n };
}
function writeGlb(path, json, bin) {
  const js = Buffer.from(JSON.stringify(json));
  const jpad = Buffer.alloc((4 - (js.length % 4)) % 4, 0x20);
  const bpad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const J = Buffer.concat([js, jpad]), B = Buffer.concat([bin, bpad]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + B.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  writeFileSync(path, Buffer.concat([head, ch(J.length, 0x4e4f534a), J, ch(B.length, 0x004e4942), B]));
}

// ---- quaternion maths (x, y, z, w) -------------------------------------------------
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(...q); return q.map((x) => x / l); };
function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((x) => -x); d = -d; }
  if (d > 0.9995) return qnorm(a.map((x, i) => x + (b[i] - x) * t));
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((x, i) => (x * Math.sin((1 - t) * th) + b[i] * Math.sin(t * th)) / s);
}
const qyaw = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const rotV = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
const heading = (q) => { const f = rotV(q, [0, 0, 1]); return Math.atan2(f[0], f[2]); };

// ---- inputs ---------------------------------------------------------------------------
const char = readGlb(opt.character);
const nodeIndex = new Map(char.json.nodes.map((n, i) => [n.name, i]));
const hipsIdx = char.json.nodes.findIndex((n) => /Hips$/.test(n.name ?? ""));
const restT = char.json.nodes[hipsIdx].translation ?? [0, 0, 0];
const specDir = join(ROOT, "assets/work", hero, "anim/specs");
const want = opt.clips ? opt.clips.split(",") : ORDER;

// ---- foot pitch ------------------------------------------------------------------------
// m2mr aims Foot at ToeBase along the tracked human's foot, which stands at an
// ankle→toe slope of ~24° below horizontal (measured: 22.8–25.4° on both
// Erikson's and Ainsworth's idles). A rig whose rest slope is steeper — heeled
// boots: Ainsworth rests at 40–41° — therefore has its toes lifted by the
// difference in every frame (hers 5–6 cm off the floor). Pitch each Foot track
// down about the foot's own lateral axis by (rest slope − M2MR_FOOT_SLOPE).
const M2MR_FOOT_SLOPE = 24;
const parentOf = new Map();
char.json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
function restWorld(i) {
  const n = char.json.nodes[i];
  const q = n.rotation ?? [0, 0, 0, 1], t = n.translation ?? [0, 0, 0];
  if (!parentOf.has(i)) return { q, p: t };
  const P = restWorld(parentOf.get(i));
  const o = rotV(P.q, t);
  return { q: qmul(P.q, q), p: [P.p[0] + o[0], P.p[1] + o[1], P.p[2] + o[2]] };
}
const footFix = new Map();   // Foot node index → local-frame correction quaternion
for (const side of ["Left", "Right"]) {
  const fi = char.json.nodes.findIndex((n) => new RegExp(`${side}Foot$`).test(n.name ?? ""));
  const ti = char.json.nodes.findIndex((n) => new RegExp(`${side}ToeBase$`).test(n.name ?? ""));
  if (fi < 0 || ti < 0) continue;
  const F = restWorld(fi), T = restWorld(ti);
  const d = [T.p[0] - F.p[0], T.p[1] - F.p[1], T.p[2] - F.p[2]];
  const slope = (Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  const delta = slope - M2MR_FOOT_SLOPE;
  if (delta <= 1 || opt["foot-fix"] === "off") continue; // off: clips not from m2mr (pinoc-retarget.mjs)
  // Lateral axis: horizontal, perpendicular to the foot's heading (+X when it faces +Z).
  const h = Math.hypot(d[0], d[2]);
  const lat = rotV(qinv(F.q), [d[2] / h, 0, -d[0] / h]);   // into the foot's local frame
  const a = ((delta * Math.PI) / 180) / 2;
  footFix.set(fi, [lat[0] * Math.sin(a), lat[1] * Math.sin(a), lat[2] * Math.sin(a), Math.cos(a)]);
  console.log(`foot pitch: ${side} rest ${slope.toFixed(1)}° → toes down ${delta.toFixed(1)}°`);
}

/** One finished clip: { name, channels: [{ node, path, times, values, n }] }. */
function finish(name) {
  const cut = JSON.parse(readFileSync(join(specDir, `${name}.cut.json`), "utf8"));
  const src = readGlb(join(opt.runs, name, "mixamo_character.glb"));
  const anim = src.json.animations[0];
  const srcHips = src.json.nodes.find((n) => /Hips$/.test(n.name ?? ""));
  const k = restT[1] / (srcHips.translation ?? [0, 1, 0])[1]; // m → cm
  // Frame window.
  const f0 = Math.round(cut.start * FPS);
  const f1 = Math.round((cut.kind === "loop" ? cut.start + cut.period : cut.end) * FPS);
  const tracks = [];
  for (const ch of anim.channels) {
    const nodeName = src.json.nodes[ch.target.node].name;
    if (!nodeIndex.has(nodeName) || !["rotation", "translation"].includes(ch.target.path)) continue;
    const s = anim.samplers[ch.sampler];
    const { data, n } = floats(src, s.output);
    const frames = [];
    for (let f = f0; f <= f1; f++) {
      const i = Math.min(f, data.length / n - 1);
      frames.push(Array.from(data.subarray(i * n, i * n + n)));
    }
    tracks.push({ node: nodeIndex.get(nodeName), name: nodeName, path: ch.target.path, frames, n });
  }
  for (const t of tracks) {
    const fx = t.path === "rotation" && footFix.get(t.node);
    if (fx) t.frames = t.frames.map((q) => qnorm(qmul(q, fx)));
  }
  const hipsRot = tracks.find((t) => /Hips$/.test(t.name) && t.path === "rotation");
  const hipsPos = tracks.find((t) => /Hips$/.test(t.name) && t.path === "translation");

  // Heading: one constant yaw for the whole clip, measured where the clip is
  // anchored (cycle mean for loops, the aligned frame otherwise).
  const anchor = cut.alignEnd ? hipsRot.frames.length - 1 : 0;
  let yaw;
  if (cut.kind === "loop") {
    let sx = 0, sz = 0;
    for (const q of hipsRot.frames) { const h = heading(q); sx += Math.sin(h); sz += Math.cos(h); }
    yaw = Math.atan2(sx, sz);
  } else yaw = heading(hipsRot.frames[anchor]);
  const fix = qyaw(-yaw);
  hipsRot.frames = hipsRot.frames.map((q) => qnorm(qmul(fix, q)));

  if (hipsPos) {
    const p0 = hipsPos.frames[anchor];
    let ys = hipsPos.frames.map((p) => p[1]);
    const yRef = cut.kind === "loop" ? Math.max(...ys) : p0[1];
    hipsPos.frames = hipsPos.frames.map((p) => {
      const d = rotV(fix, [p[0] - p0[0], 0, p[2] - p0[2]]);
      let y = restT[1] + (p[1] - yRef) * k;
      if (cut.noRise) y = Math.min(y, restT[1]);
      const keep = cut.keepRoot;
      return [restT[0] + (keep ? d[0] * k : 0), y, restT[2] + (keep ? d[2] * k : 0)];
    });
  }

  // Seamless loops: spread the end-vs-start error over the cycle.
  if (cut.kind === "loop") {
    for (const t of tracks) {
      const last = t.frames.length - 1;
      if (t.path === "rotation") {
        const delta = qmul(qinv(t.frames[last]), t.frames[0]);
        t.frames = t.frames.map((q, i) => qnorm(qmul(q, qslerp([0, 0, 0, 1], delta, i / last))));
      } else {
        const e = t.frames[0].map((x, i) => x - t.frames[last][i]);
        t.frames = t.frames.map((v, i) => v.map((x, c) => x + e[c] * (i / last)));
      }
    }
  }
  return { name, tracks, frames: f1 - f0 + 1, kind: cut.kind };
}

// ---- assemble ---------------------------------------------------------------------------
function build(clips) {
  const json = structuredClone(char.json);
  const chunks = [char.bin];
  let off = char.bin.length;
  const push = (arr, type, minmax) => {
    const pad = (4 - (off % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
    const b = Buffer.from(new Float32Array(arr).buffer);
    json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length });
    chunks.push(b); off += b.length;
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const acc = { bufferView: json.bufferViews.length - 1, componentType: 5126, count: arr.length / n, type };
    if (minmax) { acc.min = [Math.min(...arr)]; acc.max = [Math.max(...arr)]; }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };
  json.animations = [];
  for (const c of clips) {
    const times = Array.from({ length: c.frames }, (_, i) => i / FPS);
    const input = push(times, "SCALAR", true);
    const A = { name: c.name, channels: [], samplers: [] };
    for (const t of c.tracks) {
      const output = push(t.frames.flat(), t.n === 4 ? "VEC4" : "VEC3");
      A.samplers.push({ input, output, interpolation: "LINEAR" });
      A.channels.push({ sampler: A.samplers.length - 1, target: { node: t.node, path: t.path } });
    }
    json.animations.push(A);
  }
  const bin = Buffer.concat(chunks);
  json.buffers[0].byteLength = bin.length;
  return { json, bin };
}

mkdirSync(opt.out, { recursive: true });
const done = [];
for (const name of want) {
  const c = finish(name);
  done.push(c);
  const g = build([c]);
  writeGlb(join(opt.out, `${hero}_${name}.glb`), g.json, g.bin);
  console.log(`${name.padEnd(10)} ${c.kind.padEnd(7)} ${(c.frames / FPS).toFixed(2)} s  ${c.tracks.length} tracks`);
}
const all = build(done);
writeGlb(join(opt.out, `${hero}.glb`), all.json, all.bin);
console.log(`merged → ${join(opt.out, `${hero}.glb`)} (${done.length} clips)`);
