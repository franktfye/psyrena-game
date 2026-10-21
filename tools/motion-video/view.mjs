#!/usr/bin/env node
// Serve the model-pipeline tools: the m2mr run viewer (/, viewer.html) and the
// Concept Review page (/concepts, concepts.html) where Frank approves or refines
// a hero's T-pose plates before any Tripo credits are spent (concepts.mjs).
//
//   node tools/motion-video/view.mjs [--runs DIR] [--host ADDR] [--port N]
//
// A run is a folder under --runs (default ~/.cache/psyrena/m2mr-runs) holding
// source.mp4 (the gesture video fed to m2mr), mixamo_character.glb, and
// optionally compare.mp4 / run.json / gesture.json from the m2mr output.
// Plain HTTP; default host is this box's Tailscale address, so it is reachable
// on the tailnet only. It does NOT touch `tailscale serve` or the game ports.

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./concepts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), [])
);
const RUNS = resolve(args.runs ?? join(homedir(), ".cache/psyrena/m2mr-runs"));
const PORT = Number(args.port ?? 8470);
let HOST = args.host;
if (!HOST) {
  try { HOST = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).trim().split("\n")[0]; }
  catch { HOST = "127.0.0.1"; }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".glb": "model/gltf-binary", ".mp4": "video/mp4", ".png": "image/png",
};

/** One refine at a time per hero; the page polls /api/concepts for the result. */
const jobs = new Map(); // hero -> { kind, started, error? }

async function conceptState() {
  const out = [];
  for (const hero of await C.listHeroes()) {
    const r = await C.readReview(hero);
    out.push({ ...r, job: jobs.get(hero) ?? null });
  }
  return out;
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 20_000) { fail(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { ok(body ? JSON.parse(body) : {}); } catch (e) { fail(e); } });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": MIME[".json"], "Cache-Control": "no-cache" });
  res.end(JSON.stringify(obj));
}

/** Resolve `rel` inside `base`, refusing anything that escapes it. */
function inside(base, rel) {
  const p = resolve(base, "." + sep + rel);
  return p === base || p.startsWith(base + sep) ? p : null;
}

async function sendFile(req, res, file) {
  const st = await stat(file);
  const type = MIME[extname(file)] ?? "application/octet-stream";
  // Byte ranges: browsers need them to seek in <video>.
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    const end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (url === "/" || url === "/index.html") return sendFile(req, res, join(HERE, "viewer.html"));
    if (url === "/concepts") return sendFile(req, res, join(HERE, "concepts.html"));
    if (url === "/api/concepts" && req.method === "GET") return sendJson(res, 200, { buzzPerImage: C.BUZZ_PER_IMAGE, heroes: await conceptState() });
    const act = /^\/api\/concepts\/([a-z][a-z0-9_-]*)\/(refine|approve)$/.exec(url);
    if (act && req.method === "POST") {
      const [, hero, kind] = act;
      if (jobs.get(hero)?.kind === "refine" && !jobs.get(hero).error) return sendJson(res, 409, { error: "a refine is already running" });
      const body = await readJson(req);
      if (kind === "approve") return sendJson(res, 200, await C.approve(hero, body.version));
      if (!String(body.note ?? "").trim()) return sendJson(res, 400, { error: "say what to change" });
      jobs.set(hero, { kind: "refine", view: body.view, note: body.note, started: Date.now() });
      C.refine(hero, { note: body.note, view: body.view, from: body.from })
        .then(() => jobs.delete(hero))
        .catch((e) => jobs.set(hero, { kind: "refine", error: e.message, started: jobs.get(hero)?.started }));
      return sendJson(res, 202, { started: true });
    }
    if (url.startsWith("/concept-img/")) {
      const [, , hero, ...rest] = url.split("/");
      const file = inside(C.conceptDir(hero), rest.join("/"));
      if (!file) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return sendFile(req, res, file);
    }
    if (url === "/runs.json") {
      const names = [];
      for (const d of await readdir(RUNS, { withFileTypes: true })) {
        if (d.isDirectory()) names.push([d.name, (await stat(join(RUNS, d.name))).mtimeMs]);
      }
      names.sort((a, b) => b[1] - a[1]); // newest first
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      return res.end(JSON.stringify(names.map((n) => n[0])));
    }
    let file = null;
    if (url.startsWith("/runs/")) file = inside(RUNS, url.slice("/runs/".length));
    else if (url.startsWith("/three/")) file = inside(join(ROOT, "node_modules/three"), url.slice("/three/".length));
    if (!file) throw Object.assign(new Error("not found"), { code: "ENOENT" });
    await sendFile(req, res, file);
  } catch (err) {
    if (err.code === "ENOENT") return res.writeHead(404).end();
    sendJson(res, 500, { error: err.message });
  }
}).listen(PORT, HOST, () => console.log(`m2mr viewer: http://${HOST}:${PORT}/  (runs: ${RUNS})`));
