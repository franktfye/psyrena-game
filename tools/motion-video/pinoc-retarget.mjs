#!/usr/bin/env node
// Retarget a PINOC motion (its `mixamo-glb`: the X Bot mesh on a 65-joint
// Mixamo skeleton) onto a hero's 25-bone character.glb, and write the result
// in the shape m2mr writes: character.glb's own node table plus ONE clip. That
// makes it a drop-in `<runs>/<clip>/mixamo_character.glb` for finish-clips.mjs,
// which then cuts, pins and merges it exactly as it does an m2mr run.
//
//   node tools/motion-video/pinoc-retarget.mjs pinoc.glb character.glb out.glb [--fps 30]
//
// The transfer is world-space and bind-relative, per joint, by Mixamo name:
//
//     Wt(t) = Ws(t) · Bs⁻¹ · Bt          Lt(t) = Wt(parent, t)⁻¹ · Wt(t)
//
// Bs/Bt are the bind world rotations. Both rigs are true T-poses facing +Z
// (PINOC's X Bot: hands at shoulder height, 1.44 m, checked 2026-10-24; the
// hero rig by construction, tripo_to_mixamo.py), so this cancels the two rigs'
// different bone axes and leaves the target bone with the source bone's world
// orientation. Source-only joints (fingers, Spine1) fold into the world
// rotations of the mapped joints below them, so nothing is lost by skipping them.
//
// Hips translation: the source hips' world offset from bind, scaled by the
// ratio of the two rest hip heights, expressed in the target hips' parent frame
// (character.glb is in centimetres under a scaled armature; this handles both).
// finish-clips then reads it with k = 1, since the rest translation is the
// character's own.

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const [srcPath, charPath, outPath] = pos;
const FPS = Number(args[args.indexOf("--fps") + 1]) || 30;
if (!outPath) {
  console.error("usage: pinoc-retarget.mjs pinoc.glb character.glb out.glb [--fps 30]");
  process.exit(1);
}

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
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Float32Array(a.count * n);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = g.bin.readFloatLE(base + i * stride + k * 4);
  return { data: out, n };
}
function writeGlb(path, json, bin) {
  const js = Buffer.from(JSON.stringify(json));
  const J = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const B = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + B.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  writeFileSync(path, Buffer.concat([head, ch(J.length, 0x4e4f534a), J, ch(B.length, 0x004e4942), B]));
}

// ---- maths (quaternions x,y,z,w; 4×4 column-major like glTF) ----------------------
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(...q); return q.map((x) => x / l); };
const rotV = (q, v) => { const r = qmul(qmul(q, [...v, 0]), qinv(q)); return [r[0], r[1], r[2]]; };
function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((x) => -x); d = -d; }
  if (d > 0.9995) return qnorm(a.map((x, i) => x + (b[i] - x) * t));
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((x, i) => (x * Math.sin((1 - t) * th) + b[i] * Math.sin(t * th)) / s);
}
/** A transform as { q, t, s } composed parent·child; scale is kept per axis. */
function compose(P, L) {
  const st = [L.t[0] * P.s[0], L.t[1] * P.s[1], L.t[2] * P.s[2]];
  const o = rotV(P.q, st);
  return { q: qnorm(qmul(P.q, L.q)), t: [P.t[0] + o[0], P.t[1] + o[1], P.t[2] + o[2]], s: [P.s[0] * L.s[0], P.s[1] * L.s[1], P.s[2] * L.s[2]] };
}
/** Point in world → parent-local (inverse of compose's translation part). */
function toLocal(P, w) {
  const d = rotV(qinv(P.q), [w[0] - P.t[0], w[1] - P.t[1], w[2] - P.t[2]]);
  return [d[0] / P.s[0], d[1] / P.s[1], d[2] / P.s[2]];
}
const restLocal = (n) => ({ q: n.rotation ?? [0, 0, 0, 1], t: n.translation ?? [0, 0, 0], s: n.scale ?? [1, 1, 1] });

// ---- rigs -------------------------------------------------------------------------
function rig(g) {
  const nodes = g.json.nodes;
  const parent = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const byBone = new Map(); // "Hips" → index (prefix-agnostic: mixamorig:, mixamorig1:, …)
  nodes.forEach((n, i) => { const m = /(?:^|:)([A-Za-z0-9_]+)$/.exec(n.name ?? ""); if (m) byBone.set(m[1], i); });
  const order = []; // parents before children
  const seen = new Set();
  const visit = (i) => { if (seen.has(i)) return; if (parent.has(i)) visit(parent.get(i)); seen.add(i); order.push(i); };
  nodes.forEach((_, i) => visit(i));
  const world = (locals) => {
    const W = new Map();
    for (const i of order) W.set(i, parent.has(i) ? compose(W.get(parent.get(i)), locals(i)) : locals(i));
    return W;
  };
  const rest = world((i) => restLocal(nodes[i]));
  return { nodes, parent, byBone, world, rest, order };
}

const src = readGlb(srcPath);
const chr = readGlb(charPath);
const S = rig(src);
const T = rig(chr);

