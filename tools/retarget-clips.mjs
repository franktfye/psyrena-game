#!/usr/bin/env node
/**
 * LEGACY: kept to rebuild the heroes it already shipped. New heroes use the
 * default pipeline, tools/motion-video/README.md (25-bone Mixamo rig) then
 * tools/ship-hero.mjs.
 *
 * Retarget animation clips from one humanoid rig onto another, in WORLD space.
 *
 *   node tools/retarget-clips.mjs source.glb target.glb out.glb \
 *     --clip NlaTrack=cast --clip NlaTrack.001=cast_e [--replace] [--report]
 *
 * Why this exists (and why it is not `merge-glb-animations.mjs`): that script
 * transplants animation data byte-for-byte and REFUSES unless both files share
 * an identical node table — the safe case, and the only one worth using when
 * it applies. `mesh2motion-out/freud_cast.glb` (2026-07-31) does not apply: it
 * came back on a 41-joint Tripo-named skeleton (Root/Hip/Waist/Spine01/
 * L_Upperarm/…Twist01/02) while the shipped hero is the 38-joint UE-named rig
 * (root/pelvis/spine_01/clavicle_l/…). Same character, same export chain,
 * different skeleton pick — so the clips have to be retargeted, not copied.
 *
 * WHY WORLD SPACE, AND WHY IT IS EXACT HERE. The naive transfer (copy each
 * joint's local rotation, or copy its rotation-delta-from-rest) is wrong the
 * moment two rigs disagree about bone axes, and wrong again when their rest
 * poses are different POSES. Both rigs here store a genuine T-pose in
 * `inverseBindMatrices` — measured 2026-07-31, hands at (±0.389, 0.743) on
 * the UE rig and (±0.380/0.405, 0.744) on the Tripo rig, shoulders/head/hips
 * within 3 cm — so the two binds differ only in bone-axis convention, which
 * is exactly the case the world-space formula cancels:
 *
 *     Wt(t) = Ws(t) · Bs⁻¹ · Bt          (bind-relative world delta)
 *     Lt(t) = Wt(parent, t)⁻¹ · Wt(t)    (re-localise top-down)
 *
 * where Bs/Bt are the source/target BIND world rotations and Ws(t) is the
 * source's animated world rotation. At the bind pose this returns Bt exactly;
 * under motion the target bone takes the source bone's world-space rotation.
 *
 * Read the bind from `inverseBindMatrices`, NEVER from node TRS. mesh2motion
 * leaves the node TRS on some arbitrary posed frame (the shipped hero's node
 * table has the right hand up at y 0.767, above its own elbow) — retargeting
 * off that instead of the real bind is the single easiest way to get a clip
 * that looks plausible in isolation and folds the arms through the torso in
 * game.
 *
 * Intermediate joints need no mapping. Twist bones (`L_ForearmTwist01`…) and
 * spare spine links carry their contribution into the world rotation of the
 * joints below them, and those ARE mapped, so the chain resolves correctly.
 * Target joints with no source counterpart (fingers, `head_leaf`, `ball_leaf`)
 * are written at their bind LOCAL rotation rather than left out — a channel
 * that is absent leaves the joint wherever the previous clip parked it, and
 * these clips play as overlays on top of locomotion.
 *
 * `--report` re-runs FK on BOTH skeletons and prints, per joint, how far the
 * retargeted pose sits from the source pose in hip-relative world space —
 * next to the same measurement taken at the two BIND poses. The bind number
 * is the irreducible difference between the skeletons (the UE clavicle points
 * out and forward, the Tripo one runs almost pure-X, which alone is 43° of
 * bone direction); a retarget is clean when the animated number does not
 * exceed it by much. Do NOT report raw bone-direction error against the
 * source — that measures rig SHAPE, not the transfer, and reads alarming on a
 * perfectly good result.
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
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  jsonBuf.copy(out, 20);
  const bh = 20 + jsonBuf.length;
  out.writeUInt32LE(binPadded.length, bh);
  out.writeUInt32LE(0x004e4942, bh + 4); // 'BIN'
  binPadded.copy(out, bh + 8);
  writeFileSync(path, out);
}

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Read an accessor into a flat JS array, honouring byteStride. */
function readAccessor(g, index) {
  const acc = g.json.accessors[index];
  const n = NUM_COMPONENTS[acc.type];
  const Type = COMPONENT[acc.componentType];
  const out = new Array(acc.count * n);
  if (acc.bufferView === undefined) return out.fill(0);
  const bv = g.json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const elemBytes = Type.BYTES_PER_ELEMENT * n;
  const stride = bv.byteStride ?? elemBytes;
  for (let i = 0; i < acc.count; i++) {
    const view = new Type(g.bin.buffer, g.bin.byteOffset + base + i * stride, n);
    for (let c = 0; c < n; c++) out[i * n + c] = view[c];
  }
  return out;
}

