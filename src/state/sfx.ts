/**
 * SFX — one-shot sound effects for casts, fight beats and UI clicks.
 *
 * Same shape as musicSettings: one persisted mute knob, a listener bus, and
 * the codex System tab as the only writer. The player itself lives here too —
 * unlike the voice helper's single shared element (where a new line SHOULD
 * interrupt the old), sfx must overlap (a click during a cast, two casts in a
 * GCD), so every play gets a fresh HTMLAudio element; the browser's media
 * cache makes that cheap after the first play of each file.
 *
 * A play blocked by the autoplay policy is DROPPED, not queued — a combat
 * sting replayed on the next gesture would be about the wrong moment. In
 * practice everything here fires after some click anyway.
 *
 * The sound files under /assets/sfx/ are gitignored (PSFX's non-commercial
 * license bars redistributing the audio) — `node tools/sync-sfx.mjs`
 * repopulates them from the vendored psfx/ library, transcoding the library's
 * .ogg to the .webm the game asks for. A missing file plays as silence, never
 * an error.
 *
 * Frank's picks came out of the (gitignored) sfxpicker.html tool; ids with
 * more than one file alternate round-robin per play, per his spec.
 */

import { audioUrl } from "../core/audio";

export const SFX_MUTED_KEY = "psyrena.sfxMuted";

export function isSfxMuted(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SFX_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSfxMuted(muted: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (muted) localStorage.setItem(SFX_MUTED_KEY, "1");
      else localStorage.removeItem(SFX_MUTED_KEY);
    }
  } catch {
    // storage blocked — the toggle just won't persist across reloads
  }
  for (const fn of [...listeners]) fn();
}

const listeners = new Set<() => void>();

export function onSfxSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * files: stems (no extension — see src/core/audio.ts), round-robin per play.
 * gain: per-sound loudness against the master.
 */
interface SfxDef {
  files: readonly string[];
  gain?: number;
}

const MASTER = 0.8;

const SFX = {
  // ---- Pavlov ----
  "pavlov.ns.cast": { files: ["lute-C7-strum", "lute-C6-strum"], gain: 0.7 },
  "pavlov.ns.impact": { files: ["meleeattack-impacts-magicaleffects-psychic-01"], gain: 0.5 },
  "pavlov.ucs.cast": { files: ["meleeattack-swoosh-heavy-group01-00"] },
  "pavlov.cs.cast": { files: ["eldritch-blast-001"] },
  "pavlov.defense": { files: ["cure-wounds-00"] },
  "pavlov.chain": { files: ["detect-magic-001"] },
  "pavlov.ult": { files: ["divination-magic-sign-circle-complete"] },
  "pavlov.stance": { files: ["wooden-lock-clean-01"], gain: 0.6 },
  // ---- Freud ----
  "freud.basic.cast": { files: ["ranged-magic-energy-strands-001-05ft"], gain: 0.55 },
  "freud.basic.impact": { files: ["meleeattack-impacts-bludgeoning-00"], gain: 0.4 },
  "freud.stage.cast": { files: ["eldritch-blast-001"], gain: 0.8 },
  "freud.stage.impact": { files: ["meleeattack-impacts-bludgeoning-02"], gain: 0.5 },
  "freud.defense": { files: ["boon-002-01"] },
  "freud.chain": { files: ["moonbeam-intro-v1-003"] },
  "freud.ult": { files: ["divination-magic-sign-circle-intro-fade"] },
  // ---- Skinner ----
  "skinner.basic.cast": { files: ["ranged-magic-energy-strands-001-05ft"], gain: 0.55 },
  "skinner.basic.impact": { files: ["meleeattack-impacts-bludgeoning-03"], gain: 0.4 },
  "skinner.fixed-ratio": { files: ["boon-001-01"] },
  "skinner.variable-ratio": { files: ["boon-002-01"] },
  "skinner.variable-ratio.jackpot": { files: ["boon-003-01"] },
  "skinner.fixed-interval": { files: ["boon-001-01"] },
  "skinner.variable-interval": { files: ["boon-002-01"] },
  "skinner.hot.tick": { files: ["wooden-lock-clean-01"], gain: 0.3 },
  "skinner.contingency": { files: ["wooden-open-clean-01"], gain: 0.6 },
  "skinner.consequence": { files: ["revolver-prepare-001-02"], gain: 0.6 },
  "skinner.ult": { files: ["bless-v1-005"] },
  "skinner.proc": { files: ["lute-C7-strum"], gain: 0.4 },
  // ---- Boss fight ----
  "fight.countdown.tick": { files: ["ominous-bell-001"], gain: 0.6 },
  "fight.boss.engage": { files: ["thunderclap-001"] },
  "boss.melee.swing": { files: ["meleeattack-impacts-slashing-03"], gain: 0.45 },
  "boss.shapeshift": { files: ["conjuration-magic-sign-circle-intro-fade"] },
  "boss.skillcheck.correct": { files: ["boon-001-01"], gain: 0.6 },
  "boss.skillcheck.wrong": { files: ["toll-the-dead-001"], gain: 0.7 },
  "boss.armor.up": { files: ["shield-spell-v1-intro-03"] },
  "boss.terror.aoe": { files: ["chain-lightning-secondary-strike-5ft-00"], gain: 0.6 },
  // The ground fan: a rising hum while the wedge fills, then the sweep itself.
  "boss.fan.windup": { files: ["moonbeam-intro-v1-003"], gain: 0.5 },
  "boss.fan.land": { files: ["meleeattack-swoosh-heavy-group01-00"], gain: 0.75 },
  "boss.fan.land.wide": { files: ["thunderclap-001"], gain: 0.7 },
  // Psyche orbs: the throw, then each one hitting the floor.
  "boss.orb.fall": { files: ["eldritch-blast-001"], gain: 0.6 },
  "boss.orb.land": { files: ["meleeattack-impacts-bludgeoning-03"], gain: 0.8 },
  "fight.phase.warning": { files: ["detect-magic-001"], gain: 0.7 },
  "fight.victory": { files: ["bless-v1-005"] },
  "fight.defeat": { files: ["toll-the-dead-001"] },
  "fight.player.death": { files: ["snoring-humanoid-001"], gain: 0.7 },
  // ---- UI ----
  "ui.click": { files: ["wooden-lock-clean-01"], gain: 0.4 },
  "ui.panel.open": { files: ["wooden-unlock-clean-01"], gain: 0.5 },
  "ui.panel.close": { files: ["wooden-close-clean-01"], gain: 0.45 },
  "ui.purchase": { files: ["drink-liquid-002"], gain: 0.7 },
  "ui.forge": { files: ["footsteps-single-outdoors-001-03"], gain: 0.7 },
} satisfies Record<string, SfxDef>;

