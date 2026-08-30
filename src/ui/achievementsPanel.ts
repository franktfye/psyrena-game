/**
 * Achievements panel — the 33-achievement list with category tabs, progress
 * bars, and title equip/unequip (docs/05). Opened from the left dock.
 *
 * Same plain-DOM panel skeleton as hallPanel.ts: one injected CSS block, a
 * fixed overlay with a card, close via ✕ / Escape / backdrop. The list is
 * fetched once per open; equipping a title pushes the change straight into
 * the player HUD (refreshTitle) and the hero's floating title tag
 * (setLocalHeroTitle) so every surface agrees without a reload.
 */

import {
  getAchievements,
  equipTitle,
  type AchievementDef,
  type AchievementCategory,
  type TitleState,
} from "../net/achievements";
import { refreshTitle } from "./playerHud";
import { setLocalHeroTitle } from "../scenes/villageHub";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_ROW,
  WOW_GOLD_TEXT, WOW_TEXT_DIM, WOW_GOLD,
} from "./wowChrome";

const CSS = `
#achievements-panel {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; place-items: center; padding: 18px 10px;
}
#achievements-panel .card {
  width: min(560px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#achievements-panel .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#achievements-panel .head img { width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620; }
#achievements-panel .head h1 {
  margin: 0; font-size: 15px; letter-spacing: .34em; font-weight: 700; flex: 1;
  ${WOW_GOLD_TEXT}
}
#achievements-panel .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#achievements-panel .close:hover { ${WOW_BTN_HOVER} }
#achievements-panel .tabs { display: flex; gap: 4px; padding: 10px 16px 0; flex-wrap: wrap; }
#achievements-panel .body {
  padding: 12px 16px 18px; display: grid; gap: 8px; align-content: start;
  overflow-y: auto; max-height: min(58vh, 520px);
}
#achievements-panel .sub {
  font-size: 11px; color: ${WOW_TEXT_DIM}; letter-spacing: .08em;
}
#achievements-panel .empty {
  font-size: 12px; color: ${WOW_TEXT_DIM}; opacity: .75; text-align: center;
  padding: 10px; border: 1px dashed #5a4620; border-radius: 0;
}
#achievements-panel .row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  ${WOW_ROW}
}
#achievements-panel .row.locked { opacity: .45; }
#achievements-panel .row.locked .ic img { filter: grayscale(1); }
#achievements-panel .row .ic {
  width: 40px; height: 40px; flex: none; border-radius: 0;
  border: 1px solid #5a4620; background: #120d05;
  display: grid; place-items: center; overflow: hidden;
  color: ${WOW_GOLD}; font-size: 16px;
}
#achievements-panel .row .ic img { width: 100%; height: 100%; object-fit: cover; display: block; }
#achievements-panel .row .grow { flex: 1; min-width: 0; }
#achievements-panel .row .nm { letter-spacing: .05em; }
#achievements-panel .row .meta { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .9; }
#achievements-panel .row .new {
  font-size: 9px; letter-spacing: .18em; text-transform: uppercase;
  border: 1px solid #ecc36366; border-radius: 0; padding: 1px 6px; color: #ecc363;
  margin-left: 6px; vertical-align: 1px;
}
#achievements-panel .row .bar {
  margin-top: 6px; height: 4px; border-radius: 0; overflow: hidden;
  background: #0b0804; border: 1px solid #3a2d14;
}
#achievements-panel .row .bar .fill {
  height: 100%; background: linear-gradient(90deg, #5a4620, #b0914e);
  transition: width .25s ease;
}
#achievements-panel .row.done .bar .fill { background: linear-gradient(90deg, #8a6d2f, #ecc363); }
#achievements-panel .row .side { flex: none; display: grid; gap: 6px; justify-items: end; }
#achievements-panel .row .prog { font-size: 11px; color: ${WOW_TEXT_DIM}; }
#achievements-panel .row.done .prog { color: #ecc363; }
#achievements-panel .tchip {
  font-size: 10px; letter-spacing: .08em; color: #ecc363;
  border: 1px solid #ecc36355; border-radius: 0; padding: 1px 6px;
  width: fit-content; margin-top: 4px;
}
#achievements-panel .eq {
  padding: 3px 10px; font: inherit; font-size: 11px; color: #ecc363;
  ${WOW_BTN}
  border-color: #8a6d2f;
}
#achievements-panel .eq:hover:not(:disabled) { border-color: #ecc363; color: #ffe9b0; }
#achievements-panel .eq:disabled { opacity: .5; cursor: default; }
#achievements-panel .err { color: #ff8896; font-size: 12px; }
#achievements-panel .err button {
  padding: 4px 10px; font: inherit; font-size: 11px; margin-left: 8px;
  ${WOW_BTN}
}
#achievements-panel .err button:hover { ${WOW_BTN_HOVER} }
/* Small screens: full-screen card, scrolling inside it. */
@media (pointer: coarse), (max-width: 640px) {
  #achievements-panel { padding: 0; }
  #achievements-panel .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    /* Safe-area: keep full-bleed card content clear of the iPhone camera housing. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
    overflow-y: auto;
  }
  #achievements-panel .body { max-height: none; }
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

const TABS: { key: AchievementCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "collection", label: "Collection" },
  { key: "ranking", label: "Ranking" },
  { key: "damage", label: "Damage" },
  { key: "levels", label: "Levels" },
  { key: "boss", label: "Boss" },
  { key: "friends", label: "Friends" },
  { key: "gear", label: "Gear" },
];

/** The open panel's close fn, so the left dock can toggle it shut. */
let closeActive: (() => void) | null = null;

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeAchievementsPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

/** Idempotent — a second open while the panel is up does nothing. */
export function openAchievementsPanel(): void {
  if (document.getElementById("achievements-panel")) return;
  if (!document.getElementById("achievements-css")) {
    document.head.append(el("style", { id: "achievements-css" }, CSS));
  }

  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const sub = el("div", { class: "sub" }, " ");
  const tabsEl = el("div", { class: "tabs" });
  const body = el("div", { class: "body" }, el("div", { class: "empty" }, "Reading the records…"));

  let active: AchievementCategory | "all" = "all";
  let achievements: AchievementDef[] = [];
  let titles: TitleState = { owned: [], equipped: null };

  const renderTabs = (): void => {
    tabsEl.replaceChildren(
      ...TABS.map(({ key, label }) => {
        const isActive = active === key;
        const tab = el("button", {
          type: "button",
          style: [
            "border:1px solid transparent",
            "border-radius:0",
            "padding:4px 8px",
            "font:inherit",
            "font-size:10px",
            "letter-spacing:.1em",
            "text-transform:uppercase",
            "cursor:pointer",
            "white-space:nowrap",
            isActive ? "background:#120d05;border-color:#5a4620;color:#f4e3b2" : "background:transparent;color:#b8a878",
          ].join(";"),
        }, label);
        tab.addEventListener("click", () => {
          active = key;
          renderTabs();
          renderList();
        });
        return tab;
      })
    );
  };

  const equipButton = (a: AchievementDef): HTMLElement => {
    const equipped = a.title !== null && titles.equipped === a.title;
    const btn = el("button", { class: "eq", type: "button" }, equipped ? "Unequip" : "Equip");
    btn.addEventListener("click", () => {
      btn.disabled = true;
      equipTitle(equipped ? null : a.title)
        .then((res) => {
          titles.equipped = res.title ?? null;
          if (res.title && !titles.owned.includes(res.title)) titles.owned.push(res.title);
          // Push to the other surfaces: HUD name line + the hero's floating tag.
          refreshTitle(titles.equipped);
          setLocalHeroTitle(titles.equipped);
          renderList();
        })
        .catch(() => {
          btn.disabled = false;
        });
    });
    return btn;
  };

  const row = (a: AchievementDef): HTMLElement => {
    // Fallback tinted tile sits under the img; a missing icon hides the img
    // and leaves the tile rather than a broken-image glyph.
    const img = el("img", { src: a.icon, alt: "" });
    img.addEventListener("error", () => (img.style.display = "none"));
    const ic = el("div", { class: "ic" }, img);

    const nm = el("div", { class: "nm" }, a.name);
    if (a.isNew) nm.append(el("span", { class: "new" }, "NEW"));

    const grow = el("div", { class: "grow" }, nm, el("div", { class: "meta" }, a.desc));
    if (a.title) {
      grow.append(el("div", { class: "tchip" }, `Title: ${a.title}`));
    }

    const pct = a.unlocked ? 100 : Math.max(0, Math.min(100, (100 * a.progress) / Math.max(1, a.target)));
    grow.append(
      el("div", { class: "bar" }, el("div", { class: "fill", style: `width:${pct}%` }))
    );

    const side = el(
      "div",
      { class: "side" },
      el("div", { class: "prog" }, a.unlocked ? "Done" : `${a.progress} / ${a.target}`)
    );
    if (a.title && a.unlocked) side.append(equipButton(a));

    return el("div", { class: a.unlocked ? "row done" : "row locked" }, ic, grow, side);
  };

  const renderList = (): void => {
    const list =
      active === "all" ? achievements : achievements.filter((a) => a.category === active);
    if (list.length === 0) {
      body.replaceChildren(el("div", { class: "empty" }, "Nothing etched here yet."));
      return;
    }
    body.replaceChildren(...list.map(row));
  };

  const load = (): void => {
    body.replaceChildren(el("div", { class: "empty" }, "Reading the records…"));
    getAchievements()
      .then((r) => {
        achievements = r.achievements;
        titles = r.titles;
        const done = achievements.filter((a) => a.unlocked).length;
        sub.textContent = `${done} / ${achievements.length} unlocked`;
        renderList();
      })
      .catch((ex) => {
        const err = el(
          "div",
          { class: "err" },
          ex instanceof Error ? ex.message : "The records are unreachable."
        );
        const retry = el("button", { type: "button" }, "Retry");
        retry.addEventListener("click", load);
        err.append(retry);
        body.replaceChildren(err);
      });
  };

  renderTabs();
  load();

  const overlay = el(
    "div",
    { id: "achievements-panel" },
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("img", { src: "/assets/ui/achievements/achievements.webp", alt: "" }),
        el("h1", {}, "ACHIEVEMENTS"),
        close
      ),
      el("div", { style: "padding:8px 16px 0" }, sub),
      tabsEl,
      body
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
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) shut();
  });
  window.addEventListener("keydown", onKey);
  closeActive = shut;

  document.body.append(overlay);
}
