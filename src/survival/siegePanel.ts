/**
 * Dream Siege panel — the survival mode's own front door, opened by the dock's
 * Dream Siege button and the village's pailou gate. It has nothing to do with
 * the Boss Queue: its own queue (server/survival.mjs /api/survival/queue/*),
 * its own banner, its own verbs.
 *
 * Same rule as the Boss Arena panel: ONE main verb visible at a time, chosen
 * by where you already are —
 *
 *   alone              → Find a Team (the queue); Go Solo sits behind a warning
 *   party leader (2–3) → Start with Party; Find a Team fills the third seat
 *   party member       → "the leader starts it"
 *   searching          → the pulse, and Leave Queue
 *
 * Parties form in the village (tap a player → Invite to Party); this panel
 * shows the one you have. It polls /api/lobby (the party) and
 * /api/survival/queue every 2.5 s while open, and closes itself once the
 * server's survivalLaunch push has walked the player out of the village.
 *
 * Banner: public/assets/ui/survival/banner.webp — generated 2026-10-25 via
 * tools/civitai-gen.mjs, prompt in assets/work/survival/banner_prompt.txt.
 */
import { DIFFICULTIES, type DifficultyId } from "@shared/survival/content";
import { heroById } from "@shared/heroes";
import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER, WOW_ROW, WOW_GOLD_TEXT, WOW_TEXT_DIM,
} from "../ui/wowChrome";

const POLL_MS = 2500;
const DIFF_KEY = "psyrena.siegeDifficulty";

interface Party {
  matchmade: boolean;
  isHost: boolean;
  members: { username: string; hero: string; isHost: boolean }[];
}
interface QueueState {
  queued: boolean;
  difficulty: DifficultyId | null;
  since: number | null;
  waiting: Record<DifficultyId, number>;
}

const LINES: Record<DifficultyId, { feel: string; recall: string; prize: string }> = {
  lucid: { feel: "Gentle hits", recall: "Wrong answer: lose half your HP", prize: "Insight cache" },
  deep: { feel: "Harder hits", recall: "Wrong answer: lose 3/4 of your HP", prize: "Reverie cache" },
  terror: { feel: "Full damage", recall: "Wrong answer: you fall", prize: "Transference cache" },
};

