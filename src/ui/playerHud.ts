/**
 * Player frame — top-left, the raid-game convention.
 *
 * Row 1: portrait (same art as the hero picker) + name + HP/MP bars.
 * Row 2: Imaginz balance + account level, and a hairline exp bar. The bar is a
 *        plain grid child, so it is exactly as wide as the panel above it and
 *        can never outgrow it on any viewport.
 * Row 3: active buffs/debuffs with a live countdown.
 * Row 4: party slots — placeholders until the Queue Terminal forms real
 *        parties; `player.setTeammates()` is the future wire-in point.
 *
 * Plain DOM like every other overlay, created ONCE in main.ts and never
 * disposed: it reflects the account, not a scene, so it survives village ↔
 * arena switches the same way the perf HUD does (which moved to the top-right
 * to make room for this).
 */

import { player, type BuffState } from "../state/player";
import { heroPortrait, type Profile } from "./authFlow";
import { uiScale, detectControlScheme } from "./inputMode";
import { getEconomy, type Progression } from "../net/economy";
import { openHeroCodex } from "./heroCodex";

const PANEL_BG = "linear-gradient(180deg, rgba(30,24,14,.92), rgba(12,10,7,.92))";
const PANEL_BORDER = "1px solid #8a6d2f";
const FONT = "Georgia, 'Palatino Linotype', Palatino, serif";
const GOLD = "#d8b45a";

/**
 * Live chip updaters, registered by the one PlayerHud instance. Other modules
 * (gear upgrades, loot opens, fight results) call `refreshImaginz` /
 * `refreshProgress` after their server round-trips so the readouts stay
 * current without polling.
 */
let chipSetter: ((balance: number) => void) | null = null;
let progressSetter: ((p: Progression) => void) | null = null;
let titleSetter: ((title: string | null) => void) | null = null;
let stanceSetter: ((s: StanceHudState | null) => void) | null = null;

/** Threat red — matches KIND_ACCENT.stance on the action bar. */
const STANCE_ON = "#ff7a5c";

/** What the HUD shows about a held threat stance. */
export interface StanceHudState {
  /** Skill name, e.g. "Discrimination". */
  name: string;
  /** Threat multiplier while held. */
  multiplier: number;
  held: boolean;
}

/**
 * Update the HUD's Imaginz chip. With a `balance` the value is pushed
 * directly (the caller just got it from the server); without one the economy
 * ledger is re-fetched. Failures are swallowed — a stale chip beats a broken
 * caller.
 */
export function refreshImaginz(balance?: number): void {
  if (balance !== undefined) {
    chipSetter?.(balance);
    return;
  }
  getEconomy()
    .then((eco) => chipSetter?.(eco.imaginz))
    .catch(() => undefined);
}

/**
 * Update the level chip and exp bar. Same push-or-fetch contract as
 * `refreshImaginz`: fight results hand over the snapshot they were just given
 * (which is also what animates the bar right after a kill), anything else
 * calls it bare and pays for one GET.
 */
export function refreshProgress(snapshot?: Progression): void {
  if (snapshot) {
    progressSetter?.(snapshot);
    return;
  }
  getEconomy()
    .then((eco) => progressSetter?.(eco))
    .catch(() => undefined);
}

/**
 * Update the equipped-title line under the player name. Same push-or-fetch
 * contract as `refreshImaginz`: the achievements panel pushes the value it
 * just got back from POST /api/title/equip (pass null to clear), anything
 * else calls it bare and pays for one GET /api/me. Called with NO argument
 * means re-fetch; an explicit null means "no title equipped".
 */
export function refreshTitle(title?: string | null): void {
  if (arguments.length > 0) {
    titleSetter?.(title ?? null);
    return;
  }
  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((me: { title?: string | null }) => titleSetter?.(me.title ?? null))
    .catch(() => undefined);
}

/**
 * Show or clear the threat-stance line under the portrait.
 *
 * A stance is the one player state with no timer and no cooldown to read it
 * off — the action-bar button glows, but a player watching the boss is not
 * watching the bar. So it gets a permanent line under the avatar that says
 * which way it is, rather than a buff tile that looks like everything else.
 *
 * Pass `null` for a hero who has no stance at all; the row hides itself.
 */
export function refreshStance(state: StanceHudState | null): void {
  stanceSetter?.(state);
}

