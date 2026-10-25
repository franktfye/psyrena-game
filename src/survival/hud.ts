/**
 * Survival HUD (DOM, like the rest of the game's HUD). Sized for an 844×390
 * landscape phone first (CLAUDE.md rule 7): the wave line and boss bar sit
 * top-centre clear of the player frame, the Recall panel replaces the wave
 * banner while it is open, toasts stack top-right, and the dash button docks
 * inside the touch skill cluster (`dockDash`); a keyboard dashes on Space.
 */
import type { RunStats } from "@shared/survival/sim";
import { DIFFICULTIES, BOONS, type DifficultyId, type BoonId } from "@shared/survival/content";
import { openLoot, type LootBox } from "../net/economy";
import { petSpec } from "@shared/progression";
import { refreshImaginz } from "../ui/playerHud";
import { syncLoadout } from "../state/loadout";
import { detectControlScheme } from "../ui/inputMode";
import {
  WOW_FONT, WOW_CARD, WOW_CTA, WOW_CTA_HOVER, WOW_BTN, WOW_BTN_HOVER, WOW_ROW, WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM, WOW_GOLD,
} from "../ui/wowChrome";

export const RECALL_COLORS = ["#e85d5d", "#4d9bff", "#f2c14e", "#5fd38d"];
export const RECALL_LETTERS = ["A", "B", "C", "D"];

