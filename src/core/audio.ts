/**
 * The one place that knows what container shipped audio lives in.
 *
 * Everything under `public/assets/**` is Opus-in-WebM: ~2× smaller than the
 * mp3/ogg it replaced at equal or better quality (the OST alone went 33 MB →
 * 17 MB). Stereo Opus in WebM plays in every browser this game already
 * requires — Chrome, Firefox, and Safari 15+ / iOS 15+.
 *
 * Opus in **Ogg** is the trap: Safari still does not play it. If the extension
 * ever changes again, it changes here and nowhere else.
 *
 * Encoders: `tools/compress-audio.sh` (OST + Freud VO), the per-pack
 * `tools/gen-*-voice.sh` scripts (hero and boss VO, straight from their raw
 * takes), and `tools/sync-sfx.mjs` (SFX, transcoded as they are copied out of
 * the licensed PSFX tree).
 */
export const AUDIO_EXT = "webm";

/** `/assets/village/ost/firelight_1` → `/assets/village/ost/firelight_1.webm` */
export function audioUrl(pathWithoutExt: string): string {
  return `${pathWithoutExt}.${AUDIO_EXT}`;
}
