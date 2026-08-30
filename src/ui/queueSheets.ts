/**
 * The three sheets behind the Boss Arena panel's three doors — Solo Queue,
 * Team Queue, Practice.
 *
 * Split out of roomsPanel.ts because the panel's job is now small and blunt:
 * show the boss, show three buttons, and show whatever state you are already
 * in. Everything you might *configure* lives here, one sheet per verb, and is
 * only ever on screen because you asked for it.
 *
 * Sheets are mounted by the panel INSIDE its card, over the body — not as a
 * new top-level overlay. That keeps the z-index ladder (dock 30 / rooms 40 /
 * bossGuide 60 / …) untouched, keeps the panel ids in panelChrome.ts alone,
 * and — the load-bearing reason — puts these `<input>`s outside the element
 * the 2.5 s poll rebuilds, so a refresh can never eat a half-typed room name.
 *
 * Styling: no styles here. Every class is namespaced under `#rooms` in
 * roomsPanel.ts's single injected stylesheet, per house convention.
 */

import {
  DIFFICULTY,
  DIFFICULTY_ORDER,
  getDifficulty,
  setDifficulty,
  type FightDifficulty,
} from "../fight/difficulty";
import { getPracticeDifficulty, setPracticeDifficulty } from "../fight/practice";

// ---------------------------------------------------------------------------
// The /api/lobby payload. Defined here rather than in roomsPanel so the
// dependency runs one way only: the panel imports the sheets, never the other
// way round.
// ---------------------------------------------------------------------------

export interface Member {
  username: string;
  rank: string;
  hero: string;
  isHost: boolean;
  /** Lobby ready-check flag. Matchmade rooms only — see roomsPanel's roomView. */
  ready?: boolean;
}

export interface MyRoom {
  id: number;
  name: string;
  isPublic: boolean;
  locked: boolean;
  isHost: boolean;
  capacity: number;
  difficulty?: string;
  /**
   * Built by the matchmaker, so its host_id is just whoever queued first and
   * nobody consented to being led. Starts on a unanimous ready-check instead.
   */
  matchmade?: boolean;
  readyCount?: number;
  /** Whether WE have pressed ready — the count alone cannot tell us. */
  youReady?: boolean;
  members: Member[];
}

export interface RoomSummary {
  id: number;
  name: string;
  host: string;
  players: number;
  capacity: number;
  locked: boolean;
  /** Chosen at creation, shown in the browser row. */
  difficulty?: string;
  /** Member roles in seat order ("tank" | "healer" | "dps"). */
  roles?: string[];
}

export interface Invite {
  roomId: number;
  roomName: string;
  from: string;
}

export interface Friend {
  username: string;
  rank: string;
  status: "party" | "in-room" | "queued" | "idle";
  invited: boolean;
}

export interface Lobby {
  queued: boolean;
  /** Queued together with the room below (host queued everyone). */
  partyQueued: boolean;
  /** Which difficulty pool we are waiting in; null when not queued. */
  queueDifficulty?: string | null;
  /** Headcount of MY pool while queued, of the whole queue while idle. */
  queueSize: number;
  /** Per-pool headcounts, so the picker can show what it costs to be picky. */
  queueCounts?: Record<string, number>;
  /** Role census of my pool — names the missing trio seat. */
  queueRoles?: { tank: number; healer: number; dps: number };
  room: MyRoom | null;
  rooms: RoomSummary[];
  invites: Invite[];
  friends: Friend[];
}

/** What a sheet needs from the panel that owns it. */
export interface SheetDeps {
  /** Latest lobby state at build time. */
  state: Lobby;
  /** POST then repaint; the panel surfaces any error in its own error line. */
  act: (path: string, body: unknown) => void;
  /** Dismiss this sheet. */
  close: () => void;
  /** Shut the whole panel and walk into the practice arena. */
  enterPractice: () => void;
}

/** A mounted sheet. `update` lets live data repaint without losing focus. */
export interface Sheet {
  node: HTMLElement;
  /** Called on every poll with fresh state, if the sheet shows live data. */
  update?: (state: Lobby) => void;
}

export const ROLE_GLYPH: Record<string, string> = { tank: "🛡", healer: "✚", dps: "⚔" };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** The sheet shell: a titled panel with a Back affordance. */
function shell(title: string, close: () => void, ...children: (Node | string)[]): HTMLElement {
  const back = el("button", { class: "mini ghost", type: "button" }, "← back");
  back.addEventListener("click", close);
  return el(
    "div",
    { class: "sheet" },
    el("div", { class: "sheethead" }, back, el("h2", {}, title)),
    el("div", { class: "sheetbody" }, ...children)
  );
}

