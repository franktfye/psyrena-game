#!/usr/bin/env node
/**
 * Turn a finished survival-monster glb into a game-ready one. The monster twin
 * of ship-hero.mjs (same chain), with the monster contract instead of the hero
 * one (docs/survival-design.md §10):
 *
 *   node tools/ship-monster.mjs <id> <tier> [in.glb] [--out path]
 *
 *   <id>     sv-<name>, the Concept Review id (assets/work/<id>/)
 *   <tier>   minion | elite | boss: texture size and triangle budget
 *   in.glb   default assets/work/<id>/anim/glb/<id>.glb (finish-clips output);
 *            rigid minions pass their decimated Tripo model instead
 *   --out    default public/assets/survival/monsters/<id>.glb
 *
 * Chain: optimize-hero-glb.mjs (resample → dedup → prune) → resize textures to
 * the tier size → UASTC KTX2 → EXT_meshopt_compression. Checks: triangle
 * budget, and for rigged monsters the four clips idle / walk / attack / death.
 * Refuses unless the concept is approved in Concept Review.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIERS = {
  minion: { tex: 512, tris: 3_000 },
  elite: { tex: 1024, tris: 8_000 },
  boss: { tex: 1024, tris: 15_000 },
};
export const MONSTER_CLIPS = ["idle", "walk", "attack", "death"];

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outOpt = oi >= 0 ? args.splice(oi, 2)[1] : undefined;
const [id, tier, inOpt] = args;
if (!id || !/^sv-[a-z0-9-]+$/.test(id) || !TIERS[tier]) {
  console.error("usage: ship-monster.mjs <sv-id> <minion|elite|boss> [in.glb] [--out path]");
  process.exit(1);
}
const input = resolve(inOpt ?? join(ROOT, `assets/work/${id}/anim/glb/${id}.glb`));
const out = resolve(outOpt ?? join(ROOT, `public/assets/survival/monsters/${id}.glb`));

const review = join(ROOT, `assets/work/${id}/concept/review.json`);
if (!(existsSync(review) && JSON.parse(readFileSync(review, "utf8")).approved)) {
  console.error(`ship-monster: ${id}'s concept is not approved in Concept Review.`);
  process.exit(1);
}

function glbJson(path) {
  const buf = readFileSync(path);
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
}
function triangles(json) {
  let n = 0;
  for (const m of json.meshes ?? []) for (const p of m.primitives) {
    const acc = json.accessors[p.indices ?? p.attributes.POSITION];
    if ((p.mode ?? 4) === 4) n += acc.count / 3;
  }
  return Math.round(n);
}

const work = mkdtempSync(join(tmpdir(), `ship-${id}-`));
const step = (n) => join(work, `${n}.glb`);
const gt = (...a) => execFileSync("gltf-transform", a, { stdio: ["ignore", "ignore", "inherit"] });
try {
  execFileSync(process.execPath, [join(ROOT, "tools/optimize-hero-glb.mjs"), input, step(1)], { stdio: "inherit" });
  const size = String(TIERS[tier].tex);
  gt("resize", step(1), step(2), "--width", size, "--height", size);
  gt("uastc", step(2), step(3));
  gt("meshopt", step(3), step(4));

  const json = glbJson(step(4));
  const tris = triangles(json);
  const clips = new Set((json.animations ?? []).map((a) => a.name));
  const rigged = (json.skins ?? []).length > 0;
  const failures = [];
  if (tris > TIERS[tier].tris * 1.05) failures.push(`${tris} tris > ${tier} budget ${TIERS[tier].tris}`);
  if (rigged) {
    const missing = MONSTER_CLIPS.filter((c) => !clips.has(c));
    if (missing.length) failures.push(`missing clips: ${missing.join(", ")}`);
  }
  const mb = (p) => (statSync(p).size / 1e6).toFixed(2) + " MB";
  console.log(`ship-monster: ${id} (${tier}) ${mb(input)} -> ${mb(step(4))}; ${tris} tris, ${rigged ? `${json.skins[0].joints.length} joints, ${clips.size} clips` : "rigid"}`);
  if (failures.length) {
    console.error("ship-monster: FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(step(4), out);
  console.log(`ship-monster: wrote ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
