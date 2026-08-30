#!/usr/bin/env node
// MiniMax H3 video via Civitai Orchestration.
// Token: ~/.civitai.api.env
//
//   node tools/civitai-h3.mjs --prompt "..." --out clip.mp4
//   node tools/civitai-h3.mjs --prompt-file p.txt --first start.png --last end.png --duration 5 --out clip.mp4
//   node tools/civitai-h3.mjs --prompt "..." --whatif
//
// Modes are inferred: first / last / first+last / text-only.
// Always wait=0 — H3 exceeds the 100s inline timeout.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname } from 'node:path';

const API = 'https://orchestration.civitai.com/v2/consumer/workflows';

function parseArgs(argv) {
  const a = { duration: 5, resolution: '2K', images: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--prompt') a.prompt = next();
    else if (k === '--prompt-file') a.promptFile = next();
    else if (k === '--out') a.out = next();
    else if (k === '--first') a.first = next();
    else if (k === '--last') a.last = next();
    else if (k === '--duration') a.duration = Number(next());
    else if (k === '--resolution') a.resolution = next();
    else if (k === '--aspect') a.aspectRatio = next();
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

function collectVideoUrls(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectVideoUrls(n, out));
  else if (node && typeof node === 'object') {
    if (node.video && typeof node.video.url === 'string') out.push(node.video.url);
    if (typeof node.url === 'string' && /\.mp4(\?|$)/i.test(node.url)) out.push(node.url);
    for (const v of Object.values(node)) collectVideoUrls(v, out);
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
if (args.duration < 5 || args.duration > 15) { console.error('duration must be 5–15'); process.exit(1); }

const token = await loadToken();
const input = {
  engine: 'minimax-h3',
  prompt: args.prompt.trim(),
  resolution: args.resolution,
  duration: args.duration,
};
if (args.aspectRatio) input.aspectRatio = args.aspectRatio;
if (args.first) input.firstFrameImage = await fileToDataUrl(args.first);
if (args.last) input.lastFrameImage = await fileToDataUrl(args.last);
if (!args.first && !args.last) input.aspectRatio = args.aspectRatio ?? '16:9';

const qs = args.whatif ? '?whatif=true' : '?wait=0';
const res = await fetch(API + qs, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ steps: [{ $type: 'videoGen', input }] }),
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

const id = body.id;
if (!id) {
  console.error(`No workflow id: ${JSON.stringify(body, null, 2)}`);
  process.exit(1);
}
console.error(`submitted ${id} status=${body.status}`);

const terminal = (s) => !['unassigned', 'preparing', 'scheduled', 'processing'].includes(String(s).toLowerCase());
for (let tries = 0; !terminal(body.status) && tries < 90; tries++) {
  await new Promise((r) => setTimeout(r, 10000));
  const poll = await fetch(`${API}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (poll.ok) body = await poll.json();
  console.error(`  ${new Date().toISOString().slice(11, 19)}  ${body.status}`);
}

if (String(body.status).toLowerCase() === 'failed') {
  console.error(`Workflow failed: ${JSON.stringify(body, null, 2)}`);
  process.exit(1);
}

const urls = collectVideoUrls(body);
if (!urls.length) {
  console.error(`No video URL: ${JSON.stringify(body, null, 2)}`);
  process.exit(1);
}

const out = args.out ?? 'civitai-h3.mp4';
await mkdir(dirname(out) || '.', { recursive: true });
const vid = await fetch(urls[0]);
if (!vid.ok) { console.error(`Download failed (${vid.status}): ${urls[0]}`); process.exit(1); }
await writeFile(out, Buffer.from(await vid.arrayBuffer()));
console.log(out);
const costs = collectCosts(body);
if (costs.length) console.error(`cost: ${costs.map(([k, v]) => `${k}=${v}`).join(' ')}`);
