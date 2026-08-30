/**
 * Boss guide — the "Know Your Enemy" page behind the small button on the
 * queue panel (ui/roomsPanel.ts). Written copy about NIGHTMARE: what it is,
 * what its four phases do, and the answer key for the five Shapeshift forms.
 *
 * Same plain-DOM discipline as roomsPanel: markup and styles live here, the
 * panel mounts itself on <body>, and nothing touches a scene. It stacks ABOVE
 * the rooms panel (z-index 60 vs 40) and closes on its own ✕ / backdrop /
 * Escape without taking the queue panel down with it — roomsPanel's Escape
 * handler defers while `#boss-guide` is mounted.
 *
 * The card is a fixed-height column and the page scrolls inside it, on the
 * drawn track from ui/wowScroller.ts. This is several screens of reading at
 * every size, so the title bar and the ✕ stay put while it moves.
 *
 * House style follows ui/heroLore.ts: second person, short sentences, and no
 * dash characters anywhere in player-facing text (periods or the "·" dot
 * instead). Numbers are READ OFF shared/bosses/nightmare.ts at render time
 * rather than typed into the prose, for the reason heroLore gives: copy that
 * restates a tuned number is copy that goes stale. The prose is written to
 * survive a retune — it names shapes and order, never magnitudes.
 */

import { NIGHTMARE_STANDARD } from "@shared/bosses/nightmare";
import { FREUD } from "@shared/heroes/freud";
import { STAGE_DETAIL } from "./heroLore";
import {
  WOW_FONT, WOW_CARD, WOW_BTN, WOW_BTN_HOVER, WOW_GOLD, WOW_GOLD_TEXT, WOW_TEXT, WOW_TEXT_DIM,
} from "./wowChrome";
import { wowScrollCss, mountWowScroller } from "./wowScroller";

/**
 * The Nightmare's own voice, one line per phase — the same barks the boss
 * speaks on entry (PHASE_VOICE / VOICE_LINES in scenes/nightmareBoss.ts).
 * Quoted here so the guide sounds like the thing you are about to meet.
 */
const PHASE_EPIGRAPH: Record<string, string> = {
  p1: "One by one. Desire does not wait its turn.",
  p2: "Watch me grow. Every age wants something different.",
  p3: "I refuse. Denial wears better armor than steel.",
  p4: "Feel it. The pulse of every buried want.",
};

/** What each phase asks of the party, in plain second person. */
const PHASE_BRIEF: Record<string, string> = {
  p1:
    "It picks one of you and stays there, the one it hates most. The tank holds that attention on purpose. Everyone else spends the calm building the board.",
  p2:
    "The smoke closes over it and it grows through five ages. This is the window the whole fight is decided in. See the forms below.",
  p3:
    "It stops attacking and starts refusing. Armor turns nearly everything you throw aside, and it heals itself while you spend yourself on it. Only the wounds left by a correct reading reach through.",
  p4:
    "No more favorites. It hits everyone, on a slower clock, and the healer earns the run. Survive it and the cycle turns over.",
};

const LORE: string[] = [
  "Every village sleeps. Not everything that sleeps stays where it was put.",
  "What gets pushed under does not die down there. It keeps the shape of the wanting, and it grows the way buried things grow: quietly, in the dark beneath the thought, without anyone ever feeding it.",
  "The Nightmare is what that becomes when it has had long enough. It is not one sleeper's terror. It is the sediment of everyone's, pressed together season after season until it could stand up and walk out of the ground. It has no face of its own, so it borrows. It has no age of its own, so it tries them all.",
  "Watch it long enough and it stops pretending to be one thing. The smoke closes over it, and it comes back to you through the whole of a life. The mouth that has only just learned to want. The small hands learning to hold, and learning to refuse. The child rehearsing a whole household in a single afternoon. The quiet years that keep their own counsel. The self that finally turns outward and asks to be loved.",
  "Five ages. One hunger, wearing them in order.",
  "To the one holding it, it is a shape that hits. To the one healing, it is damage arriving. The Analyst is the only one at the door who can look at a mask and say which year it was cut from, and the saying is the wound: name the form correctly and it opens where it is thin, and it carries that opening with it. The denial it armors up in afterward goes soft in exactly the places it was named. Read it wrong and nothing is lost but your own footing, because a bad reading only fixates the reader.",
  "It cannot be beaten while it is being feared. It can be beaten while it is being understood.",
];