/** Append a tightly-packed float accessor, returning its index. */
function addFloatAccessor(json, chunks, values, type, extras = {}) {
  const n = NUM_COMPONENTS[type];
  const data = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) data.writeFloatLE(values[i], i * 4);
  chunks.push(data);
  json.bufferViews.push({ buffer: 0, byteOffset: -1, byteLength: data.length, __chunk: chunks.length - 1 });
  json.accessors.push({
    bufferView: json.bufferViews.length - 1,
    componentType: 5126,
    count: values.length / n,
    type,
    ...extras,
  });
  return json.accessors.length - 1;
}

// ---- quaternion / matrix helpers ------------------------------------------
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const qRot = (q, v) => {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
};
const qSlerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    d = -d;
  }
  if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
};

/** 3x3 (row-major rows) → quaternion. Columns are normalised first: the bind
 *  matrices carry uniform scale on some exports and it must not leak in. */
function mat3ToQuat(m) {
  const col = (c) => {
    const l = Math.hypot(m[0][c], m[1][c], m[2][c]) || 1;
    return [m[0][c] / l, m[1][c] / l, m[2][c] / l];
  };
  const [c0, c1, c2] = [col(0), col(1), col(2)];
  const r = [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
  const tr = r[0][0] + r[1][1] + r[2][2];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return qNorm([(r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, s / 4]);
  }
  if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2;
    return qNorm([s / 4, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s]);
  }
  if (r[1][1] > r[2][2]) {
    const s = Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2;
    return qNorm([(r[0][1] + r[1][0]) / s, s / 4, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s]);
  }
  const s = Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2;
  return qNorm([(r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, s / 4, (r[1][0] - r[0][1]) / s]);
}

/** Invert a column-major glTF 4x4 with an affine (rotation+scale+translation)
 *  layout — enough for inverseBindMatrices. Returns {pos, rot}. */
function invertBindMatrix(m) {
  const R = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const t = [m[12], m[13], m[14]];
  const det =
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
  const inv = [
    [(R[1][1] * R[2][2] - R[1][2] * R[2][1]) / det, (R[0][2] * R[2][1] - R[0][1] * R[2][2]) / det, (R[0][1] * R[1][2] - R[0][2] * R[1][1]) / det],
    [(R[1][2] * R[2][0] - R[1][0] * R[2][2]) / det, (R[0][0] * R[2][2] - R[0][2] * R[2][0]) / det, (R[0][2] * R[1][0] - R[0][0] * R[1][2]) / det],
    [(R[1][0] * R[2][1] - R[1][1] * R[2][0]) / det, (R[0][1] * R[2][0] - R[0][0] * R[2][1]) / det, (R[0][0] * R[1][1] - R[0][1] * R[1][0]) / det],
  ];
  const pos = [
    -(inv[0][0] * t[0] + inv[0][1] * t[1] + inv[0][2] * t[2]),
    -(inv[1][0] * t[0] + inv[1][1] * t[1] + inv[1][2] * t[2]),
    -(inv[2][0] * t[0] + inv[2][1] * t[1] + inv[2][2] * t[2]),
  ];
  return { pos, rot: mat3ToQuat(inv) };
}

// ---- rig model ------------------------------------------------------------
/**
 * Everything the retarget needs about one glb: node parents, name lookup, and
 * the BIND world transform per joint (from inverseBindMatrices, not node TRS).
 */
function loadRig(g) {
  const nodes = g.json.nodes;
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
  const byName = new Map();
  nodes.forEach((n, i) => byName.set(n.name, i));

  const skin = g.json.skins[0];
  const ibm = readAccessor(g, skin.inverseBindMatrices);
  const bind = new Map(); // node index → {pos, rot}
  skin.joints.forEach((nodeIx, k) => {
    bind.set(nodeIx, invertBindMatrix(ibm.slice(k * 16, k * 16 + 16)));
  });

  // World transform of the node TRS chain, used only for nodes ABOVE the
  // skeleton root (the mesh/armature wrapper) — those carry no bind entry but
  // do sit between the skeleton and the scene.
  const trsWorld = new Map();
  const trsOf = (i) => {
    if (trsWorld.has(i)) return trsWorld.get(i);
    const n = nodes[i];
    const lr = qNorm(n.rotation ?? [0, 0, 0, 1]);
    const lt = n.translation ?? [0, 0, 0];
    let w;
    if (parent[i] < 0) w = { rot: lr, pos: lt };
    else {
      const p = trsOf(parent[i]);
      const rt = qRot(p.rot, lt);
      w = { rot: qMul(p.rot, lr), pos: [p.pos[0] + rt[0], p.pos[1] + rt[1], p.pos[2] + rt[2]] };
    }
    trsWorld.set(i, w);
    return w;
  };
  nodes.forEach((_, i) => trsOf(i));

  /** Bind world transform, falling back to the TRS chain above the skeleton. */
  const bindWorld = (i) => bind.get(i) ?? trsOf(i);

  // Bind LOCAL translation per joint — the FK fallback for joints a clip does
  // not animate. The node TRS is NOT that fallback: mesh2motion leaves it
  // parked on an arbitrary posed frame (the addon export's `root` sits at
  // y 0.581), so a clip with no root translation channel (Idle_A, Sleeping)
  // used to inherit that phantom offset through sourceFk and came out ~0.58
  // too high after the world-space pelvis transfer — the "idle grounded a
  // metre above the walk" bug. For every honest joint bind-local equals the
  // node TRS anyway, so this only changes the parked ones.
  const bindLocal = new Map();
  for (const i of bind.keys()) {
    const w = bindWorld(i);
    const p = parent[i];
    if (p < 0) {
      bindLocal.set(i, [...w.pos]);
      continue;
    }
    const pw = bindWorld(p);
    bindLocal.set(i, qRot(qConj(pw.rot), [w.pos[0] - pw.pos[0], w.pos[1] - pw.pos[1], w.pos[2] - pw.pos[2]]));
  }

  return { g, nodes, parent, byName, skin, bind, bindWorld, bindLocal };
}

// ---- animation sampling ---------------------------------------------------
/** Per-node channel table for one glTF animation, with LINEAR/STEP/CUBIC input. */
function buildSamplerTable(g, anim) {
  const table = new Map(); // node index → {translation, rotation, scale}
  for (const ch of anim.channels) {
    const nodeIx = ch.target.node;
    if (nodeIx === undefined) continue;
    const s = anim.samplers[ch.sampler];
    const entry = table.get(nodeIx) ?? {};
    entry[ch.target.path] = {
      times: readAccessor(g, s.input),
      values: readAccessor(g, s.output),
      interp: s.interpolation ?? "LINEAR",
    };
    table.set(nodeIx, entry);
  }
  return table;
}

/** Sample one channel at time t. `n` is component count; rotations slerp. */
function sampleChannel(ch, t, n) {
  const { times, values, interp } = ch;
  const stride = interp === "CUBICSPLINE" ? n * 3 : n;
  const pick = (i) => {
    const off = i * stride + (interp === "CUBICSPLINE" ? n : 0);
    return values.slice(off, off + n);
  };
  if (t <= times[0]) return pick(0);
  if (t >= times[times.length - 1]) return pick(times.length - 1);
  let hi = 1;
  while (hi < times.length && times[hi] < t) hi++;
  const lo = hi - 1;
  const span = times[hi] - times[lo] || 1;
  const f = (t - times[lo]) / span;
  const a = pick(lo);
  const b = pick(hi);
  // STEP and CUBICSPLINE both fall back to their left key / linear blend:
  // these clips are baked per frame, so the difference is below a pixel.
  if (interp === "STEP") return a;
  if (n === 4) return qSlerp(qNorm(a), qNorm(b), f);
  return a.map((v, i) => v + (b[i] - v) * f);
}

/** Forward kinematics for the source rig at time t → node index → {pos, rot}. */
function sourceFk(rig, table, t) {
  const out = new Map();
  const solve = (i) => {
    if (out.has(i)) return out.get(i);
    const n = rig.nodes[i];
    const ch = table.get(i);
    const lr = qNorm(ch?.rotation ? sampleChannel(ch.rotation, t, 4) : (n.rotation ?? [0, 0, 0, 1]));
    const lt = ch?.translation
      ? sampleChannel(ch.translation, t, 3)
      : (rig.bindLocal.get(i) ?? n.translation ?? [0, 0, 0]);
    let w;
    if (rig.parent[i] < 0) w = { rot: lr, pos: lt };
    else {
      const p = solve(rig.parent[i]);
      const rt = qRot(p.rot, lt);
      w = { rot: qMul(p.rot, lr), pos: [p.pos[0] + rt[0], p.pos[1] + rt[1], p.pos[2] + rt[2]] };
    }
    out.set(i, w);
    return w;
  };
  rig.nodes.forEach((_, i) => solve(i));
  return out;
}

/**
 * World positions of the retargeted target skeleton, given its solved world
 * rotations. Bone lengths come from the bind pose (the retarget never moves
 * joints relative to their parent), so this is pure rotation-driven FK.
 */
function targetFkPositions(rig, worldRot) {
  const pos = new Map();
  for (const [i] of worldRot) {
    const p = rig.parent[i];
    const bc = rig.bindWorld(i);
    if (!worldRot.has(p)) {
      pos.set(i, bc.pos);
      continue;
    }
    const bp = rig.bindWorld(p);
    const local = qRot(qConj(bp.rot), [bc.pos[0] - bp.pos[0], bc.pos[1] - bp.pos[1], bc.pos[2] - bp.pos[2]]);
    const off = qRot(worldRot.get(p), local);
    const pp = pos.get(p);
    pos.set(i, [pp[0] + off[0], pp[1] + off[1], pp[2] + off[2]]);
  }
  return pos;
}

// ---- cli ------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const [sourcePath, targetPath, outPath] = positional;
if (!outPath) {
  console.error("usage: retarget-clips.mjs source.glb target.glb out.glb --clip SRC=DST [--clip …] [--report]");
  process.exit(2);
}
const clipMap = [];
const stripRM = new Set();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--strip-rm") stripRM.add(argv[i + 1]);
  if (argv[i] === "--clip") {
    const [from, to] = argv[++i].split("=");
    clipMap.push({ from, to });
  }
}
const wantReport = argv.includes("--report");

