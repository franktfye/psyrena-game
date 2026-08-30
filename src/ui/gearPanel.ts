/**
 * Equipment panel — opened ONLY by the left dock's gear button
 * (ui/leftDock.ts) and the G key. The Outfitter's attendant in the village
 * hub opens the store catalogue (shopPanel.ts) instead.
 *
 * Live on the economy API: the six gear slots show their real tier (icon,
 * name, quality colour), upgrades spend Imaginz via /api/gear/upgrade, and a
 * "Caches (N)" button opens the loot inventory when unopened boxes wait.
 * Same plain-DOM discipline as roomsPanel.ts — markup, styles and behaviour
 * in this one module, nothing touches a scene, so the panel opens in village
 * and arena alike.
 */

import type { Profile } from "./authFlow";
import { heroPortrait } from "./authFlow";
import {
  getEconomy,
  upgradeGear,
  ApiError,
  GEAR_TIERS,
  MAX_GEAR_TIER,
  type EconomyState,
  type GearSlot,
} from "../net/economy";
import { GEAR_SET_BONUS, gearSetTier } from "../../shared/progression";
import { setLoadoutState } from "../state/loadout";
import { playSfx } from "../state/sfx";
import { refreshImaginz } from "./playerHud";
import { openLootInventory } from "./lootPanel";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_CTA, WOW_CTA_HOVER,
  WOW_GOLD, WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

interface SlotDef {
  key: GearSlot;
  label: string;
}

// The five ARMOR slots — the set the damage bonus reads off (docs/09 §2).
// The pet slot left this panel: pet progression is per-pet in the Pet Park,
// and its old grid cell now shows the set-bonus readout instead.
const SLOTS: SlotDef[] = [
  { key: "hat", label: "Hat" },
  { key: "body", label: "Body Armor" },
  { key: "gloves", label: "Gloves" },
  { key: "pants", label: "Pants" },
  { key: "shoes", label: "Shoes" },
];

/**
 * Per-slot artwork — the set-N.webp icons all depict the same armor
 * chestpiece (a generation mistake), so slots use their own distinct icons.
 * Kept in sync with shopPanel.ts.
 */
const SLOT_ICONS: Record<GearSlot, string> = {
  hat: "/assets/ui/gear/slot-hat.webp",
  body: "/assets/ui/gear/slot-armor.webp",
  gloves: "/assets/ui/gear/slot-gloves.webp",
  pants: "/assets/ui/gear/slot-pants.webp",
  shoes: "/assets/ui/gear/slot-shoes.webp",
  pet: "/assets/ui/gear/slot-pet.webp",
};

