/**
 * The fight seam — where the arena's numbers come from.
 *
 * `arenaCombat.ts` used to hold a `BossFight` directly, which meant the browser
 * decided what a cast dealt, how much Focus it cost and who was dead. Phase 3
 * of docs-server-auth-plan.md hands all of that to the server for ranked runs,
 * and this interface is the hinge: it is EXACTLY the surface the arena already
 * used, so the scene layer neither knows nor cares which side of the wire the
 * fight is running on.
 *
 * Two implementations:
 *
 *   `LocalFightDriver`  — the sim in this tab. Practice runs keep it (there is
 *                         no server session for a learning pit), and it is the
 *                         fallback when the server fight cannot be opened: a
 *                         network hiccup must not dead-end a player inside an
 *                         arena that never engages.
 *   `RemoteFightDriver` — intents up (`POST /api/fight/sim/intent`), state and
 *                         hooks down (`fightState` over the social SSE stream).
 *                         The server's events are replayed into the very same
 *                         `FightHooks` the arena builds for the local sim, so
 *                         every VFX/SFX/HUD path keeps working untouched.
 *
 * The one thing the arena still has to branch on is `remote`, and only where
 * the two genuinely differ (the P2 stage's direction of travel, whose Focus
 * pool the HUD believes). Those branches are commented at their call sites.
 */

import type {
  BossFanView,
  BossFight,
  BossOrbsView,
  ConditioningHudState,
  FightEndStats,
  FightHooks,
  FightPhaseState,
  FightSnapshot,
  ModelingHudState,
  OperantHudState,
  PsychosocialHudState,
  SfxName,
} from "@shared/fight/bossFight";
import { psychosocialStart } from "@shared/fight/psychosocial";
import type { Hero } from "../../shared/types";
import { FOCUS, focusCostFor, type CostKind } from "../../shared/fight/costs";
import type { FightResultResponse } from "../net/economy";
import { player } from "../state/player";
import { isUnloading } from "../core/pageLife";

/** Everything a cast can be. `stance` is a toggle, not a cast — see below. */
export type DriverCastKind = Exclude<CostKind, "stance">;

export interface CastOutcome {
  /** The fight accepted the cast. A refusal never fires a projectile. */
  ok: boolean;
  /** Why it was refused — shown to the player; the server writes the words. */
  why?: string;
  /**
   * What the cast is worth. Remote: the damage the server ALREADY applied —
   * the projectile is pure presentation and shows this on impact. Local: the
   * pending hit's damage, because the local sim keeps its cast→flight→land
   * split and the applied number only exists once `land()` runs.
   *
   * Either way `dealt > 0` is the test for "something flies at the boss".
   */
  dealt: number;
  crit: boolean;
  /**
   * Local only: apply the hit, at projectile impact, and hand back the number
   * that actually landed. Absent in remote mode — `server/fight.mjs
   * applyIntent` explains why the server collapses cast and land into one.
   */
  land?: () => number;
}

/** This player's own half of the fight — the part `snapshot()` never carried. */
export interface DriverSelf {
  hp: number;
  hpMax: number;
  alive: boolean;
  /** The Focus pool. Local: the client store, which IS the pool offline. */
  focus: number;
  focusMax: number;
  /** Global cooldown left, ms. 0 locally — the action bar owns the GCD there. */
  gcdMs: number;
  /** slotId → ms left. Empty locally, for the same reason. */
  cooldowns: Record<string, number>;
  /** Index into `hero.beats` — which multiplier the next cast rides. */
  beat: number;
}

