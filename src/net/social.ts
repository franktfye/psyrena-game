/**
 * Client for the social API (server/social.mjs): lobby chat, whispers,
 * friends, presence.
 *
 * One EventSource per session. SSE was chosen over WebSocket server-side (it
 * rides the same-origin HTTP + HttpOnly cookie for free); on this side the
 * win is that EventSource reconnects itself — after a dev-server restart or a
 * phone waking up, the `hello` snapshot simply re-arrives and state heals.
 *
 * The store keeps at most `KEEP` messages per channel — that is the scrollback
 * contract the chat panel renders ("shows 5, scroll preserves 50").
 */

export interface ChatMessage {
  id: number;
  from: string;
  hero: string;
  /** Whisper recipient; absent on lobby messages. */
  to?: string;
  body: string;
  at: number;
}

export interface FriendInfo {
  username: string;
  hero: string;
  online: boolean;
}

/** Payload of the `match` SSE event — the matchmaker seated us in this room. */
export interface MatchInfo {
  roomId: number;
  name: string;
  /** The pool we were matched out of — the room fights at this difficulty. */
  difficulty?: string;
}

/** Payload of the `invite` SSE event — a friend invited us to their party. */
export interface InviteInfo {
  roomId: number;
  name: string;
  from: string;
}

/**
 * Payload of the `friendRequest` SSE event — someone just asked to be friends.
 *
 * Distinct from the `friends` snapshot on purpose, and for exactly the reason
 * `invite` is distinct from the rooms list: a snapshot is state the panel
 * repaints from, an event is something that HAPPENED and deserves a card. The
 * snapshot still arrives alongside, so the two never disagree.
 */
export interface FriendRequestInfo {
  /** Who asked. */
  from: string;
  /** Their selected hero — the card wears the portrait. */
  hero: string;
}

/** Payload of the `partyLaunch` SSE event — the leader started the fight;
 *  every member auto-enters the boss arena at the room's difficulty. */
export interface PartyLaunchInfo {
  roomId: number;
  difficulty?: string;
}

/** Payload of the `fightReady` SSE event — barrier progress for our party. */
export interface FightReadyInfo {
  roomId: number;
  ready: number;
  total: number;
}

/** Payload of the `fightStart` SSE event — every member loaded (or timed out). */
export interface FightStartInfo {
  roomId: number;
}

/**
 * Payload of the `lobbyReady` SSE event — someone in our MATCHMADE lobby
 * flipped their ready dot. Deliberately distinct from `fightReady`, which is
 * the in-arena load barrier and is already claimed by the arena scene.
 *
 * A hint, not the truth: the panel re-polls /api/lobby for authoritative
 * per-member flags, the same split `match` uses.
 */
export interface LobbyReadyInfo {
  roomId: number;
  ready: number;
  total: number;
}

const KEEP = 50;

interface HelloPayload {
  you: string;
  friends: FriendInfo[];
  incoming: string[];
  outgoing: string[];
  lobby: ChatMessage[];
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export class SocialClient {
  readonly me: string;
  lobby: ChatMessage[] = [];
  /** Whisper threads, keyed by the OTHER player's lowercased name. */
  readonly dms = new Map<string, ChatMessage[]>();
  friends: FriendInfo[] = [];
  incoming: string[] = [];
  outgoing: string[] = [];
  connected = false;

  /**
   * The account logged in somewhere else and the server deleted this tab's
   * session (single-login policy). Everything after this is 401s — the
   * handler in main.ts blocks the UI and offers a reload.
   */
  onKicked: (() => void) | null = null;
  /** Matchmaker result. SSE-pushed so a closed rooms panel still hears it. */
  onMatch: ((match: MatchInfo) => void) | null = null;
  /** Party invite from a friend — same closed-panel rationale as `match`. */
  onInvite: ((invite: InviteInfo) => void) | null = null;
  /** Somebody asked to be friends — same closed-panel rationale again. */
  onFriendRequest: ((request: FriendRequestInfo) => void) | null = null;
  /** The leader launched the party — this client should enter the arena. */
  onPartyLaunch: ((info: PartyLaunchInfo) => void) | null = null;
  /** A matchmade lobby's ready dots changed — repaint the rooms panel. */
  onLobbyReady: ((info: LobbyReadyInfo) => void) | null = null;
  /** Fight-ready barrier progress — claimed by the arena scene while it waits. */
  onFightReady: ((info: FightReadyInfo) => void) | null = null;
  /** Fight-ready barrier released — the party's fight starts now. */
  onFightStart: ((info: FightStartInfo) => void) | null = null;

  private readonly es: EventSource;
  private readonly changeListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(channel: string, msg: ChatMessage) => void>();
  private readonly fightListeners = new Set<(frame: unknown) => void>();
  private readonly resultListeners = new Set<(result: unknown) => void>();

  constructor(me: string) {
    this.me = me;
    this.es = new EventSource("/api/social/stream");

    this.es.addEventListener("hello", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as HelloPayload;
      this.lobby = data.lobby.slice(-KEEP);
      this.friends = data.friends;
      this.incoming = data.incoming;
      this.outgoing = data.outgoing;
      this.connected = true;
      this.emitChange();
    });

    this.es.addEventListener("lobby", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as ChatMessage;
      this.lobby.push(msg);
      if (this.lobby.length > KEEP) this.lobby.splice(0, this.lobby.length - KEEP);
      this.emitMessage("lobby", msg);
    });