export type SfxId = keyof typeof SFX;

/** Which of an id's files plays next — Frank's "loop them for two clicks". */
const nextIndex = new Map<SfxId, number>();

/**
 * Fire-and-forget one-shot. `rate` pitch-shifts (preservesPitch off) — the
 * five Freud stages share one cast file distinguished this way. No-ops
 * headless (the fight sim runs under node in the eval drivers) and when muted.
 */
export function playSfx(id: SfxId, rate = 1): void {
  if (typeof Audio === "undefined" || isSfxMuted()) return;
  const def: SfxDef = SFX[id];
  const i = nextIndex.get(id) ?? 0;
  nextIndex.set(id, (i + 1) % def.files.length);
  const a = new Audio(audioUrl(`/assets/sfx/${def.files[i]}`));
  a.volume = Math.min(1, MASTER * (def.gain ?? 1));
  if (rate !== 1) {
    a.preservesPitch = false;
    a.playbackRate = rate;
  }
  void a.play().catch(() => {
    // Autoplay-blocked or file missing (fresh clone before sync-sfx) — silence.
  });
}

/**
 * Ability id → cast sound. One lookup shared by the arena bar and the
 * village/booth bar so a kit sounds the same everywhere. The five Freud
 * stages share one sound at stepped pitches — the tint tells them apart on
 * screen, the pitch in the ear.
 */
const CAST_SFX: Record<string, { id: SfxId; rate?: number }> = {
  "pavlov.ns": { id: "pavlov.ns.cast" },
  "pavlov.ucs": { id: "pavlov.ucs.cast" },
  "pavlov.cs": { id: "pavlov.cs.cast" },
  "pavlov.spontaneous-recovery": { id: "pavlov.defense" },
  "pavlov.generalization": { id: "pavlov.chain" },
  "pavlov.extinction": { id: "pavlov.ult" },
  "pavlov.discrimination": { id: "pavlov.stance" },
  "freud.basic": { id: "freud.basic.cast" },
  "freud.stage.oral": { id: "freud.stage.cast", rate: 0.85 },
  "freud.stage.anal": { id: "freud.stage.cast", rate: 0.95 },
  "freud.stage.phallic": { id: "freud.stage.cast", rate: 1.05 },
  "freud.stage.latency": { id: "freud.stage.cast", rate: 1.15 },
  "freud.stage.genital": { id: "freud.stage.cast", rate: 1.28 },
  "freud.defense": { id: "freud.defense" },
  "freud.free-association": { id: "freud.chain" },
  "freud.dream-analysis": { id: "freud.ult" },
  "skinner.response-rate": { id: "skinner.basic.cast" },
  "skinner.fixed-ratio": { id: "skinner.fixed-ratio" },
  "skinner.variable-ratio": { id: "skinner.variable-ratio" },
  "skinner.fixed-interval": { id: "skinner.fixed-interval" },
  "skinner.variable-interval": { id: "skinner.variable-interval" },
  "skinner.contingency": { id: "skinner.contingency" },
  "skinner.consequence": { id: "skinner.consequence" },
  "skinner.shaping": { id: "skinner.ult" },
};

/** Ability id → the sound its projectile makes on landing. */
const IMPACT_SFX: Record<string, SfxId> = {
  "pavlov.ns": "pavlov.ns.impact",
  "freud.basic": "freud.basic.impact",
  "freud.stage.oral": "freud.stage.impact",
  "freud.stage.anal": "freud.stage.impact",
  "freud.stage.phallic": "freud.stage.impact",
  "freud.stage.latency": "freud.stage.impact",
  "freud.stage.genital": "freud.stage.impact",
  "skinner.response-rate": "skinner.basic.impact",
};

export function playCastSfx(abilityId: string): void {
  const m = CAST_SFX[abilityId];
  if (m) playSfx(m.id, m.rate);
}

export function playImpactSfx(abilityId: string): void {
  const id = IMPACT_SFX[abilityId];
  if (id) playSfx(id);
}
