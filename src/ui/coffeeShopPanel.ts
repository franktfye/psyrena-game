/**
 * Coffee Shop panel — opened ONLY by tapping the coffee-shop attendant in the
 * village hub (scenes/villageHub.ts shop-NPC pick). Deliberately no dock
 * button: the barista is the door, per the facility's design.
 *
 * The menu sells timed potion buffs (server/coffee.mjs is the ledger): the S
 * Latte (+20% damage / 24 h), S Americano (+20% healing / 24 h) and S Cold
 * Brew (+25% Focus regen / 24 h). The M and
 * L sizes are catalogued but not brewing yet — rendered grayed, refused by
 * the server. Below the menu sits the Redeem Code row, the future hook for
 * special items; today every code is politely refused by the server stub.
 *
 * Same plain-DOM discipline as shopPanel.ts — markup, styles and behaviour in
 * this one module, nothing touches a scene. Because the opener is a scene
 * POINTERUP, the close paths carry the roomsPanel ghost-click guard.
 */

import { ApiError } from "../net/economy";
import {
  getCoffee,
  buyCoffee,
  redeemCoffeeCode,
  type CoffeeItem,
  type CoffeeState,
} from "../net/coffee";
import { setActivePotions } from "../state/potions";
import { refreshImaginz } from "./playerHud";
import { playSfx } from "../state/sfx";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_ROW,
  WOW_GOLD_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

/** Card art by item name — the S/M/L sizes share one cup, M/L gray it out. */
const ITEM_ICONS: Record<string, string> = {
  Latte: "/assets/ui/coffee/latte.webp",
  Americano: "/assets/ui/coffee/americano.webp",
  "Cold Brew": "/assets/ui/coffee/coldbrew.webp",
};

/** Accent per effect — the same reads as the buff tiles they grant. */
const EFFECT_COLOR: Record<string, string> = {
  damage: "#ff9a5c",
  healing: "#6fdc8f",
  focus: "#6fb8ff",
};

