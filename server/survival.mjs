/**
 * Server-run Dream Siege for parties (docs/survival-design.md §13). The same
 * pure `shared/survival/sim.ts` a solo client runs, ticking here for a whole
 * room: one sim, every member an actor in it.
 *
 * Trust, same shape as server/fight.mjs:
 *   - the server owns the sim: waves, monsters, hazards, the Recall Test,
 *     drops, deaths, the loot roll;
 *   - clients send POSITIONS (speed-clamped) and PRICED HITS. Hero kits are
 *     priced on the client by the real BossFight (src/survival/run.ts), so the
 *     server bounds them instead: a rolling per-player damage-per-second
 *     ceiling, and a heal ceiling;
 *   - the server pays every member from its own stat block (settleSurvival).
 *
 * Transport: POST intents up, SSE `survivalState` frames down (social.mjs
 * pushTo), 10 Hz, each carrying the events since the last frame.
 */
import { SurvivalSim, HERO_HP } from "../shared/survival/sim.ts";
import { OLD_KOWLOON } from "../shared/survival/map/oldKowloon.ts";
import { DIFFICULTIES } from "../shared/survival/content.ts";
import { heroById } from "../shared/heroes/index.ts";
import { pushTo } from "./social.mjs";
import { settleSurvival } from "./economy.mjs";
import { loadoutFor } from "./fight.mjs";

const TICK_MS = 50;
const FRAME_EVERY = 2;
/** Run speed 6.2 m/s plus slack; a spent dash adds its 5 m. */
const MAX_SPEED = 7;
const DASH_M = 5.5;
/** Rolling one-second damage ceiling per player (ranked DPS ceiling is 5,000). */
const DPS_CAP = 6000;
const HPS_CAP = 400;
/** Silent this long and you are downed: the party is not held hostage by a closed tab. */
const DROP_MS = 20_000;
/**
 * Ready barrier: the sim holds at t = 0 until every member's client has loaded
 * and sent its first input (a phone may need tens of seconds for the monster
 * models), or this long has passed — whoever is still loading then joins late.
 */
const READY_TIMEOUT_MS = 90_000;
const LINGER_MS = 60_000;

let db;
let helpers;
const sessions = new Map();
let nextId = 1;

export function initSurvival(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
}

export function liveSurvivalCount() {
  return [...sessions.values()].filter((s) => !s.ended).length;
}

function sessionOf(userId) {
  for (const s of sessions.values()) if (!s.ended && s.members.includes(Number(userId))) return s;
  return null;
}

function startSession(roomId, difficulty) {
  const members = db.prepare("SELECT user_id FROM room_members WHERE room_id = ?").all(roomId).map((m) => Number(m.user_id));
  const players = members.map((uid) => {
    const row = db.prepare("SELECT selected_hero FROM game_state WHERE user_id = ?").get(uid);
    const hero = heroById(row?.selected_hero);
    const u = db.prepare("SELECT username FROM users WHERE id = ?").get(uid);
    return { id: String(uid), hero: hero.id, role: hero.role, name: u?.username ?? `player ${uid}` };
  });
  const sim = new SurvivalSim({ difficulty, map: OLD_KOWLOON, players, seed: (Date.now() & 0xffff) ^ roomId });
  const id = nextId++;
  const now = Date.now();
  const s = {
    id, roomId, difficulty, members, sim, ended: false, tickN: 0, events: [],
    lastInput: new Map(members.map((m) => [m, now])),
    /** Members whose client has sent at least one input (loaded the run). */
    ready: new Set(), startedAt: now, running: false,
    dmgWindow: new Map(members.map((m) => [m, []])),
    healWindow: new Map(members.map((m) => [m, []])),
    lastPos: new Map(), names: new Map(),
  };
  for (const p of players) s.names.set(p.id, p.name);
  s.timer = setInterval(() => step(s), TICK_MS);
  sessions.set(id, s);
  return s;
}

