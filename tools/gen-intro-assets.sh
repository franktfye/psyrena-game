#!/usr/bin/env bash
# Generate the three intro-guide card icons via the Civitai orchestration API
# (gpt-image-2) — Fight / Controls / Explore. Raw PNGs land in
# assets/work/intro, then get converted to public/assets/ui/intro/*.webp (the
# shipped path, loaded by the pre-game intro screen — DOM <img>, so webp not
# KTX2, same reasoning as the skill and buff icons).
#
# Usage: tools/gen-intro-assets.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/intro
mkdir -p "$RAW"

gen() { # $1 out  $2 prompt
  local out="$1" prompt="$2"
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" \
    --width 512 --height 512 --quality low \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

# Same dress as the buff/skill icons so the intro reads as the same game:
# one neon glyph on a dark tile, each card keyed to its own color.
STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no watermark, no border"

batch() { # run up to 4 gens in parallel, then wait
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" & shift 2; done
  wait
}

batch \
  fight "a glowing crimson neon fierce horned boss skull above two small crossed swords" \
  controls "a glowing teal neon arcade thumbstick flanked by four directional arrows in a cross layout" \
  explore "a glowing golden neon open treasure chest with a small rising four-pointed spark and a tiny paw print"

# --- Ship: PNG -> 160px webp into public/assets/ui/intro -----------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image
src = Path("assets/work/intro")
dst = Path("public/assets/ui/intro")
dst.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    img = Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS)
    out = dst / (png.stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)
PY
echo "done"