/** Small gilt pill — the shared look of the Imaginz and level readouts. */
function chipEl(title: string): HTMLDivElement {
  const chip = document.createElement("div");
  chip.title = title;
  chip.style.cssText = [
    `background:${PANEL_BG}`,
    `border:${PANEL_BORDER}`,
    "outline:1px solid #2a1f0d",
    "border-radius:4px",
    "padding:2px 8px",
    `color:${GOLD}`,
    "font-size:11px",
    "letter-spacing:.08em",
    "text-shadow:0 1px 2px #000",
    "opacity:.9",
    "white-space:nowrap",
  ].join(";");
  return chip;
}

export class PlayerHud {
  private readonly root: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLDivElement;
  private readonly mpFill: HTMLDivElement;
  private readonly mpText: HTMLDivElement;
  private readonly buffRow: HTMLDivElement;
  private readonly mateRow: HTMLDivElement;
  private readonly unsubscribe: () => void;
  private readonly countdown: number;

  // ---- buff popup ---------------------------------------------------------
  // One tooltip for the whole row, parked on document.body: the row rebuilds
  // its tiles every 500 ms (renderBuffs), so hover/tap state cannot live on a
  // tile — it lives here as "which buff id is open", and each repaint re-finds
  // that buff's tile and re-anchors the popup (or hides it when the buff
  // dropped). `pinned` is the tap mode: it survives mouseleave and closes on
  // the next tap outside the row — the only hover a phone has.
  private readonly tip: HTMLDivElement;
  private tipBuffId: string | null = null;
  private tipPinned = false;
  private readonly onGlobalPress: (ev: PointerEvent) => void;

