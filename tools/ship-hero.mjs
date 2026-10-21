/**
 * Turn a finished hero glb into the game-ready /assets/heroes/<id>.glb.
 * The last step of the default hero pipeline (tools/motion-video/README.md):
 * concept → Tripo → 25-bone Mixamo rig → authored clips → m2mr →
 * finish-clips.mjs → THIS.
 *
 *   node --experimental-strip-types tools/ship-hero.mjs <hero> [in.glb] [--out path] [--install] [--waive-gate]
 *
 *   in.glb       default assets/work/<hero>/anim/glb/<hero>.glb (finish-clips output)
 *   --out        default /tmp/ship-hero/<hero>.glb (a dry run you can inspect)
 *   --install    write public/assets/heroes/<hero>.glb and add <hero> to
 *                MODELED_HEROES (src/fight/heroModels.ts)
 *   --waive-gate install although assets/work/<hero>/concept/review.json has no
 *                approved version (only when Frank waives it for this hero)
 *
 * Chain (global gltf-transform CLI + toktx, as the other asset tools):
 *   1. optimize-hero-glb.mjs: resample → dedup → prune (drops exporter padding)
 *   2. resize textures to fit TEXTURE_RULES.heroMaxSize (Tripo bakes 2048 albedo)
 *   3. UASTC KTX2, the encoding every shipped hero uses
 *   4. EXT_meshopt_compression + quantization (CLAUDE.md rule 5)
 *   5. verify-hero-assets.mjs checks; nothing is installed unless they pass.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEXTURE_RULES } from "../src/core/budget.ts";
import { checkHeroGlb } from "./verify-hero-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_TS = join(ROOT, "src/fight/heroModels.ts");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 1).length > 0 : false;
};
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const install = flag("--install");
const waiveGate = flag("--waive-gate");
const outOpt = option("--out");
const [hero, inOpt] = args;
if (!hero || !/^[a-z][a-z0-9_]*$/.test(hero)) {
  console.error("usage: ship-hero.mjs <hero> [in.glb] [--out path] [--install] [--waive-gate]");
  process.exit(1);
}
const input = resolve(inOpt ?? join(ROOT, `assets/work/${hero}/anim/glb/${hero}.glb`));
if (!existsSync(input)) {
  console.error(`ship-hero: ${input} not found (run tools/motion-video/finish-clips.mjs first)`);
  process.exit(1);
}

if (install && !waiveGate) {
  const review = join(ROOT, `assets/work/${hero}/concept/review.json`);
  const approved = existsSync(review) && JSON.parse(readFileSync(review, "utf8")).approved;
  if (!approved) {
    console.error(`ship-hero: ${hero}'s concept is not approved in Concept Review (${review}).`);
    console.error("Approve it there, or pass --waive-gate if Frank waived the gate for this hero.");
    process.exit(1);
  }
}

const work = mkdtempSync(join(tmpdir(), `ship-${hero}-`));
const step = (n) => join(work, `${n}.glb`); // the extension tells gltf-transform to write a glb
const gt = (...a) => execFileSync("gltf-transform", a, { stdio: ["ignore", "ignore", "inherit"] });
try {
  execFileSync(process.execPath, [join(ROOT, "tools/optimize-hero-glb.mjs"), input, step(1)], { stdio: "inherit" });
  const max = String(TEXTURE_RULES.heroMaxSize);
  gt("resize", step(1), step(2), "--width", max, "--height", max);
  gt("uastc", step(2), step(3));
  gt("meshopt", step(3), step(4));

  const { failures, warnings, stats } = checkHeroGlb(step(4), hero);
  const mb = (p) => (statSync(p).size / 1e6).toFixed(2) + " MB";
  console.log(`ship-hero: ${hero} ${mb(input)} -> ${mb(step(4))}; ${stats.joints} joints, ${stats.triangles} tris, ${stats.clips} clips`);
  for (const w of warnings) console.log(`  note: ${w}`);
  if (failures.length) {
    console.error("ship-hero: FAILED hero checks:\n  " + failures.join("\n  "));
    process.exit(1);
  }

  const out = install ? join(ROOT, `public/assets/heroes/${hero}.glb`) : resolve(outOpt ?? join(tmpdir(), "ship-hero", `${hero}.glb`));
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(step(4), out);
  console.log(`ship-hero: wrote ${out}`);

  if (install) {
    const src = readFileSync(MODELS_TS, "utf8");
    const m = src.match(/new Set\(\[([^\]]*)\]\)/);
    if (!m) throw new Error(`no MODELED_HEROES set literal in ${MODELS_TS}`);
    const ids = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    if (!ids.has(hero)) {
      ids.add(hero);
      const list = [...ids].map((id) => `"${id}"`).join(", ");
      writeFileSync(MODELS_TS, src.replace(m[0], `new Set([${list}])`));
      console.log(`ship-hero: added "${hero}" to MODELED_HEROES`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
