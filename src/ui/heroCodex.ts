/**
 * Hero codex: who you are playing, and what your numbers currently are.
 *
 * Opened by clicking the portrait in the player frame. Six tabs:
 *
 *   Character   the hero as the game presents him
 *   The Man     the historical figure, and what the evidence says about him
 *   Skills      icon rows with one-line instructions; the long copy (numbers,
 *               how to play it, the theory) sits behind a ? popup per skill
 *   Stats       the live sheet, kept to short name/value rows; the derivation
 *               of each number sits behind a ? popup per section
 *   System      device-wide switches, the same for every hero: music on/off,
 *               a track pick (Auto = each area's own soundtrack), voice lines
 *   Credits     who made this and why — static copy, no state, no controls
 *
 * The Stats tab still keeps its rule: it reports what is ACTUALLY live and
 * says so plainly when a stat is declared in the design but not yet wired. A
 * sheet that prints a confident number for a stat nothing reads is worse than
 * a sheet that admits the gap, because a player will build around it. The
 * source of every number is still carried — it just lives in the ? popup now
 * so the sheet itself stays readable at a glance.
 *
 * Plain DOM, same discipline as roomsPanel and hallPanel. Nothing here touches
 * a scene, so it opens over the village, the arena or the practice booth alike.
 */

import { FREUD } from "@shared/heroes/freud";
import { heroById } from "@shared/heroes";
import type { Hero } from "@shared/types";
import { COMBAT, FORMAT_MODIFIER, BEAT_PERIOD_S } from "@shared/combat";
import { player } from "../state/player";
import { heroPortrait, type Profile } from "./authFlow";
import { CHARACTER, CHARACTERS, skillLoreFor, type HeroCharacter, type SkillLore } from "./heroLore";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_ROW,
  WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM, WOW_GOLD,
} from "./wowChrome";
import { wowScrollCss, wowScrollPhoneCss, mountWowScroller } from "./wowScroller";
import {
  MUSIC_TRACKS, isMusicMuted, setMusicMuted,
  musicTrackOverride, setMusicTrackOverride,
} from "../state/musicSettings";
import { isSfxMuted, setSfxMuted } from "../state/sfx";

// The hero the open codex describes — set from the profile on open, read by
// every tab renderer below. Freud until told otherwise.
let HERO: Hero = FREUD;
let CHAR: HeroCharacter = CHARACTER;
let LORE: SkillLore[] = skillLoreFor("freud");

const iconsDir = (): string => `/assets/ui/skills/${HERO.id}`;

/**
 * Icon for a lore entry, where one exists on disk. Freud's basic and the
 * palette wheel have none (the bar shows labels there too); every Pavlov
 * entry has its own tile.
 */
function skillIcon(loreId: string): string | null {
  if (loreId === "freud.basic" || loreId === "freud.stage") return null;
  return `${iconsDir()}/${(loreId.split(".").pop() ?? loreId).replace(/-/g, "_")}.webp`;
}

/** "tank" is sheet jargon — the codex speaks player words. */
const ROLE_WORD: Record<string, string> = {
  dps: "Damage Dealer",
  tank: "Tank",
  healer: "Healer",
  support: "Support",
  control: "Control",
  flex: "Flex",
};

