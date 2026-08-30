#!/usr/bin/env node
/**
 * Pet animation GLB → shipped `public/assets/village/pet_*.glb`.
 *
 * The six park pets were static Tripo statues; their rigged+animated re-exports
 * (Tripo / Meshy / mesh2motion, via `assets/work/village/tripo-out/village-pet-*`)
 * arrive between 2.7 MB and 60 MB, two of them at ~1.47 M triangles. This runs
 * the village runbook's chain on each one and renames the clips to the
 * canonical names `petFollower.ts` matches on:
 *
 *   idle / idle_*   the at-heel loop (several = an alternating cycle)
 *   walk            the catch-up gait
 *   run             the far-chase gait
 *
 * Renaming is done LAST, on the compressed file, as a JSON-chunk rewrite — no
 * gltf-transform stage preserves a name it does not know about, and doing it
 * first means re-checking it survived four more rewrites.
 *
 *   node tools/build-pet-anim.mjs            # build every pet
 *   node tools/build-pet-anim.mjs husky      # build one
 *
 * Source models are gitignored (`assets/work/**\/*.glb`), so this reads them
 * from the main checkout via SRC_ROOT; the shipped outputs are committed.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Raw exports live outside the repo tree (gitignored); override for a worktree. */
const SRC_ROOT = process.env.PET_SRC_ROOT ?? "/home/frank/Projects/psyrena/assets/work/village/tripo-out";
const OUT = `${ROOT}/public/assets/village`;
/** Intermediates land under the pipeline work tree, where `.gitignore` eats them. */
const TMP = `${ROOT}/assets/work/village/pet-build`;

/**
 * Per-pet recipe.
 *
 * `tris` is chosen against the shipped neighbours — the static statues were
 * ~5 k and Druzhok's walk model is 10.4 k at 0.62 m tall — not against the
 * source. A 0.36 m cat does not spend 1.47 M triangles on screen.
 *
 * `clips` maps the exporter's name to ours. Every source clip is kept: the
 * ones that are not locomotion are idle-cycle entries, which is why `Roar`
 * and `Sit` survive as `idle_*`.
 */
const PETS = {
  robot: {
    src: "village-pet-robot-d67bab9e/robot_animation.glb",
    out: "pet_robot_walk.glb",
    tris: 12000,
    texture: 512,
    // Robot keeps its ORIGINAL static model as the idle half of a split-duty
    // pair (see PetSpec.walkFile), so this file ships the walk clip only.
    clips: { NlaTrack: "walk" },
  },
  corgi: {
    src: "village-pet-corgi-98afc83b/corgi-animation.glb",
    out: "pet_corgi.glb",
    tris: 6362,
    texture: 512,
    clips: { "Armature|Unreal Take|baselayer": "walk" },
  },
  husky: {
    src: "village-pet-husky-dcbd585f/husky-animation.glb",
    out: "pet_husky.glb",
    tris: 10000,
    texture: 512,
    // No walk clip in the source: `run` covers both gaits, which is what the
    // follower falls back to when `walk` is absent.
    clips: { Rest_Pose: "idle", Sit: "idle_sit", Run: "run" },
  },
  blackcat: {
    src: "village-pet-black-cat-c5d11186/black-cat-animation.glb",
    out: "pet_black_cat.glb",
    tris: 12000,
    texture: 512,
    clips: { Rest_Pose: "idle", Run: "run" },
  },
  dinosaur: {
    src: "village-pet-dinosaur-aac1468b/dinosaur-animation.glb",
    out: "pet_dinosaur.glb",
    tris: 10000,
    texture: 512,
    clips: { Idle: "idle", Roar: "idle_roar", Walk: "walk" },
  },
  unicorn: {
    src: "village-pet-unicorn-eb85400a/unicorn-animation.glb",
    out: "pet_unicorn.glb",
    tris: 7790,
    texture: 512,
    clips: { Rest_Pose: "idle", Run: "run", Walk: "walk" },
  },
};

const gltf = (...args) => execFileSync("gltf-transform", args, { stdio: ["ignore", "pipe", "pipe"] });

