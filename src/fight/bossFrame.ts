/**
 * Boss frame — top-centre HUD for the fight.
 *
 * Plain DOM like the action bar and chat panel (flat holographic UI is a
 * stylesheet, not a render target — doc 01). Shows what a raid frame shows:
 * boss HP, the current phase and its clock, the enrage timer, the boss's
 * debuff stacks, the player's Mark/Amp state, and a single-row hate readout
 * (every hero's threat as a percentage of the top) so the hate system stays
 * visible without eating screen space.
 *
 * Created by the arena combat glue, disposed with the scene. `update()` is
 * called every frame and only touches the DOM when a value actually changed.
 */

import type { FightSnapshot } from "@shared/fight/bossFight";
import { DIFFICULTY, type FightDifficulty } from "./difficulty";
import { detectControlScheme } from "../ui/inputMode";

const FONT = "ui-monospace,SFMono-Regular,Menlo,monospace";

/**
 * Badge colour per difficulty — the same escalation the rooms panel draws with
 * its gold tags: Standard stays quiet, the two that multiply the boss do not.
 */
const DIFFICULTY_COLOR: Record<FightDifficulty, string> = {
  standard: "#9fc8d8",
  hard: "#ffc14d",
  nightmare: "#ff5964",
};

function el(tag: string, css: string, parent: HTMLElement, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function fmtHp(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${`${r}`.padStart(2, "0")}`;
}

export class BossFrame {
  private readonly root: HTMLDivElement;
  private readonly nameEl: HTMLElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLDivElement;
  private readonly phaseText: HTMLDivElement;
  private readonly enrageText: HTMLDivElement;
  private readonly stateText: HTMLDivElement;
  private readonly hateRow: HTMLDivElement;
  private readonly cache = new Map<string, string>();

  /**
   * @param difficulty The difficulty this run is actually being fought at —
   * the ranked pick, or practice's own (fight/arenaCombat.ts resolves which).
   * It is fixed for the life of the fight, so the badge is written once here
   * rather than riding the per-frame snapshot.
   */
  constructor(difficulty: FightDifficulty = "standard") {
    const compact = detectControlScheme() === "touch";
    this.root = document.createElement("div");
    this.root.id = "bossFrame";
    this.root.style.cssText = [
      "position:fixed",
      "top:8px",
      "left:50%",
      "transform:translateX(-50%)",
      compact ? "width:min(240px,58vw)" : "width:min(320px,56vw)",
      "z-index:20",
      `font:10px/1.3 ${FONT}`,
      "color:#d8f7ff",
      "background:rgba(4,10,18,.72)",
      "border:1px solid rgba(255,89,89,.35)",
      "border-radius:8px",
      compact ? "padding:3px 7px 4px" : "padding:5px 9px 6px",
      "backdrop-filter:blur(6px)",
      "pointer-events:none",
      "text-shadow:0 1px 2px #000",
    ].join(";");

    // Name and difficulty share the left cell of the head row: the badge has
    // to sit BESIDE the name, and head is space-between, which would otherwise
    // fling a third child into the middle.
    const head = el("div", "display:flex;justify-content:space-between;align-items:baseline;gap:8px", this.root) as HTMLDivElement;
    const nameWrap = el("div", "display:flex;align-items:baseline;gap:5px;min-width:0", head) as HTMLDivElement;
    this.nameEl = el("span", "color:#ff8896;font-weight:700;letter-spacing:.12em;font-size:11px", nameWrap, "☠ —");
    // Fixed for the run, so it is written once and never touched again.
    el(
      "span",
      `color:${DIFFICULTY_COLOR[difficulty]};font-size:9px;letter-spacing:.06em;white-space:nowrap`,
      nameWrap,
      `(${DIFFICULTY[difficulty].label})`
    );
    this.enrageText = el("span", "color:#7fdcf0;font-size:9px", head) as HTMLDivElement;

    // HP bar
    const barWrap = el(
      "div",
      "position:relative;height:11px;margin-top:3px;background:#14090d;border:1px solid rgba(255,136,150,.4);border-radius:4px;overflow:hidden",
      this.root
    ) as HTMLDivElement;
    this.hpFill = el(
      "div",
      "position:absolute;inset:0;width:100%;background:linear-gradient(180deg,#ff5964,#a31220);transition:width .12s linear",
      barWrap
    ) as HTMLDivElement;
    this.hpText = el(
      "div",
      "position:absolute;inset:0;display:grid;place-content:center;font-size:9px;color:#fff",
      barWrap
    ) as HTMLDivElement;
    this.hpText.id = "bossFrameHp";

    const sub = el("div", "display:flex;justify-content:space-between;gap:8px;margin-top:2px", this.root) as HTMLDivElement;
    this.phaseText = el("span", "color:#c9a0ff", sub) as HTMLDivElement;
    this.stateText = el("span", "color:#7fdcf0;font-size:9px", sub) as HTMLDivElement;

    // One row: every hero's hate as a percentage of the top threat.
    this.hateRow = el(
      "div",
      "margin-top:2px;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
      this.root
    ) as HTMLDivElement;

    document.body.appendChild(this.root);
  }

  private setText(key: string, node: HTMLElement, text: string): void {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    node.textContent = text;
  }

  update(s: FightSnapshot): void {
    this.setText("name", this.nameEl, `☠ ${s.bossName}`);

    const pct = s.hpMax > 0 ? s.hp / s.hpMax : 0;
    const pctText = `${fmtHp(s.hp)} / ${fmtHp(s.hpMax)} · ${(pct * 100).toFixed(1)}%`;
    this.setText("hp", this.hpText, pctText);
    const w = `${(pct * 100).toFixed(1)}%`;
    if (this.cache.get("hpw") !== w) {
      this.cache.set("hpw", w);
      this.hpFill.style.width = w;
    }

    // "Shapeshift — 12s → Fortress": the arrow is the heads-up for what the
    // clock runs into, so nobody is surprised by an armor phase.
    const heading = s.nextPhaseName ? ` → ${s.nextPhaseName}` : "";
    this.setText(
      "phase",
      this.phaseText,
      s.phase === "idle"
        ? `Engages in ${Math.ceil(s.phaseRemainingS)}s${heading}`
        : s.phase === "dead"
          ? "Defeated"
          : `${s.phaseName} — ${Math.ceil(s.phaseRemainingS)}s${heading}`
    );

    const enrage = s.enraged ? "ENRAGED" : `Enrage ${fmtClock(s.enrageRemainingS)}`;
    this.setText("enrage", this.enrageText, enrage);
    const enrageColor = s.enraged || s.enrageRemainingS < 60 ? "#ff5964" : "#7fdcf0";
    if (this.cache.get("enrageColor") !== enrageColor) {
      this.cache.set("enrageColor", enrageColor);
      this.enrageText.style.color = enrageColor;
    }

    const stateBits: string[] = [];
    if (s.debuffStacks > 0) stateBits.push(`Wounds ×${s.debuffStacks}`);
    if (s.marks > 0) stateBits.push(`Marks ${s.marks}`);
    if (s.amp > 0.005) stateBits.push(`Amp ${(s.amp * 100).toFixed(0)}%`);
    this.setText("state", this.stateText, stateBits.join(" · "));

    // Hate — one row, every hero's threat as a percentage of the top.
    const max = Math.max(1, s.threat[0]?.value ?? 1);
    const signature = s.threat
      .map((t) => `${t.name}${t.alive ? "" : "†"}${Math.round((t.value / max) * 100)}`)
      .join("|");
    if (this.cache.get("threat") !== signature) {
      this.cache.set("threat", signature);
      this.hateRow.replaceChildren(
        ...s.threat.map((t, i) => {
          const chip = document.createElement("span");
          chip.style.cssText = `color:${t.isPlayer ? "#ffd97a" : t.role === "tank" ? "#40e6ff" : "#9fc8d8"}`;
          chip.textContent = `${i > 0 ? " · " : ""}${t.role === "tank" ? "🛡" : t.role === "healer" ? "✚" : "⚔"}${t.name}${t.alive ? "" : " †"} ${Math.round((t.value / max) * 100)}%`;
          return chip;
        })
      );
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