/**
 * Bone map: Tripo/mesh2motion 41-joint naming → shipped UE 38-joint naming.
 *
 * Twist bones are deliberately absent — their rotation reaches the target
 * through the world rotation of the joint below them. `NeckTwist02` likewise:
 * the UE rig has one neck link, and `head` is mapped directly, so the neck's
 * total bend lands correctly whichever way the source split it.
 */
const TRIPO_BONE_MAP = {
  Root: "root",
  Hip: "pelvis",
  Waist: "spine_01",
  Spine01: "spine_02",
  Spine02: "spine_03",
  NeckTwist01: "neck_01",
  Head: "head",
  L_Clavicle: "clavicle_l",
  L_Upperarm: "upperarm_l",
  L_Forearm: "lowerarm_l",
  L_Hand: "hand_l",
  R_Clavicle: "clavicle_r",
  R_Upperarm: "upperarm_r",
  R_Forearm: "lowerarm_r",
  R_Hand: "hand_r",
  L_Thigh: "thigh_l",
  L_Calf: "calf_l",
  L_Foot: "foot_l",
  L_ToeBase: "ball_l",
  R_Thigh: "thigh_r",
  R_Calf: "calf_r",
  R_Foot: "foot_r",
  R_ToeBase: "ball_r",
};

/** The one joint that carries translation: the hips bob, as in the v3 export. */
const ROOT_MOTION_TARGET = "pelvis";

