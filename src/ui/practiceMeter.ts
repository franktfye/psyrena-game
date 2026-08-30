/**
 * Practice meter — the damage/healing readout in the Practice Booth.
 *
 * A raid meter, scoped to one player and one dummy. It exists because the
 * booth's whole job is answering "what does this button actually do", and a
 * number that flashes for 0.95 s and disappears cannot answer that: you need
 * the running total, the rate, and the share each skill is carrying.
 *
 * Plain DOM like every other overlay (player frame, action bar, damage
 * numbers) — crisp at any DPI, free alpha, zero draw calls.
 *
 * ## What the rate means
 *
 * DPS is measured over the ENCOUNTER WINDOW: first cast to last cast, floored
 * at one second. Not wall-clock since entering, because then reading the
 * tooltip for a minute would show a DPS of nearly zero and the number would be
 * useless. Not a sliding window either, because the point of a practice range
 * is to compare whole rotations against each other. Standing still does not
 * dilute your number; it just stops the clock.
 */

import { uiScale, detectControlScheme } from "./inputMode";

const PANEL_BG = "linear-gradient(180deg, rgba(30,24,14,.92), rgba(12,10,7,.92))";
const PANEL_BORDER = "1px solid #8a6d2f";
const FONT = "Georgia, 'Palatino Linotype', Palatino, serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const GOLD = "#d8b45a";
const DIM = "#9c8a63";

export interface PracticeMeter {
  /** Record a landed hit. `heal` entries feed HPS instead of DPS. */
  record(label: string, amount: number, kind: "damage" | "heal"): void;
  /** Zero everything — the Reset button, and re-entering the booth. */
  reset(): void;
  dispose(): void;
}

interface Row {
  label: string;
  casts: number;
  damage: number;
  healing: number;
}

