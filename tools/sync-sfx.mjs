/**
 * Encode the chosen PSFX sounds into public/assets/sfx/ as Opus-in-WebM.
 *
 * Reads psfx/sfx-choices.json (exported by the gitignored sfxpicker.html) and
 * transcodes every referenced .ogg out of the vendored psfx/library/ tree.
 * Both the choices file and public/assets/sfx/ are gitignored: the PSFX
 * license (Non-Commercial v1.1) permits use in the game but prohibits
 * redistributing the audio as a library, so the repo carries only this script
 * and the id→file manifest in src/state/sfx.ts — run `node tools/sync-sfx.mjs`
 * after a fresh clone to repopulate the sounds.
 *
 * Transcoding happens HERE rather than in tools/compress-audio.sh because this
 * script is the only thing that writes public/assets/sfx/ — a separate pass
 * would be undone by the next sync, and a fresh clone would land .ogg files
 * that the game (which asks for .webm — see src/core/audio.ts) never requests.
 * 48 kbps Opus takes the set from 2.3 MB to 1.0 MB.
 *
 * The manifest in src/state/sfx.ts stores STEMS, not filenames: the extension
 * belongs to src/core/audio.ts, and the source library is .ogg while what ships
 * is .webm, so a filename there would be wrong at one end or the other.
 *
 * Fails loudly on a basename collision (two chosen files with the same flat
 * name) and prints any manifest drift so src/state/sfx.ts can be updated.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const choicesPath = join(root, "psfx", "sfx-choices.json");
const outDir = join(root, "public", "assets", "sfx");

const { choices } = JSON.parse(readFileSync(choicesPath, "utf8"));

/** "footsteps-single-outdoors-001-03.ogg" -> "footsteps-single-outdoors-001-03" */
const stemOf = (f) => basename(f, extname(f));

const byStem = new Map(); // flat stem -> library-relative source
for (const [id, c] of Object.entries(choices)) {
  if (c.skip) continue;
  for (const f of c.files) {
    const stem = stemOf(f);
    const prev = byStem.get(stem);
    if (prev && prev !== f) {
      console.error(`COLLISION on ${stem}:\n  ${prev}\n  ${f} (via ${id})`);
      process.exit(1);
    }
    byStem.set(stem, f);
  }
}

mkdirSync(outDir, { recursive: true });
for (const [stem, rel] of byStem) {
  // 48k mono-or-stereo as the source has it: these are short one-shots, and
  // playSfx pitch-shifts some of them, so resampling buys nothing.
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", join(root, "psfx", "library", rel),
    "-c:a", "libopus", "-b:a", "48k", "-vbr", "on", "-application", "audio",
    join(outDir, `${stem}.webm`),
  ]);
}
console.log(`encoded ${byStem.size} files -> public/assets/sfx/*.webm`);

// Manifest lines for src/state/sfx.ts, for eyeballing drift after re-picks.
for (const [id, c] of Object.entries(choices)) {
  if (c.skip || !c.files.length) continue;
  console.log(`  "${id}": [${c.files.map((f) => `"${stemOf(f)}"`).join(", ")}],`);
}
