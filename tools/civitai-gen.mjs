#!/usr/bin/env node
// Generate concept-art PNGs via Civitai Orchestration (OpenAI gpt-image-2 engine).
// Token: ~/.civitai.api.env (raw token, or KEY=value line containing "token"/"key").
//
// Usage:
//   node tools/civitai-gen.mjs --prompt "..." --out assets/concept/foo.png
//   node tools/civitai-gen.mjs --prompt-file p.txt --width 1280 --height 720 --whatif
//   node tools/civitai-gen.mjs --prompt "..." --image src.png --out edited.png   (editImage)
//
// Options: --width --height (256–3840, multiples of 16, default 1024)
//          --quality low|medium|high (default high)  --quantity 1–4 (default 1)
//          --image <path>  (repeatable; switches to editImage, edit-chaining)
//          --whatif        (print Buzz cost, generate nothing)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname, basename } from 'node:path';

const API = 'https://orchestration.civitai.com/v2/consumer/workflows';

function parseArgs(argv) {
  const a = { width: 1024, height: 1024, quality: 'high', quantity: 1, images: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--prompt') a.prompt = next();
    else if (k === '--prompt-file') a.promptFile = next();
    else if (k === '--out') a.out = next();
    else if (k === '--width') a.width = Number(next());
    else if (k === '--height') a.height = Number(next());
    else if (k === '--quality') a.quality = next();
    else if (k === '--quantity') a.quantity = Number(next());
    else if (k === '--image') a.images.push(next());
    else if (k === '--whatif') a.whatif = true;
    else throw new Error(`Unknown arg: ${k}`);
  }
  return a;
}

async function loadToken() {
  const raw = (await readFile(join(homedir(), '.civitai.api.env'), 'utf8')).trim();
  for (const line of raw.split('\n')) {
    const m = line.match(/^[A-Za-z_]*(?:TOKEN|KEY)[A-Za-z_]*\s*=\s*(.+)$/i);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return raw.split('\n')[0].trim();
}

async function fileToDataUrl(path) {
  const buf = await readFile(path);
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function collectImageUrls(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectImageUrls(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.url === 'string' && node.url.startsWith('http')) out.push(node.url);
    for (const v of Object.values(node)) collectImageUrls(v, out);
  }
  return [...new Set(out)];
}

function collectCosts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectCosts(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/cost/i.test(k) && typeof v === 'number') out.push([k, v]);
      else collectCosts(v, out);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.promptFile) args.prompt = await readFile(args.promptFile, 'utf8');
if (!args.prompt) { console.error('Missing --prompt / --prompt-file'); process.exit(1); }
if (args.width % 16 || args.height % 16) { console.error('width/height must be multiples of 16'); process.exit(1); }

const token = await loadToken();
const input = {
  engine: 'openai',
  model: 'gpt-image-2',
  operation: args.images.length ? 'editImage' : 'createImage',
  prompt: args.prompt,
  width: args.width,
  height: args.height,
  quantity: args.quantity,
  quality: args.quality,
  outputFormat: 'png',
};
if (args.images.length) input.images = await Promise.all(args.images.map(fileToDataUrl));

const qs = args.whatif ? '?whatif=true' : '?wait=60';
const res = await fetch(API + qs, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ steps: [{ $type: 'imageGen', input }] }),
});
let body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${JSON.stringify(body, null, 2)}`);
  process.exit(1);
}

if (args.whatif) {
  const costs = collectCosts(body);
  console.log(costs.length ? costs.map(([k, v]) => `${k}: ${v}`).join('\n') : JSON.stringify(body, null, 2));
  process.exit(0);
}

// Poll until the workflow leaves processing states (wait=60 usually suffices).
const id = body.id;
const terminal = (s) => !['unassigned', 'preparing', 'scheduled', 'processing'].includes(String(s).toLowerCase());
for (let tries = 0; id && !terminal(body.status) && tries < 60; tries++) {
  await new Promise((r) => setTimeout(r, 5000));
  const poll = await fetch(`${API}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (poll.ok) body = await poll.json();
  console.error(`  status: ${body.status}`);
}
if (String(body.status).toLowerCase() === 'failed') {
  console.error(`Workflow failed: ${JSON.stringify(body, null, 2)}`);
  process.exit(1);
}

const urls = collectImageUrls(body);
if (!urls.length) {
  console.error(`No image URLs in response: ${JSON.stringify(body, null, 2)}`);
  process.exit(1);
}

const out = args.out ?? 'civitai-out.png';
await mkdir(dirname(out) || '.', { recursive: true });
for (let i = 0; i < urls.length; i++) {
  const path = urls.length === 1 ? out : join(dirname(out), `${basename(out, extname(out))}_${i + 1}${extname(out) || '.png'}`);
  const img = await fetch(urls[i]);
  if (!img.ok) { console.error(`Download failed (${img.status}): ${urls[i]}`); continue; }
  await writeFile(path, Buffer.from(await img.arrayBuffer()));
  console.log(path);
}
const costs = collectCosts(body);
if (costs.length) console.error(`cost: ${costs.map(([k, v]) => `${k}=${v}`).join(' ')}`);