const CSS = `
#hero-codex {
  position: fixed; inset: 0; z-index: 45; overflow-y: auto;
  background: rgba(4, 3, 1, .68); backdrop-filter: blur(3px);
  font: 13.5px/1.6 ${WOW_FONT};
  display: grid; place-items: center; padding: 18px 10px;
}
#hero-codex .card {
  width: min(660px, 96vw); overflow: hidden;
  ${WOW_CARD}
}
#hero-codex .head {
  display: flex; align-items: center; gap: 12px; padding: 14px 16px;
  border-bottom: 1px solid #3a2d14;
}
#hero-codex .head img {
  width: 46px; height: 46px; border-radius: 50%; object-fit: cover;
  border: 2px solid #b0914e;
}
#hero-codex .head h1 {
  margin: 0; font-size: 16px; letter-spacing: .3em; font-weight: 700;
  ${WOW_GOLD_TEXT}
}
#hero-codex .head .sub { font-size: 11px; color: ${WOW_TEXT_DIM}; letter-spacing: .1em; }
#hero-codex .close {
  margin-left: auto; width: 32px; height: 32px; font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#hero-codex .close:hover { ${WOW_BTN_HOVER} }
#hero-codex .tabs { display: flex; gap: 2px; padding: 8px 12px 0; border-bottom: 1px solid #3a2d14; }
#hero-codex .tabs button {
  background: none; border: 1px solid transparent; border-bottom: none;
  border-radius: 0; color: ${WOW_TEXT_DIM}; font: inherit; font-size: 11.5px;
  letter-spacing: .14em; text-transform: uppercase; padding: 6px 11px; cursor: pointer;
}
#hero-codex .tabs button.on {
  color: #f4e3b2; border-color: #5a4620; background: #120d05aa;
}
#hero-codex .body { padding: 14px 18px 18px; }
#hero-codex p { margin: 0 0 10px; color: ${WOW_TEXT}; }
#hero-codex .note {
  border-left: 2px solid #b0914e; background: #e2c47c12;
  padding: 8px 11px; border-radius: 0; color: #ecc363; margin: 12px 0 0;
}

/* ---- skills: icon row, one-line instruction, ? for the long copy --------- */
#hero-codex .skill {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 11px 13px; margin-bottom: 10px;
  ${WOW_ROW}
}
#hero-codex .skicon {
  width: 46px; height: 46px; flex: none; border-radius: 0;
  border: 1px solid #5a4620; background-color: #120d05;
  background-size: cover; background-position: center;
  display: grid; place-items: center;
  color: ${WOW_TEXT_DIM}; font-size: 10px; letter-spacing: .06em;
}
#hero-codex .skmain { flex: 1; min-width: 0; }
#hero-codex .skill .top { display: flex; align-items: center; gap: 9px; margin-bottom: 3px; }
#hero-codex .skill .nm {
  font-size: 14px; font-weight: 700;
  ${WOW_GOLD_TEXT}
}
#hero-codex .skill .kb {
  margin-left: auto; font-size: 10px; color: ${WOW_TEXT_DIM};
  border: 1px solid #5a4620; border-radius: 0; padding: 0 6px; white-space: nowrap;
}
#hero-codex .skill .sum { color: ${WOW_TEXT}; }
#hero-codex .stages { display: flex; gap: 5px; margin-top: 8px; }
#hero-codex .stages .st {
  width: 26px; height: 26px; border-radius: 0; border: 1px solid #5a4620;
  background-size: cover; background-position: center;
}
#hero-codex .stages .cap { font-size: 10px; color: ${WOW_TEXT_DIM}; align-self: center; margin-left: 3px; }

/* the ? button, on skills and on stat section headers */
#hero-codex .qbtn {
  width: 19px; height: 19px; flex: none; border-radius: 0; padding: 0;
  border: 1px solid #5a4620; background: #120d05; color: ${WOW_TEXT_DIM};
  font: inherit; font-size: 11px; line-height: 1; cursor: pointer;
}
#hero-codex .qbtn:hover, #hero-codex .qbtn.on { color: #f4e3b2; border-color: ${WOW_GOLD}; }

/* ---- stats: a short sheet, derivations behind ? --------------------------- */
#hero-codex .shead { display: flex; align-items: center; gap: 7px; margin: 14px 0 4px; }
#hero-codex .shead:first-child { margin-top: 2px; }
#hero-codex .shead h2 {
  margin: 0; font-size: 11px; letter-spacing: .22em; color: ${WOW_GOLD}; font-weight: 500;
}
#hero-codex .srow {
  display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
  padding: 5px 4px; border-bottom: 1px solid #2a2010;
}
#hero-codex .srow .n { color: ${WOW_TEXT_DIM}; }
#hero-codex .srow .v { color: #f4e3b2; font-weight: 700; white-space: nowrap; }
#hero-codex .srow.pending .n, #hero-codex .srow.pending .v { color: #b78a8a; }
#hero-codex .dim { color: ${WOW_TEXT_DIM}; opacity: .75; font-size: 11.5px; padding: 7px 4px 2px; }

/* ---- system: name/control rows, same sheet discipline as stats ------------ */
#hero-codex .srow.ctl { align-items: center; }
#hero-codex .sys-toggle {
  font: inherit; font-size: 10.5px; padding: 6px 12px; white-space: nowrap;
  ${WOW_BTN}
}
#hero-codex .sys-toggle.on { color: #f4e3b2; border-color: #8a6d2f; }
#hero-codex .sys-toggle:hover { ${WOW_BTN_HOVER} }
#hero-codex .sys-select {
  font: inherit; font-size: 11px; padding: 5px 8px; max-width: 62%;
  background: #120d05; color: #f4e3b2; border: 1px solid #5a4620; border-radius: 0;
  cursor: pointer;
}
#hero-codex .sys-select:hover { border-color: ${WOW_GOLD}; }

/* ---- credits: a scrolling page inside a card that keeps its size ---------- */
/* The credits run longer than any other tab. Left in the flow they would
   stretch the card past the viewport and hand the scroll to the backdrop,
   which moves the tab row off screen with it. So this tab scrolls in its own
   box (ui/wowScroller.ts) and the header and tabs stay put. The card here is
   not height-constrained, so the cap comes from the box itself. */
${wowScrollCss("#hero-codex", "min(56vh, 460px)")}
#hero-codex .byline { margin: 2px 0 12px; }
#hero-codex .byline .who {
  font-size: 17px; font-weight: 700; letter-spacing: .1em;
  ${WOW_GOLD_TEXT}
}
#hero-codex .byline .where {
  display: block; margin-top: 4px; font-size: 10.5px; letter-spacing: .2em;
  text-transform: uppercase; color: ${WOW_TEXT_DIM};
}
#hero-codex .cgroup { padding: 6px 4px; border-bottom: 1px solid #2a2010; }
#hero-codex .cgroup .lbl {
  font-size: 9.5px; letter-spacing: .22em; text-transform: uppercase;
  color: ${WOW_TEXT_DIM}; margin-bottom: 2px;
}
#hero-codex .cgroup .val { color: #f4e3b2; font-size: 12.5px; }
#hero-codex .sign {
  margin-top: 16px; text-align: right; font-style: italic; color: ${WOW_GOLD};
}

/* ---- the ? popup ---------------------------------------------------------- */
#codex-pop {
  position: fixed; z-index: 47; max-width: 300px;
  ${WOW_CARD}
  padding: 10px 12px;
  font: 12.5px/1.55 ${WOW_FONT};
}
#codex-pop .ph {
  font-weight: 700; letter-spacing: .06em; margin-bottom: 5px;
  ${WOW_GOLD_TEXT}
}
#codex-pop .pl { color: ${WOW_TEXT}; margin-bottom: 7px; }
#codex-pop .pl:last-child { margin-bottom: 0; }
#codex-pop .num {
  color: #ecc363; background: #e2c47c12;
  border-left: 2px solid #b0914e; padding: 4px 7px; border-radius: 0;
  margin-bottom: 7px;
}
#codex-pop .plbl {
  font-size: 9.5px; letter-spacing: .22em; text-transform: uppercase;
  color: ${WOW_TEXT_DIM}; margin: 6px 0 2px;
}
#codex-pop .thy { color: ${WOW_TEXT_DIM}; font-style: italic; }

/* Phones: the codex goes full-screen — a floating card wastes the one thing a
   small screen does not have (same treatment as rooms/loot/hall). The card
   itself scrolls; there is no visible backdrop left, so closing is × / Escape. */
@media (pointer: coarse), (max-width: 640px) {
  #hero-codex { padding: 0; font-size: 12px; }
  #hero-codex .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    /* Safe-area: keep full-bleed card content clear of the iPhone camera housing. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
    overflow-y: auto;
  }
  #hero-codex .head { padding: 10px 12px; gap: 9px; }
  #hero-codex .head img { width: 38px; height: 38px; }
  #hero-codex .head h1 { font-size: 13px; letter-spacing: .2em; }
  #hero-codex .head .sub { font-size: 10px; }
  #hero-codex .close { width: 28px; height: 28px; font-size: 14px; }
  #hero-codex .body { padding: 12px 12px 16px; }
  #hero-codex .skill { padding: 10px 11px; gap: 10px; }
  #hero-codex .skicon { width: 42px; height: 42px; }
  /* Full-screen card, so the card is the scroller. */
  ${wowScrollPhoneCss("#hero-codex")}
  /* The ? popup becomes a bottom sheet: anchored to its button it would
     either cover the header (flipped up) or run off the screen (flipped
     down) on a phone-height viewport. */
  #codex-pop {
    left: 8px; right: 8px; bottom: 8px; top: auto;
    max-width: none; max-height: 62vh; overflow-y: auto;
  }
}
`;

