#!/usr/bin/env bash
# Generate the hero roster avatars — flat-vector cartoon sketches — via Civitai.
#
# WHY THESE EXIST: the roster used to ship photographs of the real psychologists,
# scraped at Wikipedia's 330 px thumbnail width. Those are other people's
# copyrighted photographs. These replace them with original illustrations, drawn
# as light period archetypes rather than portrait likenesses.
#
# Each avatar = assets/work/roster-avatars/prompts/_style.txt (the shared flat
# vector style, chosen over ink-wash and pencil because it is the only one of
# the three that still reads at 64 px) + prompts/<hero>.txt (the subject).
#
# Raw 1024² PNG  -> assets/work/roster-avatars/raw/<hero>.png
# Runtime 512²    -> public/assets/heroes/<hero>_sketch.webp
#
# Wired in: src/ui/authFlow.ts (ROSTER.img — the picker AND, via heroPortrait,
# every in-game surface: HUD, chat, gear, player card, codex).
#
# Usage: tools/gen-roster-avatars.sh [hero ...]     (no args = all 14)
#   Idempotent: an existing raw PNG is kept and only re-encoded. Delete a raw
#   to re-roll that hero. ~53 Buzz per generated image at medium quality.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=assets/work/roster-avatars
RAW=$WORK/raw
OUT=public/assets/heroes
mkdir -p "$RAW" "$OUT"

HEROES=("$@")
if [ ${#HEROES[@]} -eq 0 ]; then
  HEROES=(freud pavlov skinner kohlberg bronfenbrenner vygotsky erikson piaget
          maslow seligman bandura ainsworth csikszentmihalyi beck)
fi

for hero in "${HEROES[@]}"; do
  subject="$WORK/prompts/$hero.txt"
  [ -f "$subject" ] || { echo "no prompt for $hero ($subject)" >&2; exit 1; }
  if [ -s "$RAW/$hero.png" ]; then
    echo "skip $hero (raw exists)"
  else
    echo "== $hero =="
    cat "$WORK/prompts/_style.txt" "$subject" > "$RAW/$hero.prompt.txt"
    node tools/civitai-gen.mjs --prompt-file "$RAW/$hero.prompt.txt" \
      --width 1024 --height 1024 --quality medium --out "$RAW/$hero.png"
  fi
  # 512² is twice the largest on-screen size (the picker preview tops out at
  # 240 px), so it stays sharp on a 2× display and still lands under ~40 KB.
  ffmpeg -y -loglevel error -i "$RAW/$hero.png" -vf scale=512:512 \
    -c:v libwebp -quality 88 "$OUT/${hero}_sketch.webp"
  printf "  %-20s %s\n" "${hero}_sketch.webp" "$(du -h "$OUT/${hero}_sketch.webp" | cut -f1)"
done

echo "done."
