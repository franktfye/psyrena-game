#!/usr/bin/env node
/**
 * Assemble a game-ready hero glb from Mixamo downloads.
 *
 *   node tools/build-mixamo-hero.mjs \
 *     --base "Breathing Idle.glb=idle" \
 *     --clip "Walking.glb=walk" --clip "Running.glb=run" ... \
 *     --textures old-hero.glb \
 *     --out freud.glb
 *
 * - `--base` is the "With Skin" download (mesh + skeleton + one clip); its
 *   animation is renamed to the given clip name.
 * - each `--clip` is a "Without Skin" download; its animation channels are
 *   remapped onto the base's nodes BY BONE NAME (mixamorig:* names are
 *   unique), its accessors appended to the base BIN, and the clip renamed.
 * - `--textures` donates its images/textures/material (the KTX2 set authored
 *   against the same UVs) to replace the base's placeholder material.
 *
 * Everything the engine needs — `createHeroAnimator` finds clips by name
 * (idle/walk/run/jump/cast) — comes out in one self-contained glb.
 */

import { readFileSync, writeFileSync } from "node:fs";

function parseGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
  const bh = 20 + jsonLen;
  const bin = Buffer.from(buf.slice(bh + 8, bh + 8 + buf.readUInt32LE(bh)));
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

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const opt = { clips: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--base") opt.base = args[++i];
  else if (args[i] === "--clip") opt.clips.push(args[++i]);
  else if (args[i] === "--textures") opt.textures = args[++i];
  else if (args[i] === "--out") opt.out = args[++i];
}
if (!opt.base || !opt.out) {
  console.error("usage: build-mixamo-hero.mjs --base file=name [--clip file=name ...] [--textures donor.glb] --out out.glb");
  process.exit(2);
}
const split = (s) => {
  const i = s.lastIndexOf("=");
  return [s.slice(0, i), s.slice(i + 1)];
};

// ---- base -----------------------------------------------------------------
const [basePath, baseClipName] = split(opt.base);
const target = parseGlb(basePath);
let bin = target.bin;
const tj = target.json;
if (tj.animations?.length) tj.animations[0].name = baseClipName;
const nodeByName = new Map(tj.nodes.map((n, i) => [n.name, i]));

// ---- merge clips by bone name --------------------------------------------
for (const spec of opt.clips) {
  const [path, clipName] = split(spec);
  const src = parseGlb(path);
  const anim = src.json.animations?.[0];
  if (!anim) {
    console.log(`skip ${path}: no animation`);
    continue;
  }
  const accessorMap = new Map();
  const copyAccessor = (idx) => {
    if (accessorMap.has(idx)) return accessorMap.get(idx);
    const acc = src.json.accessors[idx];
    const bv = src.json.bufferViews[acc.bufferView];
    const bytes = src.bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const alignPad = (4 - (bin.length % 4)) % 4;
    const byteOffset = bin.length + alignPad;
    bin = Buffer.concat([bin, Buffer.alloc(alignPad), bytes]);
    tj.bufferViews.push({ buffer: 0, byteOffset, byteLength: bv.byteLength });
    tj.accessors.push({ ...acc, bufferView: tj.bufferViews.length - 1, byteOffset: acc.byteOffset ?? 0 });
    accessorMap.set(idx, tj.accessors.length - 1);
    return tj.accessors.length - 1;
  };
  const channels = [];
  for (const ch of anim.channels) {
    const boneName = src.json.nodes[ch.target.node].name;
    const targetNode = nodeByName.get(boneName);
    if (targetNode === undefined) {
      console.log(`  ${clipName}: no node "${boneName}" in base — channel dropped`);
      continue;
    }
    channels.push({ sampler: ch.sampler, target: { node: targetNode, path: ch.target.path } });
  }
  const samplers = anim.samplers.map((s) => ({
    ...s,
    input: copyAccessor(s.input),
    output: copyAccessor(s.output),
  }));
  tj.animations ??= [];
  tj.animations.push({ name: clipName, samplers, channels });
  console.log(`merged ${clipName}: ${channels.length} channels from ${path}`);
}

// ---- texture transplant ---------------------------------------------------
if (opt.textures) {
  const donor = parseGlb(opt.textures);
  const dj = donor.json;
  const copyBufferView = (idx) => {
    const bv = dj.bufferViews[idx];
    const bytes = donor.bin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const alignPad = (4 - (bin.length % 4)) % 4;
    const byteOffset = bin.length + alignPad;
    bin = Buffer.concat([bin, Buffer.alloc(alignPad), bytes]);
    tj.bufferViews.push({ buffer: 0, byteOffset, byteLength: bv.byteLength });
    return tj.bufferViews.length - 1;
  };
  const imageMap = new Map();
  const copyImage = (idx) => {
    if (imageMap.has(idx)) return imageMap.get(idx);
    const img = dj.images[idx];
    tj.images ??= [];
    tj.images.push({ ...img, bufferView: copyBufferView(img.bufferView) });
    imageMap.set(idx, tj.images.length - 1);
    return tj.images.length - 1;
  };
  const texMap = new Map();
  const copyTexture = (idx) => {
    if (texMap.has(idx)) return texMap.get(idx);
    const tex = dj.textures[idx];
    const out = {};
    if (tex.sampler !== undefined) {
      tj.samplers ??= [];
      tj.samplers.push(dj.samplers[tex.sampler]);
      out.sampler = tj.samplers.length - 1;
    }
    if (tex.source !== undefined) out.source = copyImage(tex.source);
    if (tex.extensions?.KHR_texture_basisu) {
      out.extensions = { KHR_texture_basisu: { source: copyImage(tex.extensions.KHR_texture_basisu.source) } };
    }
    tj.textures ??= [];
    tj.textures.push(out);
    texMap.set(idx, tj.textures.length - 1);
    return tj.textures.length - 1;
  };
  const mat = JSON.parse(JSON.stringify(dj.materials[0]));
  const remapTexRef = (o) => {
    if (o && o.index !== undefined) o.index = copyTexture(o.index);
  };
  remapTexRef(mat.pbrMetallicRoughness?.baseColorTexture);
  remapTexRef(mat.pbrMetallicRoughness?.metallicRoughnessTexture);
  remapTexRef(mat.normalTexture);
  remapTexRef(mat.emissiveTexture);
  remapTexRef(mat.occlusionTexture);
  tj.materials = [mat];
  for (const m of tj.meshes) for (const p of m.primitives) p.material = 0;
  for (const ext of dj.extensionsUsed ?? []) {
    tj.extensionsUsed ??= [];
    if (!tj.extensionsUsed.includes(ext)) tj.extensionsUsed.push(ext);
  }
  for (const ext of dj.extensionsRequired ?? []) {
    tj.extensionsRequired ??= [];
    if (!tj.extensionsRequired.includes(ext)) tj.extensionsRequired.push(ext);
  }
  console.log(`transplanted material "${mat.name ?? "unnamed"}" + ${tj.images.length} images from ${opt.textures}`);
}

tj.buffers[0].byteLength = bin.length;
writeGlb(opt.out, tj, bin);
console.log(`wrote ${opt.out}`);