type Tab = "character" | "man" | "skills" | "stats" | "system" | "credits";

/**
 * Voice-line mute — localStorage key shared with the village scene: the
 * toggle lives in the System tab, createHeroVoice reads it back at play
 * time so flipping it takes effect mid-scene. "1" = muted; absent/"0" =
 * on. Guarded: headless runs and storage-blocked browsers read as unmuted.
 */
export const VOICE_MUTED_KEY = "psyrena.voiceMuted";

export function isVoiceMuted(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(VOICE_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

function setVoiceMuted(muted: boolean): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (muted) localStorage.setItem(VOICE_MUTED_KEY, "1");
    else localStorage.removeItem(VOICE_MUTED_KEY);
  } catch {
    // storage blocked — the toggle just won't persist across reloads
  }
}

let host: HTMLDivElement | null = null;

export function openHeroCodex(profile: Profile, tab: Tab = "character"): void {
  if (typeof document === "undefined") return;
  closeHeroCodex();

  // The codex describes whoever the account is playing.
  HERO = heroById(profile.selectedHero);
  CHAR = CHARACTERS[HERO.id] ?? CHARACTER;
  LORE = skillLoreFor(HERO.id);

  if (!document.getElementById("hero-codex-css")) {
    const style = document.createElement("style");
    style.id = "hero-codex-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  host = document.createElement("div");
  host.id = "hero-codex";

  const card = document.createElement("div");
  card.className = "card";

  // ---- header ------------------------------------------------------------
  const head = document.createElement("div");
  head.className = "head";
  const img = document.createElement("img");
  img.src = heroPortrait(profile.selectedHero);
  img.alt = CHAR.realName;
  const titles = document.createElement("div");
  const h1 = document.createElement("h1");
  h1.textContent = CHAR.realName.toUpperCase();
  const sub = document.createElement("div");
  sub.className = "sub";
  // Player words, not designer words: "dps"/"base 100"/"palette kit" are
  // sheet jargon that means nothing on first open.
  sub.textContent = `${CHAR.codename} · ${ROLE_WORD[HERO.role] ?? HERO.role} · ${CHAR.lifespan}`;
  titles.append(h1, sub);
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeHeroCodex);
  head.append(img, titles, close);

  // ---- tabs --------------------------------------------------------------
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const body = document.createElement("div");
  body.className = "body";

  const TABS: Array<[Tab, string]> = [
    ["character", "CHARACTER"],
    ["man", "THE MAN"],
    ["skills", "SKILLS"],
    ["stats", "STATS"],
    ["system", "SYSTEM"],
    ["credits", "CREDITS"],
  ];
  const buttons = new Map<Tab, HTMLButtonElement>();
  const select = (t: Tab): void => {
    closePop();
    for (const [id, btn] of buttons) btn.classList.toggle("on", id === t);
    body.replaceChildren(renderTab(t));
  };
  for (const [id, label] of TABS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => select(id));
    buttons.set(id, b);
    tabs.appendChild(b);
  }

  card.append(head, tabs, body);
  host.appendChild(card);
  // Click the backdrop to dismiss, but never a click inside the card.
  host.addEventListener("click", (e) => {
    if (e.target === host) closeHeroCodex();
  });
  // A press anywhere outside the popup closes it; the press itself keeps its
  // normal effect, so tapping another ? swaps the popup in one gesture.
  document.addEventListener("pointerdown", onDocPointer, true);
  document.body.appendChild(host);
  window.addEventListener("keydown", onKey);
  select(tab);
}

