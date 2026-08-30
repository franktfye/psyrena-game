/**
 * Skill tooltip: the text bubble that opens when a player hovers a skill button.
 *
 * Replaces the native `title` attribute on the action bar. A browser tooltip
 * waits about a second, renders in the operating system font, cannot be styled,
 * cannot hold a heading and a numbers line and a paragraph, and never appears
 * at all under a touch pointer. None of that is acceptable for the surface that
 * explains what a button does in a game about knowing what your buttons do.
 *
 * One bubble element for the whole page, moved and refilled on hover, because a
 * bubble per button would be forty idle nodes in the DOM.
 *
 * Touch is deliberately not wired to this. A long press on a phone would fight
 * the cast, and the codex behind the avatar already carries the same copy in a
 * form a thumb can actually read.
 */

import { loreFor } from "./heroLore";
import {
  WOW_FONT, WOW_CARD, WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM, WOW_GOLD,
} from "./wowChrome";

const CSS = `
#skill-tip {
  position: fixed; z-index: 60; max-width: 300px; pointer-events: none;
  opacity: 0; transform: translateY(4px); transition: opacity .12s ease, transform .12s ease;
  ${WOW_CARD}
  padding: 10px 12px;
  font: 12.5px/1.55 ${WOW_FONT};
}
#skill-tip.on { opacity: 1; transform: translateY(0); }
#skill-tip .h { display:flex; align-items:baseline; gap:8px; margin-bottom:5px; }
#skill-tip .n {
  font-size: 14px; font-weight: 700; letter-spacing: .06em;
  ${WOW_GOLD_TEXT}
}
#skill-tip .key {
  margin-left: auto; font-size: 10px; color: ${WOW_TEXT_DIM};
  border: 1px solid #5a4620; border-radius: 0; padding: 0 5px;
}
#skill-tip .q {
  pointer-events: auto; cursor: pointer; flex: none;
  width: 15px; height: 15px; border-radius: 0; padding: 0;
  border: 1px solid #5a4620; background: #120d05aa;
  color: ${WOW_TEXT_DIM}; font: inherit; font-size: 10px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
#skill-tip .q:hover { color: #f4e3b2; border-color: ${WOW_GOLD}; }
#skill-tip .sum { color: ${WOW_TEXT}; margin-bottom: 7px; }
#skill-tip .num {
  color: #ecc363; background: #e2c47c12;
  border-left: 2px solid #b0914e; padding: 4px 7px; border-radius: 0;
  margin-bottom: 7px;
}
#skill-tip .lbl {
  font-size: 9.5px; letter-spacing: .22em; text-transform: uppercase;
  color: ${WOW_TEXT_DIM}; margin: 6px 0 2px;
}
#skill-tip .body { color: ${WOW_TEXT_DIM}; }
#skill-tip-pop {
  position: fixed; z-index: 61; max-width: 260px; pointer-events: none;
  opacity: 0; transition: opacity .12s ease;
  ${WOW_CARD}
  padding: 8px 10px; color: ${WOW_TEXT_DIM};
  font: italic 12px/1.5 ${WOW_FONT};
}
#skill-tip-pop.on { opacity: 1; }
`;

export interface SkillTooltip {
  /** Make an element show `slotId`'s bubble while the pointer is over it. */
  /**
   * `slotId` may be a getter: a bar slot that TRANSFORMS (Pavlov's UCS
   * button becoming CS) keeps one element and one set of listeners, and the
   * id is read at show-time so the bubble always describes the current face.
   */
  attach(el: HTMLElement, slotId: string | (() => string)): void;
  hide(): void;
  dispose(): void;
}

