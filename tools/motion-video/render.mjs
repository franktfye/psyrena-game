#!/usr/bin/env node
// Render a motion-reference video of a Mixamo mannequin ("droid") performing a
// gesture spec, frame-exact, for Motion2MixamoRig (m2mr) on gpu-box.
//
//   node tools/motion-video/render.mjs <spec.json> <out.mp4> [--sheet sheet.png]
//
// Spec (JSON):
//   { "duration": 4, "fps": 30, "width": 1280, "height": 720,
//     "model": "soldier",             // soldier (default) | michelle | xbot
//     "base": "idle",                 // the model's mocap clip, or "tpose" for none
//     "camera": { "azimuth": 20, "elevation": 8 },
//     "keys": { "RightArm": [[0,[0,0,0],0], [0.8,[0,0,70]], ...], ... } }
//   key = [t, [x,y,z], w?]: the joint's local euler in degrees FROM THE T-POSE
//   rest, eased between keys and clamped to the joint limits in droid.html;
//   w (default 1) blends it against the base clip, so 0 → 1 eases a gesture in
//   from the idle mocap. Axis meanings per joint are in droid.html LIMITS.
//
// The figure is a Mixamo-rigged three.js sample (see MODELS below). Software GL (SwiftShader) is
// slow on the Pi, which is why the clock is driven per frame instead of
// screen-recording: the video is smooth however long each frame takes.

import { createServer } from "node:http";
import { readFile, mkdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
// Reference figures, all Mixamo-rigged samples from the three.js repo (r169),
// cached under ~/.cache/psyrena/ and never committed. m2mr's person check and
// GVHMR's tracker run YOLOv8x, which needs a figure that looks like a real
// human: Soldier scores like a photo, the faceless X Bot mannequin does not
// (0.10–0.25 "person", even painted with clothes; the gate is 0.5).
const MODELS = {
  soldier: { file: "Soldier.glb", yaw: 180 },
  michelle: { file: "Michelle.glb", yaw: 0 },
  xbot: { file: "Xbot.glb", yaw: 0 },
};
const MODEL_BASE = "https://raw.githubusercontent.com/mrdoob/three.js/r169/examples/models/gltf/";

const [specPath, outPath, ...rest] = process.argv.slice(2);
if (!specPath || !outPath) {
  console.error("usage: render.mjs <spec.json> <out.mp4> [--sheet sheet.png]");
  process.exit(1);
}
const sheetPath = rest[0] === "--sheet" ? rest[1] : null;
const spec = { duration: 4, fps: 30, width: 1280, height: 720, base: "idle", model: "soldier", ...JSON.parse(await readFile(specPath, "utf8")) };
// A .glb path renders that file instead of a stage figure: used to review
// FINISHED hero clips (base = the clip name), not to make m2mr input.
const model = spec.model.endsWith(".glb") ? { file: resolve(spec.model), yaw: 0, local: true } : MODELS[spec.model];
if (!model) throw new Error(`unknown model ${spec.model}; have ${Object.keys(MODELS).join(", ")}`);
spec.yaw ??= model.yaw;
const DROID = model.local ? model.file : join(homedir(), ".cache/psyrena", model.file);

try {
  await access(DROID);
} catch {
  await mkdir(dirname(DROID), { recursive: true });
  const r = await fetch(MODEL_BASE + model.file);
  if (!r.ok) throw new Error(`${model.file} download failed: ${r.status}`);
  await (await import("node:fs/promises")).writeFile(DROID, Buffer.from(await r.arrayBuffer()));
}

// Tiny static server: the stage page, three from node_modules, the droid.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary" };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file;
  if (url === "/" || url === "/droid.html") file = join(HERE, "droid.html");
  else if (url === "/droid.glb") file = DROID;
  else if (url.startsWith("/three/") && !url.includes("..")) file = join(ROOT, "node_modules", url);
  try {
    if (!file) throw new Error("404");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: "new",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: spec.width, height: spec.height });
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.goto(`http://127.0.0.1:${port}/droid.html`, { waitUntil: "load" });
await page.waitForFunction(() => window.stageReady === true);
const info = await page.evaluate((s) => window.setup(s), spec);
console.error(`stage: ${info.bones} bones, clips: ${info.clips.join(", ")}`);

await mkdir(dirname(resolve(outPath)), { recursive: true });
const frames = Math.round(spec.duration * spec.fps);
const ff = spawn("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(spec.fps), "-i", "-",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", outPath,
], { stdio: ["pipe", "inherit", "inherit"] });
const ffDone = new Promise((r, j) => ff.on("close", (c) => (c === 0 ? r() : j(new Error(`ffmpeg exit ${c}`)))));

const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  const url = await page.evaluate((t) => window.renderAt(t), i / spec.fps);
  const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 30 === 0) console.error(`  frame ${i}/${frames}`);
}
ff.stdin.end();
await ffDone;
const clamped = await page.evaluate(() => window.clampLog());
await browser.close();
server.close();
console.error(`rendered ${frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (clamped.length) console.error(`joint limits clamped: ${clamped.join("; ")}`);

if (sheetPath) {
  // 8 evenly spaced frames in a 4×2 grid, for review without playing the clip.
  const step = Math.max(1, Math.floor(frames / 8));
  await new Promise((r, j) =>
    spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", outPath, "-vf",
      `select='not(mod(n\\,${step}))',scale=480:-1,tile=4x2`, "-frames:v", "1", sheetPath],
      { stdio: "inherit" }).on("close", (c) => (c === 0 ? r() : j(new Error("sheet failed")))));
  console.error(`sheet: ${sheetPath}`);
}
console.log(outPath);