export function closeHeroCodex(): void {
  if (!host) return;
  window.removeEventListener("keydown", onKey);
  document.removeEventListener("pointerdown", onDocPointer, true);
  closePop();
  host.remove();
  host = null;
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // Escape peels one layer at a time: the popup first, then the codex.
  if (pop) closePop();
  else closeHeroCodex();
}

// ---------------------------------------------------------------------------
// The ? popup
//
// One shared element, refilled and re-anchored per press — same one-bubble
// discipline as the action-bar tooltip. Click and touch both work, because a
// hover-only answer is no answer on a phone.
// ---------------------------------------------------------------------------

let pop: HTMLDivElement | null = null;
let popAnchor: HTMLElement | null = null;

function togglePop(anchor: HTMLElement, fill: (root: HTMLDivElement) => void): void {
  if (pop && popAnchor === anchor) {
    closePop();
    return;
  }
  closePop();
  pop = document.createElement("div");
  pop.id = "codex-pop";
  fill(pop);
  document.body.appendChild(pop);
  popAnchor = anchor;
  anchor.classList.add("on");
  placePop(anchor);
}

function closePop(): void {
  if (!pop) return;
  popAnchor?.classList.remove("on");
  pop.remove();
  pop = null;
  popAnchor = null;
}

function placePop(anchor: HTMLElement): void {
  if (!pop) return;
  // On the phone layout the popup is a CSS bottom sheet; inline left/top
  // would override it, so anchoring is skipped there.
  if (window.matchMedia("(pointer: coarse), (max-width: 640px)").matches) return;
  const a = anchor.getBoundingClientRect();
  const t = pop.getBoundingClientRect();
  const gap = 8;
  // Below the button by default; above when there is no room. Centred on the
  // button, then pulled back inside the viewport.
  let top = a.bottom + gap;
  if (top + t.height > window.innerHeight - 8) top = Math.max(8, a.top - t.height - gap);
  let left = a.left + a.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function onDocPointer(e: PointerEvent): void {
  if (!pop) return;
  const t = e.target as Node;
  if (pop.contains(t) || popAnchor?.contains(t)) return;
  closePop();
}

function qbtn(ariaLabel: string, fill: (root: HTMLDivElement) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "qbtn";
  b.type = "button";
  b.textContent = "?";
  b.setAttribute("aria-label", ariaLabel);
  b.addEventListener("click", () => togglePop(b, fill));
  return b;
}

function popTitle(root: HTMLDivElement, text: string): void {
  const h = document.createElement("div");
  h.className = "ph";
  h.textContent = text;
  root.appendChild(h);
}

function popLine(root: HTMLDivElement, text: string, cls = "pl"): void {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  root.appendChild(d);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function renderTab(t: Tab): HTMLElement {
  const wrap = document.createElement("div");
  if (t === "character") {
    for (const para of CHAR.inGame) wrap.appendChild(p(para));
  } else if (t === "man") {
    const life = document.createElement("h2");
    life.textContent = `${CHAR.realName.toUpperCase()}, ${CHAR.lifespan}`;
    wrap.appendChild(life);
    for (const para of CHAR.historical) wrap.appendChild(p(para));
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = CHAR.evidenceNote;
    wrap.appendChild(note);
  } else if (t === "skills") {
    renderSkills(wrap);
  } else if (t === "system") {
    renderSystem(wrap);
  } else if (t === "credits") {
    renderCredits(wrap);
  } else {
    renderStats(wrap);
  }
  return wrap;
}

function p(text: string): HTMLParagraphElement {
  const el = document.createElement("p");
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function renderSkills(wrap: HTMLElement): void {
  for (const lore of LORE) {
    const card = document.createElement("div");
    card.className = "skill";

    // Icon tile: the real skill icon where one exists on disk. Freud's basic
    // attack and palette wheel have no icon (the action bar shows labels
    // there too), so their tile carries the key badge instead.
    const icon = document.createElement("div");
    icon.className = "skicon";
    const url = skillIcon(lore.id);
    if (url) icon.style.backgroundImage = `url(${url})`;
    else icon.textContent = lore.key;

    const main = document.createElement("div");
    main.className = "skmain";
    const top = document.createElement("div");
    top.className = "top";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = lore.name;
    const kb = document.createElement("span");
    kb.className = "kb";
    kb.textContent = lore.key;
    top.append(
      nm,
      kb,
      qbtn(`About ${lore.name}`, (root) => {
        popTitle(root, lore.name);
        popLine(root, lore.numbers(), "num");
        popLine(root, "HOW TO USE", "plbl");
        popLine(root, lore.howToUse);
        popLine(root, "THE THEORY", "plbl");
        popLine(root, lore.theory, "thy");
      })
    );
    const sum = document.createElement("div");
    sum.className = "sum";
    sum.textContent = lore.summary;
    main.append(top, sum);

    // The palette wheel is five stages in one slot: show their icons as a
    // strip so the wheel reads as the five buttons it actually is.
    if (lore.id === "freud.stage") {
      const strip = document.createElement("div");
      strip.className = "stages";
      for (const stage of FREUD.palette) {
        const st = document.createElement("div");
        st.className = "st";
        st.style.backgroundImage = `url(${iconsDir()}/${stage.id.split(".").pop()}.webp)`;
        st.title = stage.name;
        strip.appendChild(st);
      }
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = "one wheel, five stages";
      strip.appendChild(cap);
      main.appendChild(strip);
    }

    card.append(icon, main);
    wrap.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function srow(name: string, value: string, pending = false): HTMLDivElement {
  const row = document.createElement("div");
  row.className = pending ? "srow pending" : "srow";
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = name;
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = value;
  row.append(n, v);
  return row;
}

function shead(title: string, helpAria: string, help: (root: HTMLDivElement) => void): HTMLDivElement {
  const h = document.createElement("div");
  h.className = "shead";
  const t = document.createElement("h2");
  t.textContent = title;
  h.append(t, qbtn(helpAria, help));
  return h;
}

function dim(text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "dim";
  d.textContent = text;
  return d;
}

function renderStats(wrap: HTMLElement): void {
  // `BuffState.until` is stamped from `performance.now()` (see Player.applyBuff),
  // which counts milliseconds since page load — NOT epoch time. Comparing it
  // against `Date.now()` makes every buff read as expired, so this table used to
  // show "nothing running" and 0% mitigation while the HUD row was showing live
  // tiles. Same clock in, same clock out.
  const now = performance.now();
  const live = player.buffs.filter((b) => b.until > now);
  const debuffs = live.filter((b) => b.kind === "debuff");

  // Mitigation that is actually running. The hero's own E is the one source
  // this table reads, so the value is either zero or the grant, additive
  // under the global cap.
  const mitGrant = HERO.defense.mitigation;
  const mitActive = live.some((b) => b.name.startsWith(HERO.defense.name));
  const mitigation = Math.min(mitActive ? (mitGrant?.magnitude ?? 0) : 0, COMBAT.maxMitigation);

  // Fixation is the one debuff that touches outgoing damage today.
  const fixated = debuffs.some((b) => /fixation/i.test(b.name));

  const pct = (v: number): string => `${Math.round(v * 100)}%`;

  // ---- attributes ---------------------------------------------------------
  wrap.appendChild(
    shead("ATTRIBUTES", "Where these numbers come from", (root) => {
      popTitle(root, "Attributes");
      popLine(root, "Health and Focus are your live pools, read straight from the fight. Focus refills on its own while you are in combat.");
      popLine(
        root,
        mitActive
          ? `Mitigation is active right now from ${HERO.defense.name}, a ${(mitGrant?.durationMs ?? 0) / 1000} sec window. It can never rise above ${pct(COMBAT.maxMitigation)}.`
          : `Mitigation comes only from ${HERO.defense.name}: ${pct(mitGrant?.magnitude ?? 0)} less damage taken for ${(mitGrant?.durationMs ?? 0) / 1000} sec. It can never rise above ${pct(COMBAT.maxMitigation)}.`
      );
      popLine(root, "Every hit has the same chance to strike critically. No stat or gear raises it yet.");
      popLine(root, `Power multiplies your base damage. Gear is its only source, and it caps at x${COMBAT.maxGear}.`);
      popLine(
        root,
        "Haste, Resilience and Clarity are planned attributes. Nothing in the game reads them yet, so they change nothing today.",
        "thy"
      );
    })
  );
  wrap.append(
    srow("Health", `${Math.round(player.hp)} / ${Math.round(player.hpMax)}`),
    srow("Focus", `${Math.round(player.mana)} / ${Math.round(player.manaMax)}`),
    srow("Mitigation", pct(mitigation)),
    srow("Critical", `${pct(COMBAT.critChance)} at x${COMBAT.critMult}`),
    srow("Power", "x1.00"),
    dim("Coming later: Haste · Resilience · Clarity")
  );

  // ---- outgoing damage ----------------------------------------------------
  // A hero without a beat cycle (Pavlov) simply has one fewer term in the
  // damage sentence — the stats tab must not describe a clock they do not run.
  const beats = HERO.beats;
  const beatNames = beats?.map((b) => b.name).join(", ") ?? "";
  wrap.appendChild(
    shead("DAMAGE TERMS", "How a hit is built", (root) => {
      popTitle(root, "How a hit is built");
      popLine(root, "Every hit in the game multiplies the terms below together. Nothing else feeds the number you see on screen.");
      popLine(
        root,
        beats
          ? `Base is a fixed value on each skill; the row below shows a stage cast. Beat cycles through ${beatNames}, advancing every ${BEAT_PERIOD_S} sec on its own clock.`
          : `Base is a fixed value on each skill; the row below shows a cast. ${HERO.displayName.split(" — ")[0]} has no beat cycle — every cast pays its base, every time.`
      );
      popLine(root, `Analysis Marks add ${pct(COMBAT.markBonus)} each and stack to ${COMBAT.maxMarks}, placed by the whole team. Amp comes from support buffs and from healing that landed past full health.`);
      popLine(root, `Gear bonuses are real but deliberately small. Format depends on the room you fight in.`);
      popLine(root, "Fixation is the price of a wrong stage answer. It lowers your own damage by 30 percent for six seconds and never touches your team.", "thy");
    })
  );
  wrap.append(
    srow("Base", `${HERO.palette[0]?.base ?? 0}`),
    srow("Beat", beats ? `x${beats[0]?.multiplier} to x${beats[2]?.multiplier}` : "none — flat"),
    srow("Marks", `up to +${pct(COMBAT.markBonus * COMBAT.maxMarks)}`),
    srow("Amp", `up to +${pct(COMBAT.maxAmp)}`),
    srow("Gear", `up to x${COMBAT.maxGear}`),
    srow("Format", `x${FORMAT_MODIFIER.solo} solo / x${FORMAT_MODIFIER.match} match`),
    srow("Fixation", fixated ? "x0.70 right now" : "not active", fixated)
  );

  // ---- live effects -------------------------------------------------------
  wrap.appendChild(
    shead("EFFECTS ON YOU", "What is running right now", (root) => {
      popTitle(root, "Effects on you");
      popLine(root, "Buffs and debuffs appear here while they last, read from the same clock the fight uses. Red rows are debuffs.");
    })
  );
  if (live.length === 0) {
    wrap.appendChild(dim("Nothing running right now."));
  } else {
    for (const b of live) {
      wrap.appendChild(
        srow(b.name, `${Math.max(0, (b.until - now) / 1000).toFixed(1)}s`, b.kind === "debuff")
      );
    }
  }

}

// ---------------------------------------------------------------------------
// System — device-wide switches, identical for every hero
// ---------------------------------------------------------------------------

/** A stats-style row whose right side is a live control instead of a value. */
function crow(name: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "srow ctl";
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = name;
  row.append(n, control);
  return row;
}

function sysToggle(aria: string, isOn: () => boolean, setOn: (on: boolean) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "sys-toggle";
  b.type = "button";
  b.setAttribute("aria-label", aria);
  const sync = (): void => {
    const on = isOn();
    b.classList.toggle("on", on);
    b.textContent = on ? "On" : "Off";
    b.setAttribute("aria-pressed", String(on));
  };
  b.addEventListener("click", () => {
    setOn(!isOn());
    sync();
  });
  sync();
  return b;
}

function renderSystem(wrap: HTMLElement): void {
  wrap.appendChild(
    shead("MUSIC", "How the music settings work", (root) => {
      popTitle(root, "Music");
      popLine(
        root,
        "Auto plays each area's own soundtrack: the village rotates its six tracks (opening on Ballroom of Blades), the practice booth keeps its violet loop, and the boss fight rolls a siege loop on entry."
      );
      popLine(
        root,
        "Pick a named track to loop that one everywhere instead. Every change applies immediately and is remembered on this device."
      );
    })
  );
  wrap.appendChild(
    crow("Music", sysToggle("Toggle music", () => !isMusicMuted(), (on) => setMusicMuted(!on)))
  );
  const sel = document.createElement("select");
  sel.className = "sys-select";
  sel.setAttribute("aria-label", "Music track");
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (each area's own)";
  sel.appendChild(auto);
  for (const t of MUSIC_TRACKS) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.label;
    sel.appendChild(o);
  }
  sel.value = musicTrackOverride() ?? "";
  sel.addEventListener("change", () => setMusicTrackOverride(sel.value || null));
  wrap.appendChild(crow("Track", sel));

  wrap.appendChild(
    shead("VOICE", "About voice lines", (root) => {
      popTitle(root, "Voice lines");
      popLine(
        root,
        "Your hero speaks on casts and after standing still for a while. Off silences those lines mid-scene; the boss keeps his own voice either way."
      );
    })
  );
  wrap.appendChild(
    crow("Voice lines", sysToggle("Toggle voice lines", () => !isVoiceMuted(), (on) => setVoiceMuted(!on)))
  );

  wrap.appendChild(
    shead("SOUND EFFECTS", "About sound effects", (root) => {
      popTitle(root, "Sound effects");
      popLine(
        root,
        "One-shot sounds for skill casts, projectile impacts, boss telegraphs and UI clicks. Off silences them all; music and voice lines have their own switches."
      );
    })
  );
  wrap.appendChild(
    crow("Sound effects", sysToggle("Toggle sound effects", () => !isSfxMuted(), (on) => setSfxMuted(!on)))
  );

  wrap.appendChild(dim("These switches are per device, shared by all heroes."));
}

// ---------------------------------------------------------------------------
// Credits: who made this, why, and everything it was made with. Static copy,
// no state, no controls and nothing hero-specific, so it renders the same
// from any portrait.
//
// The tool list mirrors the "Tools used to make this game" table in the repo
// README. When a tool joins or leaves that pipeline, both places change.
// ---------------------------------------------------------------------------

/** A section header with no ? button: the credits carry their own explanation. */
function chead(title: string): HTMLDivElement {
  const h = document.createElement("div");
  h.className = "shead";
  const t = document.createElement("h2");
  t.textContent = title;
  h.appendChild(t);
  return h;
}

/**
 * A credit line: small uppercase area label, tool names underneath. The stats
 * row (name left, value right) cannot hold these, because the tool lists run
 * to several names and that column never wraps.
 */
function cgroup(area: string, tools: string): HTMLDivElement {
  const g = document.createElement("div");
  g.className = "cgroup";
  const l = document.createElement("div");
  l.className = "lbl";
  l.textContent = area;
  const v = document.createElement("div");
  v.className = "val";
  v.textContent = tools;
  g.append(l, v);
  return g;
}

/** Mirrors the README table, in the order the pipeline runs. */
const CREDIT_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["Author", "Frank Ye"],
  ["Code and architecture", "Claude, Grok and xAI coding agents, Kimi k3, Hermes, Ollama for local inference"],
  ["Concept art", "Grok Imagine, Civitai, gpt image 2"],
  ["3D models", "Tripo, for image and multiview to model, auto rigging, retargeting and decimation"],
  ["Rigs and animation", "Mixamo, Mesh2Motion, Blender"],
  ["Mesh and texture pipeline", "glTF Transform, toktx for KTX2 and UASTC, custom scripts"],
  ["Voice", "Qwen3 TTS for the shipped packs, Grok TTS for the earlier archives"],
  ["Music", "Suno"],
  ["Sound effects", "PSFX, Peri's Sound Effects, by Peri Eskell"],
  ["Engine and client", "Babylon.js 8, TypeScript, Vite, plain DOM for every panel you have opened"],
  ["Server", "Node.js and SQLite"],
  ["Testing", "Puppeteer, driving the real client"],
];

function renderCredits(host: HTMLElement): void {
  // Everything goes inside the scroller, not into the tab body itself.
  const wrap = mountWowScroller(host);

  const by = document.createElement("div");
  by.className = "byline";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "FRANK YE";
  const where = document.createElement("span");
  where.className = "where";
  where.textContent = "HKU SPACE Community College · Hong Kong";
  by.append(who, where);
  wrap.appendChild(by);

  wrap.appendChild(
    p("Design, code, art direction, combat tuning and the words you are reading: one person, start to finish.")
  );

  wrap.appendChild(chead("WHO IT IS FOR"));
  wrap.appendChild(
    p(
      "Psyrena is made for psychology students. Every playable hero is a real theorist, and every skill is their actual theory rather than a fantasy costume worn over it. Freud fights with the five psychosexual stages, a defense mechanism on a cooldown, and an Id / Ego / Superego stance he switches by hand."
    )
  );
  wrap.appendChild(
    p(
      "The bosses are where that lands. Each one moves through psychological phases, and the counter to a phase is the matching piece of theory. When the boss regresses to infancy, Oral Stage is the answer. A full set of the best gear in the game is worth a fraction of what reading the boss correctly is worth, and that is deliberate. Psyrena rewards knowing the material, not grinding for it."
    )
  );
  wrap.appendChild(
    p(
      "It replaces no lecture and no textbook. The hope is narrower: that a stage, a defense mechanism or a conditioning curve is easier to hold onto once you have had to cast it under pressure, with four other people counting on you to read the phase right."
    )
  );

  wrap.appendChild(chead("WHY IT EXISTS"));
  wrap.appendChild(
    p(
      "Nobody commissioned this and nobody is paying for it. I built it because I love this material and wanted the version of it I would have wanted as a student, where theory is something you play rather than something you survive. Every rough edge in here is mine, and so is every hour that went into it."
    )
  );

  wrap.appendChild(chead("MADE WITH"));
  wrap.appendChild(
    p(
      "Psyrena is built on an openly AI assisted pipeline. Design, code, art, 3D, voice and music all pass through generation tools before an offline pipeline compresses and packs them. Everything that helped make this game is named here."
    )
  );
  for (const [area, tools] of CREDIT_TOOLS) wrap.appendChild(cgroup(area, tools));

  wrap.appendChild(
    dim("Thanks also to everyone who queued for a boss they had never seen and then told me what broke.")
  );

  const sign = document.createElement("div");
  sign.className = "sign";
  sign.textContent = "Frank Ye, 2026";
  wrap.appendChild(sign);
}