/** The pop-ups (picker, gifts, rank board) wear the game's WoW chrome (ui/wowChrome.ts). */
const MODAL_CSS = `
#sv-modal, #sv-boons { font: 14px/1.45 ${WOW_FONT}; }
#sv-modal { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 10px; overflow-y: auto;
  background: rgba(4, 3, 1, .7); backdrop-filter: blur(3px); }
#sv-boons { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 55; width: min(94vw, 720px); }
.sv-card { ${WOW_CARD} width: min(94vw, 760px); max-height: calc(100vh - 20px); overflow-y: auto; }
.sv-card .head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #3a2d14; }
.sv-card .head h1 { margin: 0; flex: 1; font-size: clamp(15px, 3.4vh, 19px); letter-spacing: .3em; font-weight: 700; ${WOW_GOLD_TEXT} }
.sv-card .head h1.loss { background: none; color: #9a8f77; -webkit-text-fill-color: #9a8f77; }
.sv-card .head .sub { font-size: 12px; letter-spacing: .12em; color: ${WOW_TEXT_DIM}; }
.sv-card .x { width: 32px; height: 32px; font-size: 15px; ${WOW_BTN} }
.sv-card .x:hover { ${WOW_BTN_HOVER} }
.sv-card .body { padding: 12px 14px 14px; display: grid; gap: 10px; }
.sv-card .modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.sv-card .mode { ${WOW_ROW} color: inherit; font: inherit; cursor: pointer; text-align: left; padding: 10px 12px; min-height: 44px; display: grid; gap: 3px; }
.sv-card .mode:hover, .sv-card .mode:focus-visible { border-color: ${WOW_GOLD}; outline: none; background: #1d1508cc; }
.sv-card .mode b { font-size: 15px; letter-spacing: .08em; color: #f4e3b2; }
.sv-card .mode .w { font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: ${WOW_GOLD}; }
.sv-card .mode span { font-size: 12.5px; color: ${WOW_TEXT_DIM}; }
.sv-card .mode i { font-size: 11.5px; color: #8f8466; }
.sv-card .mode.terror b { color: #ff9b84; }
.sv-card .row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.sv-card .cta { ${WOW_CTA} min-height: 44px; }
.sv-card .cta:hover { ${WOW_CTA_HOVER} }
.sv-card .btn { ${WOW_BTN} min-height: 40px; padding: 0 16px; font-size: 12px; }
.sv-card .btn:hover { ${WOW_BTN_HOVER} }
.sv-card .team { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
.sv-card .team div { display: grid; justify-items: center; }
.sv-card .team b { font-size: 16px; color: #f4e3b2; font-weight: 400; }
.sv-card .team small { font-size: 9px; letter-spacing: .22em; text-transform: uppercase; color: ${WOW_TEXT_DIM}; }
.sv-card table { width: 100%; border-collapse: collapse; font-size: clamp(11.5px, 2.5vh, 13.5px); }
.sv-card th { font-weight: 400; font-size: 9.5px; letter-spacing: .2em; text-transform: uppercase; color: ${WOW_TEXT_DIM}; padding: 4px 6px; text-align: right; border-bottom: 1px solid #3a2d14; }
.sv-card td { padding: 5px 6px; text-align: right; border-bottom: 1px solid #2a2010; font-variant-numeric: tabular-nums; }
.sv-card th:nth-child(-n+2), .sv-card td:nth-child(-n+2) { text-align: left; }
.sv-card td.rk { color: ${WOW_GOLD}; width: 1.6em; }
.sv-card td.nm b { color: #f4e3b2; font-weight: 400; }
.sv-card td.nm small { display: block; font-size: 10.5px; color: #8f8466; }
.sv-card tr.me td { background: #2a1f0c88; }
.sv-card td .mvp { font-size: 9px; letter-spacing: .18em; color: #1a1205; background: ${WOW_GOLD}; padding: 0 4px; margin-left: 6px; vertical-align: 2px; }
.sv-card td.top { color: #ffd97a; }
.sv-card .gain { text-align: center; font-size: 15px; color: #ecc363; letter-spacing: .08em; }
.sv-card .gain.jackpot { font-size: 18px; color: #ffd97a; text-shadow: 0 0 12px #ffd97a88; }
.sv-card .best { text-align: center; font-size: 12px; letter-spacing: .14em; color: #ffc94d; }
.sv-card .cache { ${WOW_ROW} display: flex; align-items: center; gap: 10px; padding: 8px 10px; }
.sv-card .cache img { width: 56px; height: 56px; object-fit: contain; filter: drop-shadow(0 0 10px #e2c47c33); }
.sv-card .cache .grow { flex: 1; }
.sv-card .cache .nm { color: #f4e3b2; letter-spacing: .08em; }
.sv-card .cache .meta { font-size: 11.5px; color: #8f8466; }
.sv-card .cache .reveal { color: #ffd97a; font-size: 16px; letter-spacing: .08em; }
.sv-card .err { color: #ff8f7a; font-size: 12px; text-align: center; }
.sv-card .gift { ${WOW_ROW} color: inherit; font: inherit; cursor: pointer; text-align: left; padding: 10px 12px; min-height: 44px; display: grid; gap: 3px; }
.sv-card .gift:hover, .sv-card .gift:focus-visible { border-color: ${WOW_GOLD}; outline: none; background: #1d1508cc; }
.sv-card .gift b { color: #f4e3b2; letter-spacing: .06em; }
.sv-card .gift span { font-size: 12.5px; color: ${WOW_TEXT}; }
.sv-card .gift i { font-size: 11px; color: #8f8466; }
@media (max-height: 430px) { .sv-card .body { padding: 8px 12px 10px; gap: 7px; } .sv-card td { padding: 3px 5px; } }
`;

