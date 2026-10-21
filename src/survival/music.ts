/**
 * Dream Siege soundtrack (Frank's Suno tracks, public/assets/survival/ost):
 *   - normal waves: "Kowloon Fog" 1 → 2 → 1 …, advancing on each track's end;
 *   - the final wave (the Awakened Hag at 20 / 40 / 60): "Kowloon Fog — Final
 *     Wave", crossfaded in and looped until the run ends.
 * Honours the System-tab music settings like every scene's OST (mute, and a
 * picked track that replaces the rotation; back to Auto restores ours).
 */
import { audioUrl } from "../core/audio";
import { bindOstPlayer } from "../state/musicSettings";

const BASE = "/assets/survival/ost";
const WAVES = ["fog1", "fog2"];
const FINAL = "fog_boss";
/** Same level as the village OST (villageHub VILLAGE_OST_VOLUME). */
const VOLUME = 0.3;
const FADE_S = 3;

export interface SurvivalMusic {
  /** The last wave began: crossfade to the final-wave track. */
  final(): void;
  dispose(): void;
}

export function createSurvivalMusic(): SurvivalMusic {
  if (typeof Audio === "undefined") return { final() {}, dispose() {} };
  let player = new Audio();
  let disposed = false;
  let ix = 0;
  let isFinal = false;
  let fade = 0;

  const load = (el: HTMLAudioElement) => {
    if (isFinal) {
      el.src = audioUrl(`${BASE}/${FINAL}`);
      el.loop = true;
    } else {
      el.src = audioUrl(`${BASE}/${WAVES[ix % WAVES.length]}`);
      el.loop = false; // advance on end
    }
    el.volume = VOLUME;
    el.preload = "auto";
  };
  const play = () => { if (!disposed) void player.play().catch(() => {}); };
  const onEnded = () => {
    if (disposed || isFinal) return;
    ix = (ix + 1) % WAVES.length;
    load(player);
    play();
  };
  player.addEventListener("ended", onEnded);
  load(player);

  let unbind = bindOstPlayer(player, () => { load(player); play(); });
  const unlock = () => play();
  void player.play().catch(() => {
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  });

  return {
    final() {
      if (isFinal || disposed) return;
      isFinal = true;
      // Crossfade: the new track rises while the old one falls.
      const old = player;
      const next = new Audio();
      load(next);
      next.volume = 0;
      next.muted = old.muted;
      void next.play().catch(() => {});
      const t0 = performance.now();
      fade = window.setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / (FADE_S * 1000));
        old.volume = VOLUME * (1 - k);
        next.volume = VOLUME * k;
        if (k >= 1) {
          window.clearInterval(fade);
          old.pause();
          old.removeEventListener("ended", onEnded);
        }
      }, 50);
      player = next;
      unbind();
      unbind = bindOstPlayer(player, () => { load(player); play(); });
    },
    dispose() {
      disposed = true;
      window.clearInterval(fade);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      unbind();
      player.pause();
    },
  };
}
