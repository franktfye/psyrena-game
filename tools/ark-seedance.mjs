#!/usr/bin/env node
// Seedance video via BytePlus Ark content-generation tasks.
// Token: ~/.seedance.api.env (raw key, or KEY=value line).
//
//   node tools/ark-seedance.mjs --model dreamina-seedance-2.5 --prompt-file p.txt \
//     --first start.png --last end.png --duration 10 --out clip.mp4
//   node tools/ark-seedance.mjs --task cgt-xxxx --out clip.mp4     (resume polling)
//
// --last is optional (first-frame-only mode). Render params are appended to the
// prompt as Seedance text commands: --ratio --resolution --duration.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname } from 'node:path';

const API = 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks';

function parseArgs(argv) {
  const a = { duration: 10, resolution: '1080p', ratio: '16:9', refs: [], audios: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--model') a.model = next();
    else if (k === '--prompt') a.prompt = next();
    else if (k === '--prompt-file') a.promptFile = next();
    else if (k === '--first') a.first = next();
    else if (k === '--last') a.last = next();
    else if (k === '--ref') a.refs.push(next());
    else if (k === '--audio') a.audios.push(next());
    else if (k === '--duration') a.duration = Number(next());
    else if (k === '--resolution') a.resolution = next();
    else if (k === '--ratio') a.ratio = next();
    else if (k === '--out') a.out = next();
    else if (k === '--task') a.task = next();
    else throw new Error(`Unknown arg: ${k}`);
  }
  return a;
}

async function loadToken() {
  const raw = (await readFile(join(homedir(), '.seedance.api.env'), 'utf8')).trim();
  for (const line of raw.split('\n')) {
    const m = line.match(/^[A-Za-z_]*(?:TOKEN|KEY)[A-Za-z_]*\s*=\s*(.+)$/i);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return raw.split('\n')[0].trim();
}

async function fileToDataUrl(path) {
  const buf = await readFile(path);
  const mime = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  }[extname(path).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const args = parseArgs(process.argv.slice(2));
const token = await loadToken();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

async function createTask() {
  if (args.promptFile) args.prompt = await readFile(args.promptFile, 'utf8');
  if (!args.prompt) { console.error('Missing --prompt / --prompt-file'); process.exit(1); }
  if (!args.model) { console.error('Missing --model'); process.exit(1); }

  // with a first-frame image the output ratio must be adaptive (follows the image)
  const ratio = args.first ? 'adaptive' : args.ratio;
  const text = `${args.prompt.trim()} --ratio ${ratio} --resolution ${args.resolution} --duration ${args.duration}`;
  const content = [{ type: 'text', text }];
  if (args.first) content.push({ type: 'image_url', image_url: { url: await fileToDataUrl(args.first) }, role: 'first_frame' });
  if (args.last) content.push({ type: 'image_url', image_url: { url: await fileToDataUrl(args.last) }, role: 'last_frame' });
  for (const r of args.refs) content.push({ type: 'image_url', image_url: { url: await fileToDataUrl(r) }, role: 'reference_image' });
  for (const p of args.audios) content.push({ type: 'audio_url', audio_url: { url: await fileToDataUrl(p) }, role: 'reference_audio' });

  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ model: args.model, content }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) {
    console.error(`create failed HTTP ${res.status}: ${JSON.stringify(body)}`);
    process.exit(res.status === 404 || body?.error?.code === 'ModelNotFound' ? 44 : 1);
  }
  console.log(`task ${body.id}`);
  return body.id;
}

async function poll(id) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 30 * 60 * 1000) { console.error('timeout after 30min'); process.exit(1); }
    const res = await fetch(`${API}/${id}`, { headers });
    const body = await res.json().catch(() => ({}));
    const status = body.status ?? 'unknown';
    console.log(`  status: ${status}`);
    if (status === 'succeeded') return body;
    if (status === 'failed' || status === 'cancelled') {
      console.error(JSON.stringify(body.error ?? body, null, 2));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
}

const id = args.task ?? await createTask();
const done = await poll(id);
const url = done?.content?.video_url;
if (!url) { console.error(`no video_url in result: ${JSON.stringify(done)}`); process.exit(1); }
if (args.out) {
  const res = await fetch(url);
  if (!res.ok) { console.error(`download failed HTTP ${res.status}`); process.exit(1); }
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, Buffer.from(await res.arrayBuffer()));
  console.log(`wrote ${args.out}`);
  if (done.usage) console.log(`usage ${JSON.stringify(done.usage)}`);
} else {
  console.log(url);
}