    this.es.addEventListener("dm", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as ChatMessage;
      const other = msg.from.toLowerCase() === me.toLowerCase() ? msg.to ?? "" : msg.from;
      const thread = this.thread(other);
      // The send round-trip also echoes via SSE; drop the duplicate.
      if (thread.some((m) => m.id === msg.id)) return;
      thread.push(msg);
      if (thread.length > KEEP) thread.splice(0, thread.length - KEEP);
      this.emitMessage(`dm:${other.toLowerCase()}`, msg);
    });

    // Ordered after `friends` on the wire (server/social.mjs pushes the
    // snapshot first), so by the time the card is up the roster behind it
    // already lists the request.
    this.es.addEventListener("friendRequest", (e) => {
      this.onFriendRequest?.(JSON.parse((e as MessageEvent).data) as FriendRequestInfo);
    });

    this.es.addEventListener("friends", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as Omit<HelloPayload, "lobby" | "you">;
      this.friends = data.friends;
      this.incoming = data.incoming;
      this.outgoing = data.outgoing;
      this.emitChange();
    });

    this.es.addEventListener("kicked", () => {
      // The session is already gone server-side; stop the reconnect loop so
      // the dead stream doesn't spam 401s behind the blocking overlay.
      this.connected = false;
      this.es.close();
      this.onKicked?.();
    });

    this.es.addEventListener("match", (e) => {
      this.onMatch?.(JSON.parse((e as MessageEvent).data) as MatchInfo);
    });

    this.es.addEventListener("invite", (e) => {
      this.onInvite?.(JSON.parse((e as MessageEvent).data) as InviteInfo);
    });

    this.es.addEventListener("partyLaunch", (e) => {
      this.onPartyLaunch?.(JSON.parse((e as MessageEvent).data) as PartyLaunchInfo);
    });

    this.es.addEventListener("lobbyReady", (e) => {
      this.onLobbyReady?.(JSON.parse((e as MessageEvent).data) as LobbyReadyInfo);
    });

    this.es.addEventListener("fightReady", (e) => {
      this.onFightReady?.(JSON.parse((e as MessageEvent).data) as FightReadyInfo);
    });

    this.es.addEventListener("fightStart", (e) => {
      this.onFightStart?.(JSON.parse((e as MessageEvent).data) as FightStartInfo);
    });

    // The server-authoritative fight (server/fight.mjs) at 10 Hz. It rides
    // THIS stream rather than opening its own: one EventSource per tab is the
    // contract the server counts against, and the fight is only ever open in
    // one scene at a time.
    this.es.addEventListener("fightState", (e) => {
      const frame: unknown = JSON.parse((e as MessageEvent).data);
      for (const cb of this.fightListeners) cb(frame);
    });

    // The server's payout for a fight it ran and decided. Pushed just before
    // the state frame carrying the sim's end event, so the arena has the
    // receipt in hand the moment its fight-end flow runs.
    this.es.addEventListener("fightResult", (e) => {
      const result: unknown = JSON.parse((e as MessageEvent).data);
      for (const cb of this.resultListeners) cb(result);
    });

    this.es.onerror = () => {
      this.connected = false;
      this.emitChange(); // EventSource retries by itself; just reflect state
    };
  }

  thread(other: string): ChatMessage[] {
    const key = other.toLowerCase();
    let t = this.dms.get(key);
    if (!t) this.dms.set(key, (t = []));
    return t;
  }

  /** Lobby message, or a whisper when `to` is set. Rejects with a server reason. */
  async send(body: string, to?: string): Promise<void> {
    await api("/api/social/send", to === undefined ? { body } : { body, to });
  }

  /** Pull the stored tail of a whisper thread (opening a DM tab). */
  async loadDmHistory(other: string): Promise<void> {
    const { messages } = await api<{ messages: ChatMessage[] }>(
      `/api/social/dm?with=${encodeURIComponent(other)}`
    );
    const thread = this.thread(other);
    const known = new Set(thread.map((m) => m.id));
    const merged = [...messages.filter((m) => !known.has(m.id)), ...thread].sort((a, b) => a.id - b.id);
    thread.splice(0, thread.length, ...merged.slice(-KEEP));
    this.emitChange();
  }

  async friendOp(op: "request" | "accept" | "decline" | "remove", username: string): Promise<void> {
    // The SSE `friends` event delivers the fresh snapshot; nothing to do here.
    await api("/api/social/friend", { op, username });
  }

  /**
   * File a moderation report — a specific message (by id) or a player (by
   * name). The server snapshots the message body into the report, so it
   * survives chat pruning; admins act on it in the console.
   */
  async report(opts: { messageId?: number; username?: string; reason: string }): Promise<void> {
    await api("/api/social/report", opts);
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onMessage(cb: (channel: string, msg: ChatMessage) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  /**
   * Subscribe to the arena's `fightState` frames. Untyped here on purpose:
   * chat has no business knowing the fight's wire shape, and the arena's
   * remote driver (fight/fightDriver.ts) owns that type.
   */
  onFightState(cb: (frame: unknown) => void): () => void {
    this.fightListeners.add(cb);
    return () => this.fightListeners.delete(cb);
  }

  /** The settlement for a server-run fight. Untyped for the same reason. */
  onFightResult(cb: (result: unknown) => void): () => void {
    this.resultListeners.add(cb);
    return () => this.resultListeners.delete(cb);
  }

  dispose(): void {
    this.es.close();
  }

  private emitChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  private emitMessage(channel: string, msg: ChatMessage): void {
    for (const cb of this.messageListeners) cb(channel, msg);
    this.emitChange();
  }
}