/**
 * The Standard/Hard/Nightmare segment.
 *
 * `counts` is the per-pool wait list. It only appears on the ranked queue,
 * where being picky has a real price: the matchmaker never groups across
 * difficulties, so choosing Nightmare with nobody else in it means waiting out
 * the timeout alone. Better to show that number than to let it be a mystery.
 */
function diffSeg(
  get: () => FightDifficulty,
  set: (d: FightDifficulty) => void,
  counts?: Record<string, number>
): HTMLElement {
  const seg = el("div", { class: "seg" });
  const btns = new Map<FightDifficulty, HTMLButtonElement>();
  for (const d of DIFFICULTY_ORDER) {
    const label = el("span", { class: "lbl" }, DIFFICULTY[d].label);
    const kids: (Node | string)[] = [label];
    if (counts) {
      const n = counts[d] ?? 0;
      kids.push(el("span", { class: "cnt" }, n === 1 ? "1 waiting" : `${n} waiting`));
    }
    const b = el(
      "button",
      {
        type: "button",
        title: `boss HP ×${DIFFICULTY[d].hpMult}, boss damage ×${DIFFICULTY[d].dmgMult}`,
      },
      ...kids
    ) as HTMLButtonElement;
    b.addEventListener("click", () => {
      set(d);
      for (const [k, btn] of btns) btn.classList.toggle("on", k === d);
    });
    b.classList.toggle("on", d === get());
    btns.set(d, b);
    seg.append(b);
  }
  return seg;
}

// ---------------------------------------------------------------------------
// Solo queue
// ---------------------------------------------------------------------------

/**
 * Pick a difficulty, then queue. The choice is sent to the server and rides on
 * the queue row: unlike the old panel-wide selector, it now decides who you
 * can be matched WITH, not just what your own client renders.
 */
export function soloQueueSheet({ state, act, close }: SheetDeps): Sheet {
  let picked = getDifficulty();
  const seg = diffSeg(
    () => picked,
    (d) => {
      picked = d;
      // Keep the local setting in step so a later solo entry, or a room we
      // create next, starts from the thing we just said we wanted.
      setDifficulty(d);
    },
    state.queueCounts
  );

  const go = el("button", { class: "cta big", type: "button" }, "⚡ Enter Queue");
  go.addEventListener("click", () => {
    act("/api/queue/join", { difficulty: picked });
    close();
  });

  return {
    node: shell(
      "Solo Queue",
      close,
      el("div", { class: "cap" }, "Difficulty"),
      seg,
      go,
      el("div", { class: "hint" }, "You will only match with players who picked the same setting."),
      el(
        "div",
        { class: "hint" },
        "Matched theorists fight ONE Nightmare together — one health pool, one Mark board, and heals that land on each other."
      )
    ),
  };
}

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------

/**
 * Practice keeps its own difficulty and its own storage key (fight/practice.ts)
 * on purpose: the bots are calibrated to carry a Standard learning run and lose
 * Hard outright, and a ranked Nightmare choice must never silently follow you
 * into one.
 */
export function practiceSheet({ close, enterPractice }: SheetDeps): Sheet {
  const seg = diffSeg(getPracticeDifficulty, setPracticeDifficulty);
  const go = el("button", { class: "cta big", type: "button" }, "🎯 Enter Practice");
  go.addEventListener("click", enterPractice);

  return {
    node: shell(
      "Practice",
      close,
      el("div", { class: "cap" }, "Difficulty"),
      seg,
      go,
      el(
        "div",
        { class: "hint" },
        "The other two theorists fill in as bots — +10 ◈ per run, up to 50 ◈ a day. No ranked record, no entry cost."
      ),
      el("div", { class: "hint" }, "The bots are tuned for Standard.")
    ),
  };
}

// ---------------------------------------------------------------------------
// Team queue — invitations, create a room, browse open rooms
// ---------------------------------------------------------------------------

/**
 * Everything about playing with people you chose. The three sections are
 * ordered by how likely they are to be what you came for: an invitation
 * waiting for you, then making your own room, then browsing.
 *
 * `update` repaints only the invitations and the open-rooms list. The create
 * form is built once and never touched by a poll — it holds the caret.
 */
