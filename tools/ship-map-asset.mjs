#!/usr/bin/env node
/**
 * Meshy model → game-ready survival-map asset (docs/survival-design.md §12.3).
 *
 *   node tools/ship-map-asset.mjs <id> <building|landmark|vehicle|prop|tree> [--map kowloon] [--in model.glb] [--out path.glb]
 *
 * In:  assets/work/<map>/meshy/<id>/model.glb   (tools/meshy-gen.mjs output)
 * Out: public/assets/survival/<map>/<id>.glb
 *
 * Chain: decimate_glb.py (Blender collapse to the kind's triangle budget —
 * meshoptimizer stalls on Meshy's UV seams too) → optimize-hero-glb.mjs →
 * resize textures → UASTC KTX2 → EXT_meshopt_compression (CLAUDE.md rule 5).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = {
  building: { tris: 6000, tex: 1024 },
  landmark: { tris: 9000, tex: 1024 },
  vehicle: { tris: 3000, tex: 512 },
  tree: { tris: 4000, tex: 512 },
  prop: { tris: 1500, tex: 512 },
};
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const map = opt("--map") ?? "kowloon";
const inOpt = opt("--in");
const outOpt = opt("--out");
const [id, kind] = args;
if (!id || !KINDS[kind]) {
  console.error("usage: ship-map-asset.mjs <id> <building|landmark|vehicle|prop|tree> [--map kowloon]");
  process.exit(1);
}
const input = resolve(inOpt ?? join(ROOT, `assets/work/${map}/meshy/${id}/model.glb`));
const out = resolve(outOpt ?? join(ROOT, `public/assets/survival/${map}/${id}.glb`));
const { tris, tex } = KINDS[kind];

const work = mkdtempSync(join(tmpdir(), `ship-${id}-`));
const step = (n) => join(work, `${n}.glb`);
const gt = (...a) => execFileSync("gltf-transform", a, { stdio: ["ignore", "ignore", "inherit"] });
try {
  execFileSync("blender", ["-b", "--factory-startup", "--python", join(ROOT, "tools/motion-video/decimate_glb.py"), "--", input, step(0), String(tris)], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync(process.execPath, [join(ROOT, "tools/optimize-hero-glb.mjs"), step(0), step(1)], { stdio: "ignore" });
  gt("resize", step(1), step(2), "--width", String(tex), "--height", String(tex));
  gt("etc1s", step(2), step(3), "--quality", "160");   // background set dressing: ETC1S is ~5× smaller than UASTC
  gt("meshopt", step(3), step(4));
  const buf = readFileSync(step(4));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
  let n = 0;
  for (const m of json.meshes ?? []) for (const p of m.primitives) n += json.accessors[p.indices ?? p.attributes.POSITION].count / 3;
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(step(4), out);
  console.log(`ship-map-asset: ${id} (${kind}) ${(statSync(input).size / 1e6).toFixed(1)} MB -> ${(statSync(out).size / 1e6).toFixed(2)} MB, ${Math.round(n)} tris`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
