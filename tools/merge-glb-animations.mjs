#!/usr/bin/env node
/**
 * Merge animations from one .glb into another that shares the SAME node table.
 *
 *   node tools/merge-glb-animations.mjs target.glb source.glb out.glb
 *
 * Why this exists: `tripo anim retarget` bills per animation with a cap of 5
 * per call, and validating a rig cheaply means buying ONE clip first (see
 * assets/work/freud/README.md). That leaves the clips split across two glbs
 * from the same rig task. Because both come from the same rig, their `nodes`
 * arrays are byte-for-byte identical, so an animation can be transplanted by
 * copying its accessors/bufferViews into the target's BIN chunk and keeping
 * the channel target node indices as-is. The script REFUSES to run if the
 * node tables differ — that is the entire safety contract.
 */

import { readFileSync, writeFileSync } from "node:fs";

function parseGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
  const binHeader = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binHeader);
  const bin = buf.slice(binHeader + 8, binHeader + 8 + binLen);
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
  const binHeader = 20 + jsonBuf.length;
  out.writeUInt32LE(binPadded.length, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4); // 'BIN'
  binPadded.copy(out, binHeader + 8);
  writeFileSync(path, out);
}

const [targetPath, sourcePath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: merge-glb-animations.mjs target.glb source.glb out.glb");
  process.exit(2);
}

const target = parseGlb(targetPath);
const source = parseGlb(sourcePath);

// Safety contract: identical node tables, or the channel indices would land
// on the wrong joints silently.
const names = (j) => JSON.stringify(j.nodes.map((n) => [n.name, n.children ?? null]));
if (names(target.json) !== names(source.json)) {
  console.error("node tables differ — refusing to merge animations across different rigs");
  process.exit(1);
}

let bin = target.bin;
target.json.animations ??= [];
const existing = new Set(target.json.animations.map((a) => a.name));

for (const anim of source.json.animations ?? []) {
  if (existing.has(anim.name)) {
    console.log(`skip ${anim.name} (already in target)`);
    continue;
  }
  const accessorMap = new Map();
  const copyAccessor = (idx) => {
    if (accessorMap.has(idx)) return accessorMap.get(idx);
    const acc = source.json.accessors[idx];
    const bv = source.json.bufferViews[acc.bufferView];
    const bytes = source.bin.slice(
      bv.byteOffset ?? 0,
      (bv.byteOffset ?? 0) + bv.byteLength
    );
    // Append (4-byte aligned) to the target BIN and mint new bufferView+accessor.
    const alignPad = (4 - (bin.length % 4)) % 4;
    const byteOffset = bin.length + alignPad;
    bin = Buffer.concat([bin, Buffer.alloc(alignPad), bytes]);
    target.json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bv.byteLength });
    target.json.accessors.push({
      ...acc,
      bufferView: target.json.bufferViews.length - 1,
      byteOffset: acc.byteOffset ?? 0,
    });
    const newIdx = target.json.accessors.length - 1;
    accessorMap.set(idx, newIdx);
    return newIdx;
  };
  const samplers = anim.samplers.map((s) => ({
    ...s,
    input: copyAccessor(s.input),
    output: copyAccessor(s.output),
  }));
  // Channels keep their node indices — the identical node tables make that valid.
  target.json.animations.push({ name: anim.name, samplers, channels: anim.channels });
  console.log(`merged ${anim.name} (${anim.channels.length} channels)`);
}

target.json.buffers[0].byteLength = bin.length;
writeGlb(outPath, target.json, bin);
console.log(`wrote ${outPath}`);
