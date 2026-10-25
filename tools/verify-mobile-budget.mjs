/**
 * Mobile performance guard — runs at the end of `npm run build`, fails it on
 * a regression. Rules and rationale: CLAUDE.md ("Mobile-first performance rules").
 *
 * 1. No Babylon barrel imports. `from "@babylonjs/core"` resolves to the
 *    package index, which side-effect-imports ALL of Babylon (XR, physics,
 *    FrameGraph, gizmos). One such line in basicAttack.ts was 4 MB of the boot
 *    chunk. Deep paths only: "@babylonjs/core/Events/pointerEvents".
 *    `import type` is exempt — it is erased at compile time.
 *
 * 2. Boot JS budget. Everything index.html loads before the first frame
 *    (entry script + modulepreloads), measured raw and as the brotli sibling
 *    tools/precompress.mjs wrote. The limits are a ratchet: lower them when a
 *    change shrinks the boot, never raise them to make a build pass.
 *
 * Usage: node tools/verify-mobile-budget.mjs [distDir]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

/** Boot JS limits in MiB. Measured 2026-10-25: 2.977 raw / 0.593 brotli. */
const BOOT_JS_RAW_MB = 2.977;
const BOOT_JS_BR_MB = 0.594;

const BARREL = /^\s*import\s+(?!type\b)[^;]*?from\s+["']@babylonjs\/(core|gui|loaders|materials)(\/index(\.js)?)?["']/m;
const BARE_SIDE_EFFECT = /^\s*import\s+["']@babylonjs\/(core|gui|loaders|materials)(\/index(\.js)?)?["']/m;

const failures = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

for (const root of ["src", "shared"]) {
  for (const file of walk(root)) {
    if (![".ts", ".mts", ".js", ".mjs"].includes(extname(file))) continue;
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      if (BARREL.test(line) || BARE_SIDE_EFFECT.test(line)) {
        failures.push(`${file}:${i + 1} Babylon barrel import — use a deep path: ${line.trim()}`);
      }
    });
  }
}

const dist = process.argv[2] ?? "dist";
const indexHtml = join(dist, "index.html");
if (existsSync(indexHtml)) {
  const html = readFileSync(indexHtml, "utf8");
  const boot = new Set(
    [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1])
  );
  let raw = 0, br = 0;
  for (const rel of boot) {
    const file = join(dist, rel);
    raw += statSync(file).size;
    br += existsSync(`${file}.br`) ? statSync(`${file}.br`).size : statSync(file).size;
  }
  const rawMB = raw / 1048576, brMB = br / 1048576;
  console.log(`[mobile-budget] boot JS: ${boot.size} file(s), ${rawMB.toFixed(2)} MB raw, ${brMB.toFixed(2)} MB brotli`);
  if (rawMB > BOOT_JS_RAW_MB) failures.push(`boot JS ${rawMB.toFixed(2)} MB raw > ${BOOT_JS_RAW_MB} MB budget`);
  if (brMB > BOOT_JS_BR_MB) failures.push(`boot JS ${brMB.toFixed(2)} MB brotli > ${BOOT_JS_BR_MB} MB budget`);
} else {
  console.log(`[mobile-budget] no ${indexHtml}; checked imports only`);
}

if (failures.length) {
  console.error(`[mobile-budget] FAILED — see the rules in CLAUDE.md\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("[mobile-budget] OK");
