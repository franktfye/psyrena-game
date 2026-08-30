#!/usr/bin/env bash
# Encode the shipped OST and the Freud VO pack to Opus-in-WebM.
#
# These are the two audio paths with no generator of their own. Everything else
# is encoded by the script that produces it, so that nothing is ever transcoded
# twice through a lossy codec:
#
#   OST + Freud VO   <- here
#   Pavlov/Skinner   <- tools/gen-pavlov-voice.sh, tools/gen-skinner-voice.sh
#   Nightmare boss   <- tools/gen-nightmare-voice.sh
#   SFX              <- tools/sync-sfx.mjs (transcodes as it copies from psfx/)
#
# WHY WEBM AND NOT OGG: Safari plays Opus in WebM (15+ / iOS 15+) and does not
# play Opus in Ogg. See src/core/audio.ts, which owns the extension.
#
# OST — 96 kbps stereo VBR. There are NO lossless masters: the mp3s in public/
# were the masters, so this is a lossy→lossy hop and 96k leaves headroom that
# 64k would not. Cover art is dropped (`-vn`): every track carried an embedded
# 360² JPEG/PNG, 418 KB across the set, that no player ever shows.
#
# FREUD — 24 kbps mono, encoded from assets/work/freud/voice/*.wav rather than
# the shipped mp3, so the pack loses only one generation instead of two. (The
# other hero packs regenerate from their raw takes via their own scripts.)
#
# Usage: tools/compress-audio.sh [--force]
#   Idempotent: an output newer than its source is left alone. --force redoes
#   everything. Sources are NOT deleted — see the cleanup note at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

encode() { # src dest ffmpeg-args...
  local src="$1" dest="$2"; shift 2
  if [ "$FORCE" = 0 ] && [ -s "$dest" ] && [ "$dest" -nt "$src" ]; then
    echo "  skip $(basename "$dest")"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  ffmpeg -y -loglevel error -i "$src" -vn "$@" "$dest"
  printf "  %-38s %6s -> %6s\n" "$(basename "$dest")" \
    "$(du -h "$src" | cut -f1)" "$(du -h "$dest" | cut -f1)"
}

echo "== OST (96k stereo, cover art stripped) =="
for f in public/assets/village/ost/*.mp3 public/assets/bosses/ost/*.mp3; do
  [ -e "$f" ] || continue
  encode "$f" "${f%.mp3}.webm" -c:a libopus -b:a 96k -vbr on -application audio
done

echo "== Freud VO (24k mono, from the work wavs) =="
for f in assets/work/freud/voice/*.wav; do
  [ -e "$f" ] || continue
  stem=$(basename "$f" .wav)
  encode "$f" "public/assets/heroes/voice/$stem.webm" \
    -c:a libopus -b:a 24k -ac 1 -application voip
done

cat <<'NOTE'

done.

The .mp3 sources under public/ are still in place. Once the game has been
checked on the new files, drop them:

  git rm public/assets/village/ost/*.mp3 public/assets/bosses/ost/*.mp3 \
         public/assets/heroes/voice/*.mp3
NOTE