  constructor(profile: Profile) {
    // Touch shrinks the frame to 60%: a phone screen is mostly play area, and
    // the full-size panel crowded the top-left corner over the action zone.
    const scale = detectControlScheme() === "touch" ? uiScale() * 0.6 : 1;

    this.root = document.createElement("div");
    // Named so the left dock can measure this frame and park itself clear of
    // the party row below it (see ui/leftDock.ts).
    this.root.id = "player-hud";
    this.root.style.cssText = [
      "position:fixed",
      // Safe-area insets: with viewport-fit=cover the camera housing /
      // Dynamic Island overlaps the left or right screen edge on a landscape
      // iPhone. env() is 0 everywhere that has no such hardware.
      "top:calc(8px + env(safe-area-inset-top, 0px))",
      "left:calc(8px + env(safe-area-inset-left, 0px))",
      "z-index:10",
      "display:grid",
      "gap:5px",
      `font:11px/1.3 ${FONT}`,
      "color:#e8d9b0",
      "pointer-events:none",
      "user-select:none",
      `transform:scale(${scale})`,
      "transform-origin:top left",
    ].join(";");

    // ---- row 1: portrait + name + bars -----------------------------------
    const frame = document.createElement("div");
    frame.style.cssText = [
      "display:flex",
      "gap:9px",
      "align-items:center",
      `background:${PANEL_BG}`,
      `border:${PANEL_BORDER}`,
      "outline:1px solid #2a1f0d",
      "border-radius:4px",
      "padding:7px",
      "box-shadow:0 2px 10px rgba(0,0,0,.6), inset 0 1px 0 rgba(216,180,90,.25)",
      "backdrop-filter:blur(4px)",
    ].join(";");

    const portrait = document.createElement("img");
    portrait.src = heroPortrait(profile.selectedHero);
    portrait.alt = profile.selectedHero;
    portrait.style.cssText = [
      "width:56px",
      "height:56px",
      "object-fit:cover",
      "border-radius:50%",
      `border:2px solid ${GOLD}`,
      "box-shadow:0 0 0 2px #2a1f0d, 0 0 10px rgba(216,180,90,.35), inset 0 0 8px #000",
      "display:block",
      // The portrait is the way into the codex, so it has to look pressable
      // and it has to actually receive the press: the frame around it sets
      // pointer-events none so the HUD never eats clicks meant for the world,
      // and a child has to opt back in.
      "cursor:pointer",
      "pointer-events:auto",
    ].join(";");
    portrait.title = "Open the hero codex";
    portrait.addEventListener("click", () => openHeroCodex(profile));

    const col = document.createElement("div");
    col.style.cssText = "display:grid;gap:4px;min-width:150px";

    const name = document.createElement("div");
    name.textContent = profile.username.toUpperCase();
    name.style.cssText = `font-size:12px;letter-spacing:.08em;color:${GOLD};font-weight:600;text-shadow:0 1px 2px #000`;

    // Equipped title, small gilt serif under the name; hidden when none is set.
    const titleEl = document.createElement("div");
    titleEl.style.cssText = `font-size:10px;letter-spacing:.14em;color:${GOLD};opacity:.85;text-shadow:0 1px 2px #000;display:none`;
    const setTitle = (t: string | null): void => {
      const v = (t ?? "").trim();
      titleEl.textContent = v;
      titleEl.style.display = v ? "block" : "none";
    };
    setTitle(profile.title ?? null);
    titleSetter = setTitle;

    const hp = this.buildBar(
      "linear-gradient(180deg, rgba(255,255,255,.4), rgba(255,255,255,.05) 40%, rgba(0,0,0,.25)), linear-gradient(180deg,#76d95e,#3fae2a 55%,#267a17)",
      13
    );
    const mp = this.buildBar(
      "linear-gradient(180deg, rgba(255,255,255,.35), rgba(255,255,255,.05) 40%, rgba(0,0,0,.3)), linear-gradient(180deg,#5aa2f0,#2b63c4 55%,#173f86)",
      10
    );
    this.hpFill = hp.fill;
    this.hpText = hp.text;
    this.mpFill = mp.fill;
    this.mpText = mp.text;

    col.append(name, titleEl, hp.bar, mp.bar);
    frame.append(portrait, col);

    // ---- stance line, directly under the portrait -------------------------
    // Held/dropped is the one piece of player state with no timer and no
    // cooldown to read it off, and a tank watching the boss is not watching
    // their action bar. So it gets its own always-on line rather than a buff
    // tile that would look like every other buff tile.
    const stanceRow = document.createElement("div");
    stanceRow.style.cssText = [
      "display:none",
      "align-items:center",
      "gap:6px",
      `background:${PANEL_BG}`,
      "border-radius:4px",
      "padding:3px 8px",
      "font-size:10px",
      "letter-spacing:.1em",
      "text-shadow:0 1px 2px #000",
      "transition:border-color .18s ease, box-shadow .18s ease, color .18s ease",
    ].join(";");
    const stanceDot = document.createElement("span");
    stanceDot.style.cssText = "width:7px;height:7px;border-radius:50%;flex:0 0 auto";
    const stanceText = document.createElement("span");
    stanceRow.append(stanceDot, stanceText);

    const setStance = (st: StanceHudState | null): void => {
      if (!st) {
        stanceRow.style.display = "none";
        return;
      }
      stanceRow.style.display = "flex";
      // HELD is loud on purpose — it is a commitment, and dropping it is a
      // decision with a lead time (banked threat does not fade).
      const on = st.held;
      stanceText.textContent = on
        ? `${st.name.toUpperCase()} HELD · THREAT ×${st.multiplier}`
        : `${st.name.toUpperCase()} DROPPED · THREAT ×1`;
      stanceRow.style.border = on ? `1px solid ${STANCE_ON}` : "1px solid rgba(216,180,90,.28)";
      stanceRow.style.boxShadow = on ? `0 0 12px ${STANCE_ON}66, inset 0 0 8px ${STANCE_ON}22` : "none";
      stanceRow.style.color = on ? "#ffd8c8" : "rgba(232,217,176,.55)";
      stanceDot.style.background = on ? STANCE_ON : "rgba(216,180,90,.3)";
      stanceDot.style.boxShadow = on ? `0 0 7px ${STANCE_ON}` : "none";
    };
    setStance(null);
    stanceSetter = setStance;

    // ---- row 2: Imaginz + level chips, then the exp bar -------------------
    // The two chips hug their text; the bar below is a plain grid child, so it
    // inherits the row width — which the frame above sets — and is therefore
    // exactly panel-wide at every scale, desktop and touch alike.
    const chipRow = document.createElement("div");
    chipRow.style.cssText = "display:flex;gap:5px;align-items:center";

    const chip = chipEl("Imaginz — earned in the arena, spent at the Outfitter");
    const setChip = (balance: number): void => {
      chip.textContent = `◈ ${Math.round(balance).toLocaleString("en-US")}`;
    };
    setChip(0);
    chipSetter = setChip;
    refreshImaginz(); // one fetch at mount; updates are pushed afterwards

    const lvChip = chipEl("Account level");
    chipRow.append(chip, lvChip);

    const xpBar = document.createElement("div");
    xpBar.style.cssText = [
      "position:relative",
      // 4 px reads as a hairline next to the 13/10 px HP/MP bars — it is
      // progress you glance at between fights, not a combat readout.
      "height:4px",
      "background:linear-gradient(180deg,#050403,#141009)",
      "border:1px solid #0a0805",
      "outline:1px solid rgba(87,69,31,.7)",
      "border-radius:2px",
      "overflow:hidden",
    ].join(";");
    const xpFill = document.createElement("div");
    xpFill.style.cssText = [
      "height:100%",
      "width:0%",
      "background:linear-gradient(180deg,#ffe9a8,#d8b45a 55%,#8a6d2f)",
      "box-shadow:0 0 6px rgba(216,180,90,.45)",
      "transition:width .35s ease",
    ].join(";");
    xpBar.append(xpFill);

    const setProgress = (p: Progression): void => {
      // A server that predates the progression columns answers /api/economy
      // without them; keep the placeholder rather than painting "Lv undefined".
      if (!Number.isFinite(p.level) || !Number.isFinite(p.xpNeeded)) return;
      lvChip.textContent = `Lv ${p.level}`;
      const pct = p.xpNeeded > 0 ? (100 * p.xpInto) / p.xpNeeded : 0;
      xpFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      xpBar.title = `EXP ${Math.round(p.xpInto).toLocaleString("en-US")} / ${p.xpNeeded.toLocaleString("en-US")}`;
      lvChip.title = xpBar.title;
    };
    setProgress({ level: 1, xp: 0, xpInto: 0, xpNeeded: 1 });
    progressSetter = setProgress;
    refreshProgress();

    // ---- row 3: buffs / debuffs ------------------------------------------
    this.buffRow = document.createElement("div");
    this.buffRow.style.cssText = "display:flex;gap:4px;min-height:26px;flex-wrap:wrap";

    // ---- row 4: party -----------------------------------------------------
    this.mateRow = document.createElement("div");
    this.mateRow.style.cssText = "display:flex;gap:5px;align-items:center";

    this.root.append(frame, stanceRow, chipRow, xpBar, this.buffRow, this.mateRow);
    document.body.appendChild(this.root);

    // The popup lives OUTSIDE the scaled HUD root so the touch-mode 60% scale
    // never shrinks its text, and pointer-events:none so it can never eat a
    // press meant for the world (or for the tile under it).
    this.tip = document.createElement("div");
    this.tip.id = "buff-tooltip";
    this.tip.style.cssText = [
      "position:fixed",
      "display:none",
      "z-index:40",
      "max-width:250px",
      `background:${PANEL_BG}`,
      `border:${PANEL_BORDER}`,
      "outline:1px solid #2a1f0d",
      "border-radius:4px",
      "padding:7px 9px",
      "box-shadow:0 4px 14px rgba(0,0,0,.7), inset 0 1px 0 rgba(216,180,90,.2)",
      `font:11px/1.45 ${FONT}`,
      "color:#e8d9b0",
      "pointer-events:none",
      "user-select:none",
    ].join(";");
    document.body.appendChild(this.tip);
    // Tap anywhere outside the buff row closes a pinned popup — capture phase,
    // so a canvas that swallows the event can't leave the popup stranded.
    this.onGlobalPress = (ev: PointerEvent) => {
      if (this.tipPinned && !this.buffRow.contains(ev.target as Node)) this.hideTip();
    };
    window.addEventListener("pointerdown", this.onGlobalPress, true);

    this.unsubscribe = player.onChange(() => this.render());
    // Buff timers count down between state changes, so tick the paint too.
    this.countdown = window.setInterval(() => this.renderBuffs(), 500);
    this.render();
  }

