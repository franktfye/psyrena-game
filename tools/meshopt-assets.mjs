#!/usr/bin/env node
/**
 * Pack every shipped .glb with EXT_meshopt_compression (transport-only —
 * geometry/animation buffers decompress to the same GPU memory; see doc 06).
 *
 * Measured on this repo's assets: ~69 MB of glb → roughly half, with heroes
 * (~4.5 MB each) dropping ~43%. The client side is already wired: the glTF
 * loader registers the extension, and configureTexturePipeline points the
 * decoder at the vendored copy in public/ktx2/ (npm run assets:ktx2).
 *
 * Idempotent: files that already contain EXT_meshopt_compression are skipped,
 * so re-running after adding one new asset touches only that asset. Requires
 * @gltf-transform/cli (globally installed, same as the runbook chains):
 *
 *   node tools/meshopt-assets.mjs           # compress in place
 *   node tools/meshopt-assets.mjs --dry-run # report what would change
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "public");
const DRY = process.argv.includes("--dry-run");

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".glb")) yield p;
  }
}

const files = [...walk(ROOT)];
let before = 0;
let after = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  const size = statSync(file).size;
  // JSON chunk lives in the first few KB; the extension name appears there.
  const head = readFileSync(file).subarray(0, 4096).toString("latin1");
  if (head.includes("EXT_meshopt_compression")) {
    skipped++;
    continue;
  }
  before += size;
  if (DRY) {
    console.log(`  would pack ${file.replace(ROOT, "")} (${(size / 1048576).toFixed(2)} MB)`);
    after += size;
    continue;
  }
  // The temp name MUST end in .glb: gltf-transform infers the output format
  // from the extension, and anything else silently writes JSON glTF with
  // external .bin/.ktx2 sidecars — a scattered asset, not a compressed one.
  const tmp = file.replace(/\.glb$/, ".meshopt-tmp.glb");
  try {
    execFileSync("gltf-transform", ["meshopt", file, tmp], { stdio: "pipe" });
    const packed = statSync(tmp).size;
    renameSync(tmp, file);
    after += packed;
    console.log(
      `  ok    ${file.replace(ROOT, "").padEnd(48)} ${(size / 1048576).toFixed(2)} → ${(packed / 1048576).toFixed(2)} MB`
    );
  } catch (err) {
    rmSync(tmp, { force: true });
    after += size;
    failed++;
    console.warn(`  fail  ${file.replace(ROOT, "")}: ${err.message?.split("\n")[0]}`);
  }
}

console.log(
  `\n${files.length} glb: ${files.length - skipped - failed} packed, ${skipped} already packed, ${failed} failed`
);
if (before > 0) {
  console.log(
    `${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB (${Math.round((1 - after / before) * 100)}% smaller)`
  );
}
if (failed > 0) process.exitCode = 1;
