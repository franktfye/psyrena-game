/**
 * Server load, for the login screen's status pill (`GET /api/server/load`).
 *
 * One number a player can read: the WORST of three resources, each as a
 * fraction of what the machine can give —
 *
 *   cpu   share of all cores busy over the last sample window (from the
 *         kernel's per-core tick counters, not loadavg: a run queue is not
 *         a percentage, and on a 2-vCPU droplet loadavg 2.0 can be fine)
 *   mem   1 − MemAvailable / MemTotal (/proc/meminfo; MemAvailable counts the
 *         page cache the kernel can hand back, so a warm cache is not "full")
 *   loop  this process's event-loop lag, p99 over the window, against 200 ms
 *         — the point where a fight's 100 ms sim tick visibly stutters. Node
 *         is single-threaded: a busy loop is full whatever the cores say.
 *
 * FULL at 0.90 (Frank, 2026-10-24: "to be safe, 90% = server full"). Sampled
 * on a timer, not per request, so the probe itself costs nothing (CLAUDE.md
 * rule 6: no per-request CPU work on the static path).
 */

import os from "node:os";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

/** At or above this the server reports itself full. */
export const FULL_AT = 0.9;
/** Lag at which the event loop counts as saturated, ms. */
const LOOP_SATURATED_MS = 200;
const SAMPLE_MS = 5_000;

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

/** Busy and total ticks summed over every core. */
function cpuTicks() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
}

function memoryUsed() {
  try {
    const info = readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? NaN);
    const total = kb("MemTotal");
    const avail = kb("MemAvailable");
    if (total > 0 && avail >= 0) return 1 - avail / total;
  } catch {
    /* not Linux: fall through */
  }
  return 1 - os.freemem() / os.totalmem();
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

let prev = cpuTicks();
let latest = { cpu: 0, mem: clamp01(memoryUsed()), loop: 0 };

function sample() {
  const now = cpuTicks();
  const dTotal = now.total - prev.total;
  const cpu = dTotal > 0 ? (now.busy - prev.busy) / dTotal : 0;
  prev = now;
  const loop = loopDelay.percentile(99) / 1e6 / LOOP_SATURATED_MS;
  loopDelay.reset();
  latest = { cpu: clamp01(cpu), mem: clamp01(memoryUsed()), loop: clamp01(loop) };
}
const timer = setInterval(sample, SAMPLE_MS);
timer.unref(); // never the reason the process stays up

/** The pill's numbers: each resource, the load (the worst of them) and the verdict. */
export function serverLoad() {
  const load = Math.max(latest.cpu, latest.mem, latest.loop);
  const round = (x) => Math.round(x * 100) / 100;
  return {
    load: round(load),
    cpu: round(latest.cpu),
    mem: round(latest.mem),
    loop: round(latest.loop),
    full: load >= FULL_AT,
    fullAt: FULL_AT,
  };
}