  private buildBar(
    gradient: string,
    height: number
  ): { bar: HTMLDivElement; fill: HTMLDivElement; text: HTMLDivElement } {
    const bar = document.createElement("div");
    bar.style.cssText = [
      "position:relative",
      `height:${height}px`,
      "background:linear-gradient(180deg,#050403,#141009)",
      "border:1px solid #0a0805",
      "outline:1px solid #57451f",
      "border-radius:2px",
      "box-shadow:inset 0 1px 4px #000",
      "overflow:hidden",
    ].join(";");
    const fill = document.createElement("div");
    fill.style.cssText = [
      "position:absolute",
      "inset:0",
      "width:100%",
      `background:${gradient}`,
      "box-shadow:inset 0 -1px 2px rgba(0,0,0,.35)",
      "transition:width .15s ease",
    ].join(";");
    const text = document.createElement("div");
    text.style.cssText = [
      "position:absolute",
      "inset:0",
      "display:grid",
      "place-content:center",
      "font:600 9px/1 'Arial Narrow', Arial, sans-serif",
      "letter-spacing:.06em",
      "color:#fff",
      "text-shadow:0 1px 2px #000, 0 0 3px #000",
    ].join(";");
    bar.append(fill, text);
    return { bar, fill, text };
  }

  private render(): void {
    this.hpFill.style.width = `${(100 * player.hp) / player.hpMax}%`;
    this.hpText.textContent = `${Math.round(player.hp)} / ${player.hpMax}`;
    this.mpFill.style.width = `${(100 * player.mana) / player.manaMax}%`;
    this.mpText.textContent = `${Math.round(player.mana)} / ${player.manaMax}`;
    this.renderBuffs();
    this.renderTeammates();
  }

