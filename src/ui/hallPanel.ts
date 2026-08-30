/**
 * Hall of Minds panel — the village's record hall, as four tabs (docs/05).
 * Opened by tapping the Hall of Minds attendant in the village hub or from
 * the left dock.
 *
 * Ladder: the Season Ladder, live from /api/rankings (season countdown, top
 * 50, the player's own standing pinned when they are outside it). Global /
 * Team Records / Solo Records: the /api/leaderboards top-100 boards, with the
 * player's own standing pinned below ("100+" when unranked or deeper than the
 * board). Achievements and titles moved to their own panel
 * (achievementsPanel.ts). Same plain-DOM discipline as roomsPanel.ts —
 * nothing here touches a scene.
 */

import { ROSTER, type Profile } from "./authFlow";
import { getRankings, type RankingsResponse } from "../net/economy";
import { getLeaderboards, type LeaderboardsResponse } from "../net/achievements";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_ROW,
  WOW_GOLD_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

const CSS = `
#hall-of-minds {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; place-items: center; padding: 18px 10px;
}
#hall-of-minds .card {
  width: min(560px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#hall-of-minds .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#hall-of-minds .head img { width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620; }
#hall-of-minds .head h1 {
  margin: 0; font-size: 15px; letter-spacing: .34em; font-weight: 700; flex: 1;
  ${WOW_GOLD_TEXT}
}
#hall-of-minds .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#hall-of-minds .close:hover { ${WOW_BTN_HOVER} }
#hall-of-minds .tabs { display: flex; gap: 4px; padding: 10px 16px 0; flex-wrap: wrap; }
#hall-of-minds .pane {
  padding: 12px 16px 18px; display: grid; gap: 8px; align-content: start;
  overflow-y: auto; max-height: min(58vh, 520px);
}
#hall-of-minds .empty {
  font-size: 12px; color: ${WOW_TEXT_DIM}; opacity: .75; text-align: center;
  padding: 10px; border: 1px dashed #5a4620; border-radius: 0;
}
#hall-of-minds .row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  ${WOW_ROW}
}
#hall-of-minds .row.dense { padding: 5px 8px; gap: 8px; font-size: 11px; }
#hall-of-minds .row.me { border-color: #e2c47c88; box-shadow: 0 0 12px #e2c47c22; }
#hall-of-minds .row .rk { width: 34px; font-size: 12px; color: #ecc363; text-align: right; }
#hall-of-minds .row.dense .rk { font-size: 11px; }
#hall-of-minds .row .grow { flex: 1; min-width: 0; }
#hall-of-minds .row .nm { letter-spacing: .05em; }
#hall-of-minds .row .meta { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .9; white-space: nowrap; }
#hall-of-minds .season {
  display: flex; align-items: baseline; gap: 10px; justify-content: space-between;
  font-size: 11px; color: ${WOW_TEXT_DIM}; letter-spacing: .08em;
}
#hall-of-minds .season .ends { opacity: .7; }
#hall-of-minds .mine {
  font-size: 12px; color: #ecc363; letter-spacing: .06em; text-align: center;
  border-top: 1px dashed #5a4620; padding-top: 8px;
}
#hall-of-minds .err { color: #ff8896; font-size: 12px; }
#hall-of-minds .err button {
  padding: 4px 10px; font: inherit; font-size: 11px; margin-left: 8px;
  ${WOW_BTN}
}
#hall-of-minds .err button:hover { ${WOW_BTN_HOVER} }
/* Small screens: full-screen card, scrolling inside it. */
@media (pointer: coarse), (max-width: 640px) {
  #hall-of-minds { padding: 0; }
  #hall-of-minds .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    /* Safe-area: keep full-bleed card content clear of the iPhone camera housing. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
  }
  #hall-of-minds .pane { max-height: none; }
}
`;

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

/** "ends in Nd Nh" from a ms timestamp; past dates read as ended. */
function seasonEndsIn(endsAt: number): string {
  const ms = endsAt - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "season ended";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return `ends in ${d}d ${h}h`;
}

/** The boards list the top 100; unranked or deeper standings read "100+". */
function rankLabel(rank: number | null): string {
  return rank === null || rank > 100 ? "100+" : `#${rank}`;
}

