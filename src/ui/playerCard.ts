/**
 * Player card — tap another player's avatar in the village and this pops up:
 * who they are (public profile fields from GET /api/social/player) plus the
 * two social verbs that make a plaza a place: Add Friend and Whisper.
 *
 * Same modal recipe as confirmDialog (DOM overlay, backdrop tap closes,
 * Escape closes) but non-blocking and singleton: tapping another player while
 * a card is up replaces it. The social/chat singletons are reached through
 * window.psyrena (main.ts) rather than imports — the card is opened from the
 * 3D scene, and threading two UI singletons through the scene build for one
 * popup is more coupling than a window handle the console already exposes.
 */

import { WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER, WOW_GOLD, WOW_TEXT_DIM } from "./wowChrome";
import { heroPortrait, ROSTER } from "./authFlow";
import type { SocialClient } from "../net/social";
import type { ChatPanel } from "./chatPanel";

/** Shape of GET /api/social/player (server/social.mjs handlePlayerInfo). */
interface PlayerInfo {
  username: string;
  hero: string;
  rank: string;
  title: string;
  score: number;
  battles: number;
  wins: number;
  bossesDefeated: number;
  online: boolean;
  friendship: "self" | "friends" | "requested" | "incoming" | "none";
}

const CSS = `
#player-card {
  /* Under game-dialog (80): a confirm must be able to interrupt the card. */
  position: fixed; inset: 0; z-index: 75; display: grid; place-items: center;
  background: rgba(4, 3, 1, .55); font: 14px/1.6 ${WOW_FONT};
}
#player-card .card {
  display: grid; gap: 14px; width: min(340px, 90vw); box-sizing: border-box;
  padding: 20px 20px 18px; text-align: center; ${WOW_CARD}
}
#player-card .head { display: grid; grid-template-columns: 56px 1fr; gap: 12px; align-items: center; text-align: left; }
#player-card .portrait {
  width: 56px; height: 56px; border-radius: 6px; object-fit: cover;
  border: 1px solid #00000088; box-shadow: 0 0 0 1px ${WOW_GOLD}44;
}
#player-card .who { display: grid; gap: 2px; min-width: 0; }
#player-card .name { font-size: 17px; letter-spacing: .04em; color: ${WOW_GOLD}; overflow: hidden; text-overflow: ellipsis; }
#player-card .sub { font-size: 12px; color: ${WOW_TEXT_DIM}; }
#player-card .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }
#player-card .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; font-size: 12.5px; }
#player-card .stats span { color: ${WOW_TEXT_DIM}; }
#player-card .stats div { display: flex; justify-content: space-between; }
#player-card .title-line { font-size: 12px; color: #e8c56a; letter-spacing: .08em; }
#player-card .btns { display: grid; grid-auto-flow: column; gap: 8px; justify-content: center; }
#player-card button { min-width: 68px; font-size: 11px; }
/* Compact verbs: the card is informational, the buttons shouldn't dominate
   it — so both button flavors get their padding slimmed after the WOW
   fragments (later declaration wins). */
#player-card .cta { ${WOW_CTA} padding: 6px 12px; font-size: 11px; letter-spacing: .12em; }
#player-card .cta:hover { ${WOW_CTA_HOVER} }
#player-card .plain { ${WOW_BTN} padding: 6px 10px; letter-spacing: .12em; }
#player-card .plain:hover { ${WOW_BTN_HOVER} }
#player-card button:disabled { opacity: .55; pointer-events: none; }
#player-card .note { font-size: 11.5px; color: ${WOW_TEXT_DIM}; min-height: 1em; }
`;

function ensureCss(): void {
  if (document.getElementById("player-card-css")) return;
  const style = document.createElement("style");
  style.id = "player-card-css";
  style.textContent = CSS;
  document.head.append(style);
}

/** The singletons main.ts parks on window.psyrena — see its Object.assign. */
function handles(): { social?: SocialClient; chat?: ChatPanel } {
  const psy = (window as unknown as { psyrena?: { social?: SocialClient; chat?: ChatPanel } })
    .psyrena;
  return { social: psy?.social, chat: psy?.chat };
}

/** Open (or replace) the player card for a username. Safe to call for any
 *  name — unknown players render a "no such player" note. */
