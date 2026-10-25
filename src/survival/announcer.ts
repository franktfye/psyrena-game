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
 * fades in as the line starts and out when it ends or is cut. Nothing plays
 * while the loading screen is up (the run ticks during shader compilation, so
 * the intro used to be spoken — and subtitled — under it), and a line whose
 * audio cannot play (autoplay refused, file missing) still stays up for its
 * reading time.
 */
import { audioUrl } from "../core/audio";
import { VOICE_LINES } from "./voiceLines";

// Small but clear: upright text on a near-solid plate, a hard 1 px shadow, no italics.
const SUB_CSS = `
#sv-sub { position: fixed; left: 50%; bottom: calc(max(14px, env(safe-area-inset-bottom)) + 136px); transform: translateX(-50%);
  max-width: min(64vw, 560px); z-index: 33; pointer-events: none; text-align: center; padding: 5px 12px; border-radius: 6px;
  background: rgba(6, 4, 14, .78); border: 1px solid rgba(190, 160, 255, .22); color: #f6f0ff;
  font: 500 clamp(12px, 2.4vh, 15px)/1.35 system-ui, sans-serif; letter-spacing: .01em;
  text-shadow: 0 1px 1px #000; opacity: 0; transition: opacity .2s ease; }
#sv-sub.on { opacity: 1; }
#sv-sub b { display: block; font: 700 clamp(8px, 1.4vh, 10px) system-ui; letter-spacing: .22em; color: rgba(190, 160, 255, .9); margin-bottom: 1px; }
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
  /** The loading screen lifts when main.ts publishes the scene; until then, hold every line. */
  const onScreen = () => typeof document === "undefined" || document.body.dataset.scene === "kowloon";

  function pump(): void {
    if (playing || typeof Audio === "undefined") return;
    const now = performance.now();
    // Lines do not age behind the loading screen: a phone's shader compile can outlast 20 s.
    if (!onScreen()) for (const q of queue) q.at = now;
    if (now < quietUntil || !onScreen()) {
      timer = window.setTimeout(pump, Math.max(200, quietUntil - now));
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
    // No sound (autoplay refused, file missing): the subtitle still gets its reading time.
    const silent = () => window.setTimeout(done, Math.max(2500, (VOICE_LINES[next.key]?.length ?? 0) * 65));
    el.addEventListener("ended", done);
    el.addEventListener("error", silent);
    void el.play().catch(silent);
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
