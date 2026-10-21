#!/usr/bin/env node
// Generate a textured 3D model with Meshy (text → 3D: preview mesh, then PBR refine).
// Key: MESHY_API_KEY in the environment or ~/.meshy.api.env (KEY=value line).
//
// Usage:
//   node tools/meshy-gen.mjs --prompt-file p.txt --out assets/work/kowloon/meshy/<id> [--polycount 4000]
//   node tools/meshy-gen.mjs --image concept.png --out <dir> [--polycount 30000]   (image → 3D, textured)
//   node tools/meshy-gen.mjs --balance
//
// Writes <out>/model.glb, <out>/thumbnail.png and <out>/meshy.json (both task
// records). Re-running with the same --out resumes: a finished preview is not
// paid for twice.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.meshy.ai/openapi";

async function key() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const raw = await readFile(join(homedir(), ".meshy.api.env"), "utf8");
  const m = raw.match(/MESHY_API_KEY\s*=\s*(\S+)/);
  if (!m) throw new Error("no MESHY_API_KEY in ~/.meshy.api.env");
  return m[1];
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, "");
  args[k] = process.argv[i + 1]?.startsWith("--") || i + 1 >= process.argv.length ? true : process.argv[++i];
}

const auth = { Authorization: `Bearer ${await key()}` };
async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function wait(id, label, path = "/v2/text-to-3d") {
  for (;;) {
    const t = await call("GET", `${path}/${id}`);
    if (t.status === "SUCCEEDED") return t;
    if (t.status === "FAILED" || t.status === "CANCELED" || t.status === "EXPIRED") {
      throw new Error(`${label} ${t.status}: ${JSON.stringify(t.task_error ?? {})}`);
    }
    process.stderr.write(`${label} ${t.status} ${t.progress ?? 0}%\r`);
    await new Promise((r) => setTimeout(r, 8000));
  }
}

async function download(url, path) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
  await writeFile(path, Buffer.from(await r.arrayBuffer()));
}

if (args.balance) {
  console.log(JSON.stringify(await call("GET", "/v1/balance")));
  process.exit(0);
}
if (args.image && args.out) {
  await mkdir(args.out, { recursive: true });
  const recPath = join(args.out, "meshy.json");
  const rec = await readFile(recPath, "utf8").then(JSON.parse, () => ({ image: args.image }));
  const save = () => writeFile(recPath, JSON.stringify(rec, null, 1) + "\n");
  if (rec.task?.status !== "SUCCEEDED") {
    const b64 = (await readFile(args.image)).toString("base64");
    const mime = args.image.endsWith(".png") ? "image/png" : "image/jpeg";
    const { result } = await call("POST", "/v1/image-to-3d", {
      image_url: `data:${mime};base64,${b64}`, ai_model: "latest", topology: "triangle",
      target_polycount: Number(args.polycount ?? 30000), should_remesh: true,
      should_texture: true, enable_pbr: true,
    });
    rec.task = { id: result };
    await save();
    rec.task = await wait(result, "image-to-3d", "/v1/image-to-3d");
    await save();
  }
  await download(rec.task.model_urls.glb, join(args.out, "model.glb"));
  if (rec.task.thumbnail_url) await download(rec.task.thumbnail_url, join(args.out, "thumbnail.png"));
  console.log(`meshy-gen: ${args.out}/model.glb`);
  process.exit(0);
}
if (!args.out || !(args.prompt || args["prompt-file"])) {
  console.error("usage: meshy-gen.mjs --prompt-file p.txt --out <dir> [--polycount N] | --balance");
  process.exit(1);
}
const prompt = (args.prompt ?? (await readFile(args["prompt-file"], "utf8"))).trim().slice(0, 600);
await mkdir(args.out, { recursive: true });
const recPath = join(args.out, "meshy.json");
const rec = await readFile(recPath, "utf8").then(JSON.parse, () => ({ prompt }));
const save = () => writeFile(recPath, JSON.stringify(rec, null, 1) + "\n");

if (!rec.preview?.status || rec.preview.status !== "SUCCEEDED") {
  const { result } = await call("POST", "/v2/text-to-3d", {
    mode: "preview", prompt, art_style: "realistic", ai_model: "latest",
    topology: "triangle", target_polycount: Number(args.polycount ?? 4000), should_remesh: true,
  });
  rec.preview = { id: result };
  await save();
  rec.preview = await wait(result, "preview");
  await save();
}
if (!rec.refine?.status || rec.refine.status !== "SUCCEEDED") {
  const { result } = await call("POST", "/v2/text-to-3d", {
    mode: "refine", preview_task_id: rec.preview.id, enable_pbr: true,
  });
  rec.refine = { id: result };
  await save();
  rec.refine = await wait(result, "refine");
  await save();
}
await download(rec.refine.model_urls.glb, join(args.out, "model.glb"));
if (rec.refine.thumbnail_url) await download(rec.refine.thumbnail_url, join(args.out, "thumbnail.png"));
console.log(`meshy-gen: ${args.out}/model.glb`);
