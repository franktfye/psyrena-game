#!/usr/bin/env node
// Concept-art review CLI. Same code as the Concept Review page (concepts.mjs).
//
//   node tools/motion-video/concept.mjs new <hero> --front-prompt-file f.txt --back-prompt-file b.txt [--ref img]...
//   node tools/motion-video/concept.mjs import <hero> --front a.png --back b.png [--front-prompt-file f --back-prompt-file b]
//   node tools/motion-video/concept.mjs refine <hero> --note "..." [--view front|back|both] [--from N]
//   node tools/motion-video/concept.mjs approve <hero> [--version N]
//   node tools/motion-video/concept.mjs status <hero>
//   node tools/motion-video/concept.mjs gate <hero>      # exit 1 unless approved; prints approved plates
//
// Pipeline rule: run `gate` before any `tripo make`. Frank approves (or asks for
// changes) in Concept Review: http://localhost:8470/concepts

import { readFile } from "node:fs/promises";
import * as C from "./concepts.mjs";

const [cmd, hero, ...rest] = process.argv.slice(2);
const opt = { ref: [] };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (k === "ref") opt.ref.push(rest[++i]);
  else opt[k] = rest[++i];
}
const text = async (inline, file) => inline ?? (file ? await readFile(file, "utf8") : undefined);

try {
  if (!cmd || !hero) throw new Error("usage: concept.mjs new|import|refine|approve|status|gate <hero> [options]");
  let r;
  if (cmd === "new") {
    r = await C.newConcept(hero, {
      frontPrompt: await text(opt["front-prompt"], opt["front-prompt-file"]),
      backPrompt: await text(opt["back-prompt"], opt["back-prompt-file"]),
      refs: opt.ref,
    });
  } else if (cmd === "import") {
    r = await C.importConcept(hero, {
      front: opt.front, back: opt.back, note: opt.note ?? "imported",
      frontPrompt: await text(opt["front-prompt"], opt["front-prompt-file"]),
      backPrompt: await text(opt["back-prompt"], opt["back-prompt-file"]),
    });
  } else if (cmd === "refine") {
    r = await C.refine(hero, { note: opt.note, view: opt.view ?? "both", from: opt.from ? Number(opt.from) : undefined });
  } else if (cmd === "approve") {
    r = await C.approve(hero, opt.version ? Number(opt.version) : undefined);
  } else if (cmd === "status") {
    r = await C.readReview(hero);
  } else if (cmd === "gate") {
    const g = await C.gate(hero);
    console.log(JSON.stringify(g));
    process.exit(0);
  } else throw new Error(`unknown command ${cmd}`);
  const last = r.versions.at(-1);
  console.log(`${hero}: ${r.status}${r.approved ? ` (v${r.approved.v})` : ""}, latest v${last.v}: ${last.note}`);
} catch (err) {
  console.error(`concept: ${err.message}`);
  process.exit(1);
}
