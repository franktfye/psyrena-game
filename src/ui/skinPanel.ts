/**
 * Style Lab panel — hero skins. Opened by tapping the Style Lab attendant in
 * the village hub.
 *
 * Card carousel: ONE big skin card in the centre, swiped (or arrowed) left
 * and right — a phone screen has no room for the old thumbnail grid. The
 * header shows how many skins are owned vs the total line.
 *
 * Pure scaffold: only the Default skin exists; the 2026 line is three locked
 * placeholders. The selection lives in the wardrobe store (state/wardrobe.ts)
 * and is local-only until loadouts become server-owned. Same plain-DOM
 * discipline as roomsPanel.ts — nothing here touches a scene.
 */

import type { Profile } from "./authFlow";
import { heroFullBody } from "./authFlow";
import { wardrobe } from "../state/wardrobe";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER,
  WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM, WOW_GOLD,
} from "./wowChrome";

const CSS = `
#style-lab {
  position: fixed; inset: 0; z-index: 40;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; place-items: center; padding: 18px 10px;
}
#style-lab .card {
  width: min(420px, 94vw); overflow: hidden;
  ${WOW_CARD}
}
#style-lab .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#style-lab .head img { width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620; }
#style-lab .head h1 {
  /* .34em like the other headers wraps this longer title on the 420px card. */
  margin: 0; font-size: 15px; letter-spacing: .22em; font-weight: 700; flex: 1;
  white-space: nowrap;
  ${WOW_GOLD_TEXT}
}
#style-lab .head .owned { font-size: 10px; letter-spacing: .14em; color: ${WOW_TEXT_DIM}; }
#style-lab .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#style-lab .close:hover { ${WOW_BTN_HOVER} }

/* Carousel: the big card sits centre stage; arrows ride its sides. */
#style-lab .stage {
  position: relative; display: grid; justify-items: center;
  padding: 20px 44px 6px; touch-action: pan-y; user-select: none;
  -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
}
#style-lab .slide {
  position: relative; width: min(260px, 58vw); cursor: pointer;
  border: 1px solid #3a2d14; border-radius: 0; background: #120d05aa;
  overflow: hidden; transition: border-color .12s ease, transform .18s ease;
}
/* 7:10 matches the full-body concept renders (424×600) so the whole figure
   shows; photo fallbacks crop to the same frame. */
#style-lab .slide img { width: 100%; aspect-ratio: 7/10; object-fit: cover; display: block; }
#style-lab .slide .ph {
  width: 100%; aspect-ratio: 7/10; display: grid; place-items: center;
  border: 1px dashed #5a4620; font-size: 42px; box-sizing: border-box;
}
#style-lab .slide.equipped { border-color: ${WOW_GOLD}; box-shadow: 0 0 14px #e2c47c40; }
#style-lab .slide.locked { cursor: default; opacity: .55; }
#style-lab .slide .tag {
  position: absolute; top: 8px; left: 8px; font-size: 9px; letter-spacing: .18em;
  text-transform: uppercase; border: 1px solid #e2c47c88; border-radius: 0;
  padding: 1px 6px; color: ${WOW_GOLD}; background: #0b0804cc;
}
#style-lab .arrow {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 34px; height: 52px; font: inherit; font-size: 18px;
  ${WOW_BTN}
}
#style-lab .arrow:hover { ${WOW_BTN_HOVER} }
#style-lab .arrow.prev { left: 8px; }
#style-lab .arrow.next { right: 8px; }
#style-lab .meta { display: grid; justify-items: center; gap: 2px; padding: 8px 0 16px; }
#style-lab .meta .nm { font-size: 14px; letter-spacing: .06em; color: ${WOW_TEXT}; }
#style-lab .meta .note { font-size: 10px; color: ${WOW_TEXT_DIM}; opacity: .85; }
#style-lab .meta .dots { display: flex; gap: 6px; padding-top: 6px; }
#style-lab .meta .dot {
  width: 6px; height: 6px; border-radius: 50%; background: #5a4620;
}
#style-lab .meta .dot.on { background: ${WOW_GOLD}; box-shadow: 0 0 6px #e2c47c88; }
/* Small screens: full-screen card, scrolling inside it. */
@media (pointer: coarse), (max-width: 640px) {
  #style-lab { padding: 0; }
  #style-lab .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    /* Safe-area: keep full-bleed card content clear of the iPhone camera housing. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
    overflow-y: auto;
  }
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

interface SkinCard {
  id: string;
  name: string;
  note: string;
  owned: boolean;
  img?: string;
}

  /** The open panel's close fn, so the left dock can toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeSkinPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openSkinPanel(profile: Profile): void {
  if (document.getElementById("style-lab")) return;
  if (!document.getElementById("style-lab-css")) {
    document.head.append(el("style", { id: "style-lab-css" }, CSS));
  }

  const skins: SkinCard[] = [
    {
      id: "default",
      name: "Default",
      note: "The analyst's own coat",
      owned: true,
      img: heroFullBody(profile.selectedHero),
    },
    { id: "locked-1", name: "???", note: "2026 line — coming soon", owned: false },
    { id: "locked-2", name: "???", note: "2026 line — coming soon", owned: false },
    { id: "locked-3", name: "???", note: "2026 line — coming soon", owned: false },
  ];
  const ownedCount = skins.filter((s) => s.owned).length;

  let index = 0;

  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const owned = el("span", { class: "owned" }, `OWNED ${ownedCount}/${skins.length}`);

  const slide = el("div", { class: "slide" });
  const nm = el("div", { class: "nm" });
  const note = el("div", { class: "note" });
  const dots = el("div", { class: "dots" });

  const prev = el("button", { class: "arrow prev", type: "button", "aria-label": "Previous skin" }, "‹");
  const next = el("button", { class: "arrow next", type: "button", "aria-label": "Next skin" }, "›");
  const stage = el("div", { class: "stage" }, slide, prev, next);

  const overlay = el(
    "div",
    { id: "style-lab" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("img", { src: "/assets/ui/gear/skin.webp", alt: "" }),
        el("h1", {}, "STYLE LAB — SKINS"),
        owned,
        close
      ),
      stage,
      el("div", { class: "meta" }, nm, note, dots)
    )
  );

  function render(): void {
    const skin = skins[index]!;
    const equipped = skin.owned && wardrobe.skin === skin.id;
    slide.className = `slide${skin.owned ? "" : " locked"}${equipped ? " equipped" : ""}`;
    slide.replaceChildren(
      skin.img
        ? el("img", { src: skin.img, alt: skin.name, draggable: "false" })
        : el("div", { class: "ph" }, "🔒"),
      ...(equipped ? [el("span", { class: "tag" }, "Equipped")] : [])
    );
    nm.textContent = skin.name;
    note.textContent = `${skin.note} · ${index + 1}/${skins.length}`;
    dots.replaceChildren(
      ...skins.map((_, i) => el("span", { class: `dot${i === index ? " on" : ""}` }))
    );
  }

  function go(delta: number): void {
    index = (index + delta + skins.length) % skins.length;
    render();
  }

  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));

  // Tap the big card to equip it (locked cards just sit there). A swipe that
  // flipped the card must not ALSO equip it, so the swipe flags the click away.
  let swiped = false;
  slide.addEventListener("click", () => {
    if (swiped) {
      swiped = false;
      return;
    }
    const skin = skins[index]!;
    if (skin.owned) wardrobe.setSkin(skin.id);
  });

  // Swipe left/right on the stage: a horizontal drag past a small threshold
  // flips the card. `touch-action: pan-y` on the stage keeps vertical scroll
  // native so the gesture only claims true horizontal swipes.
  let swipeX: number | null = null;
  stage.addEventListener("pointerdown", (e) => {
    swipeX = e.clientX;
  });
  stage.addEventListener("pointerup", (e) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) >= 40) {
      swiped = true;
      go(dx < 0 ? 1 : -1);
    }
  });
  stage.addEventListener("pointercancel", () => {
    swipeX = null;
  });

  // The equipped badge follows the store, so re-selecting a skin updates
  // without a rebuild of the whole overlay.
  const offWardrobe = wardrobe.onChange(render);

  const shut = (): void => {
    closeActive = null;
    offWardrobe();
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") shut();
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  };
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) shut();
  });
  window.addEventListener("keydown", onKey);
  closeActive = shut;

  render();
  document.body.append(overlay);
}
