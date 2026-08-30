/**
 * Friend-request popup — the thing that makes an ask arrive.
 *
 * Exactly the gap ui/invitePopup.ts closed for party invites, one social verb
 * over. Tapping a villager in the plaza and pressing Add Friend has always
 * reached the other player instantly (playerCard → POST /api/social/friend →
 * SSE `friendRequest` → net/social onFriendRequest); until now the only
 * reaction on their side was a row appearing in the chat panel's FRIENDS tab,
 * so a player with chat shut never learned anybody had asked. This is the
 * missing half: a card, on screen, with Accept and Decline on it.
 *
 * Non-blocking, for the invite card's reasons — the recipient may be mid-fight
 * or mid-conversation, so the world keeps running underneath and gameplay keys
 * pass through. It shares the invite card's z-index band (below chat at 90 and
 * confirms at 80, above every panel) and stacks BELOW an open invite card
 * rather than covering it: both are top-centre, and two overlapping cards is a
 * worse outcome than one that waits its turn.
 *
 * Anti-spam: one card at a time, queued by sender. A repeat ask from someone
 * already on screen is swallowed, and a declined sender is muted for MUTE_MS —
 * declining does not merely dismiss the card, it deletes the row server-side,
 * so without the mute a determined asker could re-post and re-card forever.
 */

import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER, WOW_GOLD, WOW_TEXT_DIM,
} from "./wowChrome";
import { heroPortrait, ROSTER } from "./authFlow";

/** How long a declined sender stays quiet, in ms. */
const MUTE_MS = 120_000;

/** Auto-dismiss — an ask nobody answers should not camp the screen all session. */
const EXPIRE_MS = 45_000;

/** Gap below an open party-invite card when both want the top-centre slot. */
const STACK_GAP_PX = 10;

const CSS = `
#friend-request {
  position: fixed; z-index: 77;
  top: calc(14px + env(safe-area-inset-top, 0px));
  left: 50%; transform: translateX(-50%);
  width: min(340px, 92vw); box-sizing: border-box; padding: 14px 16px 13px;
  display: grid; gap: 10px; text-align: center;
  font: 13px/1.5 ${WOW_FONT};
  ${WOW_CARD}
  animation: friendRequestIn .22s ease-out;
}
@keyframes friendRequestIn {
  from { opacity: 0; transform: translate(-50%, -10px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
#friend-request .head {
  font-size: 10px; letter-spacing: .28em; text-transform: uppercase; color: ${WOW_TEXT_DIM};
}
#friend-request .who {
  display: grid; grid-template-columns: 40px 1fr; gap: 10px;
  align-items: center; text-align: left;
}
#friend-request .portrait {
  width: 40px; height: 40px; border-radius: 6px; object-fit: cover;
  border: 1px solid #00000088; box-shadow: 0 0 0 1px ${WOW_GOLD}44;
}
#friend-request .name { font-size: 15px; letter-spacing: .04em; color: ${WOW_GOLD}; }
#friend-request .sub { font-size: 11.5px; color: ${WOW_TEXT_DIM}; }
#friend-request .btns { display: grid; grid-auto-flow: column; gap: 8px; justify-content: center; }
#friend-request button { min-width: 84px; font-size: 11px; }
#friend-request .cta { ${WOW_CTA} padding: 7px 14px; font-size: 11px; letter-spacing: .14em; }
#friend-request .cta:hover { ${WOW_CTA_HOVER} }
#friend-request .plain { ${WOW_BTN} padding: 7px 12px; letter-spacing: .14em; }
#friend-request .plain:hover { ${WOW_BTN_HOVER} }
#friend-request button:disabled { opacity: .5; pointer-events: none; }
#friend-request .note { font-size: 11px; color: #ff8896; min-height: 1em; }
`;

function ensureCss(): void {
  if (document.getElementById("friend-request-css")) return;
  const style = document.createElement("style");
  style.id = "friend-request-css";
  style.textContent = CSS;
  document.head.append(style);
}

/** lowercased sender -> timestamp until which their requests are ignored. */
const muted = new Map<string, number>();
/** The sender whose card is currently up, if any. */
let showing: string | null = null;
/**
 * Asks that arrived while another card was up. A queue rather than a stack:
 * whoever asked first should be answered first, and a burst from one sender
 * collapses because `enqueue` dedupes by name.
 */
