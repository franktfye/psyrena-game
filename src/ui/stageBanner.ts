/**
 * Erikson's centre-screen stage indicator — the chart, flashed where the
 * player is looking, on every key 1 and key 2.
 *
 *   key 1           "STAGE 5" in spaced small caps, the crisis large in amber
 *                   (its letter-spacing tightens as it lands), the age under
 *                   it, and eight pips with the current stage lit.
 *   key 2, matched  the virtue blooms in gold with a light sweep across the
 *                   word, "+10 Focus" beneath — the pair, paid.
 *   key 2, alone    the virtue dimmed to grey, with the hint to press 1 first.
 *
 * Translucent (peaks at ~0.85 alpha), pointer-transparent, and replaced on
 * every press — keys 1 and 2 come ~1.5 s apart, so an animation is cancelled
 * rather than queued. DOM + CSS only: no GPU cost on any quality tier, and it
 * respects prefers-reduced-motion (a plain fade).
 */

import type { PsychosocialHudState } from "@shared/fight/psychosocial";
import type { Hero, PsychosocialSpec } from "../../shared/types";
import { WOW_FONT } from "./wowChrome";

const CSS = `
#stage-banner {
  position: fixed; left: 50%; top: 24%; transform: translateX(-50%);
  width: min(92vw, 820px); text-align: center; pointer-events: none;
  z-index: 9; opacity: 0; font-family: ${WOW_FONT};
}
#stage-banner .kicker {
  font: 600 clamp(10px, 1.5vw, 14px)/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .55em; text-transform: uppercase; color: #ffd9b0;
  text-shadow: 0 0 10px rgba(255,140,60,.8); margin-bottom: .45em;
}
#stage-banner .title {
  font-size: clamp(20px, 4.4vw, 46px); font-weight: 700; line-height: 1.05;
  letter-spacing: .14em; text-transform: uppercase; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
#stage-banner .title.crisis {
  color: #ffb36b;
  text-shadow: 0 0 18px rgba(255,120,40,.85), 0 0 42px rgba(255,90,20,.45), 0 2px 2px rgba(0,0,0,.6);
}
#stage-banner .vs { font-size: .55em; letter-spacing: .3em; opacity: .75; margin: 0 .5em; }
#stage-banner .title.virtue {
  font-size: clamp(30px, 7vw, 76px); letter-spacing: .22em;
  background: linear-gradient(100deg, #ffcf5a 0%, #fff6cf 45%, #ffffff 50%, #fff6cf 55%, #ffcf5a 100%);
  background-size: 260% 100%; background-position: 100% 0;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0 14px rgba(255,200,70,.85)) drop-shadow(0 0 34px rgba(255,170,40,.45));
}
#stage-banner .title.lone { color: #b9bec8; text-shadow: 0 0 10px rgba(0,0,0,.6); font-size: clamp(22px, 5vw, 52px); }
#stage-banner .sub {
  margin-top: .5em; font: 600 clamp(10px, 1.4vw, 14px)/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .25em; color: #f3e6d0; text-shadow: 0 0 8px rgba(0,0,0,.9);
}
#stage-banner .pips { margin-top: .7em; display: flex; gap: clamp(5px, 1vw, 9px); justify-content: center; }
#stage-banner .pip {
  width: clamp(6px, 1vw, 10px); height: clamp(6px, 1vw, 10px); border-radius: 50%;
  border: 1px solid rgba(255,190,120,.55); background: transparent;
}
#stage-banner .pip.done { background: rgba(255,205,90,.75); border-color: rgba(255,215,120,.9); }
/* Landscape phones (844x390): clear of the boss frame above and of the stage
   caption riding over the thumb cluster below. */
@media (max-height: 480px) {
  #stage-banner { top: 18%; }
  #stage-banner .title { font-size: 22px; }
  #stage-banner .title.virtue { font-size: 34px; }
  #stage-banner .sub { margin-top: .3em; }
  #stage-banner .pips { margin-top: .4em; }
}
#stage-banner .pip.now {
  background: #ffb36b; border-color: #ffd9b0;
  box-shadow: 0 0 10px #ff9a40, 0 0 20px rgba(255,140,60,.6); transform: scale(1.35);
}
`;

