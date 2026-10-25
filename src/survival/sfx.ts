/**
 * Dream Siege sound effects (public/assets/survival/sfx, made with Stable
 * Audio Open: tools/gen-survival-sfx.py + tools/ship-survival-sfx.sh; the
 * monster deaths, roar and the defended hit are voiced with VoxCPM2:
 * tools/gen-survival-vox-sfx.sh).
 *
 * Web Audio rather than the game's `new Audio()` per play (src/state/sfx.ts):
 * a 24-monster crowd fires hits many times a second, so every sound is decoded
 * once and played from its buffer, and each has a minimum gap so a crowd does
 * not turn into a wall of noise. Honours the game's SFX mute.
 */
import { audioUrl } from "../core/audio";
import { isSfxMuted } from "../state/sfx";

export type SvSfx =
  | "hit" | "hit_defended" | "die_minion" | "die_elite" | "player_hit" | "dash"
  | "telegraph" | "slam" | "burn" | "projectile" | "bell" | "wave_start" | "boss_roar"
  | "pickup_hp" | "pickup_focus" | "recall_open" | "recall_tick" | "recall_right" | "recall_wrong"
  | "shield_break" | "victory" | "defeat";

/** Minimum seconds between two plays of the same sound, and its level. */
const SPEC: Record<SvSfx, { gap: number; gain: number }> = {
  hit: { gap: 0.07, gain: 0.55 }, hit_defended: { gap: 0.12, gain: 0.5 },
  die_minion: { gap: 0.09, gain: 0.55 }, die_elite: { gap: 0.5, gain: 0.8 },
  player_hit: { gap: 0.18, gain: 0.7 }, dash: { gap: 0.1, gain: 0.6 },
  telegraph: { gap: 0.35, gain: 0.55 }, slam: { gap: 0.25, gain: 0.85 }, burn: { gap: 0.4, gain: 0.6 },
  projectile: { gap: 0.25, gain: 0.45 }, bell: { gap: 0.5, gain: 0.75 },
  wave_start: { gap: 2, gain: 0.8 }, boss_roar: { gap: 2, gain: 0.9 },
  pickup_hp: { gap: 0.08, gain: 0.6 }, pickup_focus: { gap: 0.08, gain: 0.6 },
  recall_open: { gap: 1, gain: 0.7 }, recall_tick: { gap: 0.5, gain: 0.5 },
  recall_right: { gap: 1, gain: 0.8 }, recall_wrong: { gap: 1, gain: 0.75 },
  shield_break: { gap: 0.3, gain: 0.75 }, victory: { gap: 3, gain: 0.9 }, defeat: { gap: 3, gain: 0.9 },
};

export interface SurvivalSfx {
  play(id: SvSfx): void;
  dispose(): void;
}

export function createSurvivalSfx(): SurvivalSfx {
  const Ctx = typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctx) return { play() {}, dispose() {} };
  const ctx = new Ctx();
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(ctx.destination);
  const buffers = new Map<SvSfx, AudioBuffer>();
  const last = new Map<SvSfx, number>();
  // Decode everything up front (276 KB); a sound still loading simply skips.
  for (const id of Object.keys(SPEC) as SvSfx[]) {
    void fetch(audioUrl(`/assets/survival/sfx/${id}`))
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => buffers.set(id, buf))
      .catch(() => {});
  }
  // Mobile browsers start the context suspended until a gesture.
  const resume = () => { if (ctx.state === "suspended") void ctx.resume(); };
  window.addEventListener("pointerdown", resume);
  window.addEventListener("keydown", resume);

  return {
    play(id) {
      if (isSfxMuted()) return;
      const buf = buffers.get(id);
      if (!buf) return;
      const now = ctx.currentTime;
      if (now - (last.get(id) ?? -99) < SPEC[id].gap) return;
      last.set(id, now);
      resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // A little pitch spread so repeated hits do not machine-gun.
      if (id === "hit" || id === "die_minion" || id === "player_hit") src.playbackRate.value = 0.92 + Math.random() * 0.16;
      const g = ctx.createGain();
      g.gain.value = SPEC[id].gain;
      src.connect(g).connect(out);
      src.start();
    },
    dispose() {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      void ctx.close();
    },
  };
}