  private renderBuffs(): void {
    const now = performance.now();
    this.buffRow.replaceChildren(
      ...player.buffs.map((b) => this.buffTile(b, Math.max(0, (b.until - now) / 1000)))
    );
    // The repaint just replaced every tile. If a popup was open, re-anchor it
    // to the new tile for the same buff — which also refreshes its countdown —
    // or close it because that buff expired.
    if (this.tipBuffId !== null) {
      const idx = player.buffs.findIndex((b) => b.id === this.tipBuffId);
      const tile = this.buffRow.children[idx] as HTMLElement | undefined;
      if (idx >= 0 && tile) this.paintTip(player.buffs[idx], tile);
      else this.hideTip();
    }
  }

  /**
   * Icon only — no name bubble, no words (2026-08-05): the tile row under the
   * avatar reads at a glance by art and border color (gold buff / red debuff),
   * the way every MMO buff row does. The full story — name, kind, effect,
   * time left — is the popup: hover on a mouse host, tap on touch (2026-08-06;
   * this replaced the native `title`, which a phone cannot see and which
   * would double up under the custom popup on desktop). The countdown digits
   * remain — a timer is a readout, not a label.
   */
  private buffTile(buff: BuffState, secondsLeft: number): HTMLDivElement {
    const tile = document.createElement("div");
    const edge = buff.kind === "debuff" ? "rgba(255,89,120,.8)" : "rgba(216,180,90,.6)";
    tile.style.cssText = [
      "position:relative",
      "width:24px",
      "height:24px",
      `background:${PANEL_BG}`,
      `border:1px solid ${edge}`,
      "border-radius:4px",
      "overflow:hidden",
      "display:grid",
      "place-content:center",
      "font-size:10px",
      "color:#e8d9b0",
      // The HUD root is pointer-events:none so it never eats world clicks;
      // a tile opts back in (same pattern as the portrait) to take the
      // hover/tap that opens its popup.
      "pointer-events:auto",
      "cursor:help",
    ].join(";");
    tile.addEventListener("mouseenter", () => {
      // A pinned popup ignores passing hovers — also keeps the synthesized
      // mouseenter a touch tap fires from un-pinning before its click lands
      // (which would turn tap-to-dismiss into tap-to-re-pin).
      if (this.tipPinned) return;
      this.showTip(buff.id, tile, false);
    });
    tile.addEventListener("mouseleave", () => {
      if (!this.tipPinned) this.hideTip();
    });
    tile.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Tap toggles: same tile closes, any tile opens pinned (mobile has no
      // mouseleave to close a hover, so a tap must own both directions).
      if (this.tipPinned && this.tipBuffId === buff.id) this.hideTip();
      else this.showTip(buff.id, tile, true);
    });
    if (buff.icon) {
      const img = document.createElement("img");
      img.src = buff.icon;
      img.alt = buff.name;
      img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.9";
      tile.appendChild(img);
    } else {
      tile.append(buff.name[0] ?? "?");
    }
    const t = document.createElement("div");
    // A permanent tile (until: Infinity — the operant quadrant) has no timer.
    // Fight buffs count raw seconds; the day-scale Coffee Shop potions would
    // read "86400", so long timers collapse to minutes then hours, MMO-style.
    t.textContent = !Number.isFinite(secondsLeft) || secondsLeft < 1
      ? ""
      : secondsLeft < 100
        ? String(Math.ceil(secondsLeft))
        : secondsLeft < 5400
          ? `${Math.ceil(secondsLeft / 60)}m`
          : `${Math.ceil(secondsLeft / 3600)}h`;
    t.style.cssText = [
      "position:absolute",
      "right:1px",
      "bottom:0",
      "font-size:9px",
      "font-weight:600",
      "color:#ffd97a",
      "text-shadow:0 1px 2px #000,0 0 3px #000",
    ].join(";");
    tile.appendChild(t);
    return tile;
  }

  private showTip(buffId: string, tile: HTMLElement, pin: boolean): void {
    const buff = player.buffs.find((b) => b.id === buffId);
    if (!buff) return;
    this.tipBuffId = buffId;
    this.tipPinned = pin;
    this.paintTip(buff, tile);
  }

  private hideTip(): void {
    this.tipBuffId = null;
    this.tipPinned = false;
    this.tip.style.display = "none";
  }

  /** Fill the popup for `buff` and anchor it under `tile`. */
  private paintTip(buff: BuffState, tile: HTMLElement): void {
    const debuff = buff.kind === "debuff";

    const name = document.createElement("div");
    name.textContent = buff.name;
    name.style.cssText = `font-size:12px;font-weight:600;letter-spacing:.04em;text-shadow:0 1px 2px #000;color:${debuff ? "#ff8ba1" : GOLD}`;

    // Kind + countdown on one dim line — the tile's cramped digits, spelled out.
    const secondsLeft = Math.max(0, (buff.until - performance.now()) / 1000);
    const left = !Number.isFinite(secondsLeft)
      ? "until removed"
      : secondsLeft < 1
        ? "expiring"
        : secondsLeft < 100
          ? `${Math.ceil(secondsLeft)} s left`
          : secondsLeft < 5400
            ? `${Math.ceil(secondsLeft / 60)} min left`
            : `${Math.ceil(secondsLeft / 3600)} h left`;
    const sub = document.createElement("div");
    sub.textContent = `${debuff ? "Debuff" : "Buff"} · ${left}`;
    sub.style.cssText = `font-size:10px;letter-spacing:.08em;opacity:.75;margin-top:1px;color:${debuff ? "#ffb3c1" : "#e8d9b0"}`;

    this.tip.replaceChildren(name, sub);
    if (buff.desc) {
      const body = document.createElement("div");
      body.textContent = buff.desc;
      body.style.cssText = "margin-top:5px;opacity:.92";
      this.tip.appendChild(body);
    }

    // Anchor under the tile, then clamp to the viewport — the row wraps, so a
    // late tile can sit near the panel's right edge on a narrow phone screen.
    this.tip.style.display = "block";
    const r = tile.getBoundingClientRect();
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
    this.tip.style.top = `${r.bottom + 6}px`;
  }

  private renderTeammates(): void {
    const slots: HTMLDivElement[] = [];
    for (const mate of player.teammates) {
      const slot = document.createElement("div");
      slot.title = mate.username;
      slot.style.cssText = "display:grid;gap:2px;justify-items:center";
      const img = document.createElement("img");
      img.src = heroPortrait(mate.hero);
      img.alt = mate.username;
      img.style.cssText = [
        "width:34px",
        "height:34px",
        "object-fit:cover",
        "border-radius:50%",
        "border:1px solid rgba(216,180,90,.55)",
        "display:block",
      ].join(";");
      const hp = document.createElement("div");
      hp.style.cssText = "width:34px;height:3px;background:#141009;border:1px solid #0a0805;border-radius:2px;overflow:hidden";
      const fill = document.createElement("div");
      fill.style.cssText = `width:${Math.round(100 * mate.hpPct)}%;height:100%;background:linear-gradient(180deg,#76d95e,#3fae2a)`;
      hp.appendChild(fill);
      slot.append(img, hp);
      slots.push(slot);
    }
    // Empty party: three dim placeholder rings, so the row reads as "yours to
    // fill at the Queue Terminal" rather than as a rendering bug.
    if (slots.length === 0) {
      for (let i = 0; i < 3; i++) {
        const ghost = document.createElement("div");
        ghost.title = "Party slot — form a team at the Queue Terminal";
        ghost.textContent = "+";
        ghost.style.cssText = [
          "width:34px",
          "height:34px",
          "border-radius:50%",
          "border:1px dashed rgba(216,180,90,.3)",
          "display:grid",
          "place-content:center",
          "color:rgba(216,180,90,.35)",
          "font-size:13px",
        ].join(";");
        slots.push(ghost);
      }
    }
    this.mateRow.replaceChildren(...slots);
  }

  dispose(): void {
    this.unsubscribe();
    window.clearInterval(this.countdown);
    window.removeEventListener("pointerdown", this.onGlobalPress, true);
    chipSetter = null;
    progressSetter = null;
    titleSetter = null;
    this.tip.remove();
    this.root.remove();
  }
}