const CSS = `
#boss-guide {
  position: fixed; inset: 0; z-index: 60; overflow: hidden;
  background: rgba(3, 2, 1, .78); backdrop-filter: blur(4px);
  font: 14px/1.7 ${WOW_FONT}; color: ${WOW_TEXT};
  display: grid; padding: 18px 10px;
}
/* The card is a fixed-height column: title bar on top, the page scrolling
   under it (ui/wowScroller.ts). This is a long read — the lore alone is most
   of a screen — and letting the backdrop take the scroll instead carried the
   boss's name off the top of the window on the first flick of the wheel. */
#boss-guide .card {
  margin: auto; width: min(640px, 96vw); max-height: 100%;
  display: flex; flex-direction: column; overflow: hidden;
  ${WOW_CARD}
}
${wowScrollCss("#boss-guide")}
#boss-guide .scrollwrap { flex: 1 1 auto; display: flex; }
#boss-guide .head {
  position: relative; flex: none; padding: 16px 46px 14px 18px;
  border-bottom: 1px solid #3d3115;
  background: linear-gradient(180deg, #1a1208, #0e0a05);
}
#boss-guide h1 {
  margin: 0; font-size: 17px; letter-spacing: .3em; font-weight: 700;
  ${WOW_GOLD_TEXT}
}
#boss-guide .head .sub {
  margin-top: 4px; font-size: 10px; letter-spacing: .2em; text-transform: uppercase;
  color: ${WOW_TEXT_DIM};
}
#boss-guide .close {
  position: absolute; top: 8px; right: 8px; width: 32px; height: 32px;
  font: inherit; font-size: 16px;
  ${WOW_BTN}
}
#boss-guide .close:hover { ${WOW_BTN_HOVER} }
/* Right padding clears the drawn track, which sits at the card's edge. */
#boss-guide .body { flex: 1 1 auto; padding: 16px 22px 20px 18px; display: grid; gap: 18px; }
#boss-guide h2 {
  margin: 0 0 8px; font-size: 11px; letter-spacing: .3em; color: ${WOW_TEXT_DIM};
  font-weight: 700; text-transform: uppercase;
}
#boss-guide p { margin: 0 0 10px; }
#boss-guide p:last-child { margin-bottom: 0; }
/* The lore reads as a page from a book, the mechanics as a briefing. */
#boss-guide .lore p { color: #ddcaa0; }
#boss-guide .lore p.turn { color: ${WOW_GOLD}; font-style: italic; }
#boss-guide .phase {
  display: grid; gap: 4px; padding: 10px 12px;
  border: 1px solid #3d3115; border-left: 2px solid #5a4620; background: #120d0699;
}
#boss-guide .phase + .phase { margin-top: 8px; }
#boss-guide .phase .nm { font-size: 13px; letter-spacing: .16em; color: #ecc363; text-transform: uppercase; }
#boss-guide .phase .nm .dur { float: right; font-size: 10px; letter-spacing: .12em; color: ${WOW_TEXT_DIM}; text-transform: none; }
#boss-guide .phase .say { font-size: 12px; font-style: italic; color: #9d8fbe; }
#boss-guide .phase .brief { font-size: 12.5px; color: ${WOW_TEXT_DIM}; }
#boss-guide .lede { font-size: 12.5px; color: ${WOW_TEXT_DIM}; }
#boss-guide .forms { display: grid; gap: 6px; }
#boss-guide .form {
  display: grid; grid-template-columns: 22px 1fr; gap: 10px; align-items: start;
  padding: 8px 10px; border: 1px solid #3d3115; background: #120d0699;
}
#boss-guide .form .key {
  font-size: 13px; color: #ecc363; text-align: center; border: 1px solid #5a4620; line-height: 20px;
}
#boss-guide .form .shows { font-size: 12.5px; }
#boss-guide .form .shows b { color: #ecc363; font-weight: 400; letter-spacing: .06em; }
#boss-guide .form .why { font-size: 11.5px; color: ${WOW_TEXT_DIM}; }
#boss-guide .note {
  font-size: 12px; color: ${WOW_TEXT_DIM}; border-top: 1px solid #3d3115; padding-top: 12px;
}
#boss-guide .note b { color: #ecc363; font-weight: 400; }
@media (pointer: coarse), (max-width: 640px) {
  #boss-guide { font-size: 12.5px; padding: 0; }
  /* Full screen, and still a column: the card is not the scroller here either,
     so the boss's name and the ✕ stay reachable however far down the page you
     are. On a phone that matters more than on a desktop, because the guide is
     the only thing on the screen and there is no backdrop left to tap. */
  #boss-guide .card {
    position: fixed; inset: 0; width: 100%; height: 100%; box-sizing: border-box;
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    max-width: none; max-height: none; border-radius: 0; margin: 0;
  }
  #boss-guide h1 { font-size: 14px; }
  #boss-guide .head { padding: 12px 40px 10px 12px; }
  #boss-guide .body { padding: 12px 16px 16px 12px; gap: 14px; }
  #boss-guide .close { width: 26px; height: 26px; font-size: 13px; }
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

/** Small counts read as words in prose, so a tuned stage count stays derived
 *  from the script without the sentence opening on a numeral. */
const spell = (n: number): string =>
  ["zero", "one", "two", "three", "four", "five", "six", "seven"][n] ?? String(n);

/** "60" -> "1:00", so a phase length reads the way a fight timer does. */
const mmss = (s: number): string =>
  s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} sec`;