export function teamQueueSheet({ state, act, close }: SheetDeps): Sheet {
  const invitesBox = el("div", { class: "stack" });
  const listBox = el("div", { class: "roomslist" });

  const paintInvites = (s: Lobby): void => {
    if (s.invites.length === 0) {
      invitesBox.replaceChildren();
      return;
    }
    const rows: (Node | string)[] = [el("h2", {}, "Invitations")];
    for (const i of s.invites) {
      rows.push(
        el(
          "div",
          { class: "row" },
          el(
            "div",
            { class: "grow" },
            el("div", { class: "nm" }, i.roomName),
            el("div", { class: "meta" }, `invited by ${i.from}`)
          ),
          el("button", { class: "mini", type: "button", "data-accept": String(i.roomId) }, "join"),
          el("button", { class: "mini ghost", type: "button", "data-decline": String(i.roomId) }, "✕")
        )
      );
    }
    invitesBox.replaceChildren(...rows);
  };

  const paintRooms = (s: Lobby): void => {
    // Never rebuild under the caret: a password typed into one row's input
    // must survive the poll that repaints the row beside it.
    const focus = document.activeElement;
    if (focus instanceof HTMLInputElement && listBox.contains(focus)) return;
    const scroll = listBox.scrollTop;
    const rows: (Node | string)[] = [];
    if (s.rooms.length === 0) {
      rows.push(el("div", { class: "empty" }, "no open rooms — make one above"));
    }
    for (const r of s.rooms) {
      const full = r.players >= r.capacity;
      const glyphs = (r.roles ?? []).map((x) => ROLE_GLYPH[x] ?? "·").join("");
      const tags: (Node | string)[] = [];
      const rd = r.difficulty ?? "standard";
      if (DIFFICULTY[rd as FightDifficulty]) {
        tags.push(
          el(
            "span",
            { class: `tag${rd !== "standard" ? " gold" : ""}` },
            DIFFICULTY[rd as FightDifficulty].label
          )
        );
      }
      if (r.locked) tags.push(el("span", { class: "tag gold" }, "🔒"));

      const row = el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "grow" },
          el("div", { class: "nm" }, r.name),
          el("div", { class: "meta" }, `${r.host} — ${r.players}/${r.capacity}${glyphs ? ` · ${glyphs}` : ""}`)
        ),
        ...tags
      );
      if (full) {
        const btn = el("button", { class: "mini", type: "button" }, "full") as HTMLButtonElement;
        btn.disabled = true;
        row.append(btn);
      } else if (r.locked) {
        // Locked rooms take the password inline — a second dialog for one
        // field is a worse trade than a cramped row.
        const pw = el("input", {
          class: "pw",
          type: "password",
          placeholder: "password",
          autocomplete: "off",
        }) as HTMLInputElement;
        const go = el("button", { class: "mini", type: "button" }, "→");
        go.addEventListener("click", () => act("/api/rooms/join", { roomId: r.id, password: pw.value }));
        pw.addEventListener("keydown", (e) => {
          if (e.key === "Enter") go.click();
        });
        row.append(pw, go);
      } else {
        row.append(el("button", { class: "mini", type: "button", "data-join": String(r.id) }, "join"));
      }
      rows.push(row);
    }
    listBox.replaceChildren(...rows);
    listBox.scrollTop = scroll;
  };

  // Create a room. Built once; the poll never rebuilds it.
  let roomDiff = getDifficulty();
  const nameIn = el("input", { class: "full", placeholder: "room name", maxlength: "32" }) as HTMLInputElement;
  const passIn = el("input", { placeholder: "password (optional)", autocomplete: "off" }) as HTMLInputElement;
  const pub = el("input", { type: "checkbox" }) as HTMLInputElement;
  pub.checked = true;
  const form = el(
    "form",
    { class: "create" },
    nameIn,
    passIn,
    el("label", { class: "chk" }, pub, "list publicly"),
    el("button", { class: "cta full", type: "submit" }, "Create Room")
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    act("/api/rooms/create", {
      name: nameIn.value,
      password: passIn.value,
      isPublic: pub.checked,
      difficulty: roomDiff,
    });
    close();
  });

  const node = shell(
    "Team Queue",
    close,
    invitesBox,
    el(
      "div",
      { class: "stack" },
      el("h2", {}, "Create a room"),
      el("div", { class: "cap" }, "Difficulty"),
      diffSeg(
        () => roomDiff,
        (d) => {
          roomDiff = d;
          setDifficulty(d);
        }
      ),
      form,
      // Doc 02's rule, restated at the door: comp is advised, never gated.
      el(
        "div",
        { class: "hint" },
        "Any comp can play · the room reminds you if a tank or healer is missing, but never blocks."
      )
    ),
    el("div", { class: "stack" }, el("h2", {}, "Open rooms"), listBox)
  );

  node.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.join) act("/api/rooms/join", { roomId: Number(t.dataset.join) });
    if (t.dataset.accept) act("/api/rooms/join", { roomId: Number(t.dataset.accept) });
    if (t.dataset.decline) act("/api/invites/decline", { roomId: Number(t.dataset.decline) });
  });

  paintInvites(state);
  paintRooms(state);

  return {
    node,
    update: (s) => {
      paintInvites(s);
      paintRooms(s);
    },
  };
}