function step(s) {
  if (s.ended) return;
  const now = Date.now();
  if (!s.running) {
    // Hold until everyone has loaded (or the barrier times out); keep pushing
    // the t = 0 frame so a loaded client is not staring at nothing.
    if (s.ready.size < s.members.length && now - s.startedAt < READY_TIMEOUT_MS) {
      if (++s.tickN % 10 === 0) pushFrame(s);
      return;
    }
    s.running = true;
    for (const uid of s.members) {
      s.lastInput.set(uid, now);
      // Still loading at the timeout: start downed (not a free target), joins on first input.
      const p = s.sim.player(String(uid));
      if (p && !s.ready.has(uid)) { p.alive = false; p.hp = 0; }
    }
  }
  for (const uid of s.members) {
    const p = s.sim.player(String(uid));
    // Never drop someone for silence before they have ever spoken (still loading).
    if (p?.alive && s.ready.has(uid) && now - s.lastInput.get(uid) > DROP_MS) {
      p.alive = false;
      p.hp = 0;
      s.sim.events.push({ type: "playerDown", player: p.id });
    }
  }
  // Everyone gone or down (a dropout downs you without a hit): end it.
  s.sim.endIfWiped();
  s.sim.tick(TICK_MS / 1000);
  s.events.push(...s.sim.drainEvents());
  if (++s.tickN % FRAME_EVERY === 0 || s.sim.phase === "victory" || s.sim.phase === "defeat") pushFrame(s);
  if ((s.sim.phase === "victory" || s.sim.phase === "defeat") && !s.ended) finish(s);
}

/** The state message: everything the client view/HUD reads, plus this frame's events. */
function frameOf(s) {
  const sim = s.sim;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    session: s.id, t: r2(sim.t), phase: sim.phase, wave: sim.wave, waves: sim.waves, gatesClosed: sim.gatesClosed,
    players: sim.players.map((p) => ({
      id: p.id, name: s.names.get(p.id), hero: p.hero, x: r2(p.x), z: r2(p.z), hp: Math.round(p.hp), hpMax: p.hpMax,
      alive: p.alive, moveMult: p.moveMult, dashCharges: p.dashCharges, boons: p.boons, offer: p.offer,
      yaw: s.lastPos.get(p.id)?.yaw ?? 0,
    })),
    hostiles: sim.hostiles.map((h) => ({
      id: h.id, kind: h.kind, def: h.def, model: h.model, x: r2(h.x), z: r2(h.z), facing: r2(h.facing), radius: h.radius,
      hp: Math.round(h.hp), hpMax: h.hpMax, state: h.state, stateT: r2(h.stateT), born: r2(h.born),
      invulnerable: h.invulnerable, twinOf: h.twinOf, ageTag: h.ageTag, debuffUntil: h.debuffUntil,
      invisibleUntil: h.invisibleUntil, notches: h.notches, stacks: h.stacks,
    })),
    hazards: sim.hazards.map((z) => ({ ...z, x: r2(z.x), z: r2(z.z), t: r2(z.t) })),
    projectiles: sim.projectiles.map((p) => ({ id: p.id, x: r2(p.x), z: r2(p.z), r: p.r })),
    pickups: sim.pickups.map((p) => ({ id: p.id, kind: p.kind, x: r2(p.x), z: r2(p.z), life: r2(p.life) })),
    recall: sim.recall ? { answers: sim.recall.answers, circles: sim.recall.circles, t: r2(sim.recall.t), total: sim.recall.total, question: sim.recall.item.question } : null,
    events: s.events.splice(0),
  };
}

function pushFrame(s) {
  const f = frameOf(s);
  for (const uid of s.members) pushTo(uid, "survivalState", f);
}

function finish(s) {
  s.ended = true;
  clearInterval(s.timer);
  const stats = s.sim.statsNow;
  const victory = s.sim.phase === "victory";
  for (const uid of s.members) {
    // The server's own numbers: nothing here came from a client.
    const score = stats.players.find((p) => p.id === String(uid));
    const r = settleSurvival(uid, { difficulty: s.difficulty, victory, wavesCleared: stats.wavesCleared, durationS: stats.durationS, score, recallRight: stats.recallRight });
    pushTo(uid, "survivalEnd", {
      session: s.id, victory, stats, awarded: r.error ? 0 : r.awarded, jackpot: !!r.jackpot,
      lootBox: r.lootBox ?? null, bestWave: r.bestWave ?? null, newBest: !!r.newBest,
    });
  }
  setTimeout(() => sessions.delete(s.id), LINGER_MS);
}

/** Sum of a rolling one-second window, after adding `amount` at `now`. */
function windowSum(list, now, amount) {
  while (list.length && now - list[0][0] > 1000) list.shift();
  list.push([now, amount]);
  return list.reduce((a, [, v]) => a + v, 0);
}