/**
 * Open the guide. Idempotent, like every other panel here: a second tap while
 * it is up does nothing.
 */
export function openBossGuide(): void {
  if (document.getElementById("boss-guide")) return;
  if (!document.getElementById("boss-guide-css")) {
    document.head.append(el("style", { id: "boss-guide-css" }, CSS));
  }

  const script = NIGHTMARE_STANDARD;
  const close = el("button", { class: "close", type: "button", "aria-label": "Close" }, "✕");

  // ---- The lore page -------------------------------------------------------
  const lore = el("div", { class: "lore" });
  for (const para of LORE) {
    // The two one-line stanzas are the turns of the piece: give them the gold
    // italic so the eye lands on them the way it would on a pull quote.
    const isTurn = para.startsWith("Five ages") || para.startsWith("It cannot be beaten");
    lore.append(el("p", isTurn ? { class: "turn" } : {}, para));
  }

  // ---- The cycle -----------------------------------------------------------
  const cycle = el("div", {}, el("h2", {}, "The Cycle"));
  for (const p of script.phases) {
    const nm = el("div", { class: "nm" }, `${p.id.toUpperCase()} · ${p.name}`);
    nm.append(el("span", { class: "dur" }, mmss(p.durationS)));
    cycle.append(
      el(
        "div",
        { class: "phase" },
        nm,
        ...(PHASE_EPIGRAPH[p.id] ? [el("div", { class: "say" }, `"${PHASE_EPIGRAPH[p.id]}"`)] : []),
        el("div", { class: "brief" }, PHASE_BRIEF[p.id] ?? "")
      )
    );
  }
  const cycleS = script.phases.reduce((a, p) => a + p.durationS, 0);
  cycle.append(
    el(
      "div",
      { class: "note" },
      `The four phases run in this order and start over. After ${script.enrageCycles} full turns of the wheel (${mmss(script.enrageCycles * cycleS)} of fighting) it enrages, and nothing survives that. Kill it inside the wheel.`
    )
  );

  // ---- The five forms ------------------------------------------------------
  const forms = el("div", { class: "forms" });
  for (const [i, slot] of FREUD.palette.entries()) {
    const d = STAGE_DETAIL[slot.id];
    forms.append(
      el(
        "div",
        { class: "form" },
        el("div", { class: "key" }, String(i + 1)),
        el(
          "div",
          {},
          el(
            "div",
            { class: "shows" },
            `It takes the form of ${d?.form ?? "something"}. Answer `,
            el("b", {}, slot.name),
            "."
          ),
          ...(d ? [el("div", { class: "why" }, `${d.span}. ${d.theory}`)] : [])
        )
      )
    );
  }
  const check = script.phases.find((p) => p.skillCheck)?.skillCheck;
  const shred = Math.round(script.p2Debuff.armorShredPerStack * 100);
  const formsSection = el(
    "div",
    {},
    el("h2", {}, "The Five Forms · Shapeshift"),
    el(
      "p",
      { class: "lede" },
      check
        ? `It wears ${spell(check.stages)} forms, about ${check.stageDurS} sec each, and only the Analyst's stage keys answer them. Every correct call leaves a Shapeshift Wound, and the wound ignores the armor that comes next: each one hands back about ${shred} percent of the damage Fortress would have blocked, and bleeds the boss through the hole. A wrong call costs only the caster, so read early and read out loud.`
        : "Only the Analyst's stage keys answer the forms."
    ),
    forms
  );

  const roleNote = el(
    "div",
    { class: "note" },
    el("b", {}, "If you are not the Analyst: "),
    "you cannot name the forms, and you are not meant to. Hold the boss, keep the party standing, and buy your Analyst the quiet to read in. The whole party spends, for the rest of the wheel, what one player earns inside that one window.",
    el("br", {}),
    el("br", {}),
    el("b", {}, "Numbers shown at Standard. "),
    "Hard and Nightmare keep this exact script and only raise its health and its damage, so a party that learns the wheel here never has to learn it again."
  );

  const card = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "head" },
      el("h1", {}, `KNOW YOUR ENEMY · ${script.displayName}`),
      el("div", { class: "sub" }, `Tier ${script.tier} · the thing under the village`),
      close
    )
  );
  // The page is the scroller, so the head above it stays put. The drawn track
  // sizes itself once the card is in the document.
  mountWowScroller(card, "body").append(lore, cycle, formsSection, roleNote);
  const overlay = el("div", { id: "boss-guide" }, card);

  const shut = (): void => {
    window.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // Eat it, so the rooms panel underneath does not close in the same press.
    e.stopPropagation();
    shut();
  };
  close.addEventListener("click", shut);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) shut();
  });
  // Capture phase: the rooms panel registered its own window handler first, so
  // bubble-phase listeners fire in registration order and it would win. This
  // one runs before any of them and stops the event there.
  window.addEventListener("keydown", onKey, true);

  document.body.append(overlay);
}
