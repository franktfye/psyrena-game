/**
 * Morpheus, the survival announcer (assets/work/survival/voice/lines.tsv).
 *
 * The sim decides WHAT to say and how urgent it is (`announce` events with a
 * priority: 0 taunt · 1 event · 2–3 instruction/boss · 4 run-defining); this
 * decides WHEN. One line at a time, never over itself:
 *   - a higher-priority line cuts a lower one that is playing (instructions
 *     must not wait behind a taunt);
 *   - waiting lines go stale: a taunt or wave call older than 3 s is dropped
 *     (it no longer matches the moment); instructions teach the game once per
 *     run, so they wait up to 20 s — long enough to outlast a run intro;
 *   - a 0.6 s gap between lines, so they read as separate thoughts.
 * Every line is subtitled (voiceLines.ts, generated from lines.tsv): the text
 * fades in as the line starts and out when it ends or is cut.
 */
import { audioUrl } from "../core/audio";
import { VOICE_LINES } from "./voiceLines";

const SUB_CSS = `
#sv-sub { position: fixed; left: 50%; bottom: calc(max(14px, env(safe-area-inset-bottom)) + 136px); transform: translateX(-50%);
  max-width: min(70vw, 680px); z-index: 32; pointer-events: none; text-align: center; padding: 6px 14px; border-radius: 8px;
  background: rgba(8, 6, 16, .45); color: rgba(246, 240, 255, .95); font: italic clamp(13px, 2.8vh, 18px) Georgia, serif;
  text-shadow: 0 1px 3px #000; opacity: 0; transition: opacity .25s ease; }
#sv-sub.on { opacity: 1; }
#sv-sub b { display: block; font: 700 clamp(9px, 1.6vh, 11px) system-ui; letter-spacing: .18em; color: rgba(190, 160, 255, .85); font-style: normal; margin-bottom: 2px; }
`;

const BASE = "/assets/survival/voice";
const GAP_MS = 600;

interface Queued { key: string; priority: number; at: number }

export interface Announcer {
  say(key: string, priority: number): void;
  dispose(): void;
}

export function createAnnouncer(): Announcer {
  const queue: Queued[] = [];
  // The subtitle line (DOM; absent headless).
  let sub: HTMLDivElement | null = null;
  if (typeof document !== "undefined") {
    if (!document.getElementById("sv-sub-css")) {
      const st = document.createElement("style");
      st.id = "sv-sub-css";
      st.textContent = SUB_CSS;
      document.head.appendChild(st);
    }
    sub = document.createElement("div");
    sub.id = "sv-sub";
    document.body.appendChild(sub);
  }
  const showSub = (key: string) => {
    const text = VOICE_LINES[key];
    if (!sub || !text) return;
    sub.innerHTML = "";
    const who = document.createElement("b");
    who.textContent = "MORPHEUS";
    sub.append(who, document.createTextNode(text));
    sub.classList.add("on");
  };
  const hideSub = () => sub?.classList.remove("on");
  let playing: { el: HTMLAudioElement; priority: number } | null = null;
  let quietUntil = 0;
  let timer = 0;

  const staleAfter = (p: number) => (p >= 2 ? 20000 : 3000);

  function pump(): void {
    if (playing || typeof Audio === "undefined") return;
    const now = performance.now();
    if (now < quietUntil) {
      timer = window.setTimeout(pump, quietUntil - now);
      return;
    }
    for (let i = queue.length - 1; i >= 0; i--) if (now - queue[i].at > staleAfter(queue[i].priority)) queue.splice(i, 1);
    if (!queue.length) return;
    queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    const next = queue.shift()!;
    const el = new Audio(audioUrl(`${BASE}/${next.key}`));
    el.volume = 1; // VO plays at full level, as the Nightmare pack does

    playing = { el, priority: next.priority };
    showSub(next.key);
    const done = () => {
      if (playing?.el !== el) return;
      playing = null;
      hideSub();
      quietUntil = performance.now() + GAP_MS;
      pump();
    };
    el.addEventListener("ended", done);
    el.addEventListener("error", done);
    void el.play().catch(done);
  }

  return {
    say(key, priority) {
      // The same line twice in the queue is never wanted.
      if (queue.some((q) => q.key === key)) return;
      queue.push({ key, priority, at: performance.now() });
      if (playing && priority > playing.priority) {
        const cut = playing.el;
        playing = null;
        cut.pause();
        hideSub();
        quietUntil = performance.now() + 150;
      }
      pump();
    },
    dispose() {
      window.clearTimeout(timer);
      queue.length = 0;
      playing?.el.pause();
      playing = null;
      sub?.remove();
    },
  };
}
