/**
 * Write `.br` and `.gz` siblings next to every compressible file in a build.
 *
 * server/index.mjs serves these when the request's Accept-Encoding allows,
 * so a phone downloads the boot chunk at ~0.6 MB instead of ~3 MB. Doing it
 * once at build time rather than per request matters on this hardware:
 * brotli at quality 11 costs ~2 s per MB on the Pi, which is fine for a
 * build and unthinkable for a response.
 *
 * Only files that actually shrink get siblings. A cheap gzip probe decides —
 * GLBs whose payload is already KTX2/WebP-compressed come out ~5% smaller,
 * not worth a second copy on disk or the brotli time. Media (webm, webp,
 * png, ktx2) is never a candidate: it is compressed by construction.
 *
 * Runs automatically from the `psyrena-precompress` plugin in vite.config.ts
 * after `vite build`; also usable directly: node tools/precompress.mjs [dir]
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { fileURLToPath } from "node:url";

export const COMPRESSIBLE = new Set([
  ".js", ".mjs", ".css", ".html", ".json", ".webmanifest", ".svg", ".txt",
  ".wasm", ".glb", ".gltf", ".bin", ".hdr", ".env",
]);

/** Below this a file is one TCP round-trip either way. */
const MIN_BYTES = 1024;
/** Keep a compressed copy only if it saves at least this fraction. */
const MIN_SAVING = 0.1;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export function precompress(dir) {
  let raw = 0, br = 0, files = 0;
  for (const file of walk(dir)) {
    if (!COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
    const buf = readFileSync(file);
    if (buf.length < MIN_BYTES) continue;
    const gz = gzipSync(buf, { level: 9 });
    if (gz.length > buf.length * (1 - MIN_SAVING)) {
      // A stale sibling from an earlier build would be served for new bytes.
      for (const s of [".gz", ".br"]) if (existsSync(file + s)) unlinkSync(file + s);
      continue;
    }
    const b = brotliCompressSync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    writeFileSync(file + ".gz", gz);
    writeFileSync(file + ".br", b);
    raw += buf.length;
    br += b.length;
    files++;
  }
  return { files, rawMB: raw / 1048576, brMB: br / 1048576 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "dist";
  const r = precompress(dir);
  console.log(`[precompress] ${r.files} files: ${r.rawMB.toFixed(1)} MB -> ${r.brMB.toFixed(1)} MB brotli`);
}
