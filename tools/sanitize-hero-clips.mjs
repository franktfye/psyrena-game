#!/usr/bin/env node
/**
 * Sanitize Tripo-retargeted animation clips in a hero .glb, in place on the
 * animation data only (textures/mesh/skin untouched).
 *
 *   node tools/sanitize-hero-clips.mjs in.glb out.glb
 *
 * Why: `tripo anim retarget` on the auto-rigged Freud mapped several preset
 * curves onto the wrong joints (measured 2026-07-30, see
 * assets/work/freud/README.md):
 *   - ankle joints held 56-84 deg from rest CONSTANTLY (pointed ballet toes);
 *   - the neck chain (named `0_Left_Limb_0` by the rig — Tripo's preset uses
 *     that name for the left ARM) received arm-swing curves: 80 deg head
 *     flail during run;
 *   - `preset:shoot` put the arm-raise on the LEGS (115-136 deg leg kicks).
 * The leg hip/knee curves are the good part. This script keeps them and
 * disciplines the rest:
 *   1. any channel whose rotation NEVER comes near rest (minDev > 25 deg)
 *      is debiased — the constant offset is removed, the motion kept;
 *   2. neck/head channels are capped at 12 deg, spine at 18 deg;
 *   3. `preset:shoot` loses its leg and root channels outright (the engine
 *      plays cast as an upper-body overlay + procedural lunge);
 *   4. walk/run legs are SYMMETRIZED. Measured phase/amplitude showed the
 *      retarget gave each leg curves of different quality (run: right hip
 *      swung 3x harder than left, phase offset 290 deg instead of 180 — a
 *      lopsided skip). The right leg's curves are mirrored across the body
 *      plane (x-mirror in the root's local frame, verified against the rest
 *      pose: hips 0.0 deg, knees 1.0 deg) as motion DELTAS onto each left
 *      joint's own rest, delayed by half a cycle — textbook gait repair.
 *
 * Joint roles come from rest-pose world height in the glb's own frame
 * (model ~0.95 units tall): head/neck > 0.6, spine 0.55-0.6, legs = "Limb"
 * chains below 0.56, root at ground level.
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---- glb io ---------------------------------------------------------------
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

// ---- quaternion helpers ---------------------------------------------------
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q) => {
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
};
const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qDot(a, b)))) * (180 / Math.PI);
const qSlerp = (a, b, t) => {
  let dot = qDot(a, b);
  let bb = b;
  if (dot < 0) {
    bb = b.map((v) => -v);
    dot = -dot;
  }
  if (dot > 0.9995) return qNorm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(dot);
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return qNorm(a.map((v, i) => sa * v + sb * bb[i]));
};

// ---- main -----------------------------------------------------------------
const [inPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: sanitize-hero-clips.mjs in.glb out.glb");
  process.exit(2);
}
const { json: j, bin } = parseGlb(inPath);
const binOf = (accIdx) => {
  const a = j.accessors[accIdx];
  const bv = j.bufferViews[a.bufferView];
  const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return { off, count: a.count };
};

// Rest-pose world position per node (TRS walk).
const parents = {};
j.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parents[c] = i)));
const quatToMat = (q) => {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
};
const worldY = (idx) => {
  const chain = [];
  for (let n = idx; n !== undefined; n = parents[n]) chain.unshift(n);
  let rot = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let pos = [0, 0, 0];
  for (const i of chain) {
    const node = j.nodes[i];
    const t = node.translation ?? [0, 0, 0];
    const m = quatToMat(node.rotation ?? [0, 0, 0, 1]);
    pos = [0, 1, 2].map((r) => pos[r] + rot[r][0] * t[0] + rot[r][1] * t[1] + rot[r][2] * t[2]);
    const nr = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) nr[r][c] = rot[r][0] * m[0][c] + rot[r][1] * m[1][c] + rot[r][2] * m[2][c];
    rot = nr;
  }
  return pos[1];
};
const roleOf = (idx) => {
  const name = j.nodes[idx].name ?? "";
  const y = worldY(idx);
  if (/Root/.test(name) || y < 0.03) return "root";
  if (y > 0.6) return "headneck";
  if (y > 0.55) return "spine";
  if (/Limb/.test(name)) return "leg";
  return "other";
};
const CAPS = { headneck: 12, spine: 18, hip: 60 };

/** Leg chain naming on this rig; level 0/1/2 = hip/knee/ankle. */
const LEG_R = "tripo::0_Right_Limb_";
const LEG_L = "tripo::1_Left_Limb_";