export function showPlayerCard(username: string): void {
  if (typeof document === "undefined") return;
  ensureCss();
  document.getElementById("player-card")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "player-card";
  overlay.setAttribute("role", "dialog");

  const card = document.createElement("div");
  card.className = "card";
  card.textContent = "…";
  overlay.append(card);

  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return; // unlike a modal, gameplay keys pass through
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);

  void fetch(`/api/social/player?username=${encodeURIComponent(username)}`)
    .then(async (res) => {
      const json = (await res.json().catch(() => ({}))) as Partial<PlayerInfo> & { error?: string };
      if (!overlay.isConnected) return;
      if (!res.ok) {
        renderError(card, json.error ?? "Player unavailable.", close);
        return;
      }
      render(card, json as PlayerInfo, close);
    })
    .catch(() => {
      if (overlay.isConnected) renderError(card, "Network hiccup — try again.", close);
    });
}

function renderError(card: HTMLElement, message: string, close: () => void): void {
  card.textContent = "";
  const msg = document.createElement("div");
  msg.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "plain";
  btn.textContent = "Close";
  btn.addEventListener("click", close);
  const btns = document.createElement("div");
  btns.className = "btns";
  btns.append(btn);
  card.append(msg, btns);
}

function render(card: HTMLElement, info: PlayerInfo, close: () => void): void {
  card.textContent = "";
  const { social, chat } = handles();

  const head = document.createElement("div");
  head.className = "head";
  const img = document.createElement("img");
  img.className = "portrait";
  img.src = heroPortrait(info.hero);
  img.alt = info.hero;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = info.username;
  const sub = document.createElement("div");
  sub.className = "sub";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = info.online ? "#7fd66a" : "#5a5346";
  const heroName = ROSTER.find((h) => h.id === info.hero)?.name ?? info.hero;
  sub.append(dot, `${info.online ? "Online" : "Offline"} · ${heroName} · ${info.rank}`);
  who.append(name, sub);
  head.append(img, who);
  card.append(head);

  if (info.title) {
    const title = document.createElement("div");
    title.className = "title-line";
    title.textContent = `« ${info.title} »`;
    card.append(title);
  }

  const stats = document.createElement("div");
  stats.className = "stats";
  for (const [label, value] of [
    ["Score", String(info.score)],
    ["Battles", String(info.battles)],
    ["Wins", String(info.wins)],
    ["Bosses Felled", String(info.bossesDefeated)],
  ] as const) {
    const row = document.createElement("div");
    const k = document.createElement("span");
    k.textContent = label;
    const v = document.createElement("b");
    v.textContent = value;
    row.append(k, v);
    stats.append(row);
  }
  card.append(stats);

  const note = document.createElement("div");
  note.className = "note";

  const btns = document.createElement("div");
  btns.className = "btns";

  if (info.friendship !== "self") {
    const friendBtn = document.createElement("button");
    friendBtn.type = "button";
    friendBtn.className = "cta";
    const paintFriend = (state: PlayerInfo["friendship"]): void => {
      friendBtn.disabled = state === "friends" || state === "requested";
      friendBtn.textContent =
        state === "friends"
          ? "Friends ✓"
          : state === "requested"
            ? "Request Sent"
            : state === "incoming"
              ? "Accept Friend"
              : "Add Friend";
    };
    paintFriend(info.friendship);
    friendBtn.addEventListener("click", () => {
      if (!social) return;
      const op = info.friendship === "incoming" ? "accept" : "request";
      friendBtn.disabled = true;
      social
        .friendOp(op, info.username)
        .then(() => {
          info.friendship = op === "accept" ? "friends" : "requested";
          paintFriend(info.friendship);
          note.textContent = op === "accept" ? "You are now friends." : "Friend request sent.";
        })
        .catch((err: unknown) => {
          friendBtn.disabled = false;
          note.textContent = err instanceof Error ? err.message : "That didn't go through.";
        });
    });
    btns.append(friendBtn);

    const whisper = document.createElement("button");
    whisper.type = "button";
    whisper.className = "plain";
    whisper.textContent = "Whisper";
    // The server only delivers whispers between friends; the chat panel
    // surfaces its refusal, so the button stays honest without pre-gating.
    whisper.addEventListener("click", () => {
      close();
      chat?.openDm(info.username);
    });
    btns.append(whisper);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "plain";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);
  btns.append(closeBtn);

  card.append(note, btns);
}
