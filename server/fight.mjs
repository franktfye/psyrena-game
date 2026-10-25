/**
 * Server-authoritative boss fights.
 *
 * Doc 06 specified this from the start — "the client sends inputs only… the
 * arena room owns all truth" — and the game shipped the offline combat core
 * instead. This is the retrofit, and it is deliberately NOT a second
 * implementation of the fight: it runs the very same `shared/fight/bossFight.ts`
 * the client has always run. The sim never had a DOM or a clock in it; it takes
 * `tick(dt)` and talks to the outside world through `FightHooks`. Those hooks
 * are the network event stream, and `snapshot()` is the state message.
 *
 * What the server owns, that the client used to: the Focus pool and every
 * cast's cost, the global cooldown and per-slot cooldowns, the beat clock, crit
 * rolls, who is dead, and the end-of-fight stat block. A client that lies about
 * any of it is talking to itself.
 *
 * A PARTY SHARES ONE SESSION. Three players seated in the same room get one
 * `BossFight` with three input-driven actors in it: one HP pool, one Mark
 * stack, one Amp pool, one threat table. A healer's heal lands on a real
 * teammate; a tank's stance pulls the boss off a real player; the wipe check
 * is the first one in this game that another person can prevent. Solo runs get
 * a session of one, on the same code path.
 *
 * Transport is the stack this codebase actually has — POST intents up, SSE
 * frames down (social.mjs `pushTo`, already open for every logged-in tab). Doc
 * 06 names Colyseus/WebSocket; the authority guarantee is what matters and it
 * is transport-independent, so this rides the proxy-tested path and leaves the
 * swap for later.
 *
 * And because the server holds the numbers, it also holds the CONSEQUENCES: it
 * pays every member out of its own stat block at fight end (`settleSession`),
 * and it remembers who walked out of a fight that was still running
 * (`markFightAbandon`).
 */

import { BossFight } from "../shared/fight/bossFight.ts";
import { heroById } from "../shared/heroes/index.ts";
import { NIGHTMARE_STANDARD } from "../shared/bosses/nightmare.ts";
import { DIFFICULTY } from "../shared/fight/difficulty.ts";
import { FOCUS, GCD_MS, focusCostFor } from "../shared/fight/costs.ts";
import { NEUTRAL_LOADOUT, petSpec, resolveLoadout } from "../shared/progression.ts";
import { pushTo, droppedOut } from "./social.mjs";
import { settleFight, noteServerSettled } from "./economy.mjs";
import { potionMult } from "./coffee.mjs";

/** Fixed sim step. Doc 06's arena tick. */
const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
/** State frames to the client. Every other tick — 100 ms is under one frame
 *  of interpolation for a HUD, and the projectile flight hides the rest. */
const STATE_EVERY = 2;
/**
 * P2's answer clock, read off the sheet the same way every headless harness
 * reads it. The sim has no stage clock of its own — it is TOLD which form the
 * boss wears (`notifyP2Stage`), and on the client that used to come from the
 * boss's visual model, which put the answer key in the presentation layer. The
 * server owns phases, so it owns this too; the client renders `snap.p2Stage`.
 */
const P2 = NIGHTMARE_STANDARD.phases[1];
const P2_TOTAL_S = P2.durationS;
const P2_STAGE_S = P2.skillCheck?.stageDurS ?? 6;

