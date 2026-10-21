/**
 * Boss Arena panel — opened by tapping the plaza portal, the group-up point in
 * front of the arena.
 *
 * Three doors, and nothing else on the front page: Solo Queue, Team Queue,
 * Practice. Each opens a sheet (ui/queueSheets.ts) mounted over this card;
 * everything you might configure lives there, and only because you asked.
 *
 * The rule this panel is built around: ONE entry verb visible at a time. The
 * old panel showed up to four buttons that all read as "start the fight" and
 * meant four different things — a party launch, a private launch that left
 * your teammates queued and waiting, a dequeue-and-enter, and practice. What
 * you see now depends entirely on where you already are:
 *
 *   nothing yet        → the three doors
 *   in the solo queue  → the searching card (leave, or give up and go alone)
 *   in a matchmade room→ ready dots; the last press launches everyone
 *   in a team room     → the leader's Start, at full strength only
 *
 * Same plain-DOM discipline as authFlow.ts: markup, styles and fetch calls all
 * live in this module, nothing touches a scene. Server contract:
 * server/app.mjs (/api/lobby and the /api/rooms|queue|invites routes). The
 * panel POLLS /api/lobby every 2.5 s while open — the account API is not a
 * realtime channel; when the Colyseus hub server lands (docs/06) this poll is
 * exactly what it replaces. The one exception is the `lobbyReady` SSE push,
 * which pokes refreshRoomsPanel() so a teammate's ready dot lands now rather
 * than up to 2.5 s from now.
 *
 * Banner: public/assets/ui/rooms/banner.webp — generated 2026-08-01 via
 * tools/civitai-gen.mjs (gpt-image-2 engine), prompt in docs/design-prompts.md
 * spirit: the plaza portal as concept art.
 */

import { DIFFICULTY, setDifficulty, getDifficulty, type FightDifficulty } from "../fight/difficulty";
import { compReminder } from "@shared/teamComp";
import { heroById } from "@shared/heroes";
import { openBossGuide } from "./bossGuide";
import {
  soloQueueSheet,
  teamQueueSheet,
  practiceSheet,
  type Lobby,
  type Sheet,
  type SheetDeps,
} from "./queueSheets";
import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER,
  WOW_ROW, WOW_INPUT, WOW_INPUT_FOCUS, WOW_GOLD_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

export interface RoomsPanelOptions {
  /**
   * Called when the player gives up on matchmaking and enters alone. The panel
   * closes first. This is the ONLY client-local entry left — every other way
   * in goes through the server so the whole party moves together.
   */
  onEnterArena?: () => void;
  /**
   * Called when the player enters practice. The panel closes first; the
   * handler sets the practice flag (fight/practice.ts) and skips the arena
   * admission gate — practice runs are free to enter.
   */
  onEnterPractice?: () => void;
}

const POLL_MS = 2500;

/**
 * The one options source of truth. villageHub configures this once (the arena
 * hand-off), so every opener — the plaza portal tap, the left-dock queue
 * button — opens the same panel with the same behaviour.
 */
let configured: RoomsPanelOptions = {};

/** Set the shared panel options once, before any opener can fire. */
export function configureRoomsPanel(opts: RoomsPanelOptions): void {
  configured = opts;
}

/** The open panel's close fn, so the dock's queue button can toggle it shut. */
let closeActive: (() => void) | null = null;

/** The open panel's refresh fn, so an out-of-band change (an invite accepted
 *  from the popup) repaints it now instead of on the next 2.5 s poll. */
let refreshActive: (() => void) | null = null;

/**
 * Accept an invitation from outside the panel (the invite popup). Rejects
 * with the server's message — "Room is full.", "That room is gone." — so the
 * caller can show it. Repaints an open panel on success.
 */
export async function joinRoom(roomId: number): Promise<void> {
  await api<Lobby>("/api/rooms/join", { roomId });
  refreshActive?.();
}

/** Drop an invitation from outside the panel (the invite popup). */
export async function declineInvite(roomId: number): Promise<void> {
  await api<Lobby>("/api/invites/decline", { roomId });
  refreshActive?.();
}

