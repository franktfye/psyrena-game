// Concept-art review: versioned T-pose plates per hero, refined from Frank's
// notes and gated on his approval before any Tripo credits are spent.
//
// Layout, per hero (committed with the rest of the hero's working art):
//   assets/work/<hero>/concept/
//     review.json               status, prompts, every version and its note
//     v<n>_front.png, v<n>_back.png
//     approved_front.png, approved_back.png   (copies of the approved version)
//
// Used by concept.mjs (CLI) and view.mjs (the Concept Review page), so a refine
// from the page and one from the terminal are the same code path.

import { readFile, writeFile, mkdir, copyFile, readdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
const WORK = join(ROOT, "assets/work");
const GEN = join(ROOT, "tools/civitai-gen.mjs");

/** Buzz per 1024² high-quality GPT Image 2.5 image (create or edit). */
export const BUZZ_PER_IMAGE = 69;

export const conceptDir = (hero) => {
  if (!/^[a-z][a-z0-9_-]*$/.test(hero)) throw new Error(`bad hero id: ${hero}`);
  return join(WORK, hero, "concept");
};

const exists = (p) => access(p).then(() => true, () => false);

export async function readReview(hero) {
  return JSON.parse(await readFile(join(conceptDir(hero), "review.json"), "utf8"));
}

async function writeReview(hero, review) {
  await writeFile(join(conceptDir(hero), "review.json"), JSON.stringify(review, null, 1) + "\n");
}

export async function listHeroes() {
  const out = [];
  for (const d of await readdir(WORK, { withFileTypes: true })) {
    if (d.isDirectory() && (await exists(join(WORK, d.name, "concept/review.json")))) out.push(d.name);
  }
  return out.sort();
}

/** One GPT Image 2.5 call through tools/civitai-gen.mjs. Rejects on failure. */
function generate({ prompt, images = [], out }) {
  const args = [GEN, "--prompt", prompt, "--width", "1024", "--height", "1024", "--quality", "high", "--out", out];
  for (const img of images) args.push("--image", img);
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`civitai-gen exit ${code}: ${err.trim().slice(-400)}`))));
  });
}

const REFINE = (note) =>
  "Revise this character concept plate. Keep everything exactly the same — identity, face, hair, " +
  "costume, colours, art style, strict T-pose, scale, camera framing, plain light-grey studio " +
  "background and lighting — except for this change requested by the art director:\n\n" + note +
  "\n\nWhole body still visible from hair to shoes, hands empty, no text.";

/**
 * Create v1. `refs` are reference images for the FRONT (style/pose plate first,
 * likeness second, as for Erikson); the back is always an edit of the new front
 * so the two views agree.
 */
export async function newConcept(hero, { frontPrompt, backPrompt, refs = [], note = "" }) {
  const dir = conceptDir(hero);
  await mkdir(dir, { recursive: true });
  if (await exists(join(dir, "review.json"))) throw new Error(`${hero} already has a concept; refine it instead`);
  const front = join(dir, "v1_front.png"), back = join(dir, "v1_back.png");
  await generate({ prompt: frontPrompt, images: refs, out: front });
  await generate({ prompt: backPrompt, images: [front], out: back });
  const review = {
    hero, status: "pending", approved: null,
    prompts: { front: frontPrompt, back: backPrompt, refs: refs.map((r) => resolve(r).replace(ROOT + "/", "")) },
    versions: [{ v: 1, front: "v1_front.png", back: "v1_back.png", note: note || "initial", created: new Date().toISOString() }],
  };
  await writeReview(hero, review);
  return review;
}

/** Register already-generated plates as v1 (e.g. art made before this tool). */
export async function importConcept(hero, { front, back, frontPrompt = "", backPrompt = "", note = "imported" }) {
  const dir = conceptDir(hero);
  await mkdir(dir, { recursive: true });
  if (await exists(join(dir, "review.json"))) throw new Error(`${hero} already has a concept`);
  await copyFile(front, join(dir, "v1_front.png"));
  await copyFile(back, join(dir, "v1_back.png"));
  const review = {
    hero, status: "pending", approved: null, prompts: { front: frontPrompt, back: backPrompt, refs: [] },
    versions: [{ v: 1, front: "v1_front.png", back: "v1_back.png", note, created: new Date().toISOString() }],
  };
  await writeReview(hero, review);
  return review;
}

/**
 * New version from a note. view = "front" | "back" | "both". A front change
 * always regenerates the back from the new front (the back is derived), so
 * "front" and "both" differ only in whether the note is ALSO applied to the back.
 */
export async function refine(hero, { note, view = "both", from }) {
  if (!note?.trim()) throw new Error("a refine needs a note saying what to change");
  if (!["front", "back", "both"].includes(view)) throw new Error(`view must be front|back|both, not ${view}`);
  const dir = conceptDir(hero);
  const review = await readReview(hero);
  const base = review.versions.find((x) => x.v === (from ?? review.versions.at(-1).v));
  if (!base) throw new Error(`no version ${from}`);
  const v = review.versions.at(-1).v + 1;
  const front = join(dir, `v${v}_front.png`), back = join(dir, `v${v}_back.png`);
  if (view === "back") {
    await copyFile(join(dir, base.front), front);
    await generate({ prompt: REFINE(note), images: [join(dir, base.back)], out: back });
  } else {
    await generate({ prompt: REFINE(note), images: [join(dir, base.front)], out: front });
    const backPrompt = (review.prompts.back || "Show this exact same character from directly BEHIND, in the identical strict T-pose, framing, lighting and background.") +
      (view === "both" ? `\n\nAlso apply this change: ${note}` : "");
    await generate({ prompt: backPrompt, images: [front], out: back });
  }
  review.versions.push({ v, front: `v${v}_front.png`, back: `v${v}_back.png`, note: note.trim(), view, from: base.v, created: new Date().toISOString() });
  review.status = "pending";
  await writeReview(hero, review);
  return review;
}

export async function approve(hero, v) {
  const dir = conceptDir(hero);
  const review = await readReview(hero);
  const ver = review.versions.find((x) => x.v === (v ?? review.versions.at(-1).v));
  if (!ver) throw new Error(`no version ${v}`);
  await copyFile(join(dir, ver.front), join(dir, "approved_front.png"));
  await copyFile(join(dir, ver.back), join(dir, "approved_back.png"));
  review.status = "approved";
  review.approved = { v: ver.v, at: new Date().toISOString() };
  await writeReview(hero, review);
  return review;
}

/** Throws unless the hero's concept is approved; returns the approved plate paths. */
export async function gate(hero) {
  const review = await readReview(hero).catch(() => null);
  if (!review) throw new Error(`${hero}: no concept yet. Generate one and get it approved first.`);
  if (review.status !== "approved") {
    throw new Error(`${hero}: concept v${review.versions.at(-1).v} is waiting for approval in Concept Review (http://localhost:8470/concepts).`);
  }
  const dir = conceptDir(hero);
  return { v: review.approved.v, front: join(dir, "approved_front.png"), back: join(dir, "approved_back.png") };
}
