#!/usr/bin/env node
/**
 * Merge-by-distance weld with averaged normals, for exports that arrive
 * flat-shaded.
 *
 *   node tools/weld-smooth.mjs in.glb out.glb
 *
 * WHY THIS EXISTS. `gltf-transform weld` merges only BITWISE-identical
 * vertices. The THREE.GLTFExporter pet re-exports carry a distinct normal on
 * every triangle corner, so no two vertices are ever bitwise equal and weld is
 * a no-op: unicorn stayed at 19,949 vertices for 7,790 triangles (2.56 per
 * triangle, where a welded mesh is near 1.0). At 56 bytes of attributes per
 * vertex that is the single largest line in the file — bigger than the
 * textures — and no amount of texture compression touches it.
 *
 * `simplify` does not fix it either: meshoptimizer preserves attribute seams,
 * so it removes triangles without ever merging the split corners. The only way
 * to collapse them is to decide the split is not meaningful and average across
 * it, which is what this does.
 *
 * WHAT IS PRESERVED. Vertices merge only when position AND uv AND skin binding
 * all agree — so UV seams, material borders, and skinning boundaries stay
 * split, and the texture still lands where it did. Only the normal is
 * discarded, replaced by the area-blind mean of the corners that met. That
 * turns faceted shading smooth, which for these organic pet meshes is the
 * intent; it would be the wrong pass for anything hard-surface that wants its
 * creases (the robot's plates survive because its creases are real position
 * seams, not shared-position normal splits).
 *
 * New attribute data is appended to the BIN chunk and the primitive is
 * repointed at it. The orphaned accessors are left for `gltf-transform prune`
 * to collect — rewriting the buffer in place would mean relocating every
 * animation sampler and inverse-bind matrix for no gain.
 */

import { readFileSync, writeFileSync } from "node:fs";

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  let off = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = Buffer.from(data);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

function writeGlb(path, json, bin) {
  const jb = Buffer.from(JSON.stringify(json), "utf8");
  const jp = Buffer.alloc((4 - (jb.length % 4)) % 4, 0x20);
  const bp = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const st = (n, t) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n, 0);
    b.writeUInt32LE(t, 4);
    return b;
  };
  const body = Buffer.concat([
    st(jb.length + jp.length, 0x4e4f534a), jb, jp,
    st(bin.length + bp.length, 0x004e4942), bin, bp,
  ]);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0);
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(12 + body.length, 8);
  writeFileSync(path, Buffer.concat([h, body]));
}

/** Read an accessor into a flat JS array, honouring an interleaved byteStride. */
function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const n = NUM[acc.type];
  const Ctor = COMP[acc.componentType];
  const out = new Ctor(acc.count * n);
  if (acc.bufferView === undefined) return { data: out, n, componentType: acc.componentType, normalized: !!acc.normalized };
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const elemBytes = Ctor.BYTES_PER_ELEMENT;
  const stride = bv.byteStride ?? n * elemBytes;
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < n; c++) {
      out[i * n + c] = readOne(bin, o + c * elemBytes, acc.componentType);
    }
  }
  return { data: out, n, componentType: acc.componentType, normalized: !!acc.normalized };
}

function readOne(buf, off, componentType) {
  switch (componentType) {
    case 5120: return buf.readInt8(off);
    case 5121: return buf.readUInt8(off);
    case 5122: return buf.readInt16LE(off);
    case 5123: return buf.readUInt16LE(off);
    case 5125: return buf.readUInt32LE(off);
    default: return buf.readFloatLE(off);
  }
}

/** Append a typed array as a new tightly-packed bufferView + accessor. */
function addAccessor(json, chunks, state, arr, type, componentType, extra = {}) {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const pad = (4 - (state.offset % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad, 0));
    state.offset += pad;
  }
  const bvIndex = json.bufferViews.push({ buffer: 0, byteOffset: state.offset, byteLength: bytes.length }) - 1;
  chunks.push(bytes);
  state.offset += bytes.length;
  const n = NUM[type];
  const count = arr.length / n;
  const acc = { bufferView: bvIndex, componentType, count, type, ...extra };
  return json.accessors.push(acc) - 1;
}

function minMax(arr, n) {
  const min = new Array(n).fill(Infinity);
  const max = new Array(n).fill(-Infinity);
  for (let i = 0; i < arr.length; i += n)
    for (let c = 0; c < n; c++) {
      if (arr[i + c] < min[c]) min[c] = arr[i + c];
      if (arr[i + c] > max[c]) max[c] = arr[i + c];
    }
  return { min, max };
}

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: weld-smooth.mjs in.glb out.glb");
  process.exit(1);
}

const { json, bin } = readGlb(inPath);
const chunks = [bin];
const state = { offset: bin.length };
let beforeTotal = 0;
let afterTotal = 0;

