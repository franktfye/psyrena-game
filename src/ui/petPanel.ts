/**
 * Pet Park panel — the pet loadout slot. Opened by tapping the Pet Park
 * attendant in the village hub.
 *
 * The roster is account-owned: every pet is equippable by any hero, except
 * hero-exclusive ones (Druzhok walks only beside Pavlov). The selection lives
 * in the wardrobe store (state/wardrobe.ts), local-only until loadouts become
 * server-owned. Same plain-DOM discipline as roomsPanel.ts — nothing here
 * touches a scene.
 */

import type { Profile } from "./authFlow";
import { wardrobe } from "../state/wardrobe";
import {
  PET_LOOT,
  PET_MAX_LEVEL,
  PET_STAT_LADDER,
  PET_UPGRADE_COST,
  petSpec,
  type PetStatKind,
} from "../../shared/progression";
import {
  onLoadoutChange,
  ownedPets,
  petLevel,
  setLoadoutState,
  shardCount,
  syncLoadout,
} from "../state/loadout";
import { adoptPet, ApiError, upgradePet } from "../net/economy";
import { refreshImaginz } from "./playerHud";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_ROW,
  WOW_GOLD_TEXT, WOW_TEXT_DIM, WOW_GOLD,
} from "./wowChrome";

/** Short label per identity stat — the second line on every pet tile. */
const STAT_LABEL: Record<PetStatKind, string> = {
  attack: "ATK",
  healing: "HEAL",
  hp: "HP",
  focus: "FOCUS",
};

/**
 * Mirror of PET_PARK_ROSTER in scenes/petFollower.ts (the park's actual
 * inhabitants) — keep the ids in sync when that roster changes. That module
 * imports Babylon loader code, and a DOM panel that must open anywhere should
 * not drag a 3D dependency in for seven names and avatars.
 *
 * `heroId` marks a pet that belongs to one hero: it is equippable only while
 * that hero is the selected one, and locked with a reason otherwise. Druzhok
 * is the first — Pavlov's dog is not a cosmetic anyone can borrow.
 */
const PETS: { id: string; name: string; avatar: string; heroId?: string; note?: string }[] = [
  {
    id: "druzhok",
    name: "Druzhok",
    avatar: "/assets/ui/pets/druzhok.webp",
    heroId: "pavlov",
    note: "Pavlov's own dog",
  },
  { id: "robot", name: "Robot", avatar: "/assets/ui/pets/robot.webp" },
  { id: "corgi", name: "Corgi", avatar: "/assets/ui/pets/corgi.webp" },
  { id: "husky", name: "Husky", avatar: "/assets/ui/pets/husky.webp" },
  { id: "blackcat", name: "Black Cat", avatar: "/assets/ui/pets/blackcat.webp" },
  { id: "dino", name: "Dino", avatar: "/assets/ui/pets/dino.webp" },
  { id: "unicorn", name: "Unicorn", avatar: "/assets/ui/pets/unicorn.webp" },
];