const pending: FriendRequest[] = [];

export interface FriendRequest {
  /** Who asked. */
  from: string;
  /** Their selected hero — drives the portrait. */
  hero: string;
}

export interface FriendRequestHandlers {
  /** Accept: befriend them. Rejects with a message the card shows. */
  onAccept: (username: string) => Promise<void>;
  /** Decline: drop the pending row server-side. Failures are ignored. */
  onDecline: (username: string) => Promise<void>;
}

/**
 * Show the request card, or queue it behind one already up. Safe to call for
 * every `friendRequest` push — repeats from the sender on screen, and senders
 * muted by a recent decline, are dropped.
 */
export function showFriendRequest(request: FriendRequest, handlers: FriendRequestHandlers): void {
  if (typeof document === "undefined") return;
  const key = request.from.toLowerCase();
  if (!key) return;
  if ((muted.get(key) ?? 0) > Date.now()) return;
  if (showing === key && document.getElementById("friend-request")) return;
  if (showing !== null && document.getElementById("friend-request")) {
    // Someone else's card owns the slot — wait behind it rather than replacing
    // it, or a second ask silently eats the first one's Accept button.
    if (!pending.some((p) => p.from.toLowerCase() === key)) pending.push(request);
    return;
  }
  render(request, handlers);
}

function render(request: FriendRequest, handlers: FriendRequestHandlers): void {
  const key = request.from.toLowerCase();
  ensureCss();
  document.getElementById("friend-request")?.remove();
  showing = key;

  const card = document.createElement("div");
  card.id = "friend-request";
  card.setAttribute("role", "dialog");

  let expiry = 0;
  const close = (): void => {
    window.clearTimeout(expiry);
    if (showing === key) showing = null;
    card.remove();
    // Hand the slot to whoever has been waiting. Deferred a frame so the
    // outgoing card is gone before the next one's entry animation starts.
    const next = pending.shift();
    if (next) requestAnimationFrame(() => showFriendRequest(next, handlers));
  };

  const head = document.createElement("div");
  head.className = "head";
  head.textContent = "Friend Request";

  const who = document.createElement("div");
  who.className = "who";
  const portrait = document.createElement("img");
  portrait.className = "portrait";
  portrait.src = heroPortrait(request.hero);
  portrait.alt = request.hero;
  const lines = document.createElement("div");
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = request.from;
  const sub = document.createElement("div");
  sub.className = "sub";
  const heroName = ROSTER.find((h) => h.id === request.hero)?.name ?? request.hero;
  sub.textContent = `${heroName} · wants to be friends`;
  lines.append(name, sub);
  who.append(portrait, lines);

  const note = document.createElement("div");
  note.className = "note";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "cta";
  accept.textContent = "Accept";

  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "plain";
  decline.textContent = "Decline";

  accept.addEventListener("click", () => {
    accept.disabled = true;
    decline.disabled = true;
    handlers
      .onAccept(request.from)
      .then(close)
      .catch((err: unknown) => {
        accept.disabled = false;
        decline.disabled = false;
        note.textContent = err instanceof Error ? err.message : "Could not accept that request.";
      });
  });

  decline.addEventListener("click", () => {
    // Mute first: the decline POST is fire-and-forget, and declining DELETES
    // the pending row, so a sender who immediately re-asks would otherwise put
    // the card straight back up.
    muted.set(key, Date.now() + MUTE_MS);
    void handlers.onDecline(request.from).catch(() => undefined);
    close();
  });

  const btns = document.createElement("div");
  btns.className = "btns";
  btns.append(accept, decline);
  card.append(head, who, note, btns);
  document.body.append(card);

  // Share the top-centre slot with the party-invite card instead of covering
  // it. Measured after append (the card has no height before layout).
  const invite = document.getElementById("party-invite");
  if (invite) {
    const below = invite.getBoundingClientRect().bottom + STACK_GAP_PX;
    card.style.top = `${Math.round(below)}px`;
  }

  // Unanswered asks fade out rather than camping the screen — the request
  // itself survives in the chat panel's FRIENDS tab either way.
  expiry = window.setTimeout(close, EXPIRE_MS);
}

/** Tear down any open card and drop the queue — used when the session dies. */
export function closeFriendRequest(): void {
  document.getElementById("friend-request")?.remove();
  showing = null;
  pending.length = 0;
}