const CSS = `
#siege { position: fixed; inset: 0; z-index: 40; overflow-y: auto; display: grid; padding: 18px 10px;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px); font: 14px/1.5 ${WOW_FONT}; }
#siege .card { margin: auto; position: relative; width: min(640px, 96vw); overflow: hidden; ${WOW_CARD} }
#siege .banner { position: relative; }
#siege .banner img { display: block; width: 100%; aspect-ratio: 3 / 1; object-fit: cover; }
#siege .banner .shade { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 50%, #0b0804f6 100%); }
#siege .banner .title { position: absolute; left: 16px; right: 48px; bottom: 10px; display: grid; gap: 2px; }
#siege .banner h1 { margin: 0; font-size: 18px; letter-spacing: .3em; font-weight: 700; ${WOW_GOLD_TEXT} filter: drop-shadow(0 2px 8px #000); }
#siege .banner .sub { font-size: 10px; letter-spacing: .18em; color: ${WOW_TEXT_DIM}; text-shadow: 0 1px 6px #000; }
#siege .close { position: absolute; top: 8px; right: 8px; width: 32px; height: 32px; font: inherit; font-size: 16px; ${WOW_BTN} }
#siege .close:hover { ${WOW_BTN_HOVER} }
#siege .body { padding: 14px 16px 18px; display: grid; gap: 12px; }
#siege h2 { margin: 0; font-size: 11px; letter-spacing: .3em; color: ${WOW_TEXT_DIM}; font-weight: 700; text-transform: uppercase; }
#siege .err { color: #ff8896; font-size: 12px; text-align: center; }
#siege .err:empty { display: none; }
#siege .seg { display: flex; border: 1px solid #5a4620; overflow: hidden; }
#siege .seg button { flex: 1; background: #120d05; color: ${WOW_TEXT_DIM}; border: none; padding: 8px 6px; font: inherit;
  font-size: 12px; letter-spacing: .08em; cursor: pointer; display: grid; gap: 1px; justify-items: center; min-height: 44px; }
#siege .seg button + button { border-left: 1px solid #5a4620; }
#siege .seg button.on { background: linear-gradient(180deg, #3b1d6e, #1f0f3d); color: #efe0ff; }
#siege .seg button.terror.on { background: linear-gradient(180deg, #8c2014, #55100a); color: #ffe9b0; }
#siege .seg .cnt { font-size: 9.5px; letter-spacing: .06em; opacity: .7; }
#siege .desc { font-size: 11.5px; color: ${WOW_TEXT_DIM}; text-align: center; }
#siege .desc b { color: #f4e3b2; font-weight: 400; }
#siege .party { display: grid; gap: 6px; }
#siege .row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; ${WOW_ROW} }
#siege .row .grow { flex: 1; min-width: 0; }
#siege .row .nm { letter-spacing: .05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#siege .row .meta { font-size: 11px; color: ${WOW_TEXT_DIM}; }
#siege .tag { font-size: 9px; letter-spacing: .18em; text-transform: uppercase; border: 1px solid #ecc36366; padding: 1px 6px; color: #ecc363; }
#siege .slot { border: 1px dashed #5a4620; padding: 6px 10px; font-size: 11.5px; color: ${WOW_TEXT_DIM}; opacity: .75; text-align: center; }
#siege .slot b { color: #f4e3b2; font-weight: 400; }
#siege .acts { display: grid; gap: 8px; justify-items: center; }
#siege button.cta { ${WOW_CTA} width: 100%; padding: 12px; letter-spacing: .26em; text-indent: .26em; min-height: 44px; }
#siege button.cta:hover:not(:disabled) { ${WOW_CTA_HOVER} }
#siege button.cta:disabled { opacity: .4; cursor: default; }
#siege button.mini { ${WOW_BTN} padding: 6px 14px; font-size: 11px; letter-spacing: .1em; min-height: 36px; white-space: nowrap; }
#siege button.mini:hover { ${WOW_BTN_HOVER} }
#siege .pair { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
#siege .pulse { font-size: 12px; color: #ecc363; letter-spacing: .12em; animation: siegePulse 1.6s ease-in-out infinite; text-align: center; }
@keyframes siegePulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
#siege .hint { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .85; text-align: center; }
#siege .warn { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid #8a4a2a; background: #2a120acc; font-size: 12.5px; color: ${WOW_TEXT_DIM}; }
#siege .warn b { color: #ffb38a; letter-spacing: .08em; }
@media (pointer: coarse), (max-width: 640px) {
  #siege { padding: 0; font-size: 12px; }
  #siege .card { position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; max-width: none; overflow-y: auto;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
  #siege .banner img { aspect-ratio: 4 / 1; }
  #siege .banner h1 { font-size: 13px; }
  #siege .banner .sub { font-size: 9px; }
  #siege .close { width: 28px; height: 28px; font-size: 13px; }
  #siege .body { padding: 10px 10px 12px; gap: 9px; }
  #siege .row { padding: 4px 8px; }
  #siege button.cta { padding: 9px; }
}
/* Landscape phones: the art becomes a strip across the gate. */
@media (max-height: 520px) {
  #siege .banner img { aspect-ratio: 7 / 1; object-position: center 46%; }
  #siege .banner .title { bottom: 4px; }
  #siege .seg button { min-height: 40px; padding: 5px 6px; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

let closeActive: (() => void) | null = null;

/**
 * Open the panel (a second open while it is up does nothing). `onSolo` starts
 * a solo run at the chosen difficulty — the caller sets the pending run and
 * walks to Old Kowloon.
 */
export function openSiegePanel(onSolo: (d: DifficultyId) => void): void {
  if (document.getElementById("siege")) return;
  if (!document.getElementById("siege-css")) document.head.append(el("style", { id: "siege-css" }, CSS));

  let diff: DifficultyId = ((): DifficultyId => {
    const v = localStorage.getItem(DIFF_KEY);
    return v === "deep" || v === "terror" ? v : "lucid";
  })();
  let party: Party | null = null;
  let q: QueueState | null = null;
  let soloArmed = false;
  let busy = false;
  let timer = 0;

  const overlay = el("div", { id: "siege", role: "dialog", "aria-label": "Dream Siege" });
  const closeBtn = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const banner = el(
    "div",
    { class: "banner" },
    el("img", { src: "/assets/ui/survival/banner.webp", alt: "" }),
    el("div", { class: "shade" }),
    el("div", { class: "title" }, el("h1", {}, "DREAM SIEGE"), el("span", { class: "sub" }, "HOLD OLD KOWLOON · BUILT FOR 2–3 PLAYERS")),
    closeBtn
  );
  const err = el("div", { class: "err" });
  const body = el("div", { class: "body" });
  overlay.append(el("div", { class: "card" }, banner, err, body));

  const close = (): void => {
    window.clearInterval(timer);
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    closeActive = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    busy = true;
    err.textContent = "";
    try {
      await fn();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
    await refresh();
  };

  const paint = (): void => {
    const searching = !!q?.queued;
    const shown = searching && q?.difficulty ? q.difficulty : diff;
    const kids: HTMLElement[] = [];

    // Difficulty: locked to the queued one while searching.
    const seg = el("div", { class: "seg" });
    for (const d of Object.keys(DIFFICULTIES) as DifficultyId[]) {
      const n = q?.waiting?.[d] ?? 0;
      const b = el(
        "button",
        { type: "button", class: `${d}${d === shown ? " on" : ""}` },
        DIFFICULTIES[d].name,
        el("span", { class: "cnt" }, n > 0 ? `${n} searching` : `${DIFFICULTIES[d].waves} waves`)
      ) as HTMLButtonElement;
      if (searching) b.disabled = true;
      b.addEventListener("click", () => {
        diff = d;
        localStorage.setItem(DIFF_KEY, d);
        soloArmed = false;
        paint();
      });
      seg.append(b);
    }
    const L = LINES[shown];
    const desc = el("div", { class: "desc" });
    desc.innerHTML = `${DIFFICULTIES[shown].waves} waves · ${L.feel} · ${L.recall} · Clear: <b>${L.prize}</b>`;
    kids.push(el("h2", {}, "Difficulty"), seg, desc);

    // The party you have (parties form in the village, not here).
    const members = party?.members ?? [];
    const box = el("div", { class: "party" });
    if (members.length === 0) {
      box.append(el("div", { class: "row" }, el("div", { class: "grow" }, el("div", { class: "nm" }, "You"), el("div", { class: "meta" }, "no party yet"))));
    }
    for (const m of members) {
      const row = el(
        "div",
        { class: "row" },
        el("div", { class: "grow" }, el("div", { class: "nm" }, m.username.toUpperCase()), el("div", { class: "meta" }, `${heroById(m.hero).displayName} · ${heroById(m.hero).role}`))
      );
      if (m.isHost && members.length > 1) row.append(el("span", { class: "tag" }, "leader"));
      box.append(row);
    }
    const open = 3 - Math.max(1, members.length);
    if (open > 0) {
      const slot = el("div", { class: "slot" });
      slot.innerHTML = `${open} open seat${open > 1 ? "s" : ""} — tap a player in the village and press <b>Invite to Party</b>`;
      box.append(slot);
    }

    // One main verb, by situation.
    const acts = el("div", { class: "acts" });
    const inParty = members.length >= 2;
    const leader = inParty && !!party?.isHost;
    if (searching) {
      const waited = q?.since ? Math.floor((Date.now() - q.since) / 1000) : 0;
      const leave = el("button", { class: "mini", type: "button" }, "Leave Queue");
      leave.addEventListener("click", () => void act(() => api("/api/survival/queue/leave", {})));
      acts.append(
        el("div", { class: "pulse" }, `SEARCHING FOR A TEAM — ${q?.waiting?.[shown] ?? 0} in queue · ${waited}s`),
        el("div", { class: "hint" }, "Teams of 3 go at once; a pair goes after 20 s. Stay in the village — you'll be taken in."),
        leave
      );
    } else if (inParty && !leader) {
      const lead = members.find((m) => m.isHost)?.username ?? "your leader";
      acts.append(el("div", { class: "hint" }, `${lead} leads: when they start or queue, you go in together.`));
    } else if (leader) {
      const start = el("button", { class: "cta", type: "button" }, `▶ Start with Party (${members.length})`);
      start.addEventListener("click", () => void act(() => api("/api/survival/launch", { difficulty: diff })));
      acts.append(start);
      if (members.length < 3) {
        const fill = el("button", { class: "mini", type: "button" }, "Find a third player");
        fill.addEventListener("click", () => void act(() => api("/api/survival/queue/join", { difficulty: diff })));
        acts.append(fill);
      }
    } else {
      const find = el("button", { class: "cta", type: "button" }, "⚡ Find a Team");
      find.addEventListener("click", () => void act(() => api("/api/survival/queue/join", { difficulty: diff })));
      acts.append(find);
      if (soloArmed) {
        const warn = el("div", { class: "warn" });
        warn.innerHTML =
          "<b>⚠ You are entering alone</b><span>Nobody can Reach Out to revive you: one Second Wind per cycle, and if you fall again the run is over.</span>";
        const go = el("button", { class: "mini", type: "button" }, "Go Solo anyway");
        go.addEventListener("click", () => {
          close();
          onSolo(diff);
        });
        const back = el("button", { class: "mini", type: "button" }, "Back");
        back.addEventListener("click", () => {
          soloArmed = false;
          paint();
        });
        acts.append(warn, el("div", { class: "pair" }, go, back));
      } else {
        const solo = el("button", { class: "mini", type: "button" }, "Go Solo");
        solo.addEventListener("click", () => {
          soloArmed = true;
          paint();
        });
        acts.append(solo);
      }
    }
    if (inParty) {
      const leaveParty = el("button", { class: "mini", type: "button" }, "Leave Party");
      leaveParty.addEventListener("click", () => void act(() => api("/api/rooms/leave", {})));
      acts.append(leaveParty);
    }
    // The verb right under the difficulty, the party last: on a landscape
    // phone the main button must be on screen without scrolling.
    kids.push(acts, el("h2", {}, "Your Party"), box);
    body.replaceChildren(...kids);
  };

  const refresh = async (): Promise<void> => {
    // The launch push took us to Old Kowloon: nothing left to show.
    if (document.body.dataset.scene && document.body.dataset.scene !== "village") return close();
    const [lobby, queue] = await Promise.all([
      api<{ room?: Party | null }>("/api/lobby").catch(() => null),
      api<QueueState>("/api/survival/queue").catch(() => null),
    ]);
    if (!overlay.isConnected) return;
    const room = lobby?.room ?? null;
    party = room && !room.matchmade ? room : null;
    q = queue;
    paint();
  };

  document.body.append(overlay);
  closeActive = close;
  paint();
  void refresh();
  timer = window.setInterval(() => void refresh(), POLL_MS);
}

/** Close the panel if it is up. */
export function closeSiegePanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}