/** Parse a GLB into {json, bin} without a glTF library. */
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a glb`);
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error(`${path}: no JSON chunk`);
  return { json, bin };
}

/** Re-emit a GLB with both chunks padded to the 4-byte alignment the spec wants. */
function writeGlb(path, json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const binPad = bin ? Buffer.alloc((4 - (bin.length % 4)) % 4, 0) : Buffer.alloc(0);
  const chunks = [
    Buffer.concat([sizeType(jsonBuf.length + jsonPad.length, 0x4e4f534a), jsonBuf, jsonPad]),
  ];
  if (bin) chunks.push(Buffer.concat([sizeType(bin.length + binPad.length, 0x004e4942), bin, binPad]));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  writeFileSync(path, Buffer.concat([header, body]));
}

function sizeType(len, type) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(len, 0);
  b.writeUInt32LE(type, 4);
  return b;
}

function triCount(json) {
  const comp = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let tris = 0;
  for (const m of json.meshes ?? [])
    for (const p of m.primitives)
      if (p.indices !== undefined) tris += json.accessors[p.indices].count / 3;
  void comp;
  return Math.round(tris);
}

/**
 * Kill self-illumination, in place.
 *
 * The corgi and unicorn re-exports arrive with `emissiveFactor [1,1,1]` and
 * the ALBEDO wired up as an emissive map — an exporter artifact, not art
 * direction. In the village's dusk lighting that renders as a pet-shaped lamp:
 * the corgi glowed bright orange both in the park and at the hero's heel,
 * ignoring every light in the scene. The Tripo statues these replace had no
 * emissive, and neither does any other pet, so the fix is to match them rather
 * than to tune it.
 */
function stripEmissive(key, path) {
  const { json, bin } = readGlb(path);
  let hit = false;
  for (const m of json.materials ?? []) {
    if (m.emissiveTexture || m.emissiveFactor?.some((v) => v > 0)) {
      console.log(`  ${key}: stripping emissive from material "${m.name ?? "(unnamed)"}"`);
      delete m.emissiveTexture;
      delete m.emissiveFactor;
      hit = true;
    }
  }
  if (hit) writeGlb(path, json, bin);
}

function build(key) {
  const spec = PETS[key];
  const src = `${SRC_ROOT}/${spec.src}`;
  mkdirSync(TMP, { recursive: true });
  const before = statSync(src).size;
  const srcTris = triCount(readGlb(src).json);

  const a = `${TMP}/${key}.a.glb`;
  const b = `${TMP}/${key}.b.glb`;
  const c = `${TMP}/${key}.c.glb`;
  const d = `${TMP}/${key}.d.glb`;

  // Smooth-weld FIRST. These exports are flat-shaded, so the stock `weld` is a
  // no-op and every later stage would be carrying 2.5 vertices per triangle;
  // see tools/weld-smooth.mjs. `prune` then collects the accessors it orphaned.
  execFileSync("node", [`${ROOT}/tools/weld-smooth.mjs`, src, a], { stdio: "inherit" });
  stripEmissive(key, a);
  // resample collapses the exporters' per-frame keys onto the ones that
  // actually change — the dinosaur's three clips ship 0.26 MB of keyframes and
  // come out at 0.14 MB for an identical curve.
  gltf("resample", a, `${a}.r.glb`);
  // ...and prune collects what the strip above orphaned, so a texture that is
  // no longer referenced is never resized or UASTC-compressed into the output.
  gltf("prune", `${a}.r.glb`, b);

  // Ratio is against the WELDED count; --error is the shape budget that stops
  // simplify early, so the aggressive pets need a looser one or they land far
  // above target (the 1.47 M models will not reach 12 k at 0.01).
  const weldedTris = triCount(readGlb(b).json);
  const ratio = Math.min(1, spec.tris / weldedTris);
  if (ratio < 1) {
    gltf("simplify", b, c, "--ratio", String(ratio), "--error", String(ratio < 0.05 ? 0.06 : 0.02));
  } else {
    copyFileSync(b, c);
  }
  gltf("resize", c, d, "--width", String(spec.texture), "--height", String(spec.texture));

  const final = `${TMP}/${key}.final.glb`;
  gltf("uastc", d, final, "--level", "2", "--zstd", "18");

  // Rename clips last — see the header.
  const { json, bin } = readGlb(final);

  const seen = new Set();
  for (const anim of json.animations ?? []) {
    const to = spec.clips[anim.name];
    if (!to) throw new Error(`${key}: source clip "${anim.name}" has no mapping`);
    if (seen.has(to)) throw new Error(`${key}: two clips map to "${to}"`);
    seen.add(to);
    anim.name = to;
  }
  for (const from of Object.keys(spec.clips))
    if (!(json.animations ?? []).some((x) => Object.values(spec.clips).includes(x.name)))
      throw new Error(`${key}: mapped clip "${from}" not found in source`);

  const dst = `${OUT}/${spec.out}`;
  writeGlb(dst, json, bin);
  const after = statSync(dst).size;
  const names = (json.animations ?? []).map((x) => x.name).join(", ");
  console.log(
    `${key.padEnd(9)} ${(before / 1e6).toFixed(1).padStart(5)} MB ${String(srcTris).padStart(8)} tris` +
      ` ->  ${(after / 1e6).toFixed(2).padStart(5)} MB ${String(triCount(json)).padStart(6)} tris` +
      `  [${names}]  ${spec.out}`
  );
  for (const t of [a, `${a}.r.glb`, b, c, d, final]) rmSync(t, { force: true });
}

const only = process.argv[2];
const keys = only ? [only] : Object.keys(PETS);
for (const k of keys) {
  if (!PETS[k]) throw new Error(`unknown pet "${k}" — one of ${Object.keys(PETS).join(", ")}`);
  build(k);
}
