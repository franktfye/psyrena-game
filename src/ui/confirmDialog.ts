/**
 * In-game confirm/alert — DOM modal replacements for window.confirm/alert.
 *
 * The native dialogs are not an option in-game: on mobile the browser kicks
 * the page out of fullscreen to show them (and in an Add-to-Home-Screen
 * standalone app they render as a jarring system sheet), so a stray "Leave
 * the battlefield?" prompt used to also cost the player their fullscreen
 * session. These render inside the page instead, styled like the rest of the
 * panel chrome, and resolve a promise rather than blocking.
 *
 * Deliberately tiny: one dialog at a time (a second call queues behind the
 * first ever being answered is not a case the game has — callers are all
 * direct tap handlers), no focus trap beyond initial focus, Escape cancels
 * and Enter confirms on keyboards.
 */

import { WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER, WOW_GOLD } from "./wowChrome";

const CSS = `
#game-dialog {
  /* Above every panel (highest existing z is 70) — a confirm can be asked
     while any of them is open. */
  position: fixed; inset: 0; z-index: 80; display: grid; place-items: center;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.7 ${WOW_FONT};
}
#game-dialog .card {
  display: grid; gap: 18px; text-align: center;
  width: min(400px, 88vw); box-sizing: border-box; padding: 24px 22px;
  ${WOW_CARD}
}
#game-dialog .msg { white-space: pre-line; font-size: 15px; letter-spacing: .04em; }
#game-dialog .btns { display: grid; grid-auto-flow: column; gap: 12px; justify-content: center; }
#game-dialog button { min-width: 116px; font-size: 12px; }
#game-dialog .ok { ${WOW_CTA} }
#game-dialog .ok:hover { ${WOW_CTA_HOVER} }
#game-dialog .cancel { ${WOW_BTN} padding: 11px 18px; letter-spacing: .22em; }
#game-dialog .cancel:hover { ${WOW_BTN_HOVER} }
#game-dialog button:focus-visible { outline: 1px solid ${WOW_GOLD}; outline-offset: 2px; }
`;

function ensureCss(): void {
  if (document.getElementById("game-dialog-css")) return;
  const style = document.createElement("style");
  style.id = "game-dialog-css";
  style.textContent = CSS;
  document.head.append(style);
}

function show(message: string, buttons: { label: string; cls: string; value: boolean }[]): Promise<boolean> {
  ensureCss();
  // One at a time: answering an existing dialog with "cancel" before showing
  // the new one beats stacking two modals nobody designed for.
  document.getElementById("game-dialog")?.dispatchEvent(new Event("force-cancel"));

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "game-dialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const card = document.createElement("div");
    card.className = "card";
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = message;
    const btns = document.createElement("div");
    btns.className = "btns";
    card.append(msg, btns);
    overlay.append(card);

    const done = (value: boolean): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };

    let focusTarget: HTMLButtonElement | undefined;
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.cls;
      btn.textContent = b.label;
      btn.addEventListener("click", () => done(b.value));
      btns.append(btn);
      // Focus the safe answer: these dialogs guard against stray taps, so a
      // reflexive Enter should not be the destructive one.
      if (!b.value || buttons.length === 1) focusTarget = btn;
    }

    // Backdrop tap = the safe answer, same policy as the focused button — a
    // modal you can only leave through one small button is hostile on a phone.
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.addEventListener("force-cancel", () => done(false));

    const onKey = (e: KeyboardEvent): void => {
      // Capture phase, so gameplay key handlers under the modal never see it.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); done(true); }
    };
    window.addEventListener("keydown", onKey, true);

    document.body.append(overlay);
    focusTarget?.focus();
  });
}

/** In-game window.confirm. Resolves true on OK, false on Cancel/Escape/backdrop. */
export function gameConfirm(
  message: string,
  opts: { okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return show(message, [
    { label: opts.cancelLabel ?? "Cancel", cls: "cancel", value: false },
    { label: opts.okLabel ?? "OK", cls: "ok", value: true },
  ]);
}

/** In-game window.alert. Resolves once dismissed. */
export async function gameAlert(message: string, opts: { okLabel?: string } = {}): Promise<void> {
  await show(message, [{ label: opts.okLabel ?? "OK", cls: "ok", value: true }]);
}