export function createSkillTooltip(): SkillTooltip {
  if (typeof document === "undefined") {
    return { attach: () => {}, hide: () => {}, dispose: () => {} };
  }

  const style = document.createElement("style");
  style.id = "skill-tip-css";
  style.textContent = CSS;
  document.head.appendChild(style);

  const tip = document.createElement("div");
  tip.id = "skill-tip";
  document.body.appendChild(tip);

  // Theory popup: the long-form psychology used to sit inline in the bubble,
  // which made every hover a wall of text. It now lives behind a "?" badge in
  // the bubble header, shown on hover and pinned on click.
  const pop = document.createElement("div");
  pop.id = "skill-tip-pop";
  document.body.appendChild(pop);

  let shownFor: HTMLElement | null = null;
  let currentTheory = "";
  let popPinned = false;
  // The bubble is positioned ABOVE the button, so the pointer must leave the
  // button to reach the "?" badge. A short grace period on hide lets it make
  // the trip instead of the bubble vanishing mid-flight.
  let hideTimer: number | null = null;

  function cancelHide(): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function place(anchor: HTMLElement): void {
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 10;
    // Above the button by default, because the bar lives at the bottom of the
    // screen. Flip below only when there is genuinely no room up there.
    let top = a.top - t.height - gap;
    if (top < 8) top = a.bottom + gap;
    // Centre on the button, then pull back inside the viewport.
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showPop(): void {
    if (!currentTheory) return;
    pop.textContent = currentTheory;
    pop.classList.add("on");
    // Beside the bubble, to the right where there is room, else to the left.
    const t = tip.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    let left = t.right + 8;
    if (left + p.width > window.innerWidth - 8) left = t.left - p.width - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
    const top = Math.max(8, Math.min(t.top, window.innerHeight - p.height - 8));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function hidePop(): void {
    pop.classList.remove("on");
  }

  function show(el: HTMLElement, slotId: string): void {
    const lore = loreFor(slotId);
    if (!lore) return;
    cancelHide();
    tip.replaceChildren();
    currentTheory = lore.theory;
    popPinned = false;
    hidePop();

    const head = document.createElement("div");
    head.className = "h";
    const name = document.createElement("span");
    name.className = "n";
    name.textContent = lore.name;
    const q = document.createElement("button");
    q.className = "q";
    q.type = "button";
    q.textContent = "?";
    q.title = "The theory";
    q.addEventListener("pointerenter", () => {
      cancelHide();
      showPop();
    });
    q.addEventListener("pointerleave", () => {
      // Pinned: the popup (and the bubble holding it) stays up until a
      // click-away dismisses it — see onDocDown.
      if (popPinned) return;
      hidePop();
      hideSoon();
    });
    q.addEventListener("click", (e) => {
      e.stopPropagation();
      popPinned = !popPinned;
      if (popPinned) showPop();
      else hidePop();
    });
    const key = document.createElement("span");
    key.className = "key";
    key.textContent = lore.key;
    head.append(name, q, key);

    const sum = document.createElement("div");
    sum.className = "sum";
    sum.textContent = lore.summary;

    const num = document.createElement("div");
    num.className = "num";
    num.textContent = lore.numbers();

    const useLbl = document.createElement("div");
    useLbl.className = "lbl";
    useLbl.textContent = "HOW TO USE";
    const use = document.createElement("div");
    use.className = "body";
    use.textContent = lore.howToUse;

    tip.append(head, sum, num, useLbl, use);
    tip.classList.add("on");
    shownFor = el;
    // Placed after the fill so the measured height is the real one.
    place(el);
  }

  function hide(): void {
    cancelHide();
    tip.classList.remove("on");
    popPinned = false;
    hidePop();
    shownFor = null;
  }

  function hideSoon(): void {
    cancelHide();
    hideTimer = window.setTimeout(hide, 160);
  }

  const onScroll = (): void => {
    if (shownFor) place(shownFor);
  };
  window.addEventListener("resize", onScroll);

  // Click-away dismisses a pinned theory popup (bubble and all). Presses on
  // the bubble itself don't count — the "?" badge's own click toggles the pin.
  const onDocDown = (e: PointerEvent): void => {
    if (!popPinned) return;
    if (tip.contains(e.target as Node) || pop.contains(e.target as Node)) return;
    hide();
  };
  document.addEventListener("pointerdown", onDocDown);

  return {
    attach(el, slotId) {
      const idOf = typeof slotId === "function" ? slotId : () => slotId;
      // Native tooltip off: two tooltips for one button is worse than either.
      el.removeAttribute("title");
      el.addEventListener("pointerenter", (e) => {
        // Mouse only. A touch pointer entering means a press has begun, and a
        // bubble opening under the thumb would cover the bar mid rotation.
        if ((e as PointerEvent).pointerType === "touch") return;
        show(el, idOf());
      });
      el.addEventListener("pointerleave", () => {
        if (!popPinned) hideSoon(); // a pinned popup holds the bubble open
      });
      // A cast should not leave the bubble hanging over the fight.
      el.addEventListener("pointerdown", hide);
    },
    hide,
    dispose() {
      cancelHide();
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("pointerdown", onDocDown);
      pop.remove();
      tip.remove();
      style.remove();
    },
  };
}
