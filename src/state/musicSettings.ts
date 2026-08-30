/**
 * Music settings — the codex System tab's contract with the three scene OSTs
 * (village hub, practice booth, boss fight).
 *
 * Two persisted knobs, one runtime bus:
 *
 *   psyrena.musicMuted   "1" = muted; absent = on (same idiom as voiceMuted)
 *   psyrena.musicTrack   a track id from MUSIC_TRACKS → loop that one track
 *                        in the village and the practice booth; absent = Auto,
 *                        each scene plays its own default. The BOSS FIGHT is
 *                        exempt: it always rotates the siege loops and
 *                        obeys only the mute switch (isMusicMuted +
 *                        onMusicSettingsChange, no bindOstPlayer) — the pick
 *                        resumes when the village rebuilds on the way out.
 *
 * The scenes keep owning their HTMLAudio elements and their dispose contracts;
 * they call bindOstPlayer() once at creation so a change made in the codex
 * takes effect mid-scene without a reload.
 */

import { audioUrl } from "../core/audio";

export interface MusicTrack {
  id: string;
  label: string;
  src: string;
}

/**
 * Every OST shipped on disk, across village, booth and boss fight. Listing a
 * track here only makes it pickable — the Auto rotations are the scenes' own
 * hardcoded lists (VILLAGE_OST_TRACKS, OST_TRACKS, BOOTH_OST), so a track
 * that appears in no scene list plays only when the player picks it.
 */
export const MUSIC_TRACKS: readonly MusicTrack[] = [
  { id: "firelight_1", label: "Firelight 1", src: audioUrl("/assets/village/ost/firelight_1") },
  { id: "firelight_2", label: "Firelight 2", src: audioUrl("/assets/village/ost/firelight_2") },
  { id: "kinetic_glass_loop", label: "Kinetic Glass", src: audioUrl("/assets/village/ost/kinetic_glass_loop") },
  { id: "violet_practice_pit", label: "Violet Practice Pit", src: audioUrl("/assets/village/ost/violet_practice_pit") },
  { id: "kinetic_glass_loop_origin", label: "Kinetic Glass Origin", src: audioUrl("/assets/village/ost/kinetic_glass_loop_origin") },
  { id: "melody_of_the_glass_city", label: "Melody of the Glass City", src: audioUrl("/assets/village/ost/melody_of_the_glass_city") },
  { id: "siege_loop_1", label: "Heartbeat Siege 1", src: audioUrl("/assets/bosses/ost/siege_loop_1") },
  { id: "siege_loop_2", label: "Heartbeat Siege 2", src: audioUrl("/assets/bosses/ost/siege_loop_2") },
  { id: "siege_sunrise_1", label: "Siege to Sunrise 1", src: audioUrl("/assets/bosses/ost/siege_sunrise_1") },
  { id: "siege_sunrise_2", label: "Siege to Sunrise 2", src: audioUrl("/assets/bosses/ost/siege_sunrise_2") },
  // Pick-only: in no Auto rotation, heard only when chosen from the dropdown.
  { id: "drafts_in_my_phone", label: "Drafts in My Phone", src: audioUrl("/assets/village/ost/drafts_in_my_phone") },
];

export const MUSIC_MUTED_KEY = "psyrena.musicMuted";
export const MUSIC_TRACK_KEY = "psyrena.musicTrack";

export function isMusicMuted(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MUSIC_MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMusicMuted(muted: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (muted) localStorage.setItem(MUSIC_MUTED_KEY, "1");
      else localStorage.removeItem(MUSIC_MUTED_KEY);
    }
  } catch {
    // storage blocked — the toggle just won't persist across reloads
  }
  notify();
}

/**
 * The chosen track id, or null for Auto. Validated against MUSIC_TRACKS so a
 * key left over from a renamed track reads as Auto instead of dead silence.
 */
export function musicTrackOverride(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const id = localStorage.getItem(MUSIC_TRACK_KEY);
    return id !== null && MUSIC_TRACKS.some((t) => t.id === id) ? id : null;
  } catch {
    return null;
  }
}

export function setMusicTrackOverride(id: string | null): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (id) localStorage.setItem(MUSIC_TRACK_KEY, id);
      else localStorage.removeItem(MUSIC_TRACK_KEY);
    }
  } catch {
    // storage blocked — the pick just won't persist across reloads
  }
  notify();
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

export function onMusicSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Wire a scene's OST element to the settings. Applies the current mute and
 * track override immediately (before the scene's own first play() attempt, so
 * an override loads as the initial src), then follows changes live. On a
 * change back to Auto, `restoreDefault` re-establishes the scene's own music
 * and is responsible for calling play().
 *
 * Returns an unbind function — the scene must call it in dispose() or the
 * listener keeps a dead Audio element alive across scene switches.
 */
export function bindOstPlayer(player: HTMLAudioElement, restoreDefault: () => void): () => void {
  let applied = musicTrackOverride();

  const srcFor = (id: string): string | undefined => MUSIC_TRACKS.find((t) => t.id === id)?.src;

  player.muted = isMusicMuted();
  if (applied) {
    const src = srcFor(applied);
    if (src) {
      player.src = src;
      player.loop = true;
    }
  }

  return onMusicSettingsChange(() => {
    player.muted = isMusicMuted();
    const override = musicTrackOverride();
    if (override === applied) return;
    applied = override;
    if (override) {
      const src = srcFor(override);
      if (!src) return;
      player.src = src;
      player.loop = true;
      // A track pick lands inside the click gesture, so play() is unlocked.
      void player.play().catch(() => {});
    } else {
      restoreDefault();
    }
  });
}
