/**
 * Party-invite popup — the thing that makes an invitation arrive.
 *
 * The invite itself has always been pushed instantly (server/app.mjs
 * /api/rooms/invite → SSE `invite` → net/social onInvite); until now the only
 * reaction was a chat line, so the player who did not have the Boss Queue
 * panel open never learned they had been invited. This is the missing half:
 * a card, on screen, the moment the push lands, with Join and Decline on it.
 *
 * Non-blocking on purpose (the confirmDialog recipe minus the modal): the
 * invitee may be mid-fight or mid-conversation, so the world keeps running
 * underneath and gameplay keys pass through. It sits BELOW the chat panel
 * (90) — chat is the always-on-top surface — and below confirms (80), which
 * must still be able to interrupt, but above every panel.
 *
 * Anti-spam: one card at a time, keyed by room. A repeat invite for a room
 * whose card is already up is swallowed rather than restacked, and a declined
 * room is muted for MUTE_MS so a mashing inviter cannot wallpaper the screen.
 */

import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER, WOW_GOLD, WOW_TEXT_DIM,
} from "./wowChrome";

/** How long a declined room stays quiet, in ms. */
const MUTE_MS = 60_000;

/** Auto-dismiss — an invite nobody answers should not sit there all session. */
const EXPIRE_MS = 45_000;

const CSS = `
#party-invite {
  position: fixed; z-index: 78;
  top: calc(14px + env(safe-area-inset-top, 0px));
  left: 50%; transform: translateX(-50%);
  width: min(340px, 92vw); box-sizing: border-box; padding: 14px 16px 13px;
  display: grid; gap: 10px; text-align: center;
  font: 13px/1.5 ${WOW_FONT};
  ${WOW_CARD}
  animation: partyInviteIn .22s ease-out;
}
@keyframes partyInviteIn {
  from { opacity: 0; transform: translate(-50%, -10px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
#party-invite .head {
  font-size: 10px; letter-spacing: .28em; text-transform: uppercase; color: ${WOW_TEXT_DIM};
}
#party-invite .who { font-size: 15px; letter-spacing: .04em; color: ${WOW_GOLD}; }
#party-invite .room {
  font-size: 12px; color: ${WOW_TEXT_DIM};
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#party-invite .btns { display: grid; grid-auto-flow: column; gap: 8px; justify-content: center; }
#party-invite button { min-width: 84px; font-size: 11px; }
#party-invite .cta { ${WOW_CTA} padding: 7px 14px; font-size: 11px; letter-spacing: .14em; }
#party-invite .cta:hover { ${WOW_CTA_HOVER} }
#party-invite .plain { ${WOW_BTN} padding: 7px 12px; letter-spacing: .14em; }
#party-invite .plain:hover { ${WOW_BTN_HOVER} }
#party-invite button:disabled { opacity: .5; pointer-events: none; }
#party-invite .note { font-size: 11px; color: #ff8896; min-height: 1em; }
`;

function ensureCss(): void {
  if (document.getElementById("party-invite-css")) return;
  const style = document.createElement("style");
  style.id = "party-invite-css";
  style.textContent = CSS;
  document.head.append(style);
}

/** roomId -> timestamp until which that room's invites are ignored. */
const muted = new Map<number, number>();
/** The room whose card is currently up, if any. */
let showing: number | null = null;

export interface PartyInvite {
  roomId: number;
  /** Room name. */
  name: string;
  /** Who invited us. */
  from: string;
}

export interface InvitePopupHandlers {
  /** Accept: join the room. Rejects with a message the card shows. */
  onJoin: (roomId: number) => Promise<void>;
  /** Decline: drop the invitation server-side. Failures are ignored. */
  onDecline: (roomId: number) => Promise<void>;
}

/**
 * Show the invite card. Safe to call for every `invite` push — repeats for a
 * room already on screen, and rooms muted by a recent decline, are dropped.
 */
export function showPartyInvite(invite: PartyInvite, handlers: InvitePopupHandlers): void {
  if (typeof document === "undefined") return;
  const mutedUntil = muted.get(invite.roomId) ?? 0;
  if (mutedUntil > Date.now()) return;
  if (showing === invite.roomId && document.getElementById("party-invite")) return;
  ensureCss();
  document.getElementById("party-invite")?.remove();
  showing = invite.roomId;

  const card = document.createElement("div");
  card.id = "party-invite";
  card.setAttribute("role", "dialog");

  let expiry = 0;
  const close = (): void => {
    window.clearTimeout(expiry);
    if (showing === invite.roomId) showing = null;
    card.remove();
  };

  const head = document.createElement("div");
  head.className = "head";
  head.textContent = "Party Invitation";

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = invite.from;

  const room = document.createElement("div");
  room.className = "room";
  room.textContent = `invites you to “${invite.name}”`;

  const note = document.createElement("div");
  note.className = "note";

  const join = document.createElement("button");
  join.type = "button";
  join.className = "cta";
  join.textContent = "Join";

  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "plain";
  decline.textContent = "Decline";

  join.addEventListener("click", () => {
    join.disabled = true;
    decline.disabled = true;
    handlers
      .onJoin(invite.roomId)
      .then(close)
      .catch((err: unknown) => {
        join.disabled = false;
        decline.disabled = false;
        note.textContent = err instanceof Error ? err.message : "Could not join that party.";
      });
  });

  decline.addEventListener("click", () => {
    // Mute first: the decline POST is fire-and-forget, and a second push that
    // raced it must not put the card straight back up.
    muted.set(invite.roomId, Date.now() + MUTE_MS);
    void handlers.onDecline(invite.roomId).catch(() => undefined);
    close();
  });

  const btns = document.createElement("div");
  btns.className = "btns";
  btns.append(join, decline);
  card.append(head, who, room, note, btns);
  document.body.append(card);

  // Unanswered invites fade out rather than camping the top of the screen —
  // the invitation itself survives in the Boss Queue panel's list.
  expiry = window.setTimeout(close, EXPIRE_MS);
}

/** Tear down any open card — used when the session dies (kick, logout). */
export function closePartyInvite(): void {
  document.getElementById("party-invite")?.remove();
  showing = null;
}