const src = parseGlb(sourcePath);
const dst = parseGlb(targetPath);
const sRig = loadRig(src);
const tRig = loadRig(dst);

// Some re-rigs come back already UE-named (pavlov-animation-addon,
// 2026-08-04): the shipped rig's own joint names plus full five-finger
// chains. Identity-map every shared name; source-only joints (index/ring/
// pinky chains) fold into the hands' world rotations the same way twist
// bones do. Detection key is `pelvis` — no Tripo-named export has it.
const ueNamed = sRig.byName.has("pelvis");
const BONE_MAP = ueNamed
  ? Object.fromEntries([...tRig.byName.keys()].filter((n) => sRig.byName.has(n)).map((n) => [n, n]))
  : TRIPO_BONE_MAP;
const ROOT_MOTION_SOURCE = ueNamed ? "pelvis" : "Hip";

// Resolve the map to node indices, and report anything unmatched — a silent
// name miss is the failure mode that produces a "mostly fine" clip.
const pairs = [];
for (const [from, to] of Object.entries(BONE_MAP)) {
  const si = sRig.byName.get(from);
  const ti = tRig.byName.get(to);
  if (si === undefined || ti === undefined) {
    console.error(`bone map: ${from} → ${to} — ${si === undefined ? "source" : "target"} joint missing`);
    process.exit(1);
  }
  pairs.push({ si, ti, from, to });
}
const mapByTarget = new Map(pairs.map((p) => [p.ti, p]));