export function createPracticeMeter(): PracticeMeter {
  if (typeof document === "undefined") {
    // Headless soak: no DOM, no meter, but the scene still runs.
    return { record: () => {}, reset: () => {}, dispose: () => {} };
  }

  const s = uiScale();
  /**
   * Touch moves the whole panel to the top centre, where the boss frame sits
   * during a fight, and shrinks it.
   *
   * On the right it was unusable: the touch skill arc reaches `bottom: 185`
   * with 66 px buttons (actionBar `TOUCH_ARC`), so a panel anchored at
   * `top: 210` on the right lands directly on top of the ultimate and the
   * palette wheel and swallows the taps. The top centre strip is free in the
   * practice booth for the same reason it is used in the arena: there is
   * exactly one thing worth reading at a glance, and in here that is this.
   */
  const compact = detectControlScheme() === "touch";
  /** Scale factor for every size in the panel. Touch reads it smaller. */
  const u = compact ? s * 0.82 : s;
  const px = (n: number): number => Math.round(n * u);

  const root = document.createElement("div");
  root.id = "practice-meter";
  root.style.cssText = [
    "position:fixed",
    ...(compact
      ? [
          "top:8px",
          "left:50%",
          "transform:translateX(-50%)",
          "width:min(300px,72vw)",
          // Never tall enough to reach the skill arc, whatever the rotation.
          "max-height:32vh",
          "overflow:hidden",
        ]
      : [`right:${px(12)}px`, `top:${px(210)}px`, `width:${px(226)}px`]),
    `background:${PANEL_BG}`,
    `border:${PANEL_BORDER}`,
    "outline:1px solid #2a1f0d",
    "border-radius:5px",
    `padding:${px(compact ? 5 : 8)}px ${px(compact ? 8 : 10)}px`,
    `font-family:${FONT}`,
    "color:#e8dcc0",
    "z-index:25",
    "pointer-events:auto",
    "user-select:none",
    "text-shadow:0 1px 2px #000",
  ].join(";");

  const head = document.createElement("div");
  head.style.cssText = `display:flex;align-items:center;justify-content:space-between;color:${GOLD};font-size:${px(compact ? 9 : 11)}px;letter-spacing:.1em;margin-bottom:${px(compact ? 3 : 6)}px`;
  const title = document.createElement("span");
  title.textContent = "PRACTICE";
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "reset";
  // Kept finger sized on touch even though the panel shrank: a 9 px tap target
  // is a decoration, not a button.
  resetBtn.style.cssText = `background:none;border:1px solid #6b5423;border-radius:3px;color:${GOLD};font:${px(9)}px ${FONT};letter-spacing:.08em;padding:${compact ? "3px 9px" : "1px 5px"};cursor:pointer;opacity:.85`;
  head.append(title, resetBtn);

  // ---- headline rates ----------------------------------------------------
  // Touch lays the two rates side by side with the totals on the same row, so
  // the whole panel is three short lines instead of six.
  const big = document.createElement("div");
  big.style.cssText = `display:grid;grid-template-columns:1fr 1fr;gap:${px(4)}px;margin-bottom:${px(compact ? 2 : 6)}px`;

  const mkStat = (
    caption: string,
    color: string
  ): { wrap: HTMLDivElement; value: HTMLDivElement; sub: HTMLDivElement } => {
    const wrap = document.createElement("div");
    wrap.style.cssText = compact ? "display:flex;align-items:baseline;gap:5px" : "";
    const value = document.createElement("div");
    value.style.cssText = `font:700 ${px(compact ? 15 : 17)}px ${MONO};color:${color};line-height:1.1`;
    value.textContent = "0";
    const sub = document.createElement("div");
    sub.style.cssText = `font-size:${px(9)}px;color:${DIM};opacity:.75;letter-spacing:.06em`;
    sub.textContent = caption;
    wrap.append(value, sub);
    return { wrap, value, sub };
  };

  const dpsStat = mkStat("DPS", "#eaf7ff");
  const hpsStat = mkStat("HPS", "#7dfaa8");
  big.append(dpsStat.wrap, hpsStat.wrap);

  // ---- totals ------------------------------------------------------------
  const totals = document.createElement("div");
  totals.style.cssText = `font:${px(compact ? 9 : 10)}px ${MONO};color:#cbb98d;opacity:.9;margin-bottom:${px(compact ? 3 : 6)}px;line-height:${compact ? 1.35 : 1.5}`;

  // ---- per-skill breakdown ----------------------------------------------
  const bars = document.createElement("div");
  bars.style.cssText = `display:flex;flex-direction:column;gap:${px(compact ? 2 : 3)}px`;

  root.append(head, big, totals, bars);
  document.body.appendChild(root);

  const rows = new Map<string, Row>();
  let damage = 0;
  let healing = 0;
  let hits = 0;
  let firstAt = 0;
  let lastAt = 0;

  /** Encounter window in seconds — see the module note. Floored so one cast
   *  cannot divide by zero and report an absurd rate. */
  const windowS = (): number => (firstAt ? Math.max(1, (lastAt - firstAt) / 1000) : 1);

  function render(): void {
    const w = windowS();
    dpsStat.value.textContent = Math.round(damage / w).toLocaleString();
    hpsStat.value.textContent = Math.round(healing / w).toLocaleString();
    const dmgTxt = `dmg ${Math.round(damage).toLocaleString()}`;
    const healTxt = `heal ${Math.round(healing).toLocaleString()}`;
    const castTxt = `${hits} cast${hits === 1 ? "" : "s"} over ${w.toFixed(1)}s`;
    // One line on touch, two on desktop: vertical space is the scarce thing at
    // the top of a phone, horizontal space is not.
    totals.textContent = compact
      ? `${dmgTxt}  ${healTxt}  ${castTxt}`
      : `${dmgTxt}   ${healTxt}\n${castTxt}`;
    totals.style.whiteSpace = "pre";

    // Ranked by contribution, the way a raid meter does it — the useful
    // question is which button is carrying, not which was pressed first.
    const ranked = [...rows.values()].sort(
      (a, b) => b.damage + b.healing - (a.damage + a.healing)
    );
    const top = ranked[0] ? ranked[0].damage + ranked[0].healing : 1;
    bars.replaceChildren();
    // Touch shows only what is carrying. A full breakdown at the top of a
    // phone would grow back down into the play area on a long rotation, which
    // is the problem this layout exists to solve.
    const shown = compact ? ranked.slice(0, 3) : ranked;
    for (const r of shown) {
      const total = r.damage + r.healing;
      const share = total / Math.max(1, damage + healing);
      const line = document.createElement("div");
      line.style.cssText = `position:relative;height:${px(compact ? 13 : 15)}px`;
      const fill = document.createElement("div");
      fill.style.cssText = [
        "position:absolute;inset:0",
        `width:${Math.max(2, (total / Math.max(1, top)) * 100)}%`,
        `background:${r.healing > r.damage ? "rgba(80,200,130,.30)" : "rgba(90,150,210,.30)"}`,
        "border-radius:2px",
      ].join(";");
      const text = document.createElement("div");
      text.style.cssText = `position:relative;display:flex;justify-content:space-between;font:${px(9)}px ${MONO};padding:0 ${px(4)}px;line-height:${px(compact ? 13 : 15)}px`;
      const name = document.createElement("span");
      name.textContent = `${r.label} ×${r.casts}`;
      const val = document.createElement("span");
      val.textContent = `${Math.round(total).toLocaleString()}  ${Math.round(share * 100)}%`;
      text.append(name, val);
      line.append(fill, text);
      bars.appendChild(line);
    }
  }

  function reset(): void {
    rows.clear();
    damage = 0;
    healing = 0;
    hits = 0;
    firstAt = 0;
    lastAt = 0;
    render();
  }

  resetBtn.addEventListener("click", reset);
  render();

  return {
    record(label, amount, kind) {
      if (!(amount > 0)) return;
      const now = performance.now();
      if (!firstAt) firstAt = now;
      lastAt = now;
      hits += 1;
      if (kind === "heal") healing += amount;
      else damage += amount;
      const row = rows.get(label) ?? { label, casts: 0, damage: 0, healing: 0 };
      row.casts += 1;
      if (kind === "heal") row.healing += amount;
      else row.damage += amount;
      rows.set(label, row);
      render();
    },
    reset,
    dispose() {
      resetBtn.removeEventListener("click", reset);
      root.remove();
    },
  };
}