const CSS = `
#gear {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; padding: 18px 10px;
}
/* margin:auto (not place-items:center): centering via grid clips the card's
   top when it is taller than the viewport — margin auto still centers but
   lets the overflow scroll reach the top. */
#gear .card {
  margin: auto;
  width: min(560px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#gear .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#gear .head img { width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620; }
#gear .head h1 {
  margin: 0; font-size: 15px; letter-spacing: .34em; font-weight: 700; flex: 1;
  ${WOW_GOLD_TEXT}
}
#gear .head .bal { font-size: 12px; color: #ecc363; letter-spacing: .08em; white-space: nowrap; }
#gear .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#gear .close:hover { ${WOW_BTN_HOVER} }
#gear .body { padding: 18px 16px 20px; display: flex; gap: 18px; align-items: flex-start; }
#gear .portrait { display: grid; gap: 8px; justify-items: center; }
#gear .portrait img {
  width: 132px; aspect-ratio: 1; object-fit: cover; border-radius: 0;
  border: 1px solid #5a4620; display: block;
}
#gear .portrait .who { font-size: 11px; letter-spacing: .12em; color: ${WOW_TEXT_DIM}; }
#gear .slots { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
#gear .slot { display: grid; gap: 5px; justify-items: center; }
#gear .slot .box {
  width: 64px; height: 64px; border-radius: 0;
  border: 1px solid #5a4620; background-color: #120d05aa;
  /* Overscan past rounded-tile corner padding (same art as the dock icons). */
  background-size: 128%; background-position: center; background-repeat: no-repeat;
}
/* Tier 0 = unforged: a dimmed dashed frame with the slot's ghost icon. */
#gear .slot .box.empty {
  border-style: dashed; border-color: #4a3a1c;
  opacity: .35; filter: grayscale(.6);
}
#gear .slot .lb { font-size: 10px; letter-spacing: .14em; color: ${WOW_TEXT_DIM}; text-transform: uppercase; }
#gear .slot .tn { font-size: 10px; letter-spacing: .08em; color: ${WOW_TEXT}; }
#gear .slot .qu { font-size: 9px; letter-spacing: .12em; opacity: .7; text-transform: uppercase; }
/* The slot's stat, small — what this tier lets the SET pay (same cool blue as
   the pet tiles' stat line, so "this row is the number" reads across panels). */
#gear .slot .st { font-size: 9px; letter-spacing: .06em; color: #cdeaff; }
/* ● per tier earned, ○ per tier to go — same 10px track the Pet Park uses. */
#gear .slot .lv { font-size: 10px; letter-spacing: .34em; color: ${WOW_GOLD}; }
/* Hover tooltip: one fixed card repopulated per tile. pointer-events:none so
   it never sits in its own hit test; coarse pointers have no hover, and the
   tile's own stat/dot rows carry the same facts there. */
#gear .tip {
  position: fixed; z-index: 60; width: 248px; pointer-events: none; display: none;
  padding: 10px 12px; font-size: 11px; line-height: 1.5; letter-spacing: .04em;
  ${WOW_CARD}
}
#gear .tip.show { display: block; }
#gear .tip h3 {
  margin: 0 0 5px; font-size: 11px; letter-spacing: .22em; font-weight: 700;
  ${WOW_GOLD_TEXT}
}
#gear .tip .r { margin: 0 0 2px; }
#gear .tip .sep { border-top: 1px solid #3a2d14; margin: 6px 0 5px; }
#gear .tip .dim { color: ${WOW_TEXT_DIM}; font-size: 10px; }
@media (pointer: coarse) { #gear .tip { display: none !important; } }
#gear .up {
  /* 8px + tight tracking so the WHOLE price fits the minmax(0,1fr) column —
     "Upgrade · 3,500 ◈" was ellipsis-clipped at 10px, which hid the one
     number the button exists to show. No ellipsis: a price that cannot be
     read is worse than a smaller one that can. */
  padding: 4px 5px; font: inherit; font-size: 8px; letter-spacing: .02em;
  white-space: nowrap; max-width: 100%;
  ${WOW_BTN}
}
#gear .up:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#gear .up:disabled { opacity: .45; cursor: default; }
#gear .up.max { border-color: #e2c47c66; color: #ecc363; cursor: default; }
#gear .up.short { border-color: #ff5964; color: #ff8896; }
#gear .caches {
  font: inherit; font-size: 12px;
  ${WOW_CTA}
  padding: 8px 14px;
}
#gear .caches:hover { ${WOW_CTA_HOVER} }
#gear .hint {
  padding: 0 16px 16px; font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .8;
  letter-spacing: .06em; min-height: 16px; text-align: center;
}
#gear .err { padding: 0 16px 12px; color: #ff8896; font-size: 12px; text-align: center; }
#gear .err button {
  padding: 4px 10px; font: inherit; font-size: 11px; margin-left: 8px;
  ${WOW_BTN}
}
#gear .err button:hover { ${WOW_BTN_HOVER} }
/* Small screens: full-screen card, scrolling inside it (same treatment as
   roomsPanel.ts — one media query per panel module, no shared sheet). */
@media (pointer: coarse), (max-width: 640px) {
  #gear { padding: 0; }
  #gear .card {
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

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The open panel's close fn, so the gear button / G key can toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeGearPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openGearPanel(profile: Profile): void {
  if (document.getElementById("gear")) return;
  if (!document.getElementById("gear-css")) {
    document.head.append(el("style", { id: "gear-css" }, CSS));
  }

  const hint = el("div", { class: "hint" });
  const err = el("div", { class: "err" });
  const tip = el("div", { class: "tip" });
  const bal = el("div", { class: "bal" }, "◈ —");
  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const slots = el("div", { class: "slots" });
  const foot = el("div", { style: "display:grid;justify-items:center;padding:0 16px 14px" });

  const overlay = el(
    "div",
    { id: "gear" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("img", { src: "/assets/ui/gear/gear.webp", alt: "" }),
        el("h1", {}, "EQUIPMENT"),
        bal,
        close
      ),
      el(
        "div",
        { class: "body" },
        el(
          "div",
          { class: "portrait" },
          el("img", { src: heroPortrait(profile.selectedHero), alt: profile.selectedHero }),
          el("div", { class: "who" }, profile.username.toUpperCase())
        ),
        slots
      ),
      foot,
      err,
      hint
    ),
    tip
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

  hint.textContent = "Consulting the Outfitter's ledger…";

  const load = (): void => {
    err.replaceChildren();
    getEconomy()
      .then((eco) => {
        hint.textContent = "";
        renderEconomy(eco);
      })
      .catch((ex) => {
        hint.textContent = "";
        err.replaceChildren(
          document.createTextNode(ex instanceof Error ? ex.message : "The ledger is unreachable.")
        );
        const retry = el("button", { type: "button" }, "Retry");
        retry.addEventListener("click", load);
        err.append(retry);
      });
  };

  // Live tiers, mutated by upgrades so the set tile re-derives without a
  // refetch — and pushed into the loadout store so the next fight sees them.
  let gearState: Record<string, number> = {};

  const pct = (v: number): string => (v * 100).toLocaleString("en-US");

  const hideTip = (): void => tip.classList.remove("show");

  /** Beside the cursor, flipped to the other side when the edge is close. */
  const placeTip = (x: number, y: number): void => {
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  };

  /** Wire a tile to the tooltip. `build` runs on every entry, not once, so the
   *  content always reads the LIVE gearState (an upgrade elsewhere moves the
   *  set-info lines of every slot's tooltip). */
  const attachTip = (node: HTMLElement, build: () => (Node | string)[]): void => {
    const show = (e: MouseEvent): void => {
      tip.replaceChildren(...build());
      tip.classList.add("show");
      placeTip(e.clientX, e.clientY);
    };
    node.addEventListener("mouseenter", show);
    // mousemove also (re)shows: an upgrade swaps the tile in place under a
    // resting cursor, and the fresh element never receives a mouseenter.
    node.addEventListener("mousemove", (e) => {
      if (tip.classList.contains("show")) placeTip(e.clientX, e.clientY);
      else show(e);
    });
    node.addEventListener("mouseleave", hideTip);
  };

  const LOWEST_NOTE = "The set reads your LOWEST armor slot — upgrade evenly.";

  function slotTipContent(def: SlotDef, tier: number): (Node | string)[] {
    const t = GEAR_TIERS[tier]!;
    const cap = GEAR_SET_BONUS[Math.min(tier, GEAR_SET_BONUS.length - 1)] ?? 0;
    const setTier = gearSetTier(gearState);
    const setBonus = GEAR_SET_BONUS[Math.min(setTier, GEAR_SET_BONUS.length - 1)] ?? 0;
    const rows: (Node | string)[] = [
      el("h3", {}, def.label.toUpperCase()),
      tier === 0
        ? el("div", { class: "r", style: "color:#8a7a58" }, "Unforged — empty socket")
        : el(
            "div",
            { class: "r", style: `color:${t.color}` },
            `${t.name} · ${t.quality} — tier ${tier}/${MAX_GEAR_TIER}`
          ),
      el(
        "div",
        { class: "r" },
        tier === 0
          ? "Contributes nothing until forged."
          : `Supports the set bonus up to +${pct(cap)}% damage.`
      ),
    ];
    if (t.cost !== null) {
      const nt = GEAR_TIERS[tier + 1]!;
      rows.push(
        el(
          "div",
          { class: "r" },
          `${tier === 0 ? "Forge" : "Upgrade"} → `,
          el("span", { style: `color:${nt.color}` }, nt.name),
          ` · ${fmt(t.cost)} ◈`
        )
      );
    } else {
      rows.push(el("div", { class: "r", style: "color:#ecc363" }, "Max tier."));
    }
    rows.push(
      el("div", { class: "sep" }),
      el(
        "div",
        { class: "r" },
        setTier > 0
          ? `Set bonus now: +${pct(setBonus)}% damage (${GEAR_TIERS[setTier]!.name} set).`
          : "Set bonus inactive — forge all 5 slots."
      )
    );
    if (tier === setTier && setTier < MAX_GEAR_TIER) {
      rows.push(
        el("div", { class: "r", style: "color:#ecc363" }, "Lowest slot — it holds the set back.")
      );
    }
    rows.push(el("div", { class: "dim" }, LOWEST_NOTE));
    return rows;
  }

  function setTipContent(): (Node | string)[] {
    const setTier = gearSetTier(gearState);
    const bonus = GEAR_SET_BONUS[Math.min(setTier, GEAR_SET_BONUS.length - 1)] ?? 0;
    const t = GEAR_TIERS[setTier]!;
    const next = setTier < MAX_GEAR_TIER ? GEAR_SET_BONUS[setTier + 1] : null;
    const rows: (Node | string)[] = [
      el("h3", {}, "SET BONUS"),
      setTier > 0
        ? el("div", { class: "r", style: `color:${t.color}` }, `${t.name} set — +${pct(bonus)}% damage.`)
        : el("div", { class: "r", style: "color:#8a7a58" }, "Inactive — forge all 5 slots to start it."),
    ];
    if (next !== null) {
      rows.push(
        el("div", { class: "r" }, `Every slot ${GEAR_TIERS[setTier + 1]!.name} → +${pct(next)}% damage.`)
      );
    } else {
      rows.push(el("div", { class: "r", style: "color:#ecc363" }, "Capped — the 12% Rule."));
    }
    rows.push(el("div", { class: "dim" }, LOWEST_NOTE));
    return rows;
  }

  function renderEconomy(eco: EconomyState): void {
    bal.textContent = `◈ ${fmt(eco.imaginz)} Imaginz`;
    gearState = { ...eco.gear };
    slots.replaceChildren(...SLOTS.map((s) => renderSlot(s, gearState[s.key] ?? 0)), renderSetTile());
    foot.replaceChildren();
    if (eco.lootBoxes.length > 0) {
      const caches = el(
        "button",
        { class: "caches", type: "button" },
        `Caches (${eco.lootBoxes.length})`
      );
      caches.addEventListener("click", () => openLootInventory());
      foot.append(caches);
    }
  }

  /**
   * The sixth grid cell: the SET BONUS the five slots add up to — the one
   * number the whole panel exists to move (docs/09 §2). Reads the LOWEST
   * tier, so it doubles as the "upgrade evenly" teacher.
   */
  function renderSetTile(): HTMLElement {
    const setTier = gearSetTier(gearState);
    const bonus = GEAR_SET_BONUS[Math.min(setTier, GEAR_SET_BONUS.length - 1)] ?? 0;
    const t = GEAR_TIERS[setTier]!;
    const active = setTier > 0;
    const box = el(
      "div",
      {
        class: active ? "box" : "box empty",
        style:
          `background-image:url("/assets/ui/gear/gear.webp")` +
          (active ? `;border-color:${t.color};box-shadow:0 0 12px ${t.color}55` : ""),
      }
    );
    const next = setTier < MAX_GEAR_TIER ? GEAR_SET_BONUS[setTier + 1] : null;
    const tile = el(
      "div",
      { class: "slot" },
      box,
      el("div", { class: "lb" }, "Set Bonus"),
      active
        ? el("div", { class: "tn", style: `color:${t.color}` }, `+${pct(bonus)}% damage`)
        : el("div", { class: "tn", style: "color:#8a7a58" }, "+0% damage"),
      el(
        "div",
        { class: "lv", "aria-label": `set tier ${setTier} of ${MAX_GEAR_TIER}` },
        "●".repeat(setTier) + "○".repeat(MAX_GEAR_TIER - setTier)
      ),
      active
        ? el("div", { class: "qu", style: `color:${t.color}` }, `${t.name} set`)
        : el("div", { class: "qu" }, "forge all 5 slots"),
      el(
        "div",
        { class: "qu", style: "text-transform:none;opacity:.85" },
        next !== null
          ? `every slot ${GEAR_TIERS[setTier + 1]!.name} → +${pct(next)}%`
          : "the 12% Rule — capped"
      )
    );
    attachTip(tile, setTipContent);
    return tile;
  }

  function renderSlot(def: SlotDef, tierRaw: number): HTMLElement {
    const tier = Math.max(0, Math.min(MAX_GEAR_TIER, Math.round(tierRaw)));
    const t = GEAR_TIERS[tier]!;
    // Tier 0 (Latent) is the UNFORGED state — an empty socket, not an item.
    const empty = tier === 0;
    const box = el("div", {
      class: empty ? "box empty" : "box",
      style: empty
        ? `background-image:url("${SLOT_ICONS[def.key]}")`
        : `background-image:url("${SLOT_ICONS[def.key]}");border-color:${t.color};box-shadow:0 0 12px ${t.color}55`,
    });
    const up = el("button", { class: "up", type: "button" }) as HTMLButtonElement;
    if (t.cost === null) {
      up.textContent = "MAX";
      up.classList.add("max");
      up.disabled = true;
    } else {
      up.textContent = empty ? `Forge · ${fmt(t.cost)} ◈` : `Upgrade · ${fmt(t.cost)} ◈`;
      up.addEventListener("click", () => doUpgrade(def, up));
    }
    const cap = GEAR_SET_BONUS[Math.min(tier, GEAR_SET_BONUS.length - 1)] ?? 0;
    const tile = el(
      "div",
      { class: "slot" },
      box,
      el("div", { class: "lb" }, def.label),
      empty
        ? el("div", { class: "tn", style: "color:#8a7a58" }, "Empty")
        : el("div", { class: "tn", style: `color:${t.color}` }, t.name),
      empty
        ? el("div", { class: "qu" }, "unforged")
        : el("div", { class: "qu", style: `color:${t.color}` }, t.quality),
      // The slot's stat: the set damage its tier supports (the set itself pays
      // the LOWEST slot's number — the tooltip and set tile teach that part).
      el("div", { class: "st" }, `set dmg +${pct(cap)}%`),
      el(
        "div",
        { class: "lv", "aria-label": `tier ${tier} of ${MAX_GEAR_TIER}` },
        "●".repeat(tier) + "○".repeat(MAX_GEAR_TIER - tier)
      ),
      up
    );
    attachTip(tile, () => slotTipContent(def, tier));
    return tile;
  }

  function doUpgrade(def: SlotDef, btn: HTMLButtonElement): void {
    btn.disabled = true;
    err.replaceChildren();
    upgradeGear(def.key)
      .then((res) => {
        playSfx("ui.forge");
        // Re-render this slot, the set tile, and the balance in place; push
        // the HUD chip and the fight loadout cache too.
        refreshImaginz(res.imaginz);
        bal.textContent = `◈ ${fmt(res.imaginz)} Imaginz`;
        gearState[def.key] = res.tier;
        setLoadoutState({ gear: gearState });
        const idx = SLOTS.indexOf(def);
        const fresh = renderSlot(def, res.tier);
        slots.children[idx]?.replaceWith(fresh);
        slots.children[SLOTS.length]?.replaceWith(renderSetTile());
        // The hovered tile was just swapped out from under the cursor; hide the
        // stale tooltip and let the fresh tile's mousemove rebuild it.
        hideTip();
      })
      .catch((ex) => {
        btn.disabled = false;
        if (ex instanceof ApiError && ex.status === 402) {
          const needed = typeof ex.data.needed === "number" ? ex.data.needed : null;
          const balance = typeof ex.data.balance === "number" ? ex.data.balance : null;
          if (balance !== null) {
            bal.textContent = `◈ ${fmt(balance)} Imaginz`;
            refreshImaginz(balance);
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
          err.textContent = ex instanceof Error ? ex.message : "Upgrade failed.";
        }
      });
  }

  load();
}