/**
 * Repaint an open panel from outside — for a change another player made that
 * arrived over SSE (a ready dot flipping). No-op when the panel is shut.
 */
export function refreshRoomsPanel(): void {
  refreshActive?.();
}

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeRoomsPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

const CSS = `
#rooms {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; padding: 18px 10px;
}
#rooms .card {
  /* margin:auto on a grid item centres it WITHOUT the place-items:center clip:
     when the card is taller than the viewport the top still scrolls into view.
     position:relative anchors the sheet, which covers the body below. */
  margin: auto; position: relative;
  width: min(680px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#rooms .banner { position: relative; }
#rooms .banner img { display: block; width: 100%; aspect-ratio: 3 / 1; object-fit: cover; }
#rooms .banner .shade {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, transparent 55%, #0b0804f6 100%);
}
#rooms .banner .title {
  position: absolute; left: 16px; right: 48px; bottom: 10px;
  display: flex; flex-direction: column; gap: 4px;
}
#rooms .banner h1 {
  margin: 0; font-size: 18px; letter-spacing: .3em; font-weight: 700;
  ${WOW_GOLD_TEXT} filter: drop-shadow(0 2px 8px #000);
}
#rooms .banner .sub {
  font-size: 10px; letter-spacing: .18em; color: ${WOW_TEXT_DIM};
  text-shadow: 0 1px 6px #000;
}
/* The guide rides in the banner's TOP corner beside the close button: it is
   something you read once before your first pull, not a step in queueing, so
   it must not sit among the doors — and the sky is the only part of the art
   with nothing in it. Bottom-right would sit on the boss's own blurb. */
#rooms .banner button.guide {
  position: absolute; top: 8px; right: 48px; z-index: 1; height: 32px;
  padding: 0 10px; font-size: 10px; letter-spacing: .1em; white-space: nowrap;
  ${WOW_BTN}
}
#rooms .banner button.guide:hover { ${WOW_BTN_HOVER} }
#rooms .close {
  position: absolute; top: 8px; right: 8px; width: 32px; height: 32px;
  font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#rooms .close:hover { ${WOW_BTN_HOVER} }
#rooms .body { padding: 18px 16px 20px; display: grid; gap: 16px; }
#rooms .stack { display: grid; gap: 8px; }
#rooms h2 {
  margin: 0; font-size: 12px; letter-spacing: .3em; color: ${WOW_TEXT_DIM};
  font-weight: 700; text-transform: uppercase;
}
/* Above both the body and any sheet, and gone entirely when there is nothing
   to say — a permanently reserved 16px under the banner reads as a gap. */
#rooms .err { color: #ff8896; font-size: 12px; padding: 10px 16px 0; text-align: center; }
#rooms .err:empty { display: none; }
#rooms .row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  ${WOW_ROW}
}
#rooms .row .grow { flex: 1; min-width: 0; }
#rooms .row .nm { letter-spacing: .05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#rooms .row .meta { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .9; }
#rooms .tag {
  font-size: 9px; letter-spacing: .18em; text-transform: uppercase;
  border: 1px solid #5a4620; border-radius: 0; padding: 1px 6px; color: ${WOW_TEXT_DIM};
}
#rooms .tag.gold { color: #ecc363; border-color: #ecc36366; }
#rooms button.cta { ${WOW_CTA} padding: 10px 14px; }
#rooms button.cta.big { width: 100%; padding: 12px; letter-spacing: .3em; text-indent: .3em; }
#rooms button.cta.warm {
  background: linear-gradient(180deg, #7a4a16, #4e2c0e 55%, #331c08);
}
#rooms button.cta:hover:not(:disabled) { ${WOW_CTA_HOVER} }
#rooms button.cta:disabled { opacity: .35; cursor: default; }
#rooms button.mini {
  padding: 6px 10px; font-size: 11px; white-space: nowrap;
  ${WOW_BTN}
}
#rooms button.mini:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#rooms button.mini:disabled { opacity: .4; cursor: default; }
#rooms button.mini.ghost { background: none; border-color: transparent; box-shadow: none; opacity: .6; }
#rooms button.mini.ghost:hover { opacity: 1; border-color: transparent; }
#rooms input {
  padding: 9px 11px; min-width: 0;
  ${WOW_INPUT}
}
#rooms input:focus { ${WOW_INPUT_FOCUS} }
#rooms input.pw { max-width: 110px; }
#rooms form.create { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
#rooms form.create .full { grid-column: 1 / -1; }
#rooms label.chk {
  display: flex; align-items: center; gap: 8px; font-size: 12px; color: ${WOW_TEXT_DIM};
  user-select: none; cursor: pointer;
}
#rooms .slot {
  border: 1px dashed #5a4620; border-radius: 0; padding: 8px 10px;
  font-size: 12px; color: ${WOW_TEXT_DIM}; opacity: .7; text-align: center;
}

/* ---- The three doors ----------------------------------------------------
   One button per verb, each big enough to be the only thing you need to read.
   The sub-line carries the promise; the badge carries anything waiting. */
#rooms .home { display: grid; gap: 10px; }
#rooms button.door {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 14px 16px; font: inherit; cursor: pointer;
  ${WOW_CTA}
}
#rooms button.door:hover { ${WOW_CTA_HOVER} }
#rooms button.door .ico { font-size: 20px; line-height: 1; flex: none; }
#rooms button.door .lines { flex: 1; min-width: 0; display: grid; gap: 2px; }
#rooms button.door .t { font-size: 13px; letter-spacing: .22em; text-transform: uppercase; }
#rooms button.door .s {
  font-size: 11px; letter-spacing: .04em; color: #d9c9a8; opacity: .75;
  text-transform: none; white-space: normal;
}
#rooms button.door .badge {
  flex: none; font-size: 10px; letter-spacing: .1em; padding: 2px 7px;
  border: 1px solid #ecc36366; color: #ecc363;
}

/* ---- Sheets -------------------------------------------------------------
   A sheet REPLACES the body in normal flow rather than covering it: the card
   then grows to fit whatever the sheet holds, so a long open-rooms list is
   never clipped to the height of the three doors behind it. The body is only
   hidden, not rebuilt — and the sheet's inputs live outside the element the
   2.5 s poll replaces, which is what keeps a half-typed room name safe. */
#rooms .card.sheeted > .body { display: none; }
#rooms .sheet { display: flex; flex-direction: column; animation: roomsSheet .16s ease-out; }
@keyframes roomsSheet { from { opacity: 0; transform: translateY(6px); } }
#rooms .sheethead {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 12px 14px; border-bottom: 1px solid #3d3115;
}
#rooms .sheetbody { padding: 14px 16px 20px; display: grid; gap: 12px; align-content: start; }
#rooms .cap {
  font-size: 10px; letter-spacing: .22em; color: ${WOW_TEXT_DIM};
  text-transform: uppercase; text-align: center;
}
#rooms .seg { display: flex; border: 1px solid #5a4620; border-radius: 0; overflow: hidden; }
#rooms .seg button {
  flex: 1; background: #120d05; color: ${WOW_TEXT_DIM}; border: none; padding: 8px 10px;
  font: inherit; font-size: 11px; letter-spacing: .1em; cursor: pointer;
  display: grid; gap: 2px; justify-items: center;
}
#rooms .seg button + button { border-left: 1px solid #5a4620; }
#rooms .seg button.on { background: linear-gradient(180deg, #8c2014, #55100a); color: #ffe9b0; }
#rooms .seg button:hover { filter: brightness(1.25); }
#rooms .seg .cnt { font-size: 9px; letter-spacing: .06em; opacity: .65; }

/* ---- Queue / room state -------------------------------------------------- */
#rooms .queuebox { display: grid; gap: 10px; justify-items: center; padding: 6px 0 2px; }
#rooms .queuebox button.cta { width: 100%; }
#rooms .queuebox .pulse { font-size: 12px; color: #ecc363; letter-spacing: .12em; animation: roomsPulse 1.6s ease-in-out infinite; }
@keyframes roomsPulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
#rooms .sect {
  width: 100%; text-align: center; font-size: 10px; letter-spacing: .22em;
  color: ${WOW_TEXT_DIM}; text-transform: uppercase;
  display: flex; align-items: center; gap: 10px;
}
#rooms .sect::before, #rooms .sect::after { content: ""; flex: 1; border-top: 1px solid #3d3115; }
/* The ready dot. Dim ring until they press, then a lit green pip — readable at
   a glance across three rows, which is the whole point of a ready check. */
#rooms .dot {
  flex: none; width: 10px; height: 10px; border-radius: 50%;
  border: 1px solid #5a4620; background: #14100a;
}
#rooms .dot.on {
  border-color: #7ee08a; background: #4cd964;
  box-shadow: 0 0 7px #4cd96499;
}
#rooms .hint { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .8; letter-spacing: .06em; text-align: center; }
#rooms .empty { font-size: 12px; color: ${WOW_TEXT_DIM}; opacity: .7; text-align: center; padding: 6px; }
/* The open-rooms list can run to 20 rows, so it scrolls inside the sheet. */
#rooms .roomslist { display: grid; gap: 8px; max-height: 46vh; overflow-y: auto; padding-right: 2px; }
/* Phones: the panel goes full-screen — a floating card wastes the one thing a
   small screen does not have. The card itself scrolls (overflow-y: auto);
   there is no visible backdrop left, so closing is ✕ / Escape. */
@media (pointer: coarse), (max-width: 640px) {
  #rooms { font-size: 12px; padding: 0; }
  #rooms .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    /* Safe-area: keep full-bleed card content clear of the iPhone camera housing. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
    overflow-y: auto;
  }
  #rooms .banner img { aspect-ratio: 4 / 1; }
  #rooms .banner .title { left: 12px; right: 44px; bottom: 6px; gap: 2px; }
  #rooms .banner h1 { font-size: 13px; }
  #rooms .banner .sub { font-size: 9px; }
  #rooms .close { width: 26px; height: 26px; font-size: 13px; }
  #rooms .body { padding: 10px 10px 12px; gap: 10px; }
  #rooms h2 { font-size: 10px; }
  #rooms .row { padding: 5px 8px; gap: 8px; }
  #rooms button.cta { padding: 7px 10px; letter-spacing: .16em; }
  #rooms button.cta.big { padding: 8px; letter-spacing: .22em; }
  #rooms button.door { padding: 10px 12px; gap: 10px; }
  #rooms button.door .ico { font-size: 17px; }
  #rooms button.door .t { font-size: 12px; letter-spacing: .16em; }
  #rooms button.door .s { font-size: 10px; }
  #rooms button.mini { padding: 4px 8px; font-size: 11px; }
  #rooms input { padding: 6px 8px; }
  #rooms .queuebox { gap: 7px; padding: 2px 0 0; }
  #rooms .sheethead { padding: 9px 10px; }
  #rooms .sheetbody { padding: 10px 10px 14px; gap: 9px; }
  /* The card already scrolls full-screen here, so the list rides the page
     rather than trapping a second scroll region inside it. */
  #rooms .roomslist { max-height: none; }
}
`;

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

