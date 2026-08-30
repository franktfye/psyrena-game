/**
 * Outfitter store panel — opened by tapping the Outfitter's attendant in the
 * village hub (scenes/villageHub.ts shop-NPC pick). The full equipment
 * catalogue: all six slots × all five quality tiers, with each card's state
 * derived from the player's CURRENT tier for that slot — owned below,
 * equipped at, forgeable next, locked beyond. Buying is the same
 * /api/gear/upgrade call the equipment panel (gearPanel.ts) makes; the panel
 * stays the dock-only loadout view, this is the browsing front-end.
 *
 * Same plain-DOM discipline as gearPanel.ts / roomsPanel.ts — markup, styles
 * and behaviour in this one module, nothing touches a scene. Because the
 * opener is a scene POINTERUP, the close paths carry the roomsPanel ghost-click
 * guard (a synthetic click at the release point must not eat the new overlay).
 */

import {
  getEconomy,
  upgradeGear,
  ApiError,
  GEAR_TIERS,
  MAX_GEAR_TIER,
  type EconomyState,
  type GearSlot,
} from "../net/economy";
import { refreshImaginz } from "./playerHud";
import { playSfx } from "../state/sfx";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_ROW,
  WOW_GOLD_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

interface SlotDef {
  key: GearSlot;
  /** Group header — keeps the slot name recognizable. */
  label: string;
  /** Flavorful noun for the item name ("Latent Visor"). */
  noun: string;
  icon: string;
}

const SLOTS: SlotDef[] = [
  { key: "hat", label: "Hat", noun: "Visor", icon: "/assets/ui/gear/slot-hat.webp" },
  { key: "body", label: "Body", noun: "Cuirass", icon: "/assets/ui/gear/slot-armor.webp" },
  { key: "gloves", label: "Gloves", noun: "Gauntlets", icon: "/assets/ui/gear/slot-gloves.webp" },
  { key: "pants", label: "Pants", noun: "Greaves", icon: "/assets/ui/gear/slot-pants.webp" },
  { key: "shoes", label: "Shoes", noun: "Treads", icon: "/assets/ui/gear/slot-shoes.webp" },
  { key: "pet", label: "Pet", noun: "Familiar", icon: "/assets/ui/gear/slot-pet.webp" },
];