/** 86000 → "1:26" — clear times arrive as server ms. */
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The open panel's close fn, so the left dock can toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeHallPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openHallPanel(profile: Profile): void {
  if (document.getElementById("hall-of-minds")) return;
  if (!document.getElementById("hall-css")) {
    document.head.append(el("style", { id: "hall-css" }, CSS));
  }

  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");

  type TabKey = "ladder" | "global" | "clears" | "levels" | "heroes";
  const TABS: { key: TabKey; label: string }[] = [
    { key: "ladder", label: "Ladder" },
    { key: "global", label: "Global" },
    { key: "clears", label: "Team Records" },
    { key: "levels", label: "Solo Records" },
    { key: "heroes", label: "My Heroes" },
  ];
  let active: TabKey = "ladder";

  const tabsEl = el("div", { class: "tabs" });
  const pane = el("div", { class: "pane" });

  // Both feeds load once per open; every tab renders from this shared state,
  // so tab switches are free and a failure is retried per feed.
  let rankings: RankingsResponse | null = null;
  let rankingsErr: string | null = null;
  let boards: LeaderboardsResponse | null = null;
  let boardsErr: string | null = null;

  const errEl = (msg: string, retry: () => void): HTMLElement => {
    const err = el("div", { class: "err" }, msg);
    const btn = el("button", { type: "button" }, "Retry");
    btn.addEventListener("click", retry);
    err.append(btn);
    return err;
  };

  const boardRow = (
    rank: string,
    username: string,
    me: boolean,
    ...cells: string[]
  ): HTMLElement =>
    el(
      "div",
      { class: me ? "row dense me" : "row dense" },
      el("div", { class: "rk" }, rank),
      el("div", { class: "grow nm" }, username),
      ...cells.map((c) => el("div", { class: "meta" }, c))
    );

  const renderLadder = (): void => {
    if (rankingsErr) {
      pane.replaceChildren(errEl(rankingsErr, loadRankings));
      return;
    }
    if (!rankings) {
      pane.replaceChildren(el("div", { class: "empty" }, "Reading the Hall's records…"));
      return;
    }
    const r = rankings;
    const nodes: HTMLElement[] = [
      el(
        "div",
        { class: "season" },
        el("span", {}, r.season.name),
        el("span", { class: "ends" }, seasonEndsIn(r.season.endsAt))
      ),
    ];
    if (r.top.length === 0) {
      nodes.push(el("div", { class: "empty" }, "No battles recorded this season yet — be the first."));
    }
    const meName = profile.username.toLowerCase();
    let meInTop = false;
    r.top.slice(0, 50).forEach((row, i) => {
      const isMe = row.username.toLowerCase() === meName;
      if (isMe) meInTop = true;
      nodes.push(
        el(
          "div",
          { class: isMe ? "row me" : "row" },
          el("div", { class: "rk" }, `#${i + 1}`),
          el(
            "div",
            { class: "grow" },
            el("div", { class: "nm" }, row.username),
            el("div", { class: "meta" }, `best ${row.bestScore}`)
          ),
          el("div", { class: "meta" }, `${row.wins}W / ${row.battles - row.wins}L`),
          el("div", { class: "nm" }, String(row.rating))
        )
      );
    });
    // Outside the top 50 (or absent from it): pin the player's own standing.
    if (!meInTop && r.me.battles > 0) {
      nodes.push(
        el(
          "div",
          { class: "mine" },
          `Your rank: #${r.me.rank} — ${r.me.rating} rating — ${r.me.wins}W / ${r.me.battles - r.me.wins}L`
        )
      );
    }
    pane.replaceChildren(...nodes);
  };

  const renderBoard = (key: Exclude<TabKey, "ladder">): void => {
    if (boardsErr) {
      pane.replaceChildren(errEl(boardsErr, loadBoards));
      return;
    }
    if (!boards) {
      pane.replaceChildren(el("div", { class: "empty" }, "Reading the Hall's records…"));
      return;
    }
    const meName = profile.username.toLowerCase();
    if (key === "global") {
      const b = boards.global;
      if (b.top.length === 0) {
        pane.replaceChildren(el("div", { class: "empty" }, "No rated players yet."));
        return;
      }
      pane.replaceChildren(
        ...b.top.map((row) =>
          boardRow(
            `#${row.rank}`,
            row.username,
            row.username.toLowerCase() === meName,
            `Lv ${row.level}`,
            String(row.rating)
          )
        ),
        el("div", { class: "mine" }, `Your rank: ${rankLabel(b.own.rank)} — ${b.own.rating} rating — Lv ${b.own.level}`)
      );
      return;
    }
    if (key === "clears") {
      const b = boards.clears;
      if (b.top.length === 0) {
        pane.replaceChildren(el("div", { class: "empty" }, "No boss clears recorded yet."));
        return;
      }
      pane.replaceChildren(
        ...b.top.map((row) =>
          boardRow(
            `#${row.rank}`,
            row.username,
            row.username.toLowerCase() === meName,
            row.difficulty,
            fmtMs(row.ms)
          )
        ),
        el("div", { class: "mine" }, `Your rank: ${rankLabel(b.own.rank)} — ${fmtMs(b.own.ms)} — ${b.own.difficulty}`)
      );
      return;
    }
    const b = boards.levels;
    if (b.top.length === 0) {
      pane.replaceChildren(el("div", { class: "empty" }, "No levels recorded yet."));
      return;
    }
    pane.replaceChildren(
      ...b.top.map((row) =>
        boardRow(
          `#${row.rank}`,
          row.username,
          row.username.toLowerCase() === meName,
          `Lv ${row.level}`,
          `${row.xp} XP`
        )
      ),
      el("div", { class: "mine" }, `Your rank: ${rankLabel(b.own.rank)} — Lv ${b.own.level} — ${b.own.xp} XP`)
    );
  };

  // The player's own record broken down by hero played (Profile.heroStats,
  // written per fight by the server). No feed to load: the profile carries
  // it, so this tab is as fresh as the login that produced the profile.
  const renderHeroes = (): void => {
    const rows = profile.heroStats ?? [];
    if (rows.length === 0) {
      pane.replaceChildren(
        el("div", { class: "empty" }, "No battles recorded yet — face the Nightmare and come back.")
      );
      return;
    }
    pane.replaceChildren(
      ...rows.map((r) => {
        const h = ROSTER.find((x) => x.id === r.heroId);
        const rate = r.battles ? Math.round((100 * r.wins) / r.battles) : 0;
        return el(
          "div",
          { class: "row dense" },
          el("div", { class: "rk" }, h?.role ?? "—"),
          el(
            "div",
            { class: "grow" },
            el("div", { class: "nm" }, h?.name ?? r.heroId),
            el(
              "div",
              { class: "meta" },
              `top score ${r.bestScore}` + (r.fastestMs != null ? ` · best clear ${fmtMs(r.fastestMs)}` : "")
            )
          ),
          el("div", { class: "meta" }, `${r.wins}W / ${r.battles - r.wins}L (${rate}%)`)
        );
      })
    );
  };

  const renderPane = (): void => {
    if (active === "ladder") renderLadder();
    else if (active === "heroes") renderHeroes();
    else renderBoard(active);
  };

  function loadRankings(): void {
    rankings = null;
    rankingsErr = null;
    if (active === "ladder") renderPane();
    getRankings()
      .then((r) => {
        rankings = r;
        if (active === "ladder") renderPane();
      })
      .catch((ex) => {
        rankingsErr = ex instanceof Error ? ex.message : "The Hall's records are unreachable.";
        if (active === "ladder") renderPane();
      });
  }

  function loadBoards(): void {
    boards = null;
    boardsErr = null;
    if (active !== "ladder") renderPane();
    getLeaderboards()
      .then((r) => {
        boards = r;
        if (active !== "ladder") renderPane();
      })
      .catch((ex) => {
        boardsErr = ex instanceof Error ? ex.message : "The Hall's records are unreachable.";
        if (active !== "ladder") renderPane();
      });
  }

  const renderTabs = (): void => {
    tabsEl.replaceChildren(
      ...TABS.map(({ key, label }) => {
        const isActive = active === key;
        const tab = el("button", {
          type: "button",
          style: [
            "border:1px solid transparent",
            "border-radius:0",
            "padding:4px 8px",
            "font:inherit",
            "font-size:10px",
            "letter-spacing:.1em",
            "text-transform:uppercase",
            "cursor:pointer",
            "white-space:nowrap",
            isActive ? "background:#120d05;border-color:#5a4620;color:#f4e3b2" : "background:transparent;color:#b8a878",
          ].join(";"),
        }, label);
        tab.addEventListener("click", () => {
          active = key;
          renderTabs();
          renderPane();
        });
        return tab;
      })
    );
  };

  renderTabs();
  renderPane();
  loadRankings();
  loadBoards();

  const overlay = el(
    "div",
    { id: "hall-of-minds" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("img", { src: "/assets/ui/gear/hall.webp", alt: "" }),
        el("h1", {}, "HALL OF MINDS"),
        close
      ),
      tabsEl,
      pane
    )
  );

  const shut = (): void => {
    closeActive = null;
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") shut();
  };
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) shut();
  });
  window.addEventListener("keydown", onKey);
  closeActive = shut;

  document.body.append(overlay);
}