// Target joints in hierarchy order (parents before children).
const targetJoints = [];
{
  const seen = new Set();
  const visit = (i) => {
    if (seen.has(i)) return;
    seen.add(i);
    if (tRig.bind.has(i)) targetJoints.push(i);
    for (const c of tRig.nodes[i].children ?? []) visit(c);
  };
  tRig.nodes.forEach((_, i) => tRig.parent[i] < 0 && visit(i));
}

const chunks = [];
dst.json.animations ??= [];
dst.json.bufferViews ??= [];
dst.json.accessors ??= [];

for (const { from, to } of clipMap) {
  const anim = src.json.animations.find((a) => a.name === from);
  if (!anim) {
    console.error(`source clip "${from}" not found (have: ${src.json.animations.map((a) => a.name).join(", ")})`);
    process.exit(1);
  }
  const table = buildSamplerTable(src, anim);

  // --strip-rm CLIP: remove the source skeleton root's TRAVEL so the engine's
  // own physics provides it (jump launch, knockback). The root's translation
  // channel is replaced with a CONSTANT at its BIND translation — not deleted,
  // because the channel-less fallback is the node TRS, which mesh2motion
  // leaves parked on an arbitrary posed frame (y 0.581 in the addon export).
  // Rotation channels stay: whole-body tilt is pose, not travel.
  if (stripRM.has(from)) {
    const ri = sRig.byName.get(ueNamed ? "root" : "Root");
    const entry = table.get(ri);
    if (entry?.translation) {
      const w = sRig.bindWorld(ri);
      const p = sRig.parent[ri];
      let lt = w.pos;
      if (p >= 0) {
        const pw = sRig.bindWorld(p);
        lt = qRot(qConj(pw.rot), [w.pos[0] - pw.pos[0], w.pos[1] - pw.pos[1], w.pos[2] - pw.pos[2]]);
      }
      entry.translation = { times: [0], values: [...lt], interp: "STEP" };
      console.log(`${from}: root travel stripped (root pinned to bind translation)`);
    }
  }

  // Sample grid: the union of every input time in the clip. These are Blender
  // bakes, so that is already one key per frame — resampling would only blur.
  const timeSet = new Set();
  for (const entry of table.values())
    for (const ch of Object.values(entry)) for (const t of ch.times) timeSet.add(Math.round(t * 1e6) / 1e6);
  const times = [...timeSet].sort((a, b) => a - b);

  // Per target joint, one rotation track; pelvis also gets translation.
  const rotTracks = new Map(targetJoints.map((i) => [i, []]));
  const posTrack = [];
  const motionTi = tRig.byName.get(ROOT_MOTION_TARGET);
  const motionSi = sRig.byName.get(ROOT_MOTION_SOURCE);

  // Hip-relative position error per probe joint: max over the clip, against
  // the same quantity measured at the two bind poses (the rig-shape floor).
  const PROBES = ["hand_l", "hand_r", "head", "foot_l", "foot_r"];
  const probeMax = new Map(PROBES.map((p) => [p, 0]));

  for (const t of times) {
    const sw = sourceFk(sRig, table, t);
    const tw = new Map(); // target node index → world rotation

    for (const i of targetJoints) {
      const p = tRig.parent[i];
      const parentRot = tw.get(p) ?? tRig.bindWorld(p).rot;
      const pair = mapByTarget.get(i);
      let world;
      if (pair) {
        // Wt = Ws · Bs⁻¹ · Bt
        const Bs = sRig.bindWorld(pair.si).rot;
        const Bt = tRig.bindWorld(i).rot;
        world = qNorm(qMul(qMul(sw.get(pair.si).rot, qConj(Bs)), Bt));
      } else {
        // Unmapped (fingers, leaf tips): hold the bind LOCAL rotation so the
        // joint tracks its parent instead of freezing in world space.
        const Bp = tRig.bindWorld(tRig.parent[i]).rot;
        const bindLocal = qMul(qConj(Bp), tRig.bindWorld(i).rot);
        world = qNorm(qMul(parentRot, bindLocal));
      }
      tw.set(i, world);
      const local = qNorm(qMul(qConj(parentRot), world));
      rotTracks.get(i).push(...local);
    }

    if (motionTi !== undefined && motionSi !== undefined) {
      // Hips bob, transferred as a world-space offset from bind and expressed
      // in the target parent's frame. Both rigs are the same character at the
      // same scale (hip height 0.504 vs 0.477), so no height rescale is applied
      // beyond the bind difference the offset already absorbs.
      const d = sw.get(motionSi).pos;
      const sb = sRig.bindWorld(motionSi).pos;
      const tb = tRig.bindWorld(motionTi).pos;
      const target = [tb[0] + (d[0] - sb[0]), tb[1] + (d[1] - sb[1]), tb[2] + (d[2] - sb[2])];
      const p = tRig.parent[motionTi];
      const pw = tRig.bindWorld(p);
      const rel = [target[0] - pw.pos[0], target[1] - pw.pos[1], target[2] - pw.pos[2]];
      posTrack.push(...qRot(qConj(tw.get(p) ?? pw.rot), rel));
    }

    if (wantReport) {
      const tp = targetFkPositions(tRig, tw);
      const hipT = tp.get(tRig.byName.get("pelvis"));
      const hipS = sw.get(sRig.byName.get(ROOT_MOTION_SOURCE)).pos;
      for (const name of PROBES) {
        const ti = tRig.byName.get(name);
        const pair = mapByTarget.get(ti);
        const a = tp.get(ti);
        const b = sw.get(pair.si).pos;
        const d = Math.hypot(
          a[0] - hipT[0] - (b[0] - hipS[0]),
          a[1] - hipT[1] - (b[1] - hipS[1]),
          a[2] - hipT[2] - (b[2] - hipS[2])
        );
        if (d > probeMax.get(name)) probeMax.set(name, d);
      }
    }
  }

  // --- write the clip ---
  const tAcc = addFloatAccessor(dst.json, chunks, times, "SCALAR", { min: [times[0]], max: [times[times.length - 1]] });
  const samplers = [];
  const channels = [];
  for (const i of targetJoints) {
    const oAcc = addFloatAccessor(dst.json, chunks, rotTracks.get(i), "VEC4");
    samplers.push({ input: tAcc, output: oAcc, interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node: i, path: "rotation" } });
  }
  if (posTrack.length) {
    const oAcc = addFloatAccessor(dst.json, chunks, posTrack, "VEC3");
    samplers.push({ input: tAcc, output: oAcc, interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node: motionTi, path: "translation" } });
  }

  const existing = dst.json.animations.findIndex((a) => a.name === to);
  const clip = { name: to, samplers, channels };
  if (existing >= 0) dst.json.animations[existing] = clip;
  else dst.json.animations.push(clip);

  const dur = times[times.length - 1] - times[0];
  console.log(`${from} → ${to}: ${times.length} keys, ${dur.toFixed(2)}s, ${channels.length} channels`);
  if (wantReport) {
    const hipTb = tRig.bindWorld(tRig.byName.get("pelvis")).pos;
    const hipSb = sRig.bindWorld(sRig.byName.get(ROOT_MOTION_SOURCE)).pos;
    for (const name of PROBES) {
      const ti = tRig.byName.get(name);
      const a = tRig.bindWorld(ti).pos;
      const b = sRig.bindWorld(mapByTarget.get(ti).si).pos;
      const floor = Math.hypot(
        a[0] - hipTb[0] - (b[0] - hipSb[0]),
        a[1] - hipTb[1] - (b[1] - hipSb[1]),
        a[2] - hipTb[2] - (b[2] - hipSb[2])
      );
      console.log(
        `    ${name.padEnd(8)} max ${(probeMax.get(name) * 100).toFixed(1).padStart(5)} cm   ` +
          `rig-shape floor ${(floor * 100).toFixed(1)} cm`
      );
    }
  }
}

// Splice the new buffers onto the end of the BIN chunk, 4-byte aligned.
let bin = dst.bin;
for (const bv of dst.json.bufferViews) {
  if (bv.byteOffset !== -1) continue;
  const pad = (4 - (bin.length % 4)) % 4;
  if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  bv.byteOffset = bin.length;
  bin = Buffer.concat([bin, chunks[bv.__chunk]]);
  delete bv.__chunk;
}
dst.json.buffers[0].byteLength = bin.length;
writeGlb(outPath, dst.json, bin);
console.log(`wrote ${outPath} (${(bin.length / 1e6).toFixed(2)} MB bin, ${dst.json.animations.length} clips)`);