const CSS = `
#pet-park {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; place-items: center; padding: 18px 10px;
}
#pet-park .card {
  width: min(560px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#pet-park .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
/* Icon art is a rounded tile on a square canvas — crop into the center so
   the light corner padding never shows as a gap around the tile. */
#pet-park .head .icon {
  width: 26px; height: 26px; border-radius: 0; overflow: hidden; flex-shrink: 0;
  border: 1px solid #5a4620; background: #120d05;
}
#pet-park .head .icon img {
  width: 100%; height: 100%; object-fit: cover; object-position: center;
  display: block; transform: scale(1.28);
}
#pet-park .head h1 {
  margin: 0; font-size: 15px; letter-spacing: .34em; font-weight: 700; flex: 1;
  ${WOW_GOLD_TEXT}
}
#pet-park .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#pet-park .close:hover { ${WOW_BTN_HOVER} }
#pet-park .grid {
  padding: 18px 16px 20px; display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
}
#pet-park .pet {
  position: relative; display: grid; gap: 6px; padding: 10px 8px 9px;
  text-align: center; cursor: pointer; font: inherit; color: #e8d9b0;
  transition: border-color .12s ease, transform .12s ease;
  ${WOW_ROW}
}
#pet-park .pet .ph {
  width: 100%; aspect-ratio: 1; border-radius: 0; display: grid; place-items: center;
  border: 1px solid #5a4620; font-size: 26px; overflow: hidden;
  background: #120d05;
}
/* Zoom past the tile's outer corners so only the subject + fill show. */
#pet-park .pet .ph img {
  width: 100%; height: 100%; object-fit: cover; object-position: center;
  display: block; transform: scale(1.22);
}
#pet-park .pet .nm { font-size: 12px; letter-spacing: .04em; }
#pet-park .pet .note { font-size: 10px; color: ${WOW_TEXT_DIM}; opacity: .85; }
#pet-park .pet:hover:not(.locked) { border-color: ${WOW_GOLD}; transform: translateY(-2px); }
#pet-park .pet.equipped { border-color: ${WOW_GOLD}; box-shadow: 0 0 14px #e2c47c40; }
#pet-park .pet .tag {
  position: absolute; top: 6px; left: 6px; font-size: 9px; letter-spacing: .18em;
  text-transform: uppercase; border: 1px solid #e2c47c88; border-radius: 0;
  padding: 1px 6px; color: ${WOW_GOLD}; background: #0b0804cc;
}
#pet-park .pet .lock {
  position: absolute; top: 6px; right: 6px; font-size: 11px; line-height: 1;
  width: 20px; height: 20px; border-radius: 0; display: grid; place-items: center;
  border: 1px solid #5a4620; background: #0b0804cc; color: ${WOW_TEXT_DIM};
}
#pet-park .pet.locked { cursor: default; opacity: .72; }
#pet-park .pet.locked .ph img { filter: saturate(.55) brightness(.85); }
/* Unowned pool pet: a silhouette waiting in the caches — dimmer than a
   hero-lock, because shards CAN reach it. */
#pet-park .pet.unowned { cursor: default; }
#pet-park .pet.unowned .ph img { filter: grayscale(.9) brightness(.55); }
#pet-park .head .shards { font-size: 12px; color: #9ad1ff; letter-spacing: .08em; white-space: nowrap; }
#pet-park .intro {
  padding: 10px 16px 0; font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .85;
  letter-spacing: .05em; text-align: center;
}
#pet-park .pet .stats { font-size: 10px; color: #cdeaff; letter-spacing: .03em; }
#pet-park .pet .lv { font-size: 10px; letter-spacing: .34em; color: ${WOW_GOLD}; }
/* Upgrade/adopt — same tiny-but-readable treatment as the gear panel's .up:
   the price must FIT, on a 118px mobile tile too, so 8px and no ellipsis. */
#pet-park .pet .act {
  padding: 4px 5px; font: inherit; font-size: 8px; letter-spacing: .02em;
  white-space: nowrap; max-width: 100%;
  ${WOW_BTN}
}
#pet-park .pet .act:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#pet-park .pet .act:disabled { opacity: .45; cursor: default; }
#pet-park .pet .act.max { border-color: #e2c47c66; color: #ecc363; cursor: default; }
#pet-park .pet .act.short { border-color: #ff5964; color: #ff8896; }
#pet-park .pet .act.adopt { border-color: #9ad1ff66; color: #9ad1ff; }
/* Small screens: full-screen card, scrolling inside it. */
@media (pointer: coarse), (max-width: 640px) {
  #pet-park { padding: 0; }
  #pet-park .card {
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

/** The open panel's close fn, so the left dock can toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closePetPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openPetPanel(profile: Profile): void {
  if (document.getElementById("pet-park")) return;
  if (!document.getElementById("pet-park-css")) {
    document.head.append(el("style", { id: "pet-park-css" }, CSS));
  }

  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const grid = el("div", { class: "grid" });
  const shards = el("div", { class: "shards" }, "✦ —");

  const overlay = el(
    "div",
    { id: "pet-park" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("span", { class: "icon" }, el("img", { src: "/assets/ui/gear/slot-pet.webp", alt: "" })),
        el("h1", {}, "PET PARK — PETS"),
        shards,
        close
      ),
      el(
        "div",
        { class: "intro" },
        `Pets are companions with benefits: every pet boosts YOUR stats, upgraded ${PET_MAX_LEVEL} times with Imaginz. ` +
          `New pets drop from boss caches — every cache also pays ✦ shards, and ${PET_LOOT.adoptCost} ✦ adopts the pet of your choice.`
      ),
      grid
    )
  );

  /** Both stats at this level, as one compact line: "HP +8% · ATK +8%". */
  function statLine(petId: string, level: number): string {
    const spec = petSpec(petId);
    if (!spec) return "";
    const v = Math.round((PET_STAT_LADDER[level] ?? PET_STAT_LADDER[0]) * 100);
    if (spec.stat2 === "hp") return `HP +${v * 2}%`; // both stats are HP — one honest number
    return `HP +${v}% · ${STAT_LABEL[spec.stat2]} +${v}%`;
  }

  function render(): void {
    grid.replaceChildren();
    shards.textContent = `✦ ${shardCount()} shards`;

    const none = el(
      "button",
      { class: `pet${wardrobe.pet === null ? " equipped" : ""}`, type: "button" },
      el("div", { class: "ph" }, "—"),
      el("div", { class: "nm" }, "No Pet"),
      ...(wardrobe.pet === null ? [el("span", { class: "tag" }, "Equipped")] : [])
    );
    none.addEventListener("click", () => wardrobe.setPet(null));
    grid.append(none);

    const owned = ownedPets();
    for (const p of PETS) {
      // Three tile states (docs/09): hero-exclusives are implicitly owned by
      // their hero and hero-locked for everyone else; pool pets are owned
      // once a cache dropped them (or shards adopted them) and silhouettes
      // until then. Owned tiles equip on tap and level up with Imaginz;
      // silhouettes adopt with shards.
      const exclusive = p.heroId !== undefined;
      const heroMatch = !exclusive || p.heroId === profile.selectedHero;
      const isOwned = exclusive ? heroMatch : p.id in owned;
      const level = petLevel(p.id);
      const equipped = isOwned && wardrobe.pet === p.id;

      const cls = exclusive && !heroMatch ? "pet locked" : isOwned ? `pet${equipped ? " equipped" : ""}` : "pet unowned";
      const tile = el(
        "div",
        { class: cls, role: "button", tabindex: "0" },
        el("div", { class: "ph" }, el("img", { src: p.avatar, alt: "" })),
        ...(equipped ? [el("span", { class: "tag" }, "Equipped")] : []),
        ...(exclusive && !heroMatch ? [el("span", { class: "lock", "aria-hidden": "true" }, "🔒")] : []),
        el("div", { class: "nm" }, p.name),
        el(
          "div",
          { class: "stats" },
          isOwned ? statLine(p.id, level) : statLine(p.id, 0)
        ),
        // ● per level earned, ○ per level to go — the 3-upgrade track at a glance.
        el("div", { class: "lv", "aria-label": `level ${level} of ${PET_MAX_LEVEL}` },
          "●".repeat(level) + "○".repeat(PET_MAX_LEVEL - level))
      );

      if (exclusive && !heroMatch) {
        tile.append(
          el("div", { class: "note" }, `${p.heroId?.[0]?.toUpperCase()}${p.heroId?.slice(1)} only`)
        );
      } else if (isOwned) {
        if (p.note) tile.append(el("div", { class: "note" }, p.note));
        tile.append(upgradeButton(p.id, level));
        tile.addEventListener("click", () => wardrobe.setPet(equipped ? null : p.id));
      } else {
        tile.append(el("div", { class: "note" }, "Drops from boss caches"), adoptButton(p.id));
      }
      grid.append(tile);
    }
  }

  function upgradeButton(petId: string, level: number): HTMLButtonElement {
    const btn = el("button", { class: "act", type: "button" }) as HTMLButtonElement;
    if (level >= PET_MAX_LEVEL) {
      btn.textContent = "MAX";
      btn.classList.add("max");
      btn.disabled = true;
      return btn;
    }
    const cost = PET_UPGRADE_COST[level] ?? 0;
    btn.textContent = `Level up · ${cost.toLocaleString("en-US")} ◈`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // the tile underneath equips — a price tap must not
      btn.disabled = true;
      upgradePet(petId)
        .then((res) => {
          refreshImaginz(res.imaginz);
          setLoadoutState({ pets: { ...ownedPets(), [petId]: res.level } }); // re-renders via listener
        })
        .catch((ex) => {
          btn.disabled = false;
          flashShort(btn, ex, `Level up · ${cost.toLocaleString("en-US")} ◈`);
        });
    });
    return btn;
  }

  function adoptButton(petId: string): HTMLButtonElement {
    const have = shardCount();
    const btn = el("button", { class: "act adopt", type: "button" }) as HTMLButtonElement;
    if (have >= PET_LOOT.adoptCost) {
      btn.textContent = `Adopt · ${PET_LOOT.adoptCost} ✦`;
    } else {
      // Disabled but still a progress bar in words — the pity floor visible.
      btn.textContent = `${have}/${PET_LOOT.adoptCost} ✦`;
      btn.disabled = true;
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      adoptPet(petId)
        .then((res) => {
          setLoadoutState({ pets: { ...ownedPets(), [petId]: res.level }, shards: res.shards });
        })
        .catch((ex) => {
          btn.disabled = false;
          flashShort(btn, ex, `Adopt · ${PET_LOOT.adoptCost} ✦`);
        });
    });
    return btn;
  }

  /** 402 shortfall flash, same treatment as the gear panel's upgrade button. */
  function flashShort(btn: HTMLButtonElement, ex: unknown, label: string): void {
    btn.classList.add("short");
    btn.textContent =
      ex instanceof ApiError && ex.status === 402
        ? typeof ex.data.needed === "number"
          ? `Need ${ex.data.needed.toLocaleString("en-US")} more`
          : "Not enough"
        : ex instanceof Error
          ? ex.message
          : "Failed";
    window.setTimeout(() => {
      btn.classList.remove("short");
      btn.textContent = label;
      }, 1600);
  }

  // The equipped badge follows the wardrobe; ownership, levels and the shard
  // count follow the loadout store (hydrated from /api/economy below).
  const offWardrobe = wardrobe.onChange(render);
  const offLoadout = onLoadoutChange(render);
  void syncLoadout();

  const shut = (): void => {
    closeActive = null;
    offWardrobe();
    offLoadout();
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

  render();
  document.body.append(overlay);
}