for (const mesh of json.meshes ?? []) {
  for (const prim of mesh.primitives) {
    const a = prim.attributes;
    if (a.POSITION === undefined || prim.indices === undefined) continue;

    const pos = readAccessor(json, bin, a.POSITION);
    const nor = a.NORMAL !== undefined ? readAccessor(json, bin, a.NORMAL) : null;
    const uv = a.TEXCOORD_0 !== undefined ? readAccessor(json, bin, a.TEXCOORD_0) : null;
    const jt = a.JOINTS_0 !== undefined ? readAccessor(json, bin, a.JOINTS_0) : null;
    const wt = a.WEIGHTS_0 !== undefined ? readAccessor(json, bin, a.WEIGHTS_0) : null;
    const idx = readAccessor(json, bin, prim.indices);

    const count = pos.data.length / 3;
    beforeTotal += count;

    // Quantise the key so float noise from the exporter does not defeat the
    // match; 1e-5 on a metre-scale model is well below anything visible, and
    // uv/skin are compared at the same grain so seams stay seams.
    const q = (v) => Math.round(v * 100000);
    const key = new Array(count);
    for (let i = 0; i < count; i++) {
      let k = `${q(pos.data[i * 3])},${q(pos.data[i * 3 + 1])},${q(pos.data[i * 3 + 2])}`;
      if (uv) k += `|${q(uv.data[i * 2])},${q(uv.data[i * 2 + 1])}`;
      if (jt) k += `|${jt.data[i * 4]},${jt.data[i * 4 + 1]},${jt.data[i * 4 + 2]},${jt.data[i * 4 + 3]}`;
      if (wt) k += `|${q(wt.data[i * 4])},${q(wt.data[i * 4 + 1])},${q(wt.data[i * 4 + 2])},${q(wt.data[i * 4 + 3])}`;
      key[i] = k;
    }

    const map = new Map();
    const remap = new Uint32Array(count);
    let next = 0;
    for (let i = 0; i < count; i++) {
      let dst = map.get(key[i]);
      if (dst === undefined) {
        dst = next++;
        map.set(key[i], dst);
      }
      remap[i] = dst;
    }
    if (next === count) {
      afterTotal += count;
      continue; // already welded — leave the primitive untouched
    }

    const newPos = new Float32Array(next * 3);
    const newNor = nor ? new Float32Array(next * 3) : null;
    const newUv = uv ? new Float32Array(next * 2) : null;
    const newJt = jt ? new (COMP[jt.componentType])(next * 4) : null;
    const newWt = wt ? new (COMP[wt.componentType])(next * 4) : null;

    for (let i = 0; i < count; i++) {
      const d = remap[i];
      newPos[d * 3] = pos.data[i * 3];
      newPos[d * 3 + 1] = pos.data[i * 3 + 1];
      newPos[d * 3 + 2] = pos.data[i * 3 + 2];
      if (newUv) {
        newUv[d * 2] = uv.data[i * 2];
        newUv[d * 2 + 1] = uv.data[i * 2 + 1];
      }
      if (newJt) for (let c = 0; c < 4; c++) newJt[d * 4 + c] = jt.data[i * 4 + c];
      if (newWt) for (let c = 0; c < 4; c++) newWt[d * 4 + c] = wt.data[i * 4 + c];
      // Normals accumulate — this is the whole point of the pass.
      if (newNor) {
        newNor[d * 3] += nor.data[i * 3];
        newNor[d * 3 + 1] += nor.data[i * 3 + 1];
        newNor[d * 3 + 2] += nor.data[i * 3 + 2];
      }
    }
    if (newNor)
      for (let i = 0; i < next; i++) {
        const x = newNor[i * 3];
        const y = newNor[i * 3 + 1];
        const z = newNor[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        newNor[i * 3] = x / len;
        newNor[i * 3 + 1] = y / len;
        newNor[i * 3 + 2] = z / len;
      }

    const newIdx =
      next > 65535
        ? new Uint32Array(idx.data.length)
        : new Uint16Array(idx.data.length);
    for (let i = 0; i < idx.data.length; i++) newIdx[i] = remap[idx.data[i]];

    // Any attribute this pass does not rebuild still points at the OLD vertex
    // count — a spec violation that also pins the pre-weld bufferView alive,
    // so prune cannot reclaim it (unicorn kept 0.83 MB of dead TANGENT that
    // way). Nothing in public/ ships a tangent or a second uv set; Babylon
    // derives tangents when a normal map needs them.
    for (const name of Object.keys(prim.attributes))
      if (!["POSITION", "NORMAL", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"].includes(name)) {
        console.log(`  weld-smooth: dropping ${name} (not rebuilt)`);
        delete prim.attributes[name];
      }

    const pm = minMax(newPos, 3);
    prim.attributes.POSITION = addAccessor(json, chunks, state, newPos, "VEC3", 5126, { min: pm.min, max: pm.max });
    if (newNor) prim.attributes.NORMAL = addAccessor(json, chunks, state, newNor, "VEC3", 5126);
    if (newUv) prim.attributes.TEXCOORD_0 = addAccessor(json, chunks, state, newUv, "VEC2", 5126);
    if (newJt) prim.attributes.JOINTS_0 = addAccessor(json, chunks, state, newJt, "VEC4", jt.componentType);
    if (newWt)
      prim.attributes.WEIGHTS_0 = addAccessor(json, chunks, state, newWt, "VEC4", wt.componentType, wt.normalized ? { normalized: true } : {});
    prim.indices = addAccessor(json, chunks, state, newIdx, "SCALAR", next > 65535 ? 5125 : 5123);

    afterTotal += next;
  }
}

const outBin = Buffer.concat(chunks);
json.buffers[0].byteLength = outBin.length;
writeGlb(outPath, json, outBin);
console.log(`  weld-smooth: ${beforeTotal} -> ${afterTotal} verts (${((1 - afterTotal / beforeTotal) * 100).toFixed(0)}% fewer)`);
