#!/usr/bin/env bash
# Generate the Coffee Shop potion icons via the Civitai orchestration API
# (gpt-image-2) — the two shop items (Latte / Americano cards, reused grayed
# for the M/L "coming soon" sizes) and their two HUD buff tiles. Raw PNGs land
# in assets/work/coffee, then get converted to public/assets/ui/coffee/*.webp
# (shop cards) and public/assets/ui/buffs/*.webp (the player-HUD buff row —
# DOM <img>, so webp not KTX2, same reasoning as the skill icons).
#
# Usage: tools/gen-coffee-assets.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/coffee
mkdir -p "$RAW"

gen() { # $1 out  $2 prompt
  local out="$1" prompt="$2"
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" \
    --width 512 --height 512 --quality low \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

# Shop cards: the gear-icon look (gen-gear-assets.sh) shifted to café-warm
# tones so the Coffee Shop's catalogue reads as its own storefront.
ITEM_STYLE="flat minimalist video game UI item icon, one centered object, dark walnut brown rounded square background, subtle warm amber rim light, clean bold silhouette, slight glossy game-icon finish, no text, no watermark, no border"
# Buff tiles: the shipped neon-glyph-on-charcoal language of gen-buff-icons.sh,
# each effect keyed to its own color so a 24 px tile reads at a glance.
BUFF_STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no watermark, no border"

gen "$RAW/latte.png"             "$ITEM_STYLE: a tall glass latte with creamy milk foam heart latte art and gentle steam wisps" &
gen "$RAW/americano.png"         "$ITEM_STYLE: a simple white ceramic cup of black americano coffee on a saucer with gentle steam wisps" &
gen "$RAW/buff_latte.png"        "$BUFF_STYLE: a glowing fiery orange neon takeaway coffee cup with a bold upward arrow rising out of its steam" &
gen "$RAW/buff_americano.png"    "$BUFF_STYLE: a glowing emerald green neon coffee cup with a medical plus cross floating in its steam" &
wait

# --- Ship: PNG -> 160px webp into the two shipped paths -----------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image

def ship(src, dst, stem):
    img = Image.open(src).convert("RGBA").resize((160, 160), Image.LANCZOS)
    dst.mkdir(parents=True, exist_ok=True)
    out = dst / (stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)

raw = Path("assets/work/coffee")
ship(raw / "latte.png",          Path("public/assets/ui/coffee"), "latte")
ship(raw / "americano.png",      Path("public/assets/ui/coffee"), "americano")
ship(raw / "buff_latte.png",     Path("public/assets/ui/buffs"),  "espresso_veins")
ship(raw / "buff_americano.png", Path("public/assets/ui/buffs"),  "steady_hands")
PY
echo "done"