export interface FightDriver {
  /** True while the SERVER is running this fight. See the file header. */
  readonly remote: boolean;
  tick(dt: number): void;
  snapshot(): FightSnapshot;
  self(): DriverSelf;
  cast(kind: DriverCastKind, opts?: { paletteIndex?: number }): Promise<CastOutcome>;
  setThreatStance(active: boolean): void;
  readonly threatStanceActive: boolean;
  readonly operant: OperantHudState | null;
  /** Erikson's rotation as the fight last reported it; null for other kits. */
  readonly psychosocial: PsychosocialHudState | null;
  /** Bandura's model and retention slots as last reported; null for other kits. */
  readonly modeling: ModelingHudState | null;
  /** Bandura: move the model pin on (automatic → each teammate → automatic). */
  cycleModel(): void;
  /** My hero stood inside fan `id` when it landed (FightHooks.bossFan). */
  fanHit(id: number): void;
  /**
   * The boss model reporting the P2 form it is showing. Local only: the sim
   * has no stage clock of its own and learns the answer this way. In remote
   * mode the arrow points the other way (server → model), so this is a no-op —
   * see `RemoteFightDriver.notifyP2Stage`.
   */
  notifyP2Stage(stage: number): void;
  /**
   * The payout for this attempt, when the SERVER decided and paid it.
   *
   * Non-null only after a remote fight has ended: server/fight.mjs settles
   * from its own stat block and pushes the receipt ahead of the end event, so
   * this is already filled by the time the arena's `fightEnd` hook runs. Null
   * everywhere else — practice and the offline fallback are still settled by
   * the client's own report, because nobody else has their numbers.
   */
  settlement(): FightResultResponse | null;
  debugWin(): void;
  debugLose(): void;
  debugKillPlayer(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Local — the sim in this tab
// ---------------------------------------------------------------------------

export class LocalFightDriver implements FightDriver {
  readonly remote = false;

  private readonly actorId: string;
  /**
   * The beat clock, moved here from the arena's tick. It belongs to whoever
   * owns the fight: offline that is this object, and online the server sends
   * its index down with every frame. The HUD reads one field either way.
   */
  private beatIndex = 0;
  private beatT = 0;

  constructor(
    private readonly fight: BossFight,
    private readonly hero: Hero
  ) {
    this.actorId = fight.actorIds()[0] ?? "player";
  }

  tick(dt: number): void {
    const beats = this.hero.beats?.length ?? 0;
    if (beats > 0) {
      this.beatT += dt;
      while (this.beatT >= FOCUS.beatPeriodS) {
        this.beatT -= FOCUS.beatPeriodS;
        this.beatIndex = (this.beatIndex + 1) % beats;
      }
    }
    this.fight.tick(dt);
  }

  snapshot(): FightSnapshot {
    return this.fight.snapshot();
  }

  self(): DriverSelf {
    const view = this.fight.actorView(this.actorId);
    return {
      hp: view?.hp ?? 0,
      hpMax: view?.hpMax ?? 0,
      alive: view?.alive ?? true,
      // The offline fight has no Focus pool of its own — the player store is
      // it, exactly as it was before the server owned one.
      focus: player.mana,
      focusMax: player.manaMax,
      gcdMs: 0,
      cooldowns: {},
      beat: this.beatIndex,
    };
  }

  async cast(kind: DriverCastKind, opts: { paletteIndex?: number } = {}): Promise<CastOutcome> {
    const beat = this.hero.beats?.[this.beatIndex]?.multiplier ?? 1;
    // Spent before the sim is asked, and spent even if the sim then refuses —
    // that is what the arena did inline, and a cast whose cost disagrees with
    // whether it happened is the bug this ordering was chosen to avoid.
    player.spendMana(focusCostFor(this.hero, kind, opts.paletteIndex));

    if (kind === "defense") {
      this.fight.castDefenseAs(this.actorId);
      return { ok: true, dealt: 0, crit: false };
    }
    if (kind === "ultimate") {
      const total = this.fight.castUltimateAs(this.actorId);
      if (total <= 0 && !this.fight.ultimateResolvedAs(this.actorId)) return { ok: false, why: "no Marks", dealt: 0, crit: false };
      return {
        ok: true,
        dealt: total,
        crit: false,
        land: () => {
          this.fight.landUltimateAs(this.actorId, total);
          return total;
        },
      };
    }
    const hit =
      kind === "basic"
        ? this.fight.castBasicAs(this.actorId, beat)
        : kind === "chain"
          ? this.fight.castChainAs(this.actorId, beat)
          : this.fight.castPaletteAs(this.actorId, opts.paletteIndex ?? 0, beat);
    if (!hit) return { ok: false, why: "refused", dealt: 0, crit: false };
    return {
      ok: true,
      dealt: hit.damage,
      crit: hit.crit,
      land: () => this.fight.landHitAs(this.actorId, hit),
    };
  }

  setThreatStance(active: boolean): void {
    this.fight.setThreatStanceAs(this.actorId, active);
  }

  get threatStanceActive(): boolean {
    return this.fight.threatStanceActiveFor(this.actorId);
  }

  get operant(): OperantHudState | null {
    return this.fight.operantFor(this.actorId);
  }

  get psychosocial(): PsychosocialHudState | null {
    return this.fight.psychosocialFor(this.actorId);
  }

  get modeling(): ModelingHudState | null {
    return this.fight.modelingFor(this.actorId);
  }

  cycleModel(): void {
    this.fight.cycleModelAs(this.actorId);
  }

  fanHit(id: number): void {
    this.fight.fanHitAs(this.actorId, id);
  }

  notifyP2Stage(stage: number): void {
    this.fight.notifyP2Stage(stage);
  }

  settlement(): FightResultResponse | null {
    return null; // an in-tab fight has no server session to have been paid by
  }

  debugWin(): void {
    this.fight.debugKillBoss();
  }

  debugLose(): void {
    this.fight.debugKillParty();
  }

  debugKillPlayer(): void {
    this.fight.debugKillPlayer();
  }

  dispose(): void {
    /* the sim holds nothing but memory; the scene drops it with this object */
  }
}

// ---------------------------------------------------------------------------
// The wire — server/fight.mjs `hooksInto()`, typed
// ---------------------------------------------------------------------------

/**
 * One replayed `FightHooks` call. `who` is the actor it belongs to (`u<userId>`)
 * on everything that is one player's business; its absence means the event is
 * the whole room's (the boss, the phase, the world chat).
 */
type WireEvent =
  | { e: "announce"; text: string }
  | { e: "phase"; phase: FightPhaseState }
  | { e: "strike"; targets: "threat" | "all" }
  | { e: "fan"; fan: BossFanView }
  | { e: "orbs"; volley: BossOrbsView }
  | { e: "dmgPlayer"; n: number; who?: string }
  | { e: "healPlayer"; n: number; who?: string }
  | { e: "hurt"; name: string; amount: number; isPlayer: boolean; who?: string }
  | {
      e: "healed";
      name: string;
      effective: number;
      attempted: number;
      isPlayer: boolean;
      label: string;
      who?: string;
    }
  | { e: "died"; name: string; isPlayer: boolean; who?: string }
  | { e: "allyCast"; name: string; action: "heal" | "damage" }
  | { e: "dot"; label: string; amount: number; who?: string }
  | {
      e: "buff";
      name: string;
      durationMs: number;
      kind?: "buff" | "debuff";
      icon?: string;
      id?: string;
      desc?: string;
      who?: string;
    }
  | { e: "focus"; n: number; who?: string }
  | { e: "proc"; name: string; who?: string }
  | { e: "lock"; paletteIndex: number; ms: number; who?: string }
  | { e: "conditioning"; state: ConditioningHudState; who?: string }
  | { e: "operant"; state: OperantHudState; who?: string }
  | { e: "psychosocial"; state: PsychosocialHudState; who?: string }
  | { e: "modeling"; state: ModelingHudState; who?: string }
  | { e: "flinch"; who?: string }
  | { e: "sfx"; name: SfxName; who?: string }
  | { e: "end"; stats: FightEndStats };

/** One `fightState` push: the shared half, this player's half, and the hooks. */
export interface FightStateFrame {
  t: number;
  key: string;
  party: number;
  snap: FightSnapshot;
  you: {
    actorId: string;
    hp: number;
    hpMax: number;
    alive: boolean;
    mitigation: number;
    focus: number;
    focusMax: number;
    gcdMs: number;
    cooldowns: Record<string, number>;
    beat: number;
    stance: boolean;
  };
  events: WireEvent[];
}

/** The subscription the driver needs — `SocialClient.onFightState`. */
export type FightStateSubscribe = (cb: (frame: FightStateFrame) => void) => () => void;

/** One `fightResult` push: the settlement, tagged with the fight it paid for. */
export type FightResultFrame = FightResultResponse & { key: string };

/** The settlement subscription — `SocialClient.onFightResult`. */
export type FightResultSubscribe = (cb: (result: FightResultFrame) => void) => () => void;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

// ---------------------------------------------------------------------------
// Remote — the server's fight, rendered here
// ---------------------------------------------------------------------------

/**
 * Two things can go wrong on the way into a server fight, and both of them
 * leave a player standing in an arena where nothing ever happens: `begin` can
 * fail outright, or it can succeed while the SSE stream that carries the fight
 * never delivers. Either one falls the whole driver back to the local sim —
 * a solo-flavoured fight is a far better outcome than a frozen boss.
 */
const FIRST_FRAME_TIMEOUT_MS = 8_000;

export class RemoteFightDriver implements FightDriver {
  /** Flips to false only if the server fight could not be run. */
  get remote(): boolean {
    return this.fallback === null;
  }

  private frame: FightStateFrame | null = null;
  /** The server's payout, once it has pushed one. See `settlement()`. */
  private paid: FightResultResponse | null = null;
  private unsubscribeResult: (() => void) | null = null;
  /**
   * Which session's frames are mine. A fight outlives the client that walked
   * out of it (a party's fight belongs to the party), and it keeps pushing to
   * every member it was built with — so a player who left one and opened
   * another receives BOTH streams down the one social connection. Without this
   * the HUD flickers between two bosses.
   */
  private key: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private begun = false;
  /** A pushed frame, as opposed to the seed taken from the begin response. */
  private streaming = false;
  private over = false;
  private disposed = false;
  /** Set when the server could not carry the fight — see FIRST_FRAME_TIMEOUT_MS. */
  private fallback: LocalFightDriver | null = null;
  private operantState: OperantHudState | null;
  private psychosocialState: PsychosocialHudState | null;
  private modelingState: ModelingHudState | null = null;
  /** Optimistic until the next frame confirms it — a stance must feel instant. */
  private stance = false;

  constructor(
    private readonly opts: {
      hero: Hero;
      difficulty: string;
      petId: string | null;
      subscribe: FightStateSubscribe;
      subscribeResult: FightResultSubscribe;
      /** Built by the arena either way; only ticked if the server drops out. */
      local: LocalFightDriver;
      hooks: FightHooks;
      /**
       * Re-attach to the session this player already holds a seat in (a
       * reload mid-fight): skip the fresh-attempt `/end`, and replay the live
       * phase into the hooks, whose phase events this tab never saw.
       */
      rejoin?: boolean;
    }
  ) {
    // A reinforcement kit opens on Positive/Reinforcement (the sim's
    // constructor says so) and the bar paints its E/R faces from this BEFORE
    // any frame has arrived — a client that joins a party's fight late missed
    // the opening `operant` event and would otherwise mount the bare kit.
    this.operantState = opts.hero.reinforcement
      ? { contingency: "positive", consequence: "reinforcement" }
      : null;
    // Same reason for a life-cycle kit: stage 1 is up before any event.
    this.psychosocialState = opts.hero.psychosocial ? psychosocialStart() : null;
  }

  tick(dt: number): void {
    if (this.fallback) {
      this.fallback.tick(dt);
      return;
    }
    // Deferred to the first tick on purpose. The scene's render observables
    // stay silent until the party's ready barrier releases, so opening the
    // session here is what makes the server's 8 s idle countdown start when
    // the party actually starts fighting — the same guarantee the local sim
    // got for free from riding the render loop.
    if (!this.begun) {
      this.begun = true;
      void this.open();
    }
  }

  private async open(): Promise<void> {
    try {
      this.unsubscribe = this.opts.subscribe((frame) => this.onFrame(frame));
      // Subscribed before `begin`, because the receipt for a fight this tab is
      // rejoining could land in the same breath as the first state frame.
      this.unsubscribeResult = this.opts.subscribeResult((result) => {
        if (this.disposed || this.fallback) return;
        if (this.key !== null && result.key !== this.key) return; // another fight's
        this.paid = result;
      });
      // Walking into the arena is a NEW attempt. A server session outlives the
      // tab that opened it — that is what lets a reload rejoin a fight in
      // progress — so without this an arena visit could attach to the boss the
      // last visit abandoned, already three phases deep. Leaving a PARTY's
      // fight only gives up this seat (server/fight.mjs), so a teammate
      // re-entering still lands back in the same fight.
      if (!this.opts.rejoin) await post("/api/fight/sim/end", {}).catch(() => undefined);
      const first = await post<{ key: string; snap: FightSnapshot; you: FightStateFrame["you"] }>(
        "/api/fight/sim/begin",
        { difficulty: this.opts.difficulty, pet: this.opts.petId ?? undefined }
      );
      if (this.disposed) return;
      // Seed the HUD off the begin response so the boss frame is right on the
      // very first painted frame instead of a tick behind.
      this.key = first.key;
      this.frame = { t: 0, key: first.key, party: 1, snap: first.snap, you: first.you, events: [] };
      this.stance = first.you.stance;
      if (this.opts.rejoin && first.snap.phase !== "idle") this.opts.hooks.setBossPhase(first.snap.phase);
      setTimeout(() => {
        if (!this.disposed && !this.fallback && !this.streaming) {
          this.goLocal(new Error(`no fightState frame in ${FIRST_FRAME_TIMEOUT_MS} ms`));
        }
      }, FIRST_FRAME_TIMEOUT_MS);
    } catch (err) {
      this.goLocal(err);
    }
  }

  /** Hand the fight to the in-tab sim and say so — this is never silent. */
  private goLocal(err: unknown): void {
    if (this.fallback) return;
    console.warn("[fight] server fight unavailable — falling back to the local sim:", err);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeResult?.();
    this.unsubscribeResult = null;
    this.frame = null;
    // Whatever the server was going to pay for, this tab is no longer playing.
    this.paid = null;
    this.fallback = this.opts.local;
    // Release the seat if `begin` did land; a stale session would otherwise
    // hold this player in a party fight they are no longer rendering.
    void post("/api/fight/sim/end", {}).catch(() => undefined);
  }

  private onFrame(frame: FightStateFrame): void {
    if (this.disposed || this.fallback) return;
    if (this.key !== null && frame.key !== this.key) return; // another fight's
    this.streaming = true;
    this.frame = frame;
    this.stance = frame.you.stance;
    this.replay(frame.events ?? []);
  }

  /**
   * The whole point of the remote driver: the server's hooks, played back into
   * the arena's own `FightHooks`. Nothing downstream knows the difference.
   *
   * `isPlayer` is rewritten to mean "this tab's player". In the local sim it
   * meant "the primary actor", which for a solo client is the same thing —
   * so every existing consumer (hit reactions, the red damage float over MY
   * head, the death pose) keeps its original meaning in a party, where the
   * primary actor is whoever took the first seat.
   */
  private replay(events: WireEvent[]): void {
    const me = this.frame?.you.actorId;
    const h = this.opts.hooks;
    const mine = (who?: string): boolean => who !== undefined && who === me;
    for (const ev of events) {
      switch (ev.e) {
        case "announce":
          h.announce(ev.text);
          break;
        case "phase":
          h.setBossPhase(ev.phase);
          break;
        case "strike":
          h.bossStrike(ev.targets);
          break;
        case "fan":
          h.bossFan?.({ ...ev.fan, targetIsPlayer: mine(ev.fan.targetId) });
          break;
        case "orbs":
          h.bossOrbs?.({ ...ev.volley, orbs: ev.volley.orbs.map((o) => ({ ...o, anchorIsPlayer: mine(o.anchorId) })) });
          break;
        case "dmgPlayer":
          if (mine(ev.who)) h.damagePlayer(ev.n);
          break;
        case "healPlayer":
          if (mine(ev.who)) h.healPlayer(ev.n);
          break;
        // Damage, healing and death are the SHARED half: a teammate's numbers
        // float over a teammate's head, which is co-op made visible.
        case "hurt":
          h.combatantDamaged?.(ev.name, ev.amount, mine(ev.who));
          break;
        case "healed":
          h.combatantHealed?.(ev.name, ev.effective, ev.attempted, mine(ev.who), ev.label);
          break;
        case "died":
          h.combatantDied?.(ev.name, mine(ev.who));
          break;
        case "allyCast":
          h.allyCast?.(ev.name, ev.action);
          break;
        // Both the team-wide Shapeshift bleed (no `who`) and a teammate's
        // ultimate ticks land on the shared boss, so both are shown.
        case "dot":
          h.dotTick?.(ev.label, ev.amount);
          break;
        case "buff":
          if (mine(ev.who))
            h.playerBuff(ev.name, ev.durationMs, ev.kind, ev.icon, ev.id, ev.desc);
          break;
        case "focus":
          if (mine(ev.who)) h.gainFocus?.(ev.n);
          break;
        case "proc":
          if (mine(ev.who)) h.defenseProc?.(ev.name);
          break;
        case "lock":
          if (mine(ev.who)) h.lockPaletteSlot(ev.paletteIndex, ev.ms);
          break;
        case "conditioning":
          if (mine(ev.who)) h.conditioningChanged?.(ev.state);
          break;
        case "operant":
          if (mine(ev.who)) {
            this.operantState = ev.state;
            h.operantChanged?.(ev.state);
          }
          break;
        case "psychosocial":
          if (mine(ev.who)) {
            this.psychosocialState = ev.state;
            h.psychosocialChanged?.(ev.state);
          }
          break;
        case "modeling":
          if (mine(ev.who)) {
            this.modelingState = ev.state;
            h.modelingChanged?.(ev.state);
          }
          break;
        case "flinch":
          if (mine(ev.who)) h.playerHitReaction();
          break;
        // An un-addressed sound is the boss's own telegraph; an addressed one
        // is somebody's kit talking, and only mine is worth hearing.
        case "sfx":
          if (ev.who === undefined || mine(ev.who)) h.sfxEvent?.(ev.name);
          break;
        case "end":
          if (!this.over) {
            this.over = true;
            h.fightEnd?.(ev.stats);
          }
          break;
      }
    }
  }

  snapshot(): FightSnapshot {
    // Before the first frame the untouched local sim stands in: it is the same
    // boss at full HP in the same idle phase, so the frame lands as a
    // correction rather than a pop.
    return this.frame?.snap ?? this.opts.local.snapshot();
  }

  self(): DriverSelf {
    const you = this.frame?.you;
    if (!you) return this.opts.local.self();
    return {
      hp: you.hp,
      hpMax: you.hpMax,
      alive: you.alive,
      focus: you.focus,
      focusMax: you.focusMax,
      gcdMs: you.gcdMs,
      cooldowns: you.cooldowns,
      beat: you.beat,
    };
  }

  async cast(kind: DriverCastKind, opts: { paletteIndex?: number } = {}): Promise<CastOutcome> {
    if (this.fallback) return this.fallback.cast(kind, opts);
    try {
      const r = await post<{ ok: boolean; dealt?: number; crit?: boolean; focus?: number; why?: string }>(
        "/api/fight/sim/intent",
        { kind, paletteIndex: opts.paletteIndex }
      );
      // Spend locally the moment the server says it spent: the next state
      // frame is up to 100 ms away and a Focus bar that lags the cast reads
      // as a dropped press.
      if (r.ok && typeof r.focus === "number" && this.frame) this.frame.you.focus = r.focus;
      return { ok: !!r.ok, why: r.why, dealt: r.dealt ?? 0, crit: !!r.crit };
    } catch (err) {
      // A dropped intent is a dropped press, not a broken fight — the server
      // still holds the truth and the next frame repaints from it.
      console.warn("[fight] cast intent failed:", err);
      return { ok: false, why: "connection", dealt: 0, crit: false };
    }
  }

  setThreatStance(active: boolean): void {
    if (this.fallback) return this.fallback.setThreatStance(active);
    this.stance = active;
    void post("/api/fight/sim/intent", { kind: "stance", on: active }).catch((err) =>
      console.warn("[fight] stance intent failed:", err)
    );
  }

  get threatStanceActive(): boolean {
    return this.fallback ? this.fallback.threatStanceActive : this.stance;
  }

  get operant(): OperantHudState | null {
    return this.fallback ? this.fallback.operant : this.operantState;
  }

  get psychosocial(): PsychosocialHudState | null {
    return this.fallback ? this.fallback.psychosocial : this.psychosocialState;
  }

  get modeling(): ModelingHudState | null {
    return this.fallback ? this.fallback.modeling : this.modelingState;
  }

  cycleModel(): void {
    if (this.fallback) return this.fallback.cycleModel();
    void post("/api/fight/sim/intent", { kind: "model" }).catch((err) =>
      console.warn("[fight] model intent failed:", err)
    );
  }

  fanHit(id: number): void {
    if (this.fallback) return this.fallback.fanHit(id);
    void post("/api/fight/sim/intent", { kind: "fan", fan: id }).catch((err) =>
      console.warn("[fight] fan report failed:", err)
    );
  }

  notifyP2Stage(stage: number): void {
    // The server owns the phase clock, so the stage travels server → boss
    // model and this is a no-op — until the fallback is in charge, at which
    // point the model is once again the only stage clock there is and the
    // answer mechanic depends on hearing it.
    this.fallback?.notifyP2Stage(stage);
  }

  settlement(): FightResultResponse | null {
    return this.fallback ? this.fallback.settlement() : this.paid;
  }

  debugWin(): void {
    this.debug("win");
  }

  debugLose(): void {
    this.debug("lose");
  }

  debugKillPlayer(): void {
    this.debug("killPlayer");
  }

  /** window.psyrenaFight's E2E hooks, on the far side of the wire. */
  private debug(action: "win" | "lose" | "killPlayer"): void {
    if (this.fallback) {
      if (action === "win") this.fallback.debugWin();
      else if (action === "lose") this.fallback.debugLose();
      else this.fallback.debugKillPlayer();
      return;
    }
    void post("/api/fight/sim/debug", { action }).catch((err) =>
      console.warn("[fight] debug hook refused (PSYRENA_FIGHT_DEBUG=1 enables it):", err)
    );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeResult?.();
    this.unsubscribeResult = null;
    // A reload is not a leave: keep the seat for the tab that comes back.
    if (!this.fallback && !isUnloading()) void post("/api/fight/sim/end", {}).catch(() => undefined);
  }
}