for (const anim of j.animations ?? []) {
  const isShoot = /shoot|cast/.test(anim.name);
  const keptChannels = [];
  for (const ch of anim.channels) {
    const role = roleOf(ch.target.node);
    const nodeName = j.nodes[ch.target.node].name;
    if (isShoot && (role === "leg" || role === "root")) {
      console.log(`${anim.name}: STRIP ${nodeName} (${role} in a cast clip)`);
      continue; // drop the channel — sampler data becomes unreferenced, harmless
    }
    keptChannels.push(ch);
    if (ch.target.path !== "rotation") continue;
    const rest = j.nodes[ch.target.node].rotation ?? [0, 0, 0, 1];
    const { off, count } = binOf(anim.samplers[ch.sampler].output);
    const read = (k) => [0, 1, 2, 3].map((c) => bin.readFloatLE(off + (k * 4 + c) * 4));
    const write = (k, q) => q.forEach((v, c) => bin.writeFloatLE(v, off + (k * 4 + c) * 4));

    // Pass 1: constant-bias removal. If the channel never comes near rest,
    // the offset is a retarget artefact (pointed ankles), not motion.
    let minDev = Infinity;
    let mean = [0, 0, 0, 0];
    for (let k = 0; k < count; k++) {
      const q = read(k);
      minDev = Math.min(minDev, qAngle(q, rest));
      const s = qDot(q, mean) < 0 ? -1 : 1;
      mean = mean.map((v, c) => v + s * q[c]);
    }
    if (minDev > 25) {
      const M = qNorm(mean);
      const corr = qMul(qInv(M), rest); // q' = q * M^-1 * rest → mean lands on rest
      for (let k = 0; k < count; k++) write(k, qNorm(qMul(read(k), corr)));
      console.log(`${anim.name}: debias ${nodeName} (was ≥${minDev.toFixed(0)}° off rest)`);
    }

    // Pass 2: amplitude cap for roles that received someone else's curves,
    // plus a runaway guard on hip swing (the run preset hit 81 deg).
    const capRole = role === "leg" && /_0$/.test(nodeName) ? "hip" : role;
    const cap = CAPS[capRole];
    if (cap !== undefined) {
      let maxDev = 0;
      for (let k = 0; k < count; k++) maxDev = Math.max(maxDev, qAngle(read(k), rest));
      if (maxDev > cap) {
        const scale = cap / maxDev;
        for (let k = 0; k < count; k++) write(k, qSlerp(rest, read(k), scale));
        console.log(`${anim.name}: cap ${nodeName} ${maxDev.toFixed(0)}°→${cap}° (${role})`);
      }
    }
  }
  anim.channels = keptChannels;

  // Pass 3 (locomotion only): symmetrize the legs. Left = the right leg's
  // motion deltas, x-mirrored in the shared parent frame, applied onto the
  // left joints' own rests, delayed half a cycle. Runs AFTER debias/caps so
  // the left leg inherits the repaired right-leg curves. Not applied to jump
  // (a two-foot takeoff SHOULD be in phase) or idle (legs barely move).
  if (/walk|run/.test(anim.name)) {
    for (const lvl of [0, 1, 2]) {
      const chR = anim.channels.find((c) => j.nodes[c.target.node].name === LEG_R + lvl);
      const chL = anim.channels.find((c) => j.nodes[c.target.node].name === LEG_L + lvl);
      if (!chR || !chL) continue;
      const restR = j.nodes[chR.target.node].rotation ?? [0, 0, 0, 1];
      const restL = j.nodes[chL.target.node].rotation ?? [0, 0, 0, 1];
      const { off: offR, count: nR } = binOf(anim.samplers[chR.sampler].output);
      const { off: offL, count: nL } = binOf(anim.samplers[chL.sampler].output);
      const srcKeys = Array.from({ length: nR }, (_, k) =>
        [0, 1, 2, 3].map((c) => bin.readFloatLE(offR + (k * 4 + c) * 4))
      );
      const shift = Math.round(nR / 2);
      for (let k = 0; k < nL; k++) {
        const src = srcKeys[(Math.round((k / nL) * nR) + shift) % nR];
        const d = qMul(src, qInv(restR)); // premultiplied delta in parent frame
        const dm = [d[0], -d[1], -d[2], d[3]]; // x-mirror across the body plane
        const q = qNorm(qMul(dm, restL));
        q.forEach((v, c) => bin.writeFloatLE(v, offL + (k * 4 + c) * 4));
      }
      console.log(`${anim.name}: symmetrize left level ${lvl} from right (T/2 shift)`);
    }
  }
}

writeGlb(outPath, j, bin);
console.log(`wrote ${outPath}`);