const CSS = `
#sv-hud { position: fixed; inset: 0; pointer-events: none; z-index: 30; font-family: Georgia, serif; color: #f2ede4; }
#sv-hud .sv-top { position: absolute; top: max(8px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); text-align: center; width: min(46vw, 520px); }
#sv-hud .sv-wave { font-size: clamp(12px, 2.2vh, 16px); letter-spacing: .12em; text-transform: uppercase; opacity: .9; text-shadow: 0 1px 3px #000; }
#sv-hud .sv-boss { margin-top: 6px; display: none; }
#sv-hud .sv-boss-name { font-size: clamp(12px, 2.4vh, 17px); text-shadow: 0 1px 3px #000; }
#sv-hud .sv-boss-bar { position: relative; height: 10px; margin-top: 3px; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.35); border-radius: 5px; overflow: hidden; }
#sv-hud .sv-boss-fill { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg,#7a1f2b,#c94a4a); transition: width .15s; }
#sv-hud .sv-notch { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,.7); }
#sv-hud .sv-banner { position: absolute; top: 26%; left: 50%; transform: translateX(-50%); font-size: clamp(22px, 6vh, 46px); letter-spacing: .08em; text-shadow: 0 2px 10px #000; opacity: 0; transition: opacity .4s; white-space: nowrap; }
#sv-hud .sv-banner.on { opacity: 1; }
#sv-hud .sv-recall { position: absolute; top: max(8px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); width: min(56vw, 760px); ${WOW_CARD} padding: 8px 12px; font-family: ${WOW_FONT}; display: none; text-align: center; }
#sv-hud .sv-q { font-size: clamp(19px, 5vh, 30px); line-height: 1.25; color: #f4e3b2; }
#sv-hud .sv-answers { display: flex; flex-wrap: wrap; gap: 8px 18px; justify-content: center; margin-top: 8px; font-size: clamp(16px, 3.8vh, 24px); }
#sv-hud .sv-answers b { display: inline-block; min-width: 1.4em; border-radius: 4px; color: #111; margin-right: 4px; text-align: center; }
#sv-hud .sv-timer { margin-top: 6px; height: 5px; background: rgba(255,255,255,.15); border-radius: 3px; overflow: hidden; }
#sv-hud .sv-timer i { display: block; height: 100%; background: #f2c14e; }
#sv-hud .sv-reveal { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(.96); width: min(70vw, 620px); ${WOW_CARD} padding: 12px 18px 14px; font-family: ${WOW_FONT}; text-align: center; opacity: 0; transition: opacity .25s, transform .25s; }
#sv-hud .sv-reveal.on { opacity: 1; transform: translate(-50%, -50%) scale(1); }
#sv-hud .sv-reveal .verdict { font-size: clamp(14px, 3vh, 18px); letter-spacing: .18em; text-transform: uppercase; color: #ff8f7a; }
#sv-hud .sv-reveal.right .verdict { color: #5fd38d; }
#sv-hud .sv-reveal .ans { margin-top: 6px; font-size: clamp(20px, 5.4vh, 32px); line-height: 1.2; color: #f4e3b2; }
#sv-hud .sv-reveal .ans b { display: inline-block; min-width: 1.4em; border-radius: 4px; color: #111; margin-right: 8px; text-align: center; font-size: .8em; vertical-align: .1em; }
#sv-hud .sv-reveal .why { margin-top: 8px; font-size: clamp(13px, 3vh, 18px); line-height: 1.35; color: #e6dcc4; }
@media (max-height: 430px) { #sv-hud .sv-reveal { padding: 8px 12px 10px; } }
#sv-hud .sv-map { position: absolute; top: max(8px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); width: clamp(84px, 26vh, 120px); height: clamp(84px, 26vh, 120px); border: 1px solid rgba(255,255,255,.35); border-radius: 8px; background: rgba(8,10,16,.6); }
#sv-hud .sv-toasts { position: absolute; top: calc(max(8px, env(safe-area-inset-top)) + clamp(84px, 26vh, 120px) + 8px); right: max(12px, env(safe-area-inset-right)); width: min(30vw, 300px); display: flex; flex-direction: column; gap: 6px; }
#sv-hud .sv-toast { background: rgba(10,12,20,.8); border-left: 3px solid #b48cff; padding: 6px 9px; border-radius: 6px; font-size: clamp(11px, 2.1vh, 14px); line-height: 1.3; animation: svIn .3s ease-out; }
#sv-hud .sv-toast b { display: block; font-size: 1.05em; margin-bottom: 2px; }
#sv-hud .sv-toast.debuff { border-left-color: #5fd38d; }
@keyframes svIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
#sv-hud .sv-callout { position: absolute; left: 50%; bottom: calc(max(14px, env(safe-area-inset-bottom)) + 96px); transform: translateX(-50%); max-width: min(64vw, 620px); background: rgba(40,10,10,.78); border: 1px solid rgba(255,120,90,.6); border-radius: 8px; padding: 6px 12px; font-size: clamp(12px, 2.6vh, 16px); text-align: center; opacity: 0; transition: opacity .3s; }
#sv-hud .sv-callout.on { opacity: 1; }
#sv-labels { position: fixed; inset: 0; pointer-events: none; z-index: 29; font: 700 clamp(10px, 2vh, 13px) system-ui; letter-spacing: .06em; }
#sv-labels span { position: absolute; transform: translate(-50%, -50%); padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,.55); color: #ffd3c4; white-space: nowrap; text-shadow: 0 1px 2px #000; }
#sv-labels span.fake { color: #fff2b0; }
#sv-labels span.burn { color: #ffb070; }
#sv-dash { position: fixed; pointer-events: auto; right: calc(max(16px, env(safe-area-inset-right)) + 110px); bottom: calc(max(14px, env(safe-area-inset-bottom)) + 8px); width: 62px; height: 62px; border-radius: 50%; border: 2px solid rgba(64,230,255,.7); background: rgba(8,20,30,.65); color: #d8f7ff; font: 600 13px system-ui; z-index: 31; touch-action: none; }
/* Survival has no jump: Space is the dash, and the touch JUMP button would only crowd the stick. */
body[data-survival] #touch-jump { display: none !important; }
#sv-dash .pips { display: block; margin-top: 2px; letter-spacing: 3px; }
#sv-dash .key { position: absolute; left: 50%; top: -9px; transform: translateX(-50%); padding: 1px 5px; border-radius: 4px; background: rgba(8,20,30,.9); border: 1px solid rgba(64,230,255,.55); font: 600 10px ui-monospace, monospace; letter-spacing: .04em; color: #a8f0ff; }
${MODAL_CSS}
`;

