/**
 * Client for the village presence API (server/village.mjs): up to 50 players
 * sharing one hub session, positions fanned out over SSE.
 *
 * Same transport story as the social client (see src/net/social.ts): plain
 * fetch POSTs ride the same-origin HttpOnly cookie, and one EventSource per
 * session reconnects by itself — after a drop the server resends a `hello`
 * snapshot, which consumers MUST treat as a full roster replace (join/leave
 * events that fired while the stream was down are lost).
 */

export interface VillagePlayer {
  username: string;
  hero: string;
  /** Equipped pet id (petFollower.ts roster key), declared at join. */
  pet?: string | null;
  x: number;
  y: number;
  z: number;
  ry: number;
}

/** Options for join(): cosmetic pet declaration, or an arena party session. */
export interface VillageJoinOptions {
  /** Equipped pet id to show beside this player (village sessions). */
  pet?: string | null;
  /** Join the party's arena session ("a<roomId>") instead of the commons.
   *  Server-gated on actually holding a seat in that room. */
  arena?: number;
}

export interface VillageJoinResponse {
  sessionId: string;
  players: VillagePlayer[];
}

/**
 * One player's entry in a batched `state` event:
 * `[x, y, z, ry, action]` where action is a coarse locomotion hint
 * ("idle" | "run" | "jump" | … — forward-compatible, treat unknown as idle).
 */
export type VillageStateEntry = [number, number, number, number, string];

/** Batched `state` payload, keyed by username. Arrives every ~200 ms. */
export type VillageStateMap = Record<string, VillageStateEntry>;

/**
 * A discrete `cast` event — broadcast immediately (NOT batched like `state`,
 * which is last-write-wins and would swallow bursts). Cosmetic-only: remote
 * tabs play the VFX/gesture; no combat resolves from it. The caster's own
 * tab receives its echo too — consumers filter by username.
 */
export interface VillageCast {
  username: string;
  id: string;
  kind: string;
}

/** Server-side rate limit is 10 state POSTs/s; stay well under it. */
const SEND_INTERVAL_MS = 200;

/**
 * Background-tab keepalive cadence. rAF stops in hidden tabs, which silences
 * the position reporter; resending the last state well inside the server's
 * 60 s expiry keeps a hidden tab from being swept into a ghost.
 */
const KEEPALIVE_MS = 20_000;