const CSS = `
#shop {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; padding: 18px 10px;
}
#shop .card {
  /* margin:auto, not place-items:center — grid centering clips the top of a
     card taller than the viewport; margin auto centers yet lets the overflow
     scroll reach the top (the catalogue is 6 groups tall). */
  margin: auto;
  width: min(760px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#shop .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#shop .head img { width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620; }
#shop .head h1 {
  margin: 0; font-size: 15px; letter-spacing: .34em; font-weight: 700; flex: 1;
  ${WOW_GOLD_TEXT}
}
#shop .head .bal { font-size: 12px; color: #ecc363; letter-spacing: .08em; white-space: nowrap; }
#shop .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#shop .close:hover { ${WOW_BTN_HOVER} }
#shop .body { padding: 16px; display: grid; gap: 14px; }
#shop .group { display: grid; gap: 6px; }
#shop .gname { font-size: 11px; letter-spacing: .28em; color: #e2c47c; text-transform: uppercase; }
#shop .row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
#shop .gcard {
  padding: 8px 6px; display: grid; gap: 3px; justify-items: center; text-align: center;
  ${WOW_ROW}
}
#shop .gcard .ic {
  width: 44px; height: 44px; border-radius: 0; border: 1px solid;
  background-color: #120d05;
  background-size: 128%; background-position: center; background-repeat: no-repeat;
}
#shop .gcard .nm { font-size: 10px; letter-spacing: .04em; }
#shop .gcard .qu { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; opacity: .85; }
#shop .gcard .pr { font-size: 10px; color: #ecc363; letter-spacing: .05em; }
#shop .gcard .st { font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: ${WOW_TEXT_DIM}; }
#shop .gcard.owned { opacity: .55; }
#shop .gcard.locked { opacity: .55; }
#shop .gcard.locked .ic { filter: grayscale(1) brightness(.45); }
#shop .buy {
  padding: 4px 8px; font: inherit; font-size: 10px; white-space: nowrap;
  ${WOW_BTN}
}
#shop .buy:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#shop .buy:disabled { opacity: .55; cursor: default; }
#shop .buy.short { border-color: #ff5964; color: #ff8896; }
#shop .hint {
  padding: 0 16px 16px; font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .8;
  letter-spacing: .06em; min-height: 16px; text-align: center;
}
#shop .err { padding: 0 16px 12px; color: #ff8896; font-size: 12px; text-align: center; }
#shop .err button {
  padding: 4px 10px; font: inherit; font-size: 11px; margin-left: 8px;
  ${WOW_BTN}
}
#shop .err button:hover { ${WOW_BTN_HOVER} }
/* Small screens: full-screen card, scrolling inside it (same treatment as
   roomsPanel.ts — one media query per panel module, no shared sheet). */
@media (pointer: coarse), (max-width: 640px) {
  #shop { padding: 0; font-size: 12px; }
  #shop .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    /* Safe-area: keep full-bleed card content clear of the iPhone camera housing. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
    overflow-y: auto;
  }
  #shop .row { gap: 5px; }
  #shop .gcard { padding: 6px 3px; }
  #shop .gcard .ic { width: 34px; height: 34px; }
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

/** The open panel's close fn, so a matching dock button could toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeShopPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openShopPanel(): void {
  if (document.getElementById("shop")) return;
  if (!document.getElementById("shop-css")) {
    document.head.append(el("style", { id: "shop-css" }, CSS));
  }

  const hint = el("div", { class: "hint" });
  const err = el("div", { class: "err" });
  const bal = el("div", { class: "bal" }, "◈ —");
  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const body = el("div", { class: "body" });

  const overlay = el(
    "div",
    { id: "shop" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("img", { src: "/assets/ui/gear/gear.webp", alt: "" }),
        el("h1", {}, "OUTFITTER"),
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
  // Ghost-click guard (same 350 ms pattern as roomsPanel.ts): the panel opens
  // on the scene's POINTERUP (the attendant tap); on touch the browser then
  // hit-tests a synthetic `click` at the release point — which now sits under
  // the just-opened overlay — and the backdrop handler would close the panel
  // in the same gesture. Escape is unaffected: no ghost key events exist.
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

  hint.textContent = "Laying out the Outfitter's catalogue…";

  let eco: EconomyState | null = null;

  const load = (): void => {
    err.replaceChildren();
    getEconomy()
      .then((fresh) => {
        hint.textContent = "";
        eco = fresh;
        bal.textContent = `◈ ${fmt(fresh.imaginz)} Imaginz`;
        body.replaceChildren(...SLOTS.map((s) => renderGroup(s, fresh)));
      })
      .catch((ex) => {
        hint.textContent = "";
        err.replaceChildren(
          document.createTextNode(ex instanceof Error ? ex.message : "The catalogue is unreachable.")
        );
        const retry = el("button", { type: "button" }, "Retry");
        retry.addEventListener("click", load);
        err.append(retry);
      });
  };

  function renderGroup(def: SlotDef, state: EconomyState): HTMLElement {
    const current = Math.max(0, Math.min(MAX_GEAR_TIER, Math.round(state.gear[def.key])));
    const cards: HTMLElement[] = [];
    for (let t = 0; t <= MAX_GEAR_TIER; t++) cards.push(renderCard(def, t, current, state.imaginz));
    return el(
      "div",
      { class: "group", "data-slot": def.key },
      el("div", { class: "gname" }, def.label),
      el("div", { class: "row" }, ...cards)
    );
  }

  function renderCard(def: SlotDef, tIdx: number, current: number, imaginz: number): HTMLElement {
    const t = GEAR_TIERS[tIdx]!;
    // Card state from the player's CURRENT tier: owned below, equipped at,
    // forgeable next, locked beyond. Tier 0 is the unforged ("Empty") state,
    // so with nothing forged the Latent card itself is the forgeable one.
    let state: "owned" | "equipped" | "buy" | "locked";
    if (current === 0) state = tIdx === 0 ? "buy" : "locked";
    else if (tIdx < current) state = "owned";
    else if (tIdx === current) state = "equipped";
    else if (tIdx === current + 1) state = "buy";
    else state = "locked";

    const icon = el("div", {
      class: "ic",
      style: `background-image:url("${def.icon}");border-color:${t.color}88`,
    });

    let tail: HTMLElement;
    if (state === "owned") {
      tail = el("div", { class: "st" }, "✓ Owned");
    } else if (state === "equipped") {
      tail = el("div", { class: "st", style: `color:${t.color}` }, "Equipped");
    } else if (state === "locked") {
      tail = el("div", { class: "st" }, "🔒 Locked");
    } else {
      // Forgeable: the button carries the REAL charge (the cost of stepping
      // off the current tier), not the card's displayed catalogue price.
      const cost = GEAR_TIERS[current]!.cost ?? 0;
      const btn = el("button", { class: "buy", type: "button" }) as HTMLButtonElement;
      btn.textContent = `Forge · ${fmt(cost)} ◈`;
      if (imaginz < cost) {
        btn.disabled = true;
        btn.classList.add("short");
        btn.title = `Not enough Imaginz — ${fmt(cost - imaginz)} short`;
      } else {
        btn.addEventListener("click", () => doForge(def, btn));
      }
      tail = btn;
    }

    return el(
      "div",
      { class: `gcard ${state}`, style: state === "equipped" ? `border-color:${t.color};box-shadow:0 0 12px ${t.color}44` : "" },
      icon,
      el("div", { class: "nm", style: `color:${t.color}` }, `${t.name} ${def.noun}`),
      el("div", { class: "qu", style: `color:${t.color}` }, t.quality),
      el("div", { class: "pr" }, t.cost === null ? "—" : `◈ ${fmt(t.cost)}`),
      tail
    );
  }

  function doForge(def: SlotDef, btn: HTMLButtonElement): void {
    btn.disabled = true;
    err.replaceChildren();
    upgradeGear(def.key)
      .then((res) => {
        playSfx("ui.forge");
        // Push the new balance to the HUD chip, re-render this slot's row and
        // the header in place.
        refreshImaginz(res.imaginz);
        bal.textContent = `◈ ${fmt(res.imaginz)} Imaginz`;
        if (eco) {
          eco = { ...eco, imaginz: res.imaginz, gear: { ...eco.gear, [def.key]: res.tier } };
          const fresh = renderGroup(def, eco);
          body.querySelector(`[data-slot="${def.key}"]`)?.replaceWith(fresh);
        }
      })
      .catch((ex) => {
        btn.disabled = false;
        if (ex instanceof ApiError && ex.status === 402) {
          const needed = typeof ex.data.needed === "number" ? ex.data.needed : null;
          const balance = typeof ex.data.balance === "number" ? ex.data.balance : null;
          if (balance !== null) {
            bal.textContent = `◈ ${fmt(balance)} Imaginz`;
            refreshImaginz(balance);
            if (eco) eco = { ...eco, imaginz: balance };
          }
          // Flash the shortfall on the button, then revert to the cost.
          const label = btn.textContent ?? "";
          btn.classList.add("short");
          btn.textContent = needed !== null ? `Need ${fmt(needed)} more ◈` : "Not enough ◈";
          window.setTimeout(() => {
            btn.classList.remove("short");
            btn.textContent = label;
          }, 1600);
        } else {
          err.textContent = ex instanceof Error ? ex.message : "Forge failed.";
        }
      });
  }

  load();
}