let root: HTMLDivElement | null = null;
let running: Animation[] = [];

function mount(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (root?.isConnected) return root;
  if (!document.getElementById("stage-banner-css")) {
    const style = document.createElement("style");
    style.id = "stage-banner-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  root = document.createElement("div");
  root.id = "stage-banner";
  root.setAttribute("aria-live", "polite");
  document.body.appendChild(root);
  return root;
}

const reducedMotion = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(cls: string, text = ""): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}

/** Fade the whole banner in, hold, fade out — the shared envelope. */
function envelope(r: HTMLElement, ms: number, peak: number): Animation {
  return r.animate(
    [
      { opacity: 0, transform: "translateX(-50%) translateY(10px) scale(.96)" },
      { opacity: peak, transform: "translateX(-50%) translateY(0) scale(1)", offset: 0.16 },
      { opacity: peak, transform: "translateX(-50%) translateY(0) scale(1)", offset: 0.68 },
      { opacity: 0, transform: "translateX(-50%) translateY(-8px) scale(1.02)" },
    ],
    { duration: ms, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }
  );
}

/**
 * Flash the indicator for one Erikson palette press. `ps` is the rotation as
 * it stood BEFORE the press (the same reading `voiceKeyFor` takes): key 1
 * shows `ps.stage`; key 2 matches when `ps.armed`.
 */
export function showStageBanner(
  spec: PsychosocialSpec,
  key: "stage" | "virtue",
  ps: PsychosocialHudState
): void {
  const r = mount();
  if (!r) return;
  for (const a of running) a.cancel();
  running = [];
  r.replaceChildren();
  const n = ps.stage;
  const row = spec.stages[n]!;
  const quiet = reducedMotion();

  if (key === "stage") {
    const title = el("title crisis");
    const [pole, opposite] = row.crisis.split(" vs ");
    title.append(document.createTextNode(pole ?? row.crisis));
    if (opposite) {
      // A span, not el()'s div: "vs" sits inline between the poles.
      const vs = document.createElement("span");
      vs.className = "vs";
      vs.textContent = "vs";
      title.append(vs, document.createTextNode(opposite));
    }
    const pips = el("pips");
    for (let i = 0; i < spec.stages.length; i++) {
      pips.append(el(`pip${i < n ? " done" : i === n ? " now" : ""}`));
    }
    r.append(el("kicker", `Stage ${n + 1}`), title, el("sub", `age ${row.age}`), pips);
    running.push(envelope(r, 1250, 0.85));
    if (!quiet) {
      running.push(
        title.animate([{ letterSpacing: "0.5em", filter: "blur(4px)" }, { letterSpacing: "0.14em", filter: "blur(0)" }], {
          duration: 420,
          easing: "cubic-bezier(.2,.8,.2,1)",
        })
      );
    }
    return;
  }

  if (ps.armed) {
    const title = el("title virtue", row.virtue);
    r.append(el("kicker", `${row.short} → virtue`), title, el("sub", `+${spec.pairFocusRefund} Focus`));
    running.push(envelope(r, 1300, 0.88));
    if (!quiet) {
      running.push(
        title.animate(
          [
            { backgroundPosition: "100% 0", transform: "scale(1.28)" },
            { backgroundPosition: "0% 0", transform: "scale(1)" },
          ],
          { duration: 700, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
        )
      );
    }
    return;
  }

  r.append(el("title lone", row.virtue), el("sub", `grows from ${row.short}: press 1 first`));
  running.push(envelope(r, 1100, 0.6));
}

/** Flash the banner if `slotId` is one of `kit`'s rotation keys; else nothing. */
export function stageBannerFor(kit: Hero, slotId: string, ps: PsychosocialHudState | null): void {
  const spec = kit.psychosocial;
  if (!spec || !ps) return;
  const effects = kit.palette.find((p) => p.id === slotId)?.effects ?? [];
  if (effects.some((e) => e.kind === "psychosocial.stage")) showStageBanner(spec, "stage", ps);
  else if (effects.some((e) => e.kind === "psychosocial.virtue")) showStageBanner(spec, "virtue", ps);
}