const CSS = `
#coffee {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; padding: 18px 10px;
}
#coffee .card {
  margin: auto;
  width: min(560px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#coffee .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#coffee .head img { width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620; }
#coffee .head h1 {
  margin: 0; font-size: 15px; letter-spacing: .34em; font-weight: 700; flex: 1;
  ${WOW_GOLD_TEXT}
}
#coffee .head .bal { font-size: 12px; color: #ecc363; letter-spacing: .08em; white-space: nowrap; }
#coffee .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#coffee .close:hover { ${WOW_BTN_HOVER} }
#coffee .body { padding: 16px; display: grid; gap: 14px; }
#coffee .group { display: grid; gap: 6px; }
#coffee .gname { font-size: 11px; letter-spacing: .28em; color: #e2c47c; text-transform: uppercase; }
#coffee .gdesc { font-size: 10px; letter-spacing: .08em; color: ${WOW_TEXT_DIM}; margin-top: -4px; }
#coffee .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
#coffee .gcard {
  padding: 10px 6px; display: grid; gap: 4px; justify-items: center; text-align: center;
  ${WOW_ROW}
}
#coffee .gcard .ic {
  width: 52px; height: 52px; border-radius: 0; border: 1px solid #5a4620;
  background-color: #120d05;
  background-size: 118%; background-position: center; background-repeat: no-repeat;
}
#coffee .gcard .nm { font-size: 11px; letter-spacing: .05em; color: #e8d9b0; }
#coffee .gcard .pr { font-size: 10px; color: #ecc363; letter-spacing: .05em; }
#coffee .gcard .st { font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: ${WOW_TEXT_DIM}; }
#coffee .gcard.locked { opacity: .5; }
#coffee .gcard.locked .ic { filter: grayscale(1) brightness(.45); }
#coffee .gcard .live { font-size: 9px; letter-spacing: .1em; }
#coffee .buy {
  padding: 4px 10px; font: inherit; font-size: 10px; white-space: nowrap;
  ${WOW_BTN}
}
#coffee .buy:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#coffee .buy:disabled { opacity: .55; cursor: default; }
#coffee .buy.short { border-color: #ff5964; color: #ff8896; }
#coffee .redeem {
  display: flex; gap: 8px; align-items: center; padding-top: 4px;
  border-top: 1px solid #3a2d14;
}
#coffee .redeem input {
  flex: 1; min-width: 0; padding: 6px 9px; font: inherit; font-size: 11px;
  letter-spacing: .12em; text-transform: uppercase;
  color: #e8d9b0; background: #120d05; border: 1px solid #5a4620; border-radius: 3px;
  outline: none;
}
#coffee .redeem input::placeholder { color: ${WOW_TEXT_DIM}; text-transform: none; letter-spacing: .06em; }
#coffee .redeem button {
  padding: 6px 12px; font: inherit; font-size: 10px; white-space: nowrap;
  ${WOW_BTN}
}
#coffee .redeem button:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#coffee .redeem button:disabled { opacity: .55; cursor: default; }
#coffee .hint {
  padding: 0 16px 16px; font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .8;
  letter-spacing: .06em; min-height: 16px; text-align: center;
}
#coffee .err { padding: 0 16px 12px; color: #ff8896; font-size: 12px; text-align: center; }
#coffee .err button {
  padding: 4px 10px; font: inherit; font-size: 11px; margin-left: 8px;
  ${WOW_BTN}
}
#coffee .err button:hover { ${WOW_BTN_HOVER} }
/* Small screens: full-screen card, scrolling inside it (same treatment as
   shopPanel.ts — one media query per panel module, no shared sheet). */
@media (pointer: coarse), (max-width: 640px) {
  #coffee { padding: 0; font-size: 12px; }
  #coffee .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
    overflow-y: auto;
  }
  #coffee .row { gap: 5px; }
  #coffee .gcard { padding: 8px 3px; }
  #coffee .gcard .ic { width: 42px; height: 42px; }
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

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** "23h 14m" / "42m" — the card's remaining-time read on an active brew. */
function remainLabel(expiresAt: number): string {
  // Whole minutes first, then split — ceiling the remainder separately could
  // read "23h 60m" in the last seconds of an hour.
  const totalM = Math.ceil(Math.max(0, expiresAt - Date.now()) / 60000);
  const h = Math.floor(totalM / 60);
  const m = totalM % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The open panel's close fn, so a repeat NPC tap can toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeCoffeePanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openCoffeePanel(): void {
  if (document.getElementById("coffee")) return;
  if (!document.getElementById("coffee-css")) {
    document.head.append(el("style", { id: "coffee-css" }, CSS));
  }

  const hint = el("div", { class: "hint" });
  const err = el("div", { class: "err" });
  const bal = el("div", { class: "bal" }, "◈ —");
  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const body = el("div", { class: "body" });

  const overlay = el(
    "div",
    { id: "coffee" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("img", { src: ITEM_ICONS.Latte!, alt: "" }),
        el("h1", {}, "COFFEE SHOP"),
        bal,
        close
      ),
      body,
      err,
      hint
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
  // Ghost-click guard (same 350 ms pattern as shopPanel.ts): the panel opens
  // on the scene's POINTERUP (the attendant tap); on touch the browser then
  // hit-tests a synthetic `click` at the release point — which now sits under
  // the just-opened overlay — and the backdrop handler would close the panel
  // in the same gesture.
  const openedAt = performance.now();
  const GHOST_MS = 350;
  const ghostShut = (): void => {
    if (performance.now() - openedAt < GHOST_MS) return;
    shut();
  };
  close.addEventListener("click", ghostShut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) ghostShut();
  });
  window.addEventListener("keydown", onKey);
  closeActive = shut;
  document.body.append(overlay);

  hint.textContent = "The barista chalks up today's menu…";

  let state: CoffeeState | null = null;

  const load = (): void => {
    err.replaceChildren();
    getCoffee()
      .then((fresh) => {
        hint.textContent = "";
        state = fresh;
        // The fetch is also a sync point for the HUD tiles — a buff bought on
        // another device shows up the moment the shop opens here.
        setActivePotions(fresh.active);
        render();
      })
      .catch((ex) => {
        hint.textContent = "";
        err.replaceChildren(
          document.createTextNode(ex instanceof Error ? ex.message : "The menu board is unreachable.")
        );
        const retry = el("button", { type: "button" }, "Retry");
        retry.addEventListener("click", load);
        err.append(retry);
      });
  };

  function render(): void {
    if (!state) return;
    bal.textContent = `◈ ${fmt(state.imaginz)} Imaginz`;
    // One group per drink name, cards in catalogue (S/M/L) order.
    const names = [...new Set(state.items.map((i) => i.name))];
    body.replaceChildren(
      ...names.map((name) => renderGroup(name, state!)),
      renderRedeemRow()
    );
  }

  function renderGroup(name: string, s: CoffeeState): HTMLElement {
    const items = s.items.filter((i) => i.name === name);
    const brewing = items.find((i) => i.available);
    const color = EFFECT_COLOR[brewing?.effect ?? "damage"] ?? "#ecc363";
    return el(
      "div",
      { class: "group", "data-drink": name },
      el("div", { class: "gname", style: `color:${color}` }, name),
      el("div", { class: "gdesc" }, brewing?.desc ?? ""),
      el("div", { class: "row" }, ...items.map((i) => renderCard(i, s)))
    );
  }

  function renderCard(item: CoffeeItem, s: CoffeeState): HTMLElement {
    const icon = el("div", {
      class: "ic",
      style: `background-image:url("${ITEM_ICONS[item.name] ?? ""}")`,
    });
    const active = s.active.find((p) => p.effect === item.effect);
    const color = EFFECT_COLOR[item.effect] ?? "#ecc363";

    let tail: HTMLElement;
    let live: HTMLElement | null = null;
    if (!item.available) {
      // The M/L teasers: grayed, priceless, refused server-side too.
      tail = el("div", { class: "st" }, "Coming soon");
    } else {
      if (active) {
        live = el(
          "div",
          { class: "live", style: `color:${color}` },
          `● Active · ${remainLabel(active.expiresAt)}`
        );
      }
      const cost = item.price ?? 0;
      const btn = el("button", { class: "buy", type: "button" }) as HTMLButtonElement;
      btn.textContent = `${active ? "Extend" : "Buy"} · ${fmt(cost)} ◈`;
      if (s.imaginz < cost) {
        btn.disabled = true;
        btn.classList.add("short");
        btn.title = `Not enough Imaginz — ${fmt(cost - s.imaginz)} short`;
      } else {
        btn.addEventListener("click", () => doBuy(item, btn));
      }
      tail = btn;
    }

    return el(
      "div",
      { class: `gcard ${item.available ? "" : "locked"}` },
      icon,
      el("div", { class: "nm" }, `${item.name} (${item.size})`),
      el("div", { class: "pr" }, item.price === null ? "—" : `◈ ${fmt(item.price)}`),
      ...(live ? [live] : []),
      tail
    );
  }

  function doBuy(item: CoffeeItem, btn: HTMLButtonElement): void {
    btn.disabled = true;
    err.replaceChildren();
    buyCoffee(item.id)
      .then((res) => {
        playSfx("ui.purchase");
        refreshImaginz(res.balance);
        setActivePotions(res.active);
        if (state) {
          state = { ...state, imaginz: res.balance, active: res.active };
          render();
        }
        hint.textContent = `${item.name} (${item.size}) served — ${item.desc}.`;
      })
      .catch((ex) => {
        btn.disabled = false;
        if (ex instanceof ApiError && ex.status === 402) {
          const balance = typeof ex.data.balance === "number" ? ex.data.balance : null;
          if (balance !== null && state) {
            state = { ...state, imaginz: balance };
            refreshImaginz(balance);
            render();
          }
        } else {
          err.textContent = ex instanceof Error ? ex.message : "The espresso machine jammed.";
        }
      });
  }

  function renderRedeemRow(): HTMLElement {
    // Gift codes are minted in the admin console (server/admin.mjs) and cash
    // out here: a wallet grant or a free cup. Errors show verbatim.
    const input = el("input", {
      type: "text",
      placeholder: "Have a gift code? Redeem it here.",
      "aria-label": "Redeem code",
      maxlength: "32",
    }) as HTMLInputElement;
    const btn = el("button", { type: "button" }, "Redeem Code") as HTMLButtonElement;
    const submit = (): void => {
      const code = input.value.trim();
      if (!code) {
        hint.textContent = "Enter a code to redeem.";
        return;
      }
      btn.disabled = true;
      err.replaceChildren();
      redeemCoffeeCode(code)
        .then((r) => {
          playSfx("ui.purchase");
          btn.disabled = false;
          input.value = "";
          refreshImaginz(r.imaginz);
          setActivePotions(r.active);
          if (state) {
            state = { ...state, imaginz: r.imaginz, active: r.active };
            render();
          }
          hint.textContent = r.message;
        })
        .catch((ex) => {
          btn.disabled = false;
          hint.textContent = ex instanceof Error ? ex.message : "That code did not take.";
        });
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      // The village WASD listener must not walk the hero while typing here —
      // inputMode.isTypingInField covers inputs, but stop it early anyway.
      e.stopPropagation();
    });
    return el("div", { class: "redeem" }, input, btn);
  }

  load();
}