function injectCss(): void {
  if (document.getElementById("sv-css")) return;
  const s = document.createElement("style");
  s.id = "sv-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** What the minimap needs, kept engine-free. */
export interface MinimapView {
  half: number;
  /** Walkable grid (row-major, 1 m cells) for the static layer. */
  grid: { n: number; walk: Uint8Array };
  bossSquare?: { x0: number; x1: number; z0: number; z1: number };
  gates: Array<{ x0: number; x1: number; z0: number; z1: number }> | null;
  me: { x: number; z: number; yaw: number };
  hostiles: Array<{ x: number; z: number; kind: "minion" | "elite" | "boss" }>;
  pickups: Array<{ x: number; z: number; hp: boolean }>;
}

export interface SurvivalHud {
  setWave(text: string): void;
  banner(text: string, ms?: number): void;
  setBoss(name: string | null, frac?: number, notches?: number[]): void;
  openRecall(question: string, answers: string[], seconds: number): void;
  tickRecall(left: number, total: number): void;
  closeRecall(): void;
  /** Centre-screen reveal after a Recall Test: verdict, the right answer and why. */
  showRecallResult(correct: boolean, answer: string, explain: string, index?: number, ms?: number): void;
  toast(title: string, text: string, kind?: "card" | "debuff", ms?: number): void;
  setDash(charges: number, max?: number): void;
  /** Offer a boon draft; resolves through onPick, or closes itself via closeBoons(). */
  openBoons(options: BoonId[], onPick: (id: BoonId) => void): void;
  closeBoons(): void;
  /** Redraw the minimap (call ~8×/s). */
  minimap(view: MinimapView): void;
  /** Explain a floor mechanic for a few seconds (bottom centre, above the bar). */
  callout(text: string, ms?: number): void;
  onDash(fn: () => void): void;
  /**
   * Touch: move the dash button INTO the skill cluster (#action-bar), beside
   * its first arc slot, so it scales with the cluster and sits under the same
   * thumb. Call once the skill bar is mounted. `inlinePalette` = the kit puts a
   * palette button on the cluster's lead spot (Erikson), so dash goes above it.
   */
  dockDash(inlinePalette: boolean): void;
  dispose(): void;
}

export function createSurvivalHud(): SurvivalHud {
  injectCss();
  const root = document.createElement("div");
  root.id = "sv-hud";
  root.innerHTML = `
    <div class="sv-top"><div class="sv-wave"></div>
      <div class="sv-boss"><div class="sv-boss-name"></div><div class="sv-boss-bar"><div class="sv-boss-fill"></div></div></div></div>
    <div class="sv-recall"><div class="sv-q"></div><div class="sv-answers"></div><div class="sv-timer"><i></i></div></div>
    <div class="sv-banner"></div>
    <div class="sv-reveal"><div class="verdict"></div><div class="ans"></div><div class="why"></div></div>
    <canvas class="sv-map" width="220" height="220"></canvas>
    <div class="sv-toasts"></div>
    <div class="sv-callout"></div>`;
  document.body.appendChild(root);
  document.body.dataset.survival = "1";
  const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
  const dash = document.createElement("button");
  dash.id = "sv-dash";
  // A keyboard dashes on Space (survival/run.ts); the badge says so, like the bar's key badges.
  const keyboard = detectControlScheme() === "keyboard";
  dash.innerHTML = `DASH<span class="pips">●●</span>${keyboard ? `<span class="key">SPACE</span>` : ""}`;
  if (keyboard) dash.title = "Dash (Space): a quick burst forward, briefly untouchable.";
  document.body.appendChild(dash);
  let dashFn: (() => void) | null = null;
  dash.addEventListener("pointerdown", (e) => { e.preventDefault(); dashFn?.(); });
  let bannerTimer = 0;
  let calloutTimer = 0;
  let revealTimer = 0;
  const mapCanvas = root.querySelector(".sv-map") as HTMLCanvasElement;
  const mctx = mapCanvas.getContext("2d")!;
  let mapBase: HTMLCanvasElement | null = null;

  return {
    setWave(text) { $(".sv-wave").textContent = text; },
    banner(text, ms = 2200) {
      const b = $(".sv-banner");
      b.textContent = text;
      b.classList.add("on");
      window.clearTimeout(bannerTimer);
      bannerTimer = window.setTimeout(() => b.classList.remove("on"), ms);
    },
    setBoss(name, frac = 1, notches = []) {
      const box = $(".sv-boss");
      if (!name) { box.style.display = "none"; return; }
      box.style.display = "block";
      $(".sv-boss-name").textContent = name;
      ($(".sv-boss-fill") as HTMLElement).style.width = `${Math.max(0, frac) * 100}%`;
      const bar = $(".sv-boss-bar");
      bar.querySelectorAll(".sv-notch").forEach((n) => n.remove());
      for (const n of notches) {
        const el = document.createElement("div");
        el.className = "sv-notch";
        el.style.left = `${n * 100}%`;
        bar.appendChild(el);
      }
    },
    openRecall(question, answers) {
      $(".sv-q").textContent = question;
      $(".sv-answers").innerHTML = answers
        .map((a, i) => `<span><b style="background:${RECALL_COLORS[i]}">${RECALL_LETTERS[i]}</b>${escapeHtml(a)}</span>`)
        .join("");
      $(".sv-recall").style.display = "block";
      $(".sv-top").style.visibility = "hidden";
    },
    tickRecall(left, total) {
      ($(".sv-timer i") as HTMLElement).style.width = `${Math.max(0, left / total) * 100}%`;
    },
    closeRecall() {
      $(".sv-recall").style.display = "none";
      $(".sv-top").style.visibility = "visible";
    },
    showRecallResult(correct, answer, explain, index, ms = 4500) {
      const r = $(".sv-reveal");
      r.classList.toggle("right", correct);
      $(".sv-reveal .verdict").textContent = correct ? "Correct" : "Wrong — the answer was";
      const chip = index !== undefined && RECALL_LETTERS[index]
        ? `<b style="background:${RECALL_COLORS[index]}">${RECALL_LETTERS[index]}</b>` : "";
      $(".sv-reveal .ans").innerHTML = chip + escapeHtml(answer);
      $(".sv-reveal .why").textContent = explain;
      r.classList.add("on");
      window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(() => r.classList.remove("on"), ms);
    },
    toast(title, text, kind = "card", ms = 6000) {
      const t = document.createElement("div");
      t.className = `sv-toast ${kind}`;
      t.innerHTML = `<b>${escapeHtml(title)}</b>${escapeHtml(text)}`;
      const box = $(".sv-toasts");
      box.appendChild(t);
      while (box.children.length > 3) box.firstElementChild?.remove();
      window.setTimeout(() => t.remove(), ms);
    },
    setDash(charges, max = 2) {
      (dash.querySelector(".pips") as HTMLElement).textContent = "●".repeat(charges) + "○".repeat(Math.max(0, max - charges));
      dash.style.opacity = charges > 0 ? "1" : ".55";
    },
    onDash(fn) { dashFn = fn; },
    dockDash(inlinePalette) {
      if (detectControlScheme() !== "touch") return;
      const bar = document.getElementById("action-bar");
      if (!bar) return;
      // Cluster coordinates (actionBar.ts TOUCH_ARC): the basic attack is centred
      // at (68, 68), arc slot 1 at (190, 77), slot 2 at (164, 143). The free
      // spot left of slot 1 is the inline palette's lead (256, 40) when a kit
      // uses one; otherwise dash takes it, else it sits just above it.
      const SIZE = 58;
      const at = inlinePalette ? { right: 266, bottom: 112 } : { right: 258, bottom: 42 };
      dash.style.cssText = `position:absolute;right:${at.right - SIZE / 2}px;bottom:${at.bottom - SIZE / 2}px;width:${SIZE}px;height:${SIZE}px;font-size:12px;z-index:2`;
      bar.appendChild(dash);
    },
    openBoons(options, onPick) {
      document.getElementById("sv-boons")?.remove();
      const m = document.createElement("div");
      m.id = "sv-boons";
      m.innerHTML = `<div class="sv-card"><div class="head"><h1>CHOOSE A GIFT</h1><span class="sub">one, for the rest of the run</span></div>
        <div class="body"><div class="modes">${options.map((id) => {
        const b = BOONS.find((x) => x.id === id)!;
        return `<button class="gift" data-b="${id}"><b>${escapeHtml(b.name)}</b><span>${escapeHtml(b.text)}</span><i>${escapeHtml(b.theory)}</i></button>`;
      }).join("")}</div></div></div>`;
      m.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-b]") as HTMLElement | null;
        if (!btn) return;
        m.remove();
        onPick(btn.dataset.b as BoonId);
      });
      document.body.appendChild(m);
    },
    closeBoons() { document.getElementById("sv-boons")?.remove(); },
    minimap(v) {
      const S = mapCanvas.width;
      const k = S / (v.half * 2);
      // +x right, +z (north, the harbour) up.
      const px = (x: number) => (x + v.half) * k;
      const pz = (z: number) => (v.half - z) * k;
      if (!mapBase) {
        mapBase = document.createElement("canvas");
        mapBase.width = mapBase.height = S;
        const b = mapBase.getContext("2d")!;
        b.fillStyle = "#15171d";
        b.fillRect(0, 0, S, S);
        b.fillStyle = "#4a4f5c";
        const { n, walk } = v.grid;
        for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
          if (walk[iz * n + ix]) b.fillRect(ix * k, S - (iz + 1) * k, Math.ceil(k), Math.ceil(k));
        }
        if (v.bossSquare) {
          b.strokeStyle = "rgba(242,193,78,.8)";
          b.lineWidth = 2;
          const q = v.bossSquare;
          b.strokeRect(px(q.x0), pz(q.z1), (q.x1 - q.x0) * k, (q.z1 - q.z0) * k);
        }
      }
      mctx.drawImage(mapBase, 0, 0);
      if (v.gates) {
        mctx.fillStyle = "rgba(180,140,255,.9)";
        for (const g of v.gates) mctx.fillRect(px(g.x0), pz(g.z1), Math.max(2, (g.x1 - g.x0) * k), Math.max(2, (g.z1 - g.z0) * k));
      }
      for (const p of v.pickups) {
        mctx.fillStyle = p.hp ? "#5fd38d" : "#4d9bff";
        mctx.fillRect(px(p.x) - 2, pz(p.z) - 2, 4, 4);
      }
      for (const h of v.hostiles) {
        const r = h.kind === "boss" ? 7 : h.kind === "elite" ? 4.5 : 2.6;
        mctx.fillStyle = h.kind === "boss" ? "#b48cff" : h.kind === "elite" ? "#ff9f43" : "#e85d5d";
        mctx.beginPath();
        mctx.arc(px(h.x), pz(h.z), r, 0, Math.PI * 2);
        mctx.fill();
      }
      // You: an arrow along your facing (hero models face -Z at yaw 0).
      const fx = -Math.sin(v.me.yaw);
      const fz = -Math.cos(v.me.yaw);
      const cx = px(v.me.x);
      const cz = pz(v.me.z);
      mctx.fillStyle = "#6ee7ff";
      mctx.beginPath();
      mctx.moveTo(cx + fx * 8, cz - fz * 8);
      mctx.lineTo(cx - fz * 5 - fx * 4, cz - fx * 5 + fz * 4);
      mctx.lineTo(cx + fz * 5 - fx * 4, cz + fx * 5 + fz * 4);
      mctx.closePath();
      mctx.fill();
    },
    callout(text, ms = 4500) {
      const c = $(".sv-callout");
      c.textContent = text;
      c.classList.add("on");
      window.clearTimeout(calloutTimer);
      calloutTimer = window.setTimeout(() => c.classList.remove("on"), ms);
    },
    dispose() {
      window.clearTimeout(bannerTimer);
      window.clearTimeout(calloutTimer);
      window.clearTimeout(revealTimer);
      document.getElementById("sv-boons")?.remove();
      root.remove();
      dash.remove();
      delete document.body.dataset.survival;
    },
  };
}