// ---- sample the source clip at FPS --------------------------------------------------
const anim = src.json.animations[0];
if (!anim) throw new Error(`${srcPath}: no animation`);
const chans = new Map(); // node → { rotation, translation, scale } samplers
let dur = 0;
for (const ch of anim.channels) {
  const s = anim.samplers[ch.sampler];
  if ((s.interpolation ?? "LINEAR") === "CUBICSPLINE") throw new Error("CUBICSPLINE samplers are not handled");
  const times = floats(src, s.input).data;
  const out = floats(src, s.output);
  dur = Math.max(dur, times[times.length - 1]);
  if (!chans.has(ch.target.node)) chans.set(ch.target.node, {});
  chans.get(ch.target.node)[ch.target.path] = { times, ...out, step: s.interpolation === "STEP" };
}
function sample(tr, t, isRot) {
  const { times, data, n } = tr;
  const at = (k) => Array.from(data.subarray(k * n, k * n + n));
  if (t <= times[0]) return at(0);
  const last = times.length - 1;
  if (t >= times[last]) return at(last);
  let lo = 0, hi = last;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  if (tr.step) return at(lo);
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return isRot ? qslerp(at(lo), at(hi), f) : at(lo).map((x, i) => x + (at(hi)[i] - x) * f);
}
const frames = Math.max(2, Math.round(dur * FPS) + 1);

// ---- the map ---------------------------------------------------------------------------
const pairs = []; // { ti, si, bone }
for (const [bone, ti] of T.byBone) {
  if (!T.nodes[ti].name?.includes(":")) continue; // joints only (mixamorig:…)
  const si = S.byBone.get(bone);
  if (si === undefined) { console.error(`map: ${bone} has no source joint, held at bind`); continue; }
  pairs.push({ ti, si, bone });
}
const tHips = T.byBone.get("Hips"), sHips = S.byBone.get("Hips");
const hipRatio = (T.rest.get(tHips).t[1] - T.rest.get(T.byBone.get("LeftFoot")).t[1]) /
                 (S.rest.get(sHips).t[1] - S.rest.get(S.byBone.get("LeftFoot")).t[1]);
const corr = new Map(pairs.map((p) => [p.ti, qmul(qinv(S.rest.get(p.si).q), T.rest.get(p.ti).q)])); // Bs⁻¹·Bt

// ---- retarget --------------------------------------------------------------------------
const rotTracks = new Map(pairs.map((p) => [p.ti, []]));
const posTrack = [];
const tMapped = new Set(pairs.map((p) => p.ti));
for (let f = 0; f < frames; f++) {
  const t = Math.min(f / FPS, dur);
  const SW = S.world((i) => {
    const r = restLocal(S.nodes[i]);
    const c = chans.get(i);
    if (!c) return r;
    return {
      q: c.rotation ? qnorm(sample(c.rotation, t, true)) : r.q,
      t: c.translation ? sample(c.translation, t, false) : r.t,
      s: c.scale ? sample(c.scale, t, false) : r.s,
    };
  });
  // Target world rotations for mapped joints; unmapped ones ride their parent at rest-local.
  const TW = new Map();
  for (const i of T.order) {
    const p = T.parent.get(i);
    const PW = p === undefined ? null : TW.get(p);
    if (tMapped.has(i)) {
      const pr = pairs.find((x) => x.ti === i);
      TW.set(i, { q: qnorm(qmul(SW.get(pr.si).q, corr.get(i))), t: [0, 0, 0], s: T.rest.get(i).s });
    } else {
      TW.set(i, PW ? compose(PW, restLocal(T.nodes[i])) : T.rest.get(i));
    }
  }
  for (const p of pairs) {
    const par = T.parent.get(p.ti);
    const PW = par === undefined ? { q: [0, 0, 0, 1] } : TW.get(par);
    rotTracks.get(p.ti).push(...qnorm(qmul(qinv(PW.q), TW.get(p.ti).q)));
  }
  // Hips: world offset from bind, scaled, placed in the parent's (rest) frame.
  const d = SW.get(sHips).t.map((x, k) => (x - S.rest.get(sHips).t[k]) * hipRatio);
  const tw = T.rest.get(tHips).t.map((x, k) => x + d[k]);
  posTrack.push(...toLocal(T.rest.get(T.parent.get(tHips)) ?? { q: [0, 0, 0, 1], t: [0, 0, 0], s: [1, 1, 1] }, tw));
}

// ---- write: character.glb + one clip -------------------------------------------------
const json = structuredClone(chr.json);
const chunks = [chr.bin];
let off = chr.bin.length;
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
const input = push(Array.from({ length: frames }, (_, i) => i / FPS), "SCALAR", true);
const A = { name: "mixamo_clip", samplers: [], channels: [] };
for (const [ti, vals] of rotTracks) {
  A.samplers.push({ input, output: push(vals, "VEC4"), interpolation: "LINEAR" });
  A.channels.push({ sampler: A.samplers.length - 1, target: { node: ti, path: "rotation" } });
}
A.samplers.push({ input, output: push(posTrack, "VEC3"), interpolation: "LINEAR" });
A.channels.push({ sampler: A.samplers.length - 1, target: { node: tHips, path: "translation" } });
json.animations = [A];
const bin = Buffer.concat(chunks);
json.buffers[0].byteLength = bin.length;
writeGlb(outPath, json, bin);
console.log(`${outPath}: ${frames} frames @ ${FPS} fps (${dur.toFixed(2)} s), ${pairs.length} joints, hip scale ${hipRatio.toFixed(3)} (rest hip-height ratio × unit change)`);
