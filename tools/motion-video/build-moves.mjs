#!/usr/bin/env node
// Write a hero's authored clip specs, render each to video (render.mjs) with a
// review sheet, and record how to cut each m2mr result into the game clip.
//
//   node tools/motion-video/build-moves.mjs <hero> [clip ...]
//
// Specs + cuts → assets/work/<hero>/anim/specs/ (committed: the source of truth).
// Videos + sheets → ~/.cache/psyrena/anim/<hero>/ (rebuildable).

import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const [hero, ...only] = process.argv.slice(2);
if (!hero) { console.error("usage: build-moves.mjs <hero> [clip ...]"); process.exit(1); }
const { CLIPS } = await import(join(HERE, "moves", `${hero}.mjs`));
const specDir = join(ROOT, "assets/work", hero, "anim/specs");
const outDir = join(homedir(), ".cache/psyrena/anim", hero);
await mkdir(specDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const cuts = {};
for (const [name, make] of Object.entries(CLIPS)) {
  if (only.length && !only.includes(name)) continue;
  const { spec, cut } = make();
  cuts[name] = cut;
  const specPath = join(specDir, `${name}.json`);
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(join(specDir, `${name}.cut.json`), JSON.stringify(cut, null, 1) + "\n");
  const r = spawnSync(process.execPath, [join(HERE, "render.mjs"), specPath, join(outDir, `${name}.mp4`), "--sheet", join(outDir, `${name}_sheet.png`)], { encoding: "utf8" });
  const clamps = (r.stderr.match(/joint limits clamped: (.*)/) ?? [])[1];
  const took = (r.stderr.match(/rendered (\d+) frames in ([\d.]+) s/) ?? []).slice(1).join(" frames, ");
  console.log(`${name.padEnd(10)} ${r.status === 0 ? "ok" : "FAILED"}  ${took}s${clamps ? `  CLAMPED: ${clamps}` : ""}`);
  if (r.status !== 0) console.log(r.stderr.slice(-800));
}