/** A door on the home view: icon, title, promise, optional waiting-count badge. */
function door(ico: string, title: string, sub: string, badge?: string): HTMLButtonElement {
  const kids: (Node | string)[] = [
    el("span", { class: "ico" }, ico),
    el("span", { class: "lines" }, el("span", { class: "t" }, title), el("span", { class: "s" }, sub)),
  ];
  if (badge) kids.push(el("span", { class: "badge" }, badge));
  return el("button", { class: "door", type: "button" }, ...kids) as HTMLButtonElement;
}

const diffLabel = (d?: string): string =>
  DIFFICULTY[(d ?? "standard") as FightDifficulty]?.label ?? "Standard";

/**
 * Open the panel. Idempotent — a second tap while it is up does nothing.
 * Closes on ✕, backdrop click, or Escape; the poll timer dies with it.
 */
export function openRoomsPanel(opts: RoomsPanelOptions = configured): void {
  if (document.getElementById("rooms")) return;
  if (!document.getElementById("rooms-css")) {
    document.head.append(el("style", { id: "rooms-css" }, CSS));
  }

  const err = el("div", { class: "err" });
  const content = el("div", {});
  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");

  const guideBtn = el(
    "button",
    { class: "guide", type: "button", title: "Read up on NIGHTMARE before you pull" },
    "📖 Know Your Enemy"
  );
  guideBtn.addEventListener("click", () => openBossGuide());

  const card = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "banner" },
      el("img", { src: "/assets/ui/rooms/banner.webp", alt: "The plaza portal" }),
      el("div", { class: "shade" }),
      el(
        "div",
        { class: "title" },
        el("h1", {}, "BOSS ARENA"),
        el(
          "div",
          { class: "sub" },
          "The Nightmare — living residue of every repressed desire; it fears the Analyst above all."
        )
      ),
      guideBtn,
      close
    ),
    // The error line sits OUTSIDE the body, because a sheet hides the body and
    // the errors a sheet provokes — "Room is full.", "Wrong room password." —
    // are exactly the ones you must be able to read while it is open.
    err,
    el("div", { class: "body" }, content)
  );
  const overlay = el("div", { id: "rooms" }, card);

  let timer = 0;
  const shut = (): void => {
    window.clearInterval(timer);
    window.removeEventListener("keydown", onKey);
    closeActive = null;
    refreshActive = null;
    overlay.remove();
  };
  closeActive = shut;

  // ---- Sheets -------------------------------------------------------------
  // At most one is up at a time. It covers the body, so the state underneath
  // keeps polling and is correct the moment the sheet closes.
  let sheet: Sheet | null = null;
  const closeSheet = (): boolean => {
    if (!sheet) return false;
    sheet.node.remove();
    card.classList.remove("sheeted");
    sheet = null;
    return true;
  };
  const openSheet = (build: (deps: SheetDeps) => Sheet): void => {
    if (!current) return;
    closeSheet();
    err.textContent = "";
    sheet = build({
      state: current,
      act: (path, body) => void act(path, body),
      close: closeSheet,
      enterPractice: () => {
        shut();
        opts.onEnterPractice?.();
      },
    });
    card.append(sheet.node);
    card.classList.add("sheeted");
  };

  const onKey = (e: KeyboardEvent): void => {
    // The boss guide stacks on top of this panel and eats its own Escape in
    // the capture phase; this guard is the belt to that suspenders, so one
    // press can never close both.
    if (document.getElementById("boss-guide")) return;
    if (e.key !== "Escape") return;
    // A sheet is the innermost thing on screen, so it goes first.
    if (closeSheet()) return;
    shut();
  };
  // Ghost-click guard. The panel opens on the scene's POINTERUP (the portal
  // tap); on touch the browser then hit-tests a synthetic `click` at the
  // release point — which now sits under the just-opened overlay — and the
  // backdrop handler ate it, closing the panel in the same gesture (the
  // "panel flashes and never opens" report). Ignore pointer-driven closes for
  // a beat after open. Escape is unaffected: no ghost key events exist.
  const openedAt = performance.now();
  const GHOST_MS = 350;
  const ghostShut = (): void => {
    if (performance.now() - openedAt < GHOST_MS) return;
    if (closeSheet()) return;
    shut();
  };
  close.addEventListener("click", ghostShut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) ghostShut();
  });
  window.addEventListener("keydown", onKey);

  // Every mutation returns the fresh lobby, so the UI answers immediately and
  // the poll only has to catch what OTHER players change.
  const act = async (path: string, body: unknown): Promise<void> => {
    err.textContent = "";
    try {
      render(await api<Lobby>(path, body), true);
    } catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : "Something went wrong.";
    }
  };

  let lastSig = "";
  const refresh = async (): Promise<void> => {
    try {
      render(await api<Lobby>("/api/lobby"));
    } catch (ex) {
      // A 401 here means the session died under us — nothing the panel can fix.
      err.textContent = ex instanceof Error ? ex.message : "Lobby unavailable.";
    }
  };
  refreshActive = () => void refresh();

  let current: Lobby | null = null;

  function render(state: Lobby, force = false): void {
    const sig = JSON.stringify(state);
    if (sig === lastSig) return;
    // Never let the POLL rebuild under the player's caret. The sheets keep
    // their own inputs outside `content` precisely so this stays a narrow
    // guard rather than a running battle.
    const focus = document.activeElement;
    if (!force && focus instanceof HTMLInputElement && content.contains(focus)) return;
    lastSig = sig;
    current = state;
    content.replaceChildren(
      state.room ? roomView(state) : state.queued ? searchingView(state) : homeView(state)
    );
    // A sheet showing live data (open rooms, invitations) patches in place —
    // it is never torn down by a poll.
    sheet?.update?.(state);
    // Landing in a room means the matchmaker found us, or we just created or
    // joined one: whatever sheet was up has been answered.
    if (state.room) closeSheet();
  }

  // ---- Nothing yet: the three doors ---------------------------------------
  function homeView(state: Lobby): HTMLElement {
    const solo = door("⚡", "Solo Queue", "Quick match into a three-stack.");
    solo.addEventListener("click", () => openSheet(soloQueueSheet));

    const openCount = state.rooms.length;
    const team = door(
      "🛡",
      "Team Queue",
      openCount > 0 ? `Make a room, or join one of ${openCount} open.` : "Make a room and invite your friends.",
      state.invites.length > 0 ? `${state.invites.length} invite${state.invites.length > 1 ? "s" : ""}` : undefined
    );
    team.addEventListener("click", () => openSheet(teamQueueSheet));

    const prac = door("🎯", "Practice", "Fight with bots. No stakes, no record.");
    prac.addEventListener("click", () => openSheet(practiceSheet));

    return el("div", { class: "home" }, solo, team, prac);
  }

  // ---- In the solo queue: one card, one primary action --------------------
  function searchingView(state: Lobby): HTMLElement {
    const wrap = el("div", { class: "queuebox" });
    // The matchmaker starts a trio the moment 1 tank + 1 healer + 1 dps are
    // waiting (server matchQueue), so name the seat that is missing instead of
    // a bare headcount. Both numbers describe OUR difficulty pool only — the
    // pools never match across each other.
    const qr = state.queueRoles;
    const missing = qr ? (["tank", "healer", "dps"] as const).filter((r) => qr[r] === 0) : [];
    const detail = !qr
      ? `${state.queueSize} waiting`
      : missing.length === 0
        ? "tank ✓ · healer ✓ · dps ✓ — matching…"
        : `${state.queueSize} waiting · need ${missing.join(" + ")}`;

    const leave = el("button", { class: "mini", type: "button" }, "leave queue");
    leave.addEventListener("click", () => void act("/api/queue/leave", {}));

    // The escape hatch, and the only client-local entry in the panel. Small and
    // explicit on purpose: doc 01 promises a solo run is always possible, but
    // it must never compete with waiting for a real party.
    const alone = el("button", { class: "mini ghost", type: "button" }, "fight alone instead");
    alone.addEventListener("click", () => {
      void api("/api/queue/leave", {}).catch(() => undefined);
      shut();
      opts.onEnterArena?.();
    });

    wrap.append(
      el("div", { class: "sect" }, `Searching — ${diffLabel(state.queueDifficulty ?? undefined)}`),
      el("div", { class: "pulse" }, detail),
      leave,
      alone,
      el("div", { class: "hint" }, "You only match with players who picked the same difficulty.")
    );
    return wrap;
  }

  // ---- In a room: party, then exactly one way in --------------------------
  function roomView(state: Lobby): HTMLElement {
    const room = state.room!;
    const wrap = el("div", { class: "body", style: "padding:0" });
    const matchmade = !!room.matchmade;
    const full = room.members.length >= room.capacity;

    const badges: (Node | string)[] = [];
    if (matchmade) badges.push(el("span", { class: "tag gold" }, "matched"));
    else badges.push(el("span", { class: "tag" }, room.isPublic ? "public" : "invite-only"));
    if (room.locked) badges.push(el("span", { class: "tag gold" }, "🔒 password"));
    // The room's difficulty is the contract. Members' local difficulty follows
    // it so the arena they enter matches the door they walked through; the
    // host's own choice already made it.
    const roomDiff = (room.difficulty ?? "standard") as FightDifficulty;
    if (DIFFICULTY[roomDiff]) {
      badges.push(
        el("span", { class: `tag${roomDiff !== "standard" ? " gold" : ""}` }, DIFFICULTY[roomDiff].label)
      );
      if (!room.isHost && getDifficulty() !== roomDiff) setDifficulty(roomDiff);
    }

    const leave = el("button", { class: "mini ghost", type: "button" }, "leave");
    leave.addEventListener("click", () => void act("/api/rooms/leave", {}));
    wrap.append(
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "grow" },
          el("div", { class: "nm" }, room.name),
          el("div", { class: "meta" }, `party ${room.members.length}/${room.capacity}`)
        ),
        ...badges,
        leave
      )
    );

    const party = el("div", { class: "stack" }, el("h2", {}, "Party"));
    for (const m of room.members) {
      const bits: (Node | string)[] = [];
      // A matchmade lobby has no leader anyone agreed to, so it shows consent
      // (the dot) where a team room shows authority (the crown).
      if (matchmade) bits.push(el("span", { class: m.ready ? "dot on" : "dot" }));
      bits.push(
        el(
          "div",
          { class: "grow" },
          el("div", { class: "nm" }, m.username.toUpperCase()),
          // Role next to the hero so the comp tip below reads as a receipt,
          // not an accusation.
          el("div", { class: "meta" }, `${m.rank} — ${m.hero} · ${heroById(m.hero).role}`)
        )
      );
      if (matchmade) bits.push(el("span", { class: "tag" }, m.ready ? "ready" : "waiting"));
      else if (m.isHost) bits.push(el("span", { class: "tag gold" }, "host"));
      party.append(el("div", { class: "row" }, ...bits));
    }
    for (let i = room.members.length; i < room.capacity; i++) {
      party.append(el("div", { class: "slot" }, "awaiting theorist…"));
    }
    // Role-spread reminder (shared/teamComp.ts) — a dim hint, never a gate.
    const compTip = compReminder(room.members.map((m) => m.hero), room.capacity);
    if (compTip) party.append(el("div", { class: "hint" }, compTip));
    wrap.append(party);

    const box = el("div", { class: "queuebox" });
    if (matchmade) {
      // Everyone agrees, or nobody goes. The last press launches the party
      // server-side, so there is no "start for everyone" button to disagree
      // with — and no leader to resent.
      const ready = !!room.youReady;
      const count = `${room.readyCount ?? 0}/${room.members.length}`;
      if (ready) {
        const cancel = el("button", { class: "mini", type: "button" }, "not ready yet");
        cancel.addEventListener("click", () => void act("/api/rooms/ready", { ready: false }));
        box.append(el("div", { class: "pulse" }, `WAITING FOR THE OTHERS — ${count} ready`), cancel);
      } else {
        const go = el("button", { class: "cta big", type: "button" }, `● I'm Ready — ${count}`);
        go.addEventListener("click", () => void act("/api/rooms/ready", { ready: true }));
        box.append(go, el("div", { class: "hint" }, "The fight starts the moment everyone here is ready."));
      }
    } else if (room.isHost) {
      const start = el("button", { class: "cta big", type: "button" }, "⚔ Start Fight") as HTMLButtonElement;
      start.disabled = !full;
      start.addEventListener("click", () => void act("/api/rooms/launch", {}));
      box.append(start);
      // Dream Siege for the whole party (server/survival.mjs). The server's
      // survivalLaunch push walks every member — the leader too — into Old
      // Kowloon (src/main.ts). Survival takes any party of 2–3, full or not.
      if (room.members.length >= 2) {
        const siege = el("button", { class: "cta", type: "button" }, "🌙 Dream Siege (party)") as HTMLButtonElement;
        siege.addEventListener("click", () => {
          void import("../survival/hud").then(({ openSurvivalPicker }) =>
            openSurvivalPicker((difficulty) => {
              void fetch("/api/survival/launch", {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ difficulty }),
              }).then(async (r) => {
                if (!r.ok) chatError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start the Dream Siege.");
              });
            })
          );
        });
        box.append(siege);
      }
      if (!full) {
        // Under-strength is not a button any more. The queue fills the seat;
        // failing that, the 90 s timeout takes you in with whoever is left.
        box.append(
          el("div", { class: "hint" }, `Party not full — ${room.members.length}/${room.capacity}. Queue for a fill.`)
        );
        if (state.queued) {
          const out = el("button", { class: "mini", type: "button" }, "leave queue");
          out.addEventListener("click", () => void act("/api/queue/leave", {}));
          box.append(el("div", { class: "pulse" }, `QUEUED FOR A FILL — ${state.queueSize} waiting`), out);
        } else {
          const q = el("button", { class: "cta", type: "button" }, "⚡ Queue for a Fill");
          q.addEventListener("click", () => void act("/api/queue/join", {}));
          box.append(q);
        }
      } else {
        box.append(el("div", { class: "hint" }, "Full stack. The boss waits until everyone has loaded."));
      }
    } else {
      box.append(
        el(
          "div",
          { class: "pulse" },
          state.queued ? `QUEUED FOR A FILL — ${state.queueSize} waiting` : "WAITING FOR YOUR LEADER"
        ),
        el("div", { class: "hint" }, "Only the party leader can queue the party or start the fight.")
      );
    }
    // What "together" actually buys, now that the fight is one shared sim on
    // the server rather than three private ones.
    box.append(
      el(
        "div",
        { class: "hint" },
        "Your party fights ONE Nightmare: one health pool, one Mark board, and heals that land on each other."
      )
    );
    wrap.append(box);

    // Only a room you made is a room you can recruit into: a matchmade lobby
    // is already the matchmaker's answer, and its seats are not yours to sell.
    if (!matchmade && !full) {
      const friends = el("div", { class: "stack" }, el("h2", {}, "Invite friends"));
      if (state.friends.length === 0) {
        friends.append(el("div", { class: "empty" }, "no friends yet — they will appear here"));
      }
      for (const f of state.friends) {
        const inParty = f.status === "party";
        const btn = el(
          "button",
          { class: "mini", type: "button", "data-invite": f.username },
          inParty ? "in party" : f.invited ? "invited ✓" : "invite"
        ) as HTMLButtonElement;
        if (inParty || f.invited) btn.disabled = true;
        friends.append(
          el(
            "div",
            { class: "row" },
            el(
              "div",
              { class: "grow" },
              el("div", { class: "nm" }, f.username),
              el("div", { class: "meta" }, `${f.rank} — ${f.status}`)
            ),
            btn
          )
        );
      }
      friends.addEventListener("click", (e) => {
        const invite = (e.target as HTMLElement).dataset.invite;
        if (invite) void act("/api/rooms/invite", { username: invite });
      });
      wrap.append(friends);
    }

    return wrap;
  }

  document.body.append(overlay);
  void refresh();
  timer = window.setInterval(() => void refresh(), POLL_MS);
}

/** Surface a launch refusal without a native dialog (which drops fullscreen). */
function chatError(text: string): void {
  const t = document.createElement("div");
  t.textContent = text;
  t.style.cssText = "position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:80;background:#2a1418;color:#ffd3c4;border:1px solid #c94a4a;border-radius:8px;padding:8px 14px;font:14px system-ui";
  document.body.appendChild(t);
  window.setTimeout(() => t.remove(), 3500);
}
