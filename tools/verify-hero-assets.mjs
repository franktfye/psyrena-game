/**
 * Hero asset guard — runs at the end of `npm run build`, fails it on a hero
 * glb that would break the game or the mobile budget. Rules: CLAUDE.md
 * ("Ship assets mobile-ready") and the clip contract in arenaHero.ts /
 * villageHub.ts. `tools/ship-hero.mjs` runs the same checks before it installs.
 *
 * A hero glb is any skinned, animated glb in public/assets/heroes/ (static
 * props like freud_book.glb are skipped). Each one must have:
 *   - every clip in REQUIRED_CLIPS (cast_f is optional: cast_e stands in);
 *   - KTX2 textures no larger than TEXTURE_RULES.heroMaxSize;
 *   - EXT_meshopt_compression;
 *   - at most 4 joint influences per vertex (JOINTS_0 only);
 *   - joints and triangles within the caps below.
 * And MODELED_HEROES (src/fight/heroModels.ts) must list exactly those heroes:
 * an id missing from the set silently loads Freud's body instead.
 *
 * Caps are a ratchet, like verify-mobile-budget.mjs: lower them when the
 * roster allows, never raise them to make a build pass. Reads only the glb
 * JSON chunk and the KTX2 headers, so it needs no decoder and runs in ms.
 *
 * Usage: node --experimental-strip-types tools/verify-hero-assets.mjs [dir]
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { TEXTURE_RULES } from "../src/core/budget.ts";
import { MODELED_HEROES } from "../src/fight/heroModels.ts";

export const REQUIRED_CLIPS = [
  "idle", "walk", "run", "cast", "cast_e", "cast_r", "hit", "death", "jump_start", "jump_land",
];

/**
 * 38 = the UE-style rig of the first three heroes. New heroes come out of
 * tools/motion-video on the 25-bone Mixamo rig, which is the default: a third
 * fewer bone matrices and animation channels to evaluate per hero per frame.
 */
const MAX_JOINTS = 38;
/** Pavlov/Skinner ship at ~30k; tools/motion-video decimates to 20k. */
const MAX_TRIANGLES = 30_000;
/** Shipped before this check existed. Shrink to the default cap when re-exported. */
const GRANDFATHERED_TRIANGLES = { freud: 52_000 };

const KTX2_ID = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a glb");
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  return { json, bin: buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen)) };
}

export const isRiggedHero = (json) => (json.skins?.length ?? 0) > 0 && (json.animations?.length ?? 0) > 0;

/** Check one hero glb. Returns { failures, warnings, stats }. */
export function checkHeroGlb(path, id = basename(path, ".glb")) {
  const { json, bin } = readGlb(path);
  const failures = [];
  const warnings = [];

  const clips = new Set((json.animations ?? []).map((a) => a.name));
  const missing = REQUIRED_CLIPS.filter((c) => !clips.has(c));
  if (missing.length) failures.push(`missing clips: ${missing.join(", ")}`);
  if (!clips.has("cast_f")) warnings.push("no cast_f clip (cast_e plays the ultimate)");

  for (const [i, img] of (json.images ?? []).entries()) {
    const label = img.name || `image ${i}`;
    if (img.mimeType !== "image/ktx2") {
      failures.push(`${label}: ${img.mimeType ?? img.uri} is not KTX2`);
      continue;
    }
    const bv = json.bufferViews[img.bufferView];
    const head = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + 28);
    if (!head.subarray(0, 12).equals(KTX2_ID)) {
      failures.push(`${label}: KTX2 mimeType but no KTX2 header`);
      continue;
    }
    const w = head.readUInt32LE(20);
    const h = head.readUInt32LE(24);
    if (Math.max(w, h) > TEXTURE_RULES.heroMaxSize) {
      failures.push(`${label}: ${w}x${h} > ${TEXTURE_RULES.heroMaxSize} (TEXTURE_RULES.heroMaxSize)`);
    }
  }

  if (!(json.extensionsUsed ?? []).includes("EXT_meshopt_compression")) {
    failures.push("no EXT_meshopt_compression (npm run assets:meshopt)");
  }

  const joints = Math.max(...json.skins.map((s) => s.joints.length));
  if (joints > MAX_JOINTS) failures.push(`${joints} joints > ${MAX_JOINTS}`);

  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives) {
      if ("JOINTS_1" in p.attributes) failures.push(`mesh "${mesh.name}": more than 4 joint influences (JOINTS_1)`);
      const count = json.accessors[p.indices ?? p.attributes.POSITION].count;
      triangles += Math.round(count / 3);
    }
  }
  const triCap = GRANDFATHERED_TRIANGLES[id] ?? MAX_TRIANGLES;
  if (triangles > triCap) failures.push(`${triangles} triangles > ${triCap}`);

  return { failures, warnings, stats: { joints, triangles, clips: clips.size } };
}

function main(dir) {
  const failures = [];
  const rigged = new Set();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".glb")).sort()) {
    const path = join(dir, name);
    const id = basename(name, ".glb");
    let result;
    try {
      if (!isRiggedHero(readGlb(path).json)) continue;
      result = checkHeroGlb(path, id);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      continue;
    }
    rigged.add(id);
    const { joints, triangles, clips } = result.stats;
    console.log(`[hero-assets] ${id}: ${joints} joints, ${triangles} tris, ${clips} clips`);
    for (const w of result.warnings) console.log(`[hero-assets]   note: ${w}`);
    for (const f of result.failures) failures.push(`${name}: ${f}`);
  }
  for (const id of rigged) {
    if (!MODELED_HEROES.has(id)) failures.push(`${id}.glb is not in MODELED_HEROES (src/fight/heroModels.ts)`);
  }
  for (const id of MODELED_HEROES) {
    if (!rigged.has(id)) failures.push(`MODELED_HEROES lists "${id}" but ${dir}/${id}.glb is missing or unrigged`);
  }
  if (failures.length) {
    console.error("[hero-assets] FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log(`[hero-assets] ok: ${rigged.size} heroes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2] ?? "public/assets/heroes");