function applyInput(s, uid, body) {
  const now = Date.now();
  const id = String(uid);
  const sim = s.sim;
  const p = sim.player(id);
  if (!p) return;
  const last = s.lastPos.get(id);
  const dtS = last ? Math.min(1, (now - last.at) / 1000) : 1;
  s.lastInput.set(uid, now);
  if (!s.ready.has(uid)) {
    s.ready.add(uid);
    // The first input declares the equipped pet; gear and ownership are the server's (fight.mjs loadoutFor).
    const hpMax = Math.round(HERO_HP * loadoutFor(uid, p.hero, typeof body.pet === "string" ? body.pet : null).hpMult);
    if (hpMax !== p.hpMax) { p.hp = Math.round((p.hp / p.hpMax) * hpMax); p.hpMax = hpMax; }
    // A late loader (past the barrier timeout) comes in on its first word.
    if (s.running && !p.alive && p.hp === 0 && s.sim.phase !== "victory" && s.sim.phase !== "defeat") { p.alive = true; p.hp = p.hpMax; }
  }
  if (!s.running) return; // positions before the start would teleport-drift; just count as loaded
  let dashed = false;
  if (body.dash === true) dashed = sim.dash(id);
  if (Number.isFinite(body.x) && Number.isFinite(body.z) && p.alive) {
    // Speed clamp: never further than running (plus a dash) since the last input.
    const maxStep = MAX_SPEED * dtS * p.moveMult + (dashed ? DASH_M : 0) + 0.5;
    let dx = body.x - p.x;
    let dz = body.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > maxStep) { dx *= maxStep / d; dz *= maxStep / d; }
    sim.setPlayerPos(id, p.x + dx, p.z + dz);
  }
  s.lastPos.set(id, { at: now, yaw: Number(body.yaw) || 0 });
  const dmgList = s.dmgWindow.get(uid);
  for (const h of Array.isArray(body.hits) ? body.hits.slice(0, 20) : []) {
    const amount = Math.max(0, Number(h.amount) || 0);
    if (windowSum(dmgList, now, amount) > DPS_CAP) continue;
    const cast = { player: id, slotId: String(h.slotId ?? ""), kind: String(h.kind ?? "basic"), answersTag: h.answersTag, consequence: h.consequence };
    if (h.area) sim.hitArea(Number(h.x) || 0, Number(h.z) || 0, Math.min(8, Number(h.r) || 6), amount, !!h.crit, cast);
    else sim.hitHostile(Number(h.target), amount, !!h.crit, cast);
  }
  const heal = Math.max(0, Number(body.heal) || 0);
  if (heal > 0 && windowSum(s.healWindow.get(uid), now, heal) <= HPS_CAP) sim.healPlayer(id, heal);
  if (body.mitigation === true) sim.setMitigation(id, 0.35, 4);
  if (typeof body.boon === "string") sim.pickBoon(id, body.boon);
}

export async function handleSurvival(req, res, url, userId) {
  const { send, readBody } = helpers;
  // Every survival route acts as a player; the dispatcher leaves the login check
  // to each handler (economy.mjs does the same).
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;
  if (route === "POST /api/survival/launch") {
    const body = await readBody(req);
    if (!DIFFICULTIES[body?.difficulty]) return send(res, 400, { error: "difficulty must be lucid | deep | terror." });
    const room = db.prepare("SELECT r.id, r.host_id FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ?").get(userId);
    if (!room) return send(res, 400, { error: "Join a party first — solo runs start from the Dream Siege button." });
    if (Number(room.host_id) !== Number(userId)) return send(res, 403, { error: "Only the party leader can start a Dream Siege." });
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?").get(room.id).n);
    if (count < 2) return send(res, 400, { error: "A party run needs at least two players." });
    const existing = sessionOf(userId);
    if (existing) return send(res, 409, { error: "Your party is already in a Dream Siege." });
    const s = startSession(Number(room.id), body.difficulty);
    for (const uid of s.members) pushTo(uid, "survivalLaunch", { session: s.id, difficulty: s.difficulty, members: s.members.map(String) });
    return send(res, 200, { session: s.id });
  }
  if (route === "POST /api/survival/input") {
    const body = await readBody(req);
    const s = sessions.get(Number(body?.session));
    if (!s || s.ended || !s.members.includes(Number(userId))) return send(res, 404, { error: "no such run" });
    applyInput(s, Number(userId), body);
    return send(res, 200, { ok: true });
  }
  if (route === "POST /api/survival/leave") {
    const s = sessionOf(userId);
    if (s) {
      const p = s.sim.player(String(userId));
      if (p) { p.alive = false; p.hp = 0; s.sim.events.push({ type: "playerDown", player: p.id }); }
      s.lastInput.set(Number(userId), 0);
    }
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "unknown survival route" });
}
