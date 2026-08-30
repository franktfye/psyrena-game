/**
 * Loot panel — two faces of the same module:
 *
 *  - `openLootResult(result, win)` — the post-fight overlay: Victory/Defeat,
 *    score + rating, the Imaginz award, and the awarded cache with an Open
 *    button that rolls it via /api/loot/open.
 *  - `openLootInventory()` — unopened caches from /api/economy (the gear
 *    panel's "Caches (N)" button), each with the same Open flow.
 *
 * Same plain-DOM discipline as the other panels: one module, one injected
 * stylesheet, nothing here touches a scene. The arena's 3D loot box re-opens
 * the last result through `reopenLastLoot()`.
 */

import {
  getEconomy,
  openLoot,
  LOOT_TIERS,
  type FightResultResponse,
  type LootBox,
} from "../net/economy";
import { petSpec } from "../../shared/progression";
import { syncLoadout } from "../state/loadout";
import { refreshImaginz } from "./playerHud";
import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER,
  WOW_ROW, WOW_GOLD_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";

const CSS = `
#loot {
  position: fixed; inset: 0; z-index: 45; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 14px/1.5 ${WOW_FONT};
  display: grid; place-items: center; padding: 18px 10px;
}
#loot .card {
  width: min(480px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#loot .head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#loot .head h1 { margin: 0; font-size: 16px; letter-spacing: .3em; font-weight: 700; flex: 1; }
#loot .head h1.win { ${WOW_GOLD_TEXT} filter: drop-shadow(0 0 14px #ffd97a44); }
#loot .head h1.loss { color: #9a8f77; }
#loot .close {
  width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#loot .close:hover { ${WOW_BTN_HOVER} }
#loot .body { padding: 18px 16px 20px; display: grid; gap: 14px; justify-items: center; }
#loot .stats { display: flex; gap: 18px; flex-wrap: wrap; justify-content: center; }
#loot .stat { display: grid; gap: 2px; justify-items: center; }
#loot .stat .v { font-size: 17px; color: #f4e3b2; letter-spacing: .06em; }
#loot .stat .k { font-size: 9px; letter-spacing: .22em; color: ${WOW_TEXT_DIM}; text-transform: uppercase; }
#loot .gain { font-size: 15px; color: #ecc363; letter-spacing: .1em; }
#loot .boxrow { display: grid; gap: 8px; justify-items: center; }
#loot .boxrow img { width: 96px; height: 96px; object-fit: contain; filter: drop-shadow(0 0 14px #e2c47c33); }
#loot .boxrow .nm { font-size: 12px; letter-spacing: .18em; color: ${WOW_TEXT_DIM}; text-transform: uppercase; }
#loot button.cta { ${WOW_CTA} }
#loot button.cta:hover:not(:disabled) { ${WOW_CTA_HOVER} }
#loot button.cta:disabled { opacity: .35; cursor: default; }
#loot button.mini {
  padding: 6px 10px; font-size: 11px;
  ${WOW_BTN}
}
#loot button.mini:hover:not(:disabled) { ${WOW_BTN_HOVER} }
#loot button.mini:disabled { opacity: .4; cursor: default; }
#loot .note { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .8; letter-spacing: .06em; text-align: center; }
#loot .err { color: #ff8896; font-size: 12px; min-height: 16px; text-align: center; }
#loot .reveal {
  font-size: 22px; color: #ecc363; letter-spacing: .12em;
  text-shadow: 0 0 18px #ecc36388; animation: lootPop .5s ease-out;
}
#loot .shardline {
  font-size: 12px; color: #9ad1ff; letter-spacing: .1em;
  animation: lootPop .5s ease-out .12s backwards;
}
/* The 2% moment — a pet fell out of the cache. */
#loot .petjackpot {
  display: grid; gap: 4px; justify-items: center; padding: 6px 0 2px;
  animation: lootPop .6s ease-out .2s backwards;
}
#loot .petjackpot img {
  width: 64px; height: 64px; object-fit: cover; border: 1px solid #e2c47c;
  box-shadow: 0 0 22px #ecc36366; background: #120d05;
}
#loot .petjackpot .pn { font-size: 13px; letter-spacing: .18em; ${WOW_GOLD_TEXT} }
#loot .petjackpot .pk { font-size: 9px; letter-spacing: .26em; color: #9ad1ff; text-transform: uppercase; }
@keyframes lootPop {
  0% { transform: scale(.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); }
}
#loot .row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; width: 100%;
  box-sizing: border-box;
  ${WOW_ROW}
}
#loot .row img { width: 40px; height: 40px; object-fit: contain; }
#loot .row .grow { flex: 1; min-width: 0; }
#loot .row .nm { letter-spacing: .05em; }
#loot .row .meta { font-size: 11px; color: ${WOW_TEXT_DIM}; opacity: .9; }
#loot .empty { font-size: 12px; color: ${WOW_TEXT_DIM}; opacity: .7; text-align: center; padding: 6px; }
/* Small screens: full-screen card (same treatment as the other panels). */
@media (pointer: coarse), (max-width: 640px) {
  #loot { padding: 0; }
  #loot .card {
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

/** The open panel's close fn, so a re-open can replace it cleanly. */
let closeActive: (() => void) | null = null;

/** Last fight result, kept so the arena's 3D loot box can open it. */
let lastResult: { result: FightResultResponse | null; win: boolean } | null = null;

/**
 * Remember a fight result WITHOUT opening the overlay. The victory path uses
 * this: no popup on the kill (and none surviving into the village) — the
 * result waits inside the 3D cache beside the dead boss, and an uncollected
 * cache is still claimable from the hub's unclaimed-cache prop (the server
 * ledger, not this variable, is what persists it).
 */
export function stashLootResult(result: FightResultResponse | null, win: boolean): void {
  lastResult = { result, win };
}

/**
 * One listener fired after ANY cache roll succeeds. The village hub's
 * unclaimed-cache prop uses it to re-check the ledger and vanish once the
 * last box is opened — registered per hub scene, cleared on scene dispose.
 */
let cacheOpenedListener: (() => void) | null = null;
export function setCacheOpenedListener(fn: (() => void) | null): void {
  cacheOpenedListener = fn;
}

/** Close the panel if it is up. Returns true when there was something to close. */
export function closeLootPanel(): boolean {
  if (!closeActive) return false;
  closeActive();
  return true;
}

function openShell(title: string, titleClass = ""): { body: HTMLElement; shut: () => void } {
  closeLootPanel();
  if (!document.getElementById("loot-css")) {
    document.head.append(el("style", { id: "loot-css" }, CSS));
  }
  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");
  const body = el("div", { class: "body" });
  const overlay = el(
    "div",
    { id: "loot" },
    el(
      "div",
      { class: "card" },
      el("div", { class: "head" }, el("h1", { class: titleClass }, title), close),
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
  return { body, shut };
}

/**
 * One cache row with an Open button — shared by the result overlay and the
 * inventory. On a successful roll the row flips to the reveal; on failure the
 * error lands on `errEl`.
 */
function cacheRow(box: { id: string; tier: number; name: string }, errEl: HTMLElement): HTMLElement {
  const row = el(
    "div",
    { class: "row" },
    el("img", { src: `/assets/ui/gear/lootbox-${box.tier}.webp`, alt: box.name }),
    el(
      "div",
      { class: "grow" },
      el("div", { class: "nm" }, box.name),
      el("div", { class: "meta" }, LOOT_TIERS[box.tier] ?? `tier ${box.tier}`)
    )
  );
  const openBtn = el("button", { class: "mini", type: "button" }, "Open");
  openBtn.addEventListener("click", () => {
    openBtn.disabled = true;
    errEl.textContent = "";
    openLoot(box.id)
      .then((res) => {
        refreshImaginz(res.balance);
        const reveal = el(
          "div",
          { style: "margin:auto;display:grid;gap:2px;justify-items:center" },
          el("div", { class: "reveal" }, `+${fmt(res.imaginz)} ◈`)
        );
        // Shards land on every open (docs/09 §4) — the pity floor, visible.
        if (res.shardsGained > 0) {
          reveal.append(
            el("div", { class: "shardline" }, `+${res.shardsGained} ✦ pet shards (${fmt(res.shards)} total)`)
          );
        }
        // The whole-pet jackpot: rare on purpose, so it gets the fanfare.
        const pet = petSpec(res.pet);
        if (pet) {
          reveal.append(
            el(
              "div",
              { class: "petjackpot" },
              el("img", { src: `/assets/ui/pets/${pet.id}.webp`, alt: pet.name }),
              el("div", { class: "pn" }, `${pet.name} joins you!`),
              el("div", { class: "pk" }, "new pet — visit the pet park")
            )
          );
        }
        row.replaceChildren(reveal);
        // Keep the loadout cache honest (shards, a possibly new pet).
        void syncLoadout();
        cacheOpenedListener?.();
      })
      .catch((ex) => {
        openBtn.disabled = false;
        errEl.textContent = ex instanceof Error ? ex.message : "Could not open the cache.";
      });
  });
  row.append(openBtn);
  return row;
}

/** Record kinds as the server names them (economy.mjs `settleFight`). */
function pbLabel(kind: string): string {
  return kind === "dps" ? "damage" : kind === "time" ? "fastest clear" : "score";
}

/**
 * The post-fight overlay. `result` is null when the report POST failed — the
 * fight UI never breaks on network errors, the rewards simply show as
 * unavailable.
 */
export function openLootResult(result: FightResultResponse | null, win: boolean): void {
  lastResult = { result, win };
  const { body } = openShell(win ? "VICTORY" : "DEFEAT", win ? "win" : "loss");
  const errEl = el("div", { class: "err" });

  if (!result) {
    body.append(
      el("div", { class: "note" }, "Rewards unavailable — the result could not reach the server."),
      errEl,
      laterButton()
    );
    return;
  }

  if (result.practice) {
    // Practice receipt: no score/rating theatre — the run was a rehearsal.
    body.append(
      el("div", { class: "note" }, "Practice run — no ranked records were touched."),
      el(
        "div",
        { class: "gain" },
        result.imaginzAwarded > 0
          ? `+${fmt(result.imaginzAwarded)} ◈ Imaginz (${result.practice.today}/${result.practice.cap} today)`
          : `Daily practice Imaginz spent (${result.practice.cap}/${result.practice.cap}) — runs stay free.`
      )
    );
    body.append(errEl, laterButton());
    return;
  }
  body.append(
    el(
      "div",
      { class: "stats" },
      stat(String(result.score), "score"),
      stat(String(result.rating), "rating"),
      stat(result.seasonId, "season")
    ),
    el("div", { class: "gain" }, `+${fmt(result.imaginzAwarded)} ◈ Imaginz`)
  );
  // The +20% is already inside imaginzAwarded; this line is why it is bigger.
  if (result.personalBest) {
    body.append(
      el(
        "div",
        { class: "gain", style: "color:#ffc94d" },
        `New personal best (${result.personalBest.kinds.map(pbLabel).join(", ")}) — +${fmt(result.personalBest.bonus)} ◈`
      )
    );
  }
  if (result.lootBox) {
    body.append(el("h1", { style: "margin:0;font-size:11px;letter-spacing:.3em;color:#b8a878" }, "CACHE RECOVERED"));
    body.append(cacheRow(result.lootBox, errEl));
  }
  body.append(errEl, laterButton());

  function stat(v: string, k: string): HTMLElement {
    return el("div", { class: "stat" }, el("div", { class: "v" }, v), el("div", { class: "k" }, k));
  }
  function laterButton(): HTMLElement {
    const b = el("button", { class: "cta", type: "button" }, "Later");
    b.addEventListener("click", () => closeLootPanel());
    return b;
  }
}

/** Re-open the last fight result (the arena's 3D loot box click). */
export function reopenLastLoot(): void {
  if (lastResult) openLootResult(lastResult.result, lastResult.win);
}

/** Unopened caches from the economy ledger — the gear panel's "Caches (N)". */
export function openLootInventory(): void {
  const { body } = openShell("CACHES");
  const errEl = el("div", { class: "err" });
  const list = el("div", { style: "display:grid;gap:8px;width:100%" });
  body.append(list, errEl);
  list.append(el("div", { class: "empty" }, "Consulting the ledger…"));

  const load = (): void => {
    getEconomy()
      .then((eco) => {
        errEl.textContent = "";
        list.replaceChildren();
        if (eco.lootBoxes.length === 0) {
          list.append(el("div", { class: "empty" }, "No caches waiting — the Nightmare keeps its secrets."));
          return;
        }
        for (const box of eco.lootBoxes) list.append(cacheRow(box as LootBox, errEl));
      })
      .catch((ex) => {
        list.replaceChildren();
        errEl.textContent = ex instanceof Error ? ex.message : "The ledger is unreachable.";
        const retry = el("button", { class: "mini", type: "button" }, "Retry");
        retry.addEventListener("click", load);
        errEl.append(" ", retry);
      });
  };
  load();
}