/**
 * The Dream Siege front door, shared by the dock button and the village gate:
 * the survival panel (siegePanel.ts) with its own queue, party view and solo
 * warning. `onSolo` starts a solo run at the picked difficulty.
 */
export function openSurvivalPicker(onSolo: (d: DifficultyId) => void): void {
  void import("./siegePanel").then((m) => m.openSiegePanel(onSolo));
}

/** What the server paid for the run (null: the settle failed, or an offline run). */
export interface RunSettlement {
  awarded: number;
  jackpot: boolean;
  lootBox: Pick<LootBox, "id" | "tier" | "name"> | null;
  newBest?: boolean;
  bestWave?: number | null;
}

/**
 * The after-game rank board, for a clear and for a wipe: every teammate's
 * damage, healing, kills, damage taken, downs and revives, sorted by damage,
 * then the rewards and the cache (which, left closed, waits in the village).
 */
export function openResults(o: {
  stats: RunStats;
  victory: boolean;
  me: string;
  heroName: (id: string) => string;
  settle: RunSettlement | null;
  onLeave: () => void;
}): void {
  injectCss();
  document.getElementById("sv-modal")?.remove();
  const { stats, victory, settle } = o;
  const m = document.createElement("div");
  m.id = "sv-modal";
  const rows = [...(stats.players ?? [])].sort((a, b) => b.dealt - a.dealt || b.kills - a.kills);
  const best = (k: "dealt" | "healed" | "kills" | "revives") => Math.max(1, ...rows.map((r) => r[k]));
  const n = (v: number) => v.toLocaleString();
  const cell = (v: number, k: "dealt" | "healed" | "kills" | "revives") =>
    `<td class="${rows.length > 1 && v === best(k) ? "top" : ""}">${n(v)}</td>`;
  const mins = Math.floor(stats.durationS / 60);
  const secs = String(Math.floor(stats.durationS % 60)).padStart(2, "0");
  const loot = stats.loot;
  const awarded = settle ? settle.awarded : loot?.total ?? 0;
  const jackpot = settle ? settle.jackpot : !!loot?.jackpot;
  m.innerHTML = `<div class="sv-card"><div class="head">
      <h1 class="${victory ? "" : "loss"}">${victory ? "YOU WOKE UP" : "THE DREAM KEEPS YOU"}</h1>
      <span class="sub">${DIFFICULTIES[stats.difficulty].name} · wave ${stats.wavesCleared}/${stats.waves} · ${mins}:${secs}</span></div>
    <div class="body">
      <table><thead><tr><th>#</th><th>Player</th><th>Damage</th><th>Healing</th><th>Kills</th><th>Taken</th><th>Downs</th><th>Revives</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.id === o.me ? "me" : ""}"><td class="rk">${i + 1}</td>
        <td class="nm"><b>${escapeHtml(r.name)}</b>${i === 0 && r.dealt > 0 ? `<span class="mvp">MVP</span>` : ""}<small>${escapeHtml(o.heroName(r.hero))}</small></td>
        ${cell(r.dealt, "dealt")}${cell(r.healed, "healed")}${cell(r.kills, "kills")}<td>${n(r.taken)}</td><td>${r.downs}</td>${cell(r.revives, "revives")}</tr>`).join("")}
      </tbody></table>
      <div class="team">
        <div><b>${n(stats.kills)}</b><small>dream-spawn</small></div>
        <div><b>${stats.elitesKilled}</b><small>elites</small></div>
        <div><b>${stats.bossesKilled}</b><small>bosses</small></div>
        <div><b>${stats.recallRight}/${stats.recallTotal}</b><small>recall</small></div>
      </div>
      <div class="gain ${jackpot ? "jackpot" : ""}">${jackpot ? "JACKPOT! " : ""}+${n(awarded)} ◈ Imaginz${settle ? "" : " (not credited: offline)"}</div>
      ${settle?.newBest ? `<div class="best">NEW PERSONAL BEST · WAVE ${settle.bestWave}</div>` : ""}
      ${settle?.lootBox ? `<div class="cache"><img src="/assets/ui/gear/lootbox-${settle.lootBox.tier}.webp" alt="">
        <div class="grow"><div class="nm">${escapeHtml(settle.lootBox.name)}</div><div class="meta">Leave it closed and it waits for you in the village.</div></div>
        <button class="btn" data-open>Open</button></div>` : ""}
      <div class="err"></div>
      <div class="row"><button class="cta" data-leave>Return to town</button></div>
    </div></div>`;
  const errEl = m.querySelector(".err") as HTMLElement;
  const openBtn = m.querySelector("[data-open]") as HTMLButtonElement | null;
  if (openBtn && settle?.lootBox) {
    const box = settle.lootBox;
    openBtn.addEventListener("click", () => {
      openBtn.disabled = true;
      errEl.textContent = "";
      openLoot(box.id)
        .then((res) => {
          refreshImaginz(res.balance);
          const pet = petSpec(res.pet);
          const meta = [res.shardsGained > 0 ? `+${res.shardsGained} ✦ pet shards` : "", pet ? `${pet.name} joins you!` : ""].filter(Boolean).join(" · ");
          const grow = openBtn.parentElement!.querySelector(".grow")!;
          grow.innerHTML = `<div class="reveal">+${n(res.imaginz)} ◈</div><div class="meta">${escapeHtml(meta)}</div>`;
          openBtn.remove();
          void syncLoadout();
        })
        .catch((ex) => {
          openBtn.disabled = false;
          errEl.textContent = ex instanceof Error ? ex.message : "Could not open the cache.";
        });
    });
  }
  m.querySelector("[data-leave]")!.addEventListener("click", () => { m.remove(); o.onLeave(); });
  document.body.appendChild(m);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
