#!/usr/bin/env node
/**
 * Vendor the KTX2 / Basis Universal transcoder into `public/ktx2/`.
 *
 * By default Babylon fetches these from the Babylon CDN at runtime. That works,
 * but it puts a third-party request on the critical path of a game whose entire
 * onboarding pitch is "click a link and play" (doc 01). They are ~200 KB total.
 * Self-host them.
 *
 * After running this, flip SELF_HOST_KTX2 to `true` in src/core/assets.ts.
 *
 * NOTE: this vendors the *decoder*. Encoding source art to .ktx2 is a separate,
 * offline step using KTX-Software's `toktx` (or `basisu`):
 *
 *   toktx --t2 --encode uastc --uastc_quality 2 --zcmp 18 --genmipmap \
 *         out.ktx2 in.png
 *
 * Target sizes are in docs/06 — heroes 1024², environment 2048², VFX 512².
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CDN = "https://cdn.babylonjs.com";
const TRANSCODERS = `${CDN}/ktx2Transcoders/1`;
const OUT = join(process.cwd(), "public", "ktx2");

// Filenames taken from the defaults baked into babylon.ktx2Decoder.js — note
// the RGBA transcoders are `rgba8_*_v2` (NOT `rgba32_*`, which 404s) and
// zstddec lives at the CDN root rather than under ktx2Transcoders/.
const FILES = [
  [`${CDN}/babylon.ktx2Decoder.js`, "babylon.ktx2Decoder.js"],
  [`${TRANSCODERS}/uastc_astc.wasm`, "uastc_astc.wasm"],
  [`${TRANSCODERS}/uastc_bc7.wasm`, "uastc_bc7.wasm"],
  [`${TRANSCODERS}/uastc_rgba8_unorm_v2.wasm`, "uastc_rgba8_unorm_v2.wasm"],
  [`${TRANSCODERS}/uastc_rgba8_srgb_v2.wasm`, "uastc_rgba8_srgb_v2.wasm"],
  [`${TRANSCODERS}/uastc_r8_unorm.wasm`, "uastc_r8_unorm.wasm"],
  [`${TRANSCODERS}/uastc_rg8_unorm.wasm`, "uastc_rg8_unorm.wasm"],
  [`${TRANSCODERS}/msc_basis_transcoder.js`, "msc_basis_transcoder.js"],
  [`${TRANSCODERS}/msc_basis_transcoder.wasm`, "msc_basis_transcoder.wasm"],
  [`${CDN}/zstddec.wasm`, "zstddec.wasm"],
  // Meshopt geometry decoder (EXT_meshopt_compression in the shipped glbs) —
  // same third-party-on-the-critical-path rationale as the transcoders above.
  [`${CDN}/meshopt_decoder.js`, "meshopt_decoder.js"],
];

await mkdir(OUT, { recursive: true });

let total = 0;
let failed = 0;

for (const [url, name] of FILES) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  skip  ${name.padEnd(28)} HTTP ${res.status}`);
      failed++;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(join(OUT, name), buf);
    total += buf.length;
    console.log(`  ok    ${name.padEnd(28)} ${(buf.length / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.warn(`  fail  ${name.padEnd(28)} ${err.message}`);
    failed++;
  }
}

console.log(`\nvendored ${FILES.length - failed}/${FILES.length} files, ${(total / 1024).toFixed(0)} KB total -> public/ktx2/`);
if (failed === 0) {
  console.log("Next: set SELF_HOST_KTX2 = true in src/core/assets.ts");
} else {
  process.exitCode = 1;
}