/** Fisher-Yates on a copy — mirrors `shuffled` in src/scenes/nightmareBoss.ts. */
function shuffled(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A session nobody has spoken to for this long is abandoned. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
/** Hard ceiling on a single fight, past the sim's own enrage runway. */
const MAX_FIGHT_MS = 20 * 60_000;
/** How long a finished session sticks around so late readers see the result. */
const LINGER_MS = 60_000;

let db = null;
let helpers = null;

/** sessionKey -> session */
const sessions = new Map();
/** userId -> sessionKey */
const byUser = new Map();

export function initFight(database, apiHelpers) {
  db = database;
  helpers = apiHelpers;
  startLoop();
}

// ---------------------------------------------------------------------------
// Building a session
// ---------------------------------------------------------------------------

/**
 * Everything the sim needs about a player that the player must not be asked
 * for. Gear comes out of the DB; the hero comes out of game_state — the same
 * field economy.mjs already calls "server-derived, never a client-supplied
 * field".
 */
export function loadoutFor(userId, heroId, petId) {
  try {
    const gear = {};
    for (const r of db
      .prepare("SELECT slot, tier FROM gear_pieces WHERE user_id = ?")
      .all(String(userId))) {
      gear[r.slot] = Number(r.tier);
    }
    // The equipped pet still lives in client storage (wardrobe), so it is the
    // one declared input here. It only scales pet damage/healing; persisting
    // the equipment is a separate change, and until then this is an honest
    // seam rather than a pretend one.
    const petRow = petId
      ? db
          .prepare("SELECT level FROM pets WHERE user_id = ? AND pet_id = ?")
          .get(String(userId), String(petId))
      : null;
    // A declared pool pet with no DB row is a claim, not a fact — only
    // hero-exclusives are implicitly owned (level 0, economy.mjs petsFor).
    const spec = petSpec(petId ?? null);
    const owned = spec && (spec.exclusiveTo || petRow) ? petId : null;
    return resolveLoadout(gear, owned ?? null, petRow ? Number(petRow.level) : 0, heroId);
  } catch {
    return { ...NEUTRAL_LOADOUT };
  }
}

/**
 * A member's own `begin` is when their equipped pet is declared (it lives in
 * client storage — see loadoutFor). The party's actors are all built when the
 * FIRST member begins, so everyone else starts petless and their terms are
 * re-resolved here, ticks later, the moment they show up. Idempotent: a
 * reconnect re-begin just resolves to the same numbers.
 */
function applyMemberPet(session, member, body) {
  session.fight.applyLoadout(
    member.actorId,
    loadoutFor(member.userId, member.hero.id, typeof body?.pet === "string" ? body.pet : null)
  );
}

function identityOf(userId) {
  const row = db
    .prepare(
      `SELECT u.username, g.selected_hero AS hero
       FROM users u JOIN game_state g ON g.user_id = u.id WHERE u.id = ?`
    )
    .get(userId);
  return {
    username: row ? String(row.username) : `player${userId}`,
    hero: heroById(row ? String(row.hero) : "freud"),
  };
}

/** The room this player is seated in, and everyone in it, oldest seat first. */
function partyOf(userId) {
  const seat = db.prepare("SELECT room_id FROM room_members WHERE user_id = ?").get(userId);
  if (!seat) return { roomId: null, userIds: [Number(userId)] };
  const roomId = Number(seat.room_id);
  const userIds = db
    .prepare("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY joined_at, user_id")
    .all(roomId)
    .map((r) => Number(r.user_id));
  return { roomId, userIds: userIds.length ? userIds : [Number(userId)] };
}

/** One member's private half of the fight — the part `snapshot()` never had. */
function makeMember(userId, actorId, hero, username) {
  return {
    userId,
    actorId,
    hero,
    name: username,
    /** The sim has no Focus pool; this is the cost model the client used to
     *  enforce on itself. */
    focus: FOCUS.max,
    /** Focus regen multiplier: a Cold Brew from the Coffee Shop, read at fight start. */
    focusRegen: potionMult(userId, "focus"),
    gcdUntil: 0,
    /** slotId -> ready-at, in sim seconds. */
    cooldowns: new Map(),
    beatIndex: 0,
    beatT: 0,
    /** Set once this player's client has actually opened the fight. A seated
     *  member who never shows still holds an actor — same as going AFK. */
    joined: false,
    lastSeen: Date.now(),
    /** This member's payout once the fight ends; null until `settleSession`. */
    settlement: null,
  };
}

/**
 * Open (or attach to) a fight.
 *
 * The whole party is built at creation, not as members trickle in: the boss's
 * HP and outgoing scale to team size, and a boss that resized itself under the
 * players mid-pull would be indefensible. A seated member who never begins is
 * an AFK player, which the sim already models.
 *
 * That is exactly why a seat held by a browser that is GONE cannot be allowed
 * through. app.mjs evicts those before the countdown; this is the same rule
 * applied one moment later, for a disconnect that lands between the fightStart
 * push and this call. Anyone still connected is seated, however slowly they
 * are loading — the ready barrier is what waits for them.
 */
function beginFight(userId, body) {
  const existingKey = byUser.get(userId);
  const existing = existingKey ? sessions.get(existingKey) : null;
  if (existing && !existing.over) {
    const member = existing.members.get(userId);
    if (member) {
      member.joined = true;
      member.lastSeen = Date.now();
      applyMemberPet(existing, member, body);
      return existing;
    }
  }

  const difficulty = DIFFICULTY[body?.difficulty] ? body.difficulty : "standard";
  const { roomId, userIds: seated } = partyOf(userId);
  // The caller is here by definition; a teammate whose connection died is not.
  const userIds = seated.filter((id) => id === Number(userId) || !droppedOut(id));
  const key = roomId !== null && userIds.length > 1 ? `room:${roomId}` : `solo:${userId}`;

  // Someone else in the party opened it first — take a seat in theirs.
  const already = sessions.get(key);
  if (already && !already.over) {
    const member = already.members.get(userId);
    if (member) {
      member.joined = true;
      member.lastSeen = Date.now();
      byUser.set(userId, key);
      applyMemberPet(already, member, body);
      return already;
    }
  }
  if (already) disposeSession(key);

  const events = [];
  const members = new Map();
  const actorSpecs = [];
  for (const id of userIds) {
    const { username, hero } = identityOf(id);
    const actorId = `u${id}`;
    members.set(id, makeMember(id, actorId, hero, username));
    actorSpecs.push({
      id: actorId,
      name: username,
      hero,
      input: true,
      // Only the opener's pet is known right now; each teammate's is applied
      // when THEIR begin arrives (applyMemberPet above).
      loadout: loadoutFor(id, hero.id, id === userId && typeof body?.pet === "string" ? body.pet : null),
    });
  }

  const fight = BossFight.forParty(NIGHTMARE_STANDARD, actorSpecs, hooksInto(events, members), {
    hpMult: DIFFICULTY[difficulty].hpMult,
    dmgMult: DIFFICULTY[difficulty].dmgMult,
  });

  const session = {
    key,
    roomId,
    difficulty,
    fight,
    members,
    events,
    simT: 0,
    tickCount: 0,
    startedAt: Date.now(),
    over: false,
    endedAt: 0,
    result: null,
    /** Payout runs exactly once per session — see `settleSession`. */
    settled: false,
    /**
     * Which doll each P2 slot shows, and how many shapeshifts have run. The
     * first P2 walks the ages 1→5 in order; every later one shuffles. Must
     * match src/scenes/nightmareBoss.ts, which applies the same rule when the
     * boss model owns the stage clock (offline fights) — a server-run fight
     * pushes `snap.p2Stage` into the model instead, so without this the
     * randomization would silently not happen online.
     */
    p2Order: [0, 1, 2, 3, 4],
    p2Cycles: 0,
    inP2: false,
  };
  sessions.set(key, session);
  for (const id of members.keys()) byUser.set(id, key);
  const me = members.get(userId);
  if (me) {
    me.joined = true;
    me.lastSeen = Date.now();
  }
  return session;
}

function disposeSession(key) {
  const session = sessions.get(key);
  if (!session) return;
  for (const id of session.members.keys()) {
    if (byUser.get(id) === key) byUser.delete(id);
  }
  sessions.delete(key);
}

/**
 * The sim's hooks, captured as a wire event list.
 *
 * Every one of these is something the client already knows how to render — it
 * implements this exact interface today. Replaying them on the other side is
 * what lets the whole VFX/SFX/HUD layer keep working with the sim on another
 * machine. Actor-addressed events carry `who` so each client can tell "me"
 * from "my teammate".
 */
function hooksInto(events, members) {
  const push = (e) => {
    // A stalled or hostile client must not let the buffer grow without bound.
    if (events.length < 600) events.push(e);
  };
  return {
    announce: (text) => push({ e: "announce", text }),
    setBossPhase: (phase) => push({ e: "phase", phase }),
    bossStrike: (targets) => push({ e: "strike", targets }),
    bossFan: (fan) => push({ e: "fan", fan }),
    bossOrbs: (volley) => push({ e: "orbs", volley }),
    damagePlayer: (n, who) => push({ e: "dmgPlayer", n, who }),
    healPlayer: (n, who) => push({ e: "healPlayer", n, who }),
    combatantDamaged: (name, amount, isPlayer, who) =>
      push({ e: "hurt", name, amount, isPlayer, who }),
    combatantHealed: (name, effective, attempted, isPlayer, label, who) =>
      push({ e: "healed", name, effective, attempted, isPlayer, label, who }),
    combatantDied: (name, isPlayer, who) => push({ e: "died", name, isPlayer, who }),
    allyCast: (name, action) => push({ e: "allyCast", name, action }),
    dotTick: (label, amount) => push({ e: "dot", label, amount }),
    playerBuff: (name, durationMs, kind, icon, id, desc, who) =>
      push({ e: "buff", name, durationMs, kind, icon, id, desc, who }),
    // A refund is server state, not just a float: the member's pool IS the
    // Focus the intent check reads. Pushing only the event (as before) showed
    // the client a refund the next state frame took back — Pavlov's pairing
    // Focus never actually arrived in a server fight.
    gainFocus: (n, who) => {
      for (const m of members.values()) {
        if (m.actorId === who) m.focus = Math.min(FOCUS.max, m.focus + n);
      }
      push({ e: "focus", n, who });
    },
    defenseProc: (name, who) => push({ e: "proc", name, who }),
    lockPaletteSlot: (paletteIndex, ms, who) => push({ e: "lock", paletteIndex, ms, who }),
    conditioningChanged: (state, who) => push({ e: "conditioning", state, who }),
    operantChanged: (state, who) => push({ e: "operant", state, who }),
    psychosocialChanged: (state, who) => push({ e: "psychosocial", state, who }),
    modelingChanged: (state, who) => push({ e: "modeling", state, who }),
    playerHitReaction: (who) => push({ e: "flinch", who }),
    sfxEvent: (name, who) => push({ e: "sfx", name, who }),
    fightEnd: (stats) => push({ e: "end", stats }),
  };
}

// ---------------------------------------------------------------------------
// Intents — the only thing a client is allowed to say
// ---------------------------------------------------------------------------

const KINDS = new Set(["basic", "palette", "defense", "chain", "ultimate", "stance", "model", "fan"]);

/**
 * Latency grace on the cast timers, in seconds.
 *
 * The client's action bar runs the same GCD and the same per-slot cooldowns,
 * from the moment of the PRESS. The server sees the intent a network hop (and,
 * on a struggling client, a frame or two of main-thread stall) later — so a
 * player who honestly waited out their own cooldown gets refused for a delay
 * they did not cause, and the press vanishes with the button lit.
 *
 * The grace absorbs that hop. It cannot be farmed into a faster cast rate,
 * because the next window is anchored to the SCHEDULE and not to the early
 * arrival: casting 0.2 s early buys the next cast at the same moment it would
 * have come anyway.
 */
const TIMER_GRACE_S = 0.3;

/**
 * Apply one cast intent, or refuse it with a reason the HUD can show.
 *
 * Cast and land are collapsed here. In the client sim they are two calls with
 * the projectile's flight between them; across a network that split would mean
 * holding resolved damage server-side waiting for a client to claim it landed,
 * which is precisely the authority hole being closed. The projectile is now
 * pure presentation: the number it shows on impact is the number the server
 * already applied.
 */
function applyIntent(session, member, body) {
  const kind = KINDS.has(body?.kind) ? body.kind : null;
  if (!kind) return { ok: false, why: "bad intent" };
  const fight = session.fight;
  if (session.over || fight.snapshot().phase === "dead") return { ok: false, why: "fight is over" };

  const view = fight.actorView(member.actorId);
  if (view && !view.alive) return { ok: false, why: "you are down" };

  // Stance is free and off-GCD by definition — a Focus-starved tank must
  // always be able to drop aggro, which is exactly when they need it.
  if (kind === "stance") {
    fight.setThreatStanceAs(member.actorId, !!body.on);
    return { ok: true, stance: fight.threatStanceActiveFor(member.actorId) };
  }
  // "I was standing in fan N when it landed." The sim checks the fan is live
  // and counts each hero once; where the hero stood is the client's word (the
  // server has no positions — the same trust as the arena's movement).
  if (kind === "fan") {
    return { ok: fight.fanHitAs(member.actorId, Number(body.fan)) };
  }
  // Bandura's model pin: free and off-GCD like the stance — attention is not a cast.
  if (kind === "model") {
    fight.cycleModelAs(member.actorId);
    return { ok: true };
  }

  const hero = member.hero;
  const paletteIndex = Number.isInteger(body?.paletteIndex) ? body.paletteIndex : -1;
  const slotId =
    kind === "palette" ? hero.palette[paletteIndex]?.id : kind === "basic" ? "basic" : kind;
  if (kind === "palette" && !slotId) return { ok: false, why: "no such skill" };

  // The basic attack is off the GCD and paced by its own (much shorter)
  // cooldown — the client's action bar has always exempted it, and the sheet's
  // cast cadence assumes that. Everything else pays the GCD and arms it.
  const onGcd = kind !== "basic";
  if (onGcd && session.simT < member.gcdUntil - TIMER_GRACE_S) return { ok: false, why: "gcd" };
  const readyAt = member.cooldowns.get(slotId) ?? 0;
  if (session.simT < readyAt - TIMER_GRACE_S) return { ok: false, why: "cooling down" };

  const cost = focusCostFor(hero, kind, paletteIndex);
  if (member.focus < cost) return { ok: false, why: "not enough Focus" };
  // Paid BEFORE the cast, so a refund the cast triggers (gainFocus — Erikson's
  // pair, Pavlov's pairing) lands on the spent pool and is never eaten by the
  // cap. A refusal below hands the cost back.
  member.focus -= cost;
  const refuse = (why) => {
    member.focus = Math.min(FOCUS.max, member.focus + cost);
    return { ok: false, why };
  };

  // The beat clock is server-side now: which multiplier a cast lands on is not
  // something a client gets to choose.
  const beat = beatMult(member);
  const who = member.actorId;

  let dealt = 0;
  let crit = false;
  if (kind === "basic" || kind === "palette" || kind === "chain") {
    const hit =
      kind === "basic"
        ? fight.castBasicAs(who, beat)
        : kind === "palette"
          ? fight.castPaletteAs(who, paletteIndex, beat)
          : fight.castChainAs(who, beat);
    if (!hit) return refuse("refused");
    crit = !!hit.crit;
    dealt = fight.landHitAs(who, hit);
  } else if (kind === "defense") {
    fight.castDefenseAs(who);
  } else if (kind === "ultimate") {
    const total = fight.castUltimateAs(who);
    // A healer's ultimate resolves for 0 damage (Shaping, Equilibration):
    // that is a cast, and it pays its cooldown like one.
    if (total <= 0 && !fight.ultimateResolvedAs(who)) return refuse("no Marks");
    if (total > 0) fight.landUltimateAs(who, total);
    dealt = total;
  }

  member.focus = Math.max(0, member.focus);
  // Anchored to whichever is later, the schedule or now — see TIMER_GRACE_S.
  if (onGcd) member.gcdUntil = Math.max(session.simT, member.gcdUntil) + GCD_MS / 1000;
  const cd = cooldownSecondsFor(hero, kind, paletteIndex);
  if (cd > 0) member.cooldowns.set(slotId, Math.max(session.simT, readyAt) + cd);

  return { ok: true, dealt, crit, focus: Math.round(member.focus) };
}

/** Which multiplier this hero's 3-beat cycle currently has up. */
function beatMult(member) {
  const beats = member.hero.beats;
  if (!beats || beats.length === 0) return 1;
  return beats[member.beatIndex % beats.length]?.multiplier ?? 1;
}

/**
 * Per-slot cooldowns, in seconds. The kit authors them in ms (shared/types.ts
 * `Ability.cooldownMs`) — reading a `cooldownS` that no hero has ever had made
 * every cooldown zero, which handed a scripted client its ultimate on every
 * GCD. Palette entries carry no authored cooldown; the bar's 3 s is a display
 * scaffold, and the GCD is the real pacing there.
 */
function cooldownSecondsFor(hero, kind, paletteIndex) {
  if (kind === "basic") return Number(hero.basic?.cooldownMs ?? 0) / 1000;
  if (kind === "defense") return Number(hero.defense?.cooldownMs ?? 0) / 1000;
  if (kind === "chain") return Number(hero.chain?.cooldownMs ?? 0) / 1000;
  if (kind === "ultimate") return Number(hero.ultimate?.cooldownMs ?? 0) / 1000;
  if (kind === "palette") return Number(hero.palette?.[paletteIndex]?.cooldownMs ?? 0) / 1000;
  return 0;
}

// ---------------------------------------------------------------------------
// Payout — phase 4 of docs-server-auth-plan.md
// ---------------------------------------------------------------------------

/**
 * Pay every member of a finished fight, from the server's own numbers.
 *
 * This is the whole point of the retrofit landing: win, duration, damage,
 * healing and damage taken are read off the sim that produced them instead of
 * being asked of the client that benefits from them.
 *
 * The split is PER ACTOR (`actorStats`), not the team block — three players in
 * one session did three different amounts of work, and paying each of them the
 * party's total would pay the one who stood still exactly what it paid the
 * tank. Win/loss and duration stay shared, because the attempt is shared.
 *
 * Everyone the session was built with is paid, including a member who never
 * opened their client: they held an actor, the boss was sized for them, and
 * the party fought the harder fight for it. Every server session is ranked —
 * practice has no server fight at all (there is nothing to make authoritative
 * about a pit of bots in one tab), so `practice` never appears here.
 */
function settleSession(session, stats) {
  if (session.settled) return;
  session.settled = true;
  const durationMs = Math.max(1, Number(stats.durationMs) || 0);
  const durationS = durationMs / 1000;
  for (const member of session.members.values()) {
    const mine = session.fight.actorStats(member.actorId);
    if (!mine) continue;
    try {
      const result = settleFight(member.userId, {
        win: !!stats.win,
        difficulty: session.difficulty,
        durationMs,
        dps: mine.damageDealt / durationS,
        healing: mine.healing,
        damageTaken: mine.damageTaken,
      });
      noteServerSettled(member.userId);
      member.settlement = result;
      // Pushed BEFORE the state frame that carries the sim's `end` event, so
      // the client has its receipt in hand by the time its fight-end flow
      // runs and never has to wait on a second round-trip to show the loot.
      pushTo(member.userId, "fightResult", { key: session.key, ...result });
    } catch (err) {
      // One member's payout must not cost the rest of the party theirs.
      console.error("[fight] settle failed for", member.userId, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Desertion — the cost of walking out of a live fight
// ---------------------------------------------------------------------------

/**
 * How long a deserter waits. The env override is for tests, the same way
 * PSYRENA_FIGHT_READY_MS / PSYRENA_MATCH_MS are.
 */
const DESERTER_LOCK_MS = Number(process.env.PSYRENA_DESERTER_MS) || 120_000;

/** "103000" → "1:43" — a wait a player can read at a glance. */
function formatWait(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A live session this user still has a seat in, or null.
 *
 * Scans rather than reading `byUser`, because leaving deletes that index and
 * the questions here ("were they in a running fight?", "are they coming back
 * to it?") both need to see through that.
 */
function liveSessionOf(userId) {
  const id = Number(userId);
  for (const session of sessions.values()) {
    if (!session.over && session.members.has(id)) return session;
  }
  return null;
}

/**
 * The live boss fight this user can come back to after a reload, or null:
 * a seat in a session that is still being fought (not over, boss not dead).
 * Read-only — `begin` is what takes the seat again.
 */
export function rejoinableFight(userId) {
  const session = liveSessionOf(userId);
  if (!session) return null;
  const phase = session.fight.snapshot().phase;
  if (phase === "dead") return null;
  return { key: session.key, roomId: session.roomId, difficulty: session.difficulty, phase };
}

/**
 * Start the lock.
 *
 * `pending` is the sentence; `until` is only the current attempt at serving
 * it. The two are separate because the penalty has to be served WHILE PLAYING
 * — a lock that merely expires at a wall-clock instant is served best by
 * closing the tab, which is the behaviour being discouraged. So logging in
 * (app.mjs) restarts `until` for as long as `pending` stands, and only the
 * clock running out with the player present clears it.
 */
function lockDeserter(userId) {
  db.prepare("UPDATE game_state SET deserter_pending = 1, deserter_until = ? WHERE user_id = ?")
    .run(Date.now() + DESERTER_LOCK_MS, Number(userId));
}

function clearDeserter(userId) {
  db.prepare("UPDATE game_state SET deserter_pending = 0, deserter_until = NULL WHERE user_id = ?")
    .run(Number(userId));
}

/**
 * The live lock for this user, or null — `{ remainingMs, message }`.
 *
 * Reading is also what expires it: the sweep-free way to hold "clear both once
 * `until` has passed" is to notice on the way past.
 */
export function deserterLockFor(userId) {
  const row = db
    .prepare("SELECT deserter_pending, deserter_until FROM game_state WHERE user_id = ?")
    .get(Number(userId));
  if (!row || !Number(row.deserter_pending)) return null;
  const remainingMs = Number(row.deserter_until ?? 0) - Date.now();
  if (remainingMs <= 0) {
    clearDeserter(userId);
    return null;
  }
  return {
    remainingMs,
    message: `You left a fight in progress. You can enter again in ${formatWait(remainingMs)}.`,
  };
}

/**
 * Restart the clock at login (app.mjs).
 *
 * Without this the penalty is a wall-clock timer, and the cheapest way to serve
 * it is to quit the game — which is precisely the thing it is meant to cost.
 *
 * But a clock that ran out with the player STILL HERE has been served, and
 * signing in again must not resurrect a sentence they finished. `last_seen`
 * (app.mjs writes it on authenticated traffic) is the record of who was
 * present: past `until` means they sat it out, before it means they left
 * early. Its 30 s write throttle can misjudge the last half-minute of a
 * 2-minute lock, which errs on the side of the rule rather than against it.
 */
export function restartDeserterClock(userId) {
  const row = db
    .prepare("SELECT deserter_pending, deserter_until, last_seen FROM game_state WHERE user_id = ?")
    .get(Number(userId));
  if (!row || !Number(row.deserter_pending)) return;
  if (Number(row.last_seen ?? 0) >= Number(row.deserter_until ?? 0)) {
    clearDeserter(userId);
    return;
  }
  db.prepare("UPDATE game_state SET deserter_until = ? WHERE user_id = ?")
    .run(Date.now() + DESERTER_LOCK_MS, Number(userId));
}

/**
 * Give up a seat, and say whether the fight was still being fought.
 *
 * Both ways out of a fight land here: the explicit `POST /api/fight/sim/end`
 * and the grace-logout sweep. Leaving does not end a PARTY's fight — the
 * others are still in it — but the LAST one out does end it, or an abandoned
 * session would keep ticking (and keep a seat warm for everyone in it) until
 * the idle timeout, and the next fight those players open is a different
 * session.
 *
 * "Deserted" means the sim was actually in combat. A session still dormant
 * (the 10 s idle countdown) or already finished is not a fight anyone can quit
 * half way — which also keeps the remote driver's own fallback path
 * (`goLocal`, up to 8 s in) from being read as walking out.
 */
function releaseSeat(userId) {
  const session = liveSessionOf(userId) ?? sessions.get(byUser.get(Number(userId)));
  if (!session) return { session: null, deserted: false };
  const member = session.members.get(Number(userId));
  if (!member || !member.joined) {
    byUser.delete(Number(userId));
    return { session, deserted: false };
  }
  const phase = session.fight.snapshot().phase;
  const deserted = !session.over && phase !== "idle" && phase !== "dead";
  member.joined = false;
  byUser.delete(Number(userId));
  if ([...session.members.values()].every((m) => !m.joined)) disposeSession(session.key);
  return { session, deserted };
}

/**
 * A player dropped off the network mid-fight (app.mjs's grace-logout sweep).
 *
 * The seat is freed exactly as an explicit leave frees it, because from the
 * fight's point of view they are the same event — and a lock that only ever
 * fired on the polite exit would be a lock that teaches players to pull the
 * plug instead.
 */
export function markFightAbandon(userId) {
  const { deserted } = releaseSeat(userId);
  if (deserted) lockDeserter(userId);
  return deserted;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** What one client is told about itself — the half the snapshot never carried. */
function selfView(session, member) {
  const cds = {};
  for (const [slot, at] of member.cooldowns) {
    const left = at - session.simT;
    if (left > 0) cds[slot] = Math.round(left * 1000);
  }
  const view = session.fight.actorView(member.actorId);
  return {
    actorId: member.actorId,
    hp: view?.hp ?? 0,
    hpMax: view?.hpMax ?? 0,
    alive: view?.alive ?? false,
    mitigation: view?.mitigation ?? 0,
    focus: Math.round(member.focus),
    focusMax: FOCUS.max,
    gcdMs: Math.max(0, Math.round((member.gcdUntil - session.simT) * 1000)),
    cooldowns: cds,
    beat: member.beatIndex,
    stance: session.fight.threatStanceActiveFor(member.actorId),
  };
}

function flush(session) {
  const events = session.events.splice(0, session.events.length);
  const snap = session.fight.snapshot();
  const t = Math.round(session.simT * 1000);
  // One serialization of the shared half, one personalized `you` per member —
  // everyone sees the same boss, their own Focus and cooldowns. Only to the
  // members actually IN it: a player who left is very likely looking at
  // another fight by now, and two state streams into one client is a HUD
  // flickering between two bosses.
  for (const member of session.members.values()) {
    if (!member.joined) continue;
    pushTo(member.userId, "fightState", {
      t,
      key: session.key,
      party: session.members.size,
      snap,
      you: selfView(session, member),
      events,
    });
  }
}

function tickAll() {
  const now = Date.now();
  const dt = TICK_MS / 1000;
  for (const [key, session] of sessions) {
    if (session.over) {
      if (now - session.endedAt > LINGER_MS) disposeSession(key);
      continue;
    }
    const lastSeen = Math.max(...[...session.members.values()].map((m) => m.lastSeen));
    if (now - lastSeen > IDLE_TIMEOUT_MS || now - session.startedAt > MAX_FIGHT_MS) {
      disposeSession(key);
      continue;
    }
    try {
      session.simT += dt;
      session.fight.tick(dt);

      // Advance the Shapeshift form. `notifyP2Stage` is idempotent per stage,
      // so this is one announce + one sfx per form, exactly as when the boss
      // model drove it.
      const phased = session.fight.snapshot();
      if (phased.phase === "p2") {
        if (!session.inP2) {
          // Fresh shapeshift: first one in order, later ones shuffled.
          session.inP2 = true;
          session.p2Order = session.p2Cycles === 0 ? [0, 1, 2, 3, 4] : shuffled([0, 1, 2, 3, 4]);
          session.p2Cycles += 1;
        }
        const slot = Math.min(4, Math.floor((P2_TOTAL_S - phased.phaseRemainingS) / P2_STAGE_S));
        session.fight.notifyP2Stage(session.p2Order[slot] ?? 0);
      } else {
        session.inP2 = false;
      }

      // Focus regen and the beat clock, both of which the client used to own.
      for (const member of session.members.values()) {
        member.focus = Math.min(FOCUS.max, member.focus + FOCUS.regenPerS * member.focusRegen * dt);
        const beats = member.hero.beats;
        if (beats && beats.length > 0) {
          member.beatT += dt;
          while (member.beatT >= FOCUS.beatPeriodS) {
            member.beatT -= FOCUS.beatPeriodS;
            member.beatIndex = (member.beatIndex + 1) % beats.length;
          }
        }
      }

      const ended = session.events.find((e) => e.e === "end");
      if (ended) {
        session.over = true;
        session.endedAt = now;
        session.result = ended.stats;
        settleSession(session, ended.stats);
      }
      session.tickCount++;
      if (session.over || session.tickCount % STATE_EVERY === 0) flush(session);
    } catch (err) {
      console.error("[fight] session tick failed:", err);
      disposeSession(key);
    }
  }
}

/**
 * Rebound on globalThis, not merely guarded: a Vite middleware reload must
 * neither stack duplicate loops nor keep ticking a stale closure of this file
 * (the same rule app.mjs's matchmaker documents).
 */
function startLoop() {
  const KEY = "__psyrenaFightLoop";
  if (globalThis[KEY]) clearInterval(globalThis[KEY]);
  globalThis[KEY] = setInterval(() => {
    try {
      tickAll();
    } catch (err) {
      console.error("[fight] loop:", err);
    }
  }, TICK_MS);
  globalThis[KEY].unref?.();
}

// ---------------------------------------------------------------------------
// Router — /api/fight/sim/*
// ---------------------------------------------------------------------------

/** Intents are GCD-paced; this is abuse headroom, not a game rule. */
const INTENT_RATE = { count: 20, windowMs: 1000 };
const recentIntent = new Map();

function sessionFor(userId) {
  const key = byUser.get(userId);
  if (!key) return null;
  const session = sessions.get(key);
  if (!session) return null;
  const member = session.members.get(userId);
  if (!member) return null;
  return { session, member };
}

export async function handleFightSim(req, res, url, userId) {
  const { send, readBody } = helpers;
  if (!userId) return send(res, 401, { error: "Not logged in." });
  const route = `${req.method} ${url.pathname}`;

  if (route === "POST /api/fight/sim/begin") {
    // Coming BACK to a fight still in progress is not a new admission — it is
    // how a reloaded tab gets its seat back, and it is the opposite of
    // desertion, so it both bypasses the lock and cancels one already set.
    // Practice is not gated at all: it never opens a server session.
    if (liveSessionOf(userId)?.members.get(Number(userId))) {
      clearDeserter(userId);
    } else {
      const lock = deserterLockFor(userId);
      if (lock) return send(res, 403, { error: lock.message });
    }
    const session = beginFight(userId, await readBody(req));
    const member = session.members.get(userId);
    return send(res, 200, {
      ok: true,
      key: session.key,
      party: session.members.size,
      roomId: session.roomId,
      difficulty: session.difficulty,
      actors: session.fight.actorIds(),
      snap: session.fight.snapshot(),
      you: member ? selfView(session, member) : null,
    });
  }

  if (route === "POST /api/fight/sim/intent") {
    const found = sessionFor(userId);
    if (!found) return send(res, 409, { error: "No fight in progress." });
    found.member.lastSeen = Date.now();

    const now = Date.now();
    const hits = (recentIntent.get(userId) ?? []).filter((t) => now - t < INTENT_RATE.windowMs);
    if (hits.length >= INTENT_RATE.count) return send(res, 200, { ok: false, why: "too fast" });
    hits.push(now);
    recentIntent.set(userId, hits);

    // The caller gets its answer now — the projectile it fires is drawn from
    // this — and the broadcast carries the consequences to the whole party.
    return send(res, 200, applyIntent(found.session, found.member, await readBody(req)));
  }

  if (route === "POST /api/fight/sim/end") {
    const settlement = sessionFor(userId)?.member.settlement ?? null;
    const { session, deserted } = releaseSeat(userId);
    if (deserted) lockDeserter(userId);
    return send(res, 200, {
      ok: true,
      result: session?.result ?? null,
      // The receipt again, for a client that missed the SSE push.
      settlement,
      deserted,
    });
  }

  /**
   * The `window.psyrenaFight.debugWin/debugLose/debugKillPlayer` hooks, which
   * several E2E tools drive the whole win/defeat flow through. With the fight
   * on the server the client can no longer reach into the sim, so the hooks
   * come here instead — behind an env flag, and 404 without it, because an
   * endpoint that ends a ranked fight as a win is not something a deployment
   * should be able to reach by guessing the path.
   */
  if (route === "POST /api/fight/sim/debug") {
    if (process.env.PSYRENA_FIGHT_DEBUG !== "1") return send(res, 404, { error: "No such endpoint." });
    const found = sessionFor(userId);
    if (!found) return send(res, 409, { error: "No fight in progress." });
    const action = (await readBody(req))?.action;
    // killPlayer drops the session's PRIMARY actor — the party's first seat,
    // which is the caller in the solo runs these hooks are used from.
    if (action === "win") found.session.fight.debugKillBoss();
    else if (action === "lose") found.session.fight.debugKillParty();
    else if (action === "killPlayer") found.session.fight.debugKillPlayer();
    else return send(res, 400, { error: "Unknown debug action." });
    return send(res, 200, { ok: true });
  }

  if (route === "GET /api/fight/sim/state") {
    const found = sessionFor(userId);
    if (!found) return send(res, 409, { error: "No fight in progress." });
    found.member.lastSeen = Date.now();
    return send(res, 200, {
      t: Math.round(found.session.simT * 1000),
      key: found.session.key,
      party: found.session.members.size,
      snap: found.session.fight.snapshot(),
      you: selfView(found.session, found.member),
      over: found.session.over,
      result: found.session.result,
      settlement: found.member.settlement,
    });
  }

  return send(res, 404, { error: "No such endpoint." });
}

/** Test/introspection hook — how many fights are live right now. */
export function liveFightCount() {
  return sessions.size;
}
