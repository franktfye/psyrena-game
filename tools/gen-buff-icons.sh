#!/usr/bin/env bash
# Generate the fight buff/debuff tile icons via the Civitai orchestration API
# (gpt-image-2) — the six Defense Mechanism riders, the Fixation debuff and the
# Team Amp buff. Raw PNGs land in assets/work/freud/buffs, then get converted
# to public/assets/ui/buffs/*.webp (the shipped path, loaded by the player HUD
# buff tiles — DOM <img>, so webp not KTX2, same reasoning as the skill icons).
#
# Usage: tools/gen-buff-icons.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/freud/buffs
mkdir -p "$RAW"

gen() { # $1 out  $2 prompt
  local out="$1" prompt="$2"
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" \
    --width 512 --height 512 --quality low \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

# Matches the shipped Freud skill icons: one neon glyph on a dark tile, each
# effect keyed to its own color so a 24 px tile still reads at a glance.
STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no watermark, no border"

batch() { # run up to 4 gens in parallel, then wait
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" & shift 2; done
  wait
}

batch \
  denial "a glowing crimson neon open hand raised palm-forward in a stop gesture inside a broken circle" \
  projection "a glowing orange neon tilted mirror bouncing an arrow back the way it came" \
  displacement "a glowing teal neon arrow swerving sharply sideways past a small shield" \
  sublimation "a glowing golden neon flame transforming into a rising four-pointed spark of light"

batch \
  repression "a glowing violet neon round vault door clamped shut over a small burst" \
  regression "a glowing green neon counter-clockwise spiral with two rewind chevron arrows" \
  fixation "a glowing magenta neon chain and padlock wrapped around a hypnotic spiral" \
  team_amp "three glowing golden neon upward chevron arrows rising together with radiant sparks"

# --- Ship: PNG -> 160px webp into public/assets/ui/buffs ----------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image
src = Path("assets/work/freud/buffs")
dst = Path("public/assets/ui/buffs")
dst.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    img = Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS)
    out = dst / (png.stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)
PY
echo "done"
