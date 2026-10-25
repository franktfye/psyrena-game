/**
 * Server load: the login screen's status pill (`GET /api/server/load`) and the
 * login gate (`loginGate`, app.mjs) that turns new sessions away when the
 * machine is nearly full.
 *
 * One number a player can read: the WORST of three resources, each as a
 * fraction of what the machine can give —
 *
 *   cpu   share of CPU time not spent idle over the last sample window, from
 *         /proc/stat's aggregate line. Steal counts as BUSY (on a shared
 *         droplet it is time the hypervisor gave someone else, i.e. capacity
 *         we do not have), iowait as idle. os.cpus() was used before; it
 *         reports neither, so a droplet under steal read as quiet. Not
 *         loadavg: a run queue is not a percentage.
 *   mem   1 − MemAvailable / MemTotal (/proc/meminfo; MemAvailable counts the
 *         page cache the kernel can hand back, so a warm cache is not "full")
 *   loop  this process's event-loop lag, p99 over the window, against 200 ms
 *         — the point where a fight's 100 ms sim tick visibly stutters. Node
 *         is single-threaded: a busy loop is full whatever the cores say. The
 *         histogram's own resolution is subtracted: an idle loop sampled at
 *         20 ms reads ~22 ms, which used to show as a permanent 11 %.
 *
 * FULL at 0.90 (Frank, 2026-10-24: "to be safe, 90% = server full"). The pill
 * shows the latest 5 s sample. The GATE reads a ~30 s moving average with
 * hysteresis — it closes at FULL_AT and reopens below REOPEN_AT — so one GC
 * pause or a burst of password hashing cannot bounce a wave of logins.
 *
 * Sampled on a timer, not per request, so the probe costs nothing (CLAUDE.md
 * rule 6: no per-request CPU work on the static path).
 *
 * PSYRENA_LOAD_FORCE=<0..1> pins every reading (tests, and a manual "close the
 * doors" on a live server without a deploy).
 */

import os from "node:os";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

/** At or above this the server reports itself full and the gate closes. */
export const FULL_AT = 0.9;
/** The gate reopens once the smoothed load falls below this. */
export const REOPEN_AT = 0.8;
/** Lag at which the event loop counts as saturated, ms. */
const LOOP_SATURATED_MS = 200;
const LOOP_RESOLUTION_MS = 20;
const SAMPLE_MS = Number(process.env.PSYRENA_LOAD_SAMPLE_MS) || 5_000;
/** EWMA weight per sample: ~30 s of memory at 5 s samples. */
const SMOOTH = 1 - Math.exp(-SAMPLE_MS / 30_000);

const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
loopDelay.enable();

/** Busy and total CPU ticks, all cores, from /proc/stat (os.cpus() off Linux). */
function cpuTicks() {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n", 1)[0];
    // cpu  user nice system idle iowait irq softirq steal guest guest_nice
    const [user, nice, system, idle, iowait, irq, softirq, steal] = line.trim().split(/\s+/).slice(1).map(Number);
    if ([user, nice, system, idle].every(Number.isFinite)) {
      const busy = user + nice + system + (irq || 0) + (softirq || 0) + (steal || 0);
      return { busy, total: busy + idle + (iowait || 0) };
    }
  } catch {
    /* not Linux: fall through */
  }
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
const forced = () => {
  const v = process.env.PSYRENA_LOAD_FORCE;
  return v === undefined || v === "" ? null : clamp01(Number(v));
};

let prev = cpuTicks();
let latest = { cpu: 0, mem: clamp01(memoryUsed()), loop: 0 };
let smoothed = Math.max(latest.cpu, latest.mem, latest.loop);
let gateClosed = false;

function sample() {
  const now = cpuTicks();
  const dTotal = now.total - prev.total;
  const cpu = dTotal > 0 ? (now.busy - prev.busy) / dTotal : 0;
  prev = now;
  const lagMs = Math.max(0, loopDelay.percentile(99) / 1e6 - LOOP_RESOLUTION_MS);
  loopDelay.reset();
  latest = { cpu: clamp01(cpu), mem: clamp01(memoryUsed()), loop: clamp01(lagMs / LOOP_SATURATED_MS) };
  smoothed += (Math.max(latest.cpu, latest.mem, latest.loop) - smoothed) * SMOOTH;
  updateGate();
}

function updateGate() {
  const level = forced() ?? smoothed;
  if (!gateClosed && level >= FULL_AT) gateClosed = true;
  else if (gateClosed && level < REOPEN_AT) gateClosed = false;
}

const timer = setInterval(sample, SAMPLE_MS);
timer.unref(); // never the reason the process stays up

/** The pill's numbers: each resource, the load (the worst of them) and the verdict. */
export function serverLoad() {
  const f = forced();
  const round = (x) => Math.round(x * 100) / 100;
  const load = f ?? Math.max(latest.cpu, latest.mem, latest.loop);
  updateGate();
  return {
    load: round(load),
    cpu: round(f ?? latest.cpu),
    mem: round(f ?? latest.mem),
    loop: round(f ?? latest.loop),
    // The pill says "full" exactly when the doors are shut, so the two never disagree.
    full: gateClosed,
    fullAt: FULL_AT,
  };
}

/**
 * The login gate: true while new sessions should be turned away (the smoothed
 * load reached FULL_AT and has not yet fallen below REOPEN_AT).
 */
export function loginGateClosed() {
  updateGate();
  return gateClosed;
}
