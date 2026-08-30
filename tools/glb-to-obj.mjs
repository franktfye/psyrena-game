#!/usr/bin/env node
/**
 * Extract a glb's first mesh as Wavefront OBJ (positions/uvs/normals + faces).
 *
 *   node tools/glb-to-obj.mjs in.glb out.obj
 *
 * Purpose-built for the Mixamo handoff: Mixamo's auto-rigger accepts OBJ but
 * not glb. UVs are preserved, so after rigging, the existing KTX2 texture set
 * (authored against these same UVs) can be transplanted back onto the rigged
 * mesh. Geometry only — materials are intentionally not exported.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [inPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: glb-to-obj.mjs in.glb out.obj");
  process.exit(2);
}

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a glb");
const jsonLen = buf.readUInt32LE(12);
const j = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;

const COMPONENT = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const READ = {
  5121: (o) => buf.readUInt8(o),
  5123: (o) => buf.readUInt16LE(o),
  5125: (o) => buf.readUInt32LE(o),
  5126: (o) => buf.readFloatLE(o),
};
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessor(idx) {
  const a = j.accessors[idx];
  const bv = j.bufferViews[a.bufferView];
  const base = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const n = NUM[a.type];
  const compSize = COMPONENT[a.componentType];
  const stride = bv.byteStride ?? n * compSize;
  const read = READ[a.componentType];
  const out = [];
  for (let k = 0; k < a.count; k++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(read(base + k * stride + c * compSize));
    out.push(row);
  }
  return out;
}

// First primitive of the first mesh with geometry.
const mesh = j.meshes.find((m) => m.primitives?.length);
const prim = mesh.primitives[0];
const pos = accessor(prim.attributes.POSITION);
const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0) : null;
const nrm = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL) : null;
const idxAcc = accessor(prim.indices).map((r) => r[0]);

const lines = [`# ${inPath} — mesh "${mesh.name ?? "unnamed"}", ${pos.length} verts, ${idxAcc.length / 3} tris`];
for (const p of pos) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
if (uv) for (const t of uv) lines.push(`vt ${t[0]} ${1 - t[1]}`); // glTF v is top-down
if (nrm) for (const v of nrm) lines.push(`vn ${v[0]} ${v[1]} ${v[2]}`);
for (let i = 0; i < idxAcc.length; i += 3) {
  const f = (k) => {
    const v = idxAcc[i + k] + 1;
    return uv && nrm ? `${v}/${v}/${v}` : uv ? `${v}/${v}` : nrm ? `${v}//${v}` : `${v}`;
  };
  // glTF is right-handed CCW; OBJ consumers expect CCW too — but the glb's
  // vertices come through the loader's RH frame directly here (no -Z bake),
  // so keep the winding as authored.
  lines.push(`f ${f(0)} ${f(1)} ${f(2)}`);
}
writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath}: ${pos.length} verts, ${idxAcc.length / 3} tris, uv=${!!uv}, normals=${!!nrm}`);