/** Stream-death retry ladder — capped, so a downed server costs one request/10 s. */
const RETRY_MS = [1000, 2000, 5000, 10_000];

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((json as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

export class VillageClient {
  /** Full-roster replace. Fired on `hello` (initial connect AND reconnect). */
  onRoster: ((players: VillagePlayer[]) => void) | null = null;
  onJoin: ((player: VillagePlayer) => void) | null = null;
  onLeave: ((username: string) => void) | null = null;
  onState: ((players: VillageStateMap) => void) | null = null;
  onCast: ((cast: VillageCast) => void) | null = null;

  sessionId: string | null = null;

  private es: EventSource | null = null;
  /** Latest values awaiting the trailing-edge send. */
  private pending: { x: number; y: number; z: number; ry: number; action: string } | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  /** Last state actually handed to sendState — what the keepalive re-sends. */
  private lastState: { x: number; y: number; z: number; ry: number; action: string } | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIndex = 0;
  /** One in-flight 409 recovery at a time — a burst of stale POSTs is one re-join. */
  private rejoining = false;
  private closed = false;

  /** The join body, kept so self-healing re-joins land in the same session
   *  flavor (arena vs commons) with the same pet. */
  private joinOpts: VillageJoinOptions = {};

  /** Join a session and open the presence stream. Idempotent server-side. */
  async join(opts?: VillageJoinOptions): Promise<VillageJoinResponse> {
    if (opts) this.joinOpts = opts;
    const res = await api<VillageJoinResponse>("/api/village/join", this.joinOpts);
    this.closed = false;
    this.sessionId = res.sessionId;
    this.openStream(res.sessionId);
    if (this.keepaliveTimer === null) {
      this.keepaliveTimer = setInterval(() => this.keepalive(), KEEPALIVE_MS);
    }
    return res;
  }

  /**
   * Throttled state reporter: at most one POST per SEND_INTERVAL_MS, with a
   * trailing-edge send of the LATEST values (stale intermediate positions are
   * dropped, not queued). Safe to call every frame. Fire-and-forget — the
   * server silently drops over-limit traffic, so a failed POST is not worth
   * surfacing.
   */
  sendState(x: number, y: number, z: number, ry: number, action: string): void {
    this.pending = { x, y, z, ry, action };
    this.lastState = this.pending;
    if (this.sendTimer !== null) return;
    const wait = SEND_INTERVAL_MS - (Date.now() - this.lastSentAt);
    if (wait <= 0) this.flush();
    else this.sendTimer = setTimeout(() => this.flush(), wait);
  }

  /**
   * Re-declare the cosmetic pet mid-session (a Pet Park equip/unequip). Goes
   * through the idempotent join route, which re-broadcasts this player's
   * `join` to the session when the pet actually changed — but deliberately
   * NOT through join() itself, which would tear down and re-open the stream
   * for a cosmetic swap. Fire-and-forget.
   */
  setPet(pet: string | null): void {
    this.joinOpts = { ...this.joinOpts, pet };
    if (this.sessionId === null || this.closed) return;
    void api("/api/village/join", this.joinOpts).catch(() => undefined);
  }

  /**
   * Announce a skill cast. Fire-and-forget and unthrottled — the GCD already
   * paces real casts, and the server drops abuse silently. Unlike sendState
   * there is no trailing-edge coalescing: every accepted cast is an event.
   */
  sendCast(id: string, kind: string): void {
    if (this.sessionId === null || this.closed) return;
    void api("/api/village/cast", { id, kind }).catch(() => undefined);
  }

  /** Leave the session and close the stream. Never rejects. */
  async leave(): Promise<void> {
    this.closed = true;
    if (this.sendTimer !== null) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pending = null;
    this.lastState = null;
    this.es?.close();
    this.es = null;
    if (this.sessionId !== null) {
      this.sessionId = null;
      await api("/api/village/leave").catch(() => undefined);
    }
  }

  private flush(): void {
    if (this.sendTimer !== null) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    const p = this.pending;
    this.pending = null;
    if (!p || this.sessionId === null) return;
    this.lastSentAt = Date.now();
    void this.postState(p);
  }

  /** Hidden-tab lifeline: repeat the last pose so the 60 s sweep passes us by. */
  private keepalive(): void {
    const p = this.lastState;
    if (!p || this.sessionId === null || this.closed) return;
    if (Date.now() - this.lastSentAt < KEEPALIVE_MS) return; // reporter is alive
    this.lastSentAt = Date.now();
    void this.postState(p);
  }

  /**
   * State POST with self-healing: a 409 means the server swept us (village.mjs
   * expires silent members after 60 s) — re-join once (idempotent) and resend
   * instead of ghosting. Other failures stay fire-and-forget.
   */
  private async postState(p: { x: number; y: number; z: number; ry: number; action: string }): Promise<void> {
    try {
      await api("/api/village/state", p);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) return;
      if (this.rejoining || this.closed) return;
      this.rejoining = true;
      try {
        const res = await this.join(); // re-opens the stream on the new session
        this.onRoster?.(res.players);
        await api("/api/village/state", p).catch(() => undefined);
      } catch {
        this.scheduleRejoin(); // server still down — keep trying on the ladder
      } finally {
        this.rejoining = false;
      }
    }
  }

  /** Capped-backoff re-join, used when the stream dies for good (403/401). */
  private scheduleRejoin(): void {
    if (this.retryTimer !== null || this.closed) return;
    const wait = RETRY_MS[Math.min(this.retryIndex++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      this.join().then(
        (res) => this.onRoster?.(res.players),
        () => this.scheduleRejoin()
      );
    }, wait);
  }

  private openStream(sessionId: string): void {
    this.es?.close();
    const es = new EventSource(`/api/village/stream?session=${encodeURIComponent(sessionId)}`);
    this.es = es;

    es.addEventListener("hello", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        sessionId: string;
        players: VillagePlayer[];
      };
      this.sessionId = data.sessionId;
      this.retryIndex = 0; // a healthy stream resets the backoff ladder
      // Full replace: the roster may have drifted while the stream was down.
      this.onRoster?.(data.players);
    });
    es.addEventListener("join", (e) => {
      this.onJoin?.(JSON.parse((e as MessageEvent).data) as VillagePlayer);
    });
    es.addEventListener("leave", (e) => {
      this.onLeave?.((JSON.parse((e as MessageEvent).data) as { username: string }).username);
    });
    es.addEventListener("state", (e) => {
      this.onState?.((JSON.parse((e as MessageEvent).data) as { players: VillageStateMap }).players);
    });
    es.addEventListener("cast", (e) => {
      this.onCast?.(JSON.parse((e as MessageEvent).data) as VillageCast);
    });
    // EventSource retries transient drops by itself (the follow-up `hello`
    // heals the roster) — but on a non-2xx response it gives up FOREVER.
    // That is exactly what happens after the 60 s sweep: the re-opened stream
    // gets a 403 for a session we no longer belong to. Re-join (idempotent)
    // on a capped backoff so the tab heals instead of ghosting.
    es.onerror = () => {
      if (this.es !== es) return; // superseded by a newer stream
      if (es.readyState !== EventSource.CLOSED) return; // auto-retry in flight
      this.scheduleRejoin();
    };
  }
}
