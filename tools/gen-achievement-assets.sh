#!/usr/bin/env bash
# Generate achievement UI icons via the Civitai orchestration API (gpt-image-2).
# Icons land in assets/work/achievements/icons as PNG, then get converted to
# public/assets/ui/achievements/*.webp (the shipped path).
#
# Usage: tools/gen-achievement-assets.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/achievements
mkdir -p "$RAW/icons"

gen() { # $1 out  $2 prompt
  local out="$1" prompt="$2"
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" \
    --width 512 --height 512 --quality low \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

ICON_STYLE="flat minimalist video game UI icon, one centered object, dark navy blue rounded square background, subtle cyan rim light, clean bold silhouette, slight glossy game-icon finish, no text, no watermark, no border"

batch() { # run up to 4 gens in parallel, then wait
  while [ "$#" -gt 0 ]; do gen "$RAW/icons/$1.png" "$ICON_STYLE: $2" & shift 2; done
  wait
}

# --- Dock icon ----------------------------------------------------------------
batch \
  achievements "a golden achievement medal with a ribbon and a glowing brain emblem" \
  col_heroes_2 "two overlapping theater masks, one light one dark, duality motif" \
  col_heroes_5 "a circle of five glowing human head silhouettes" \
  col_heroes_all "a golden laurel crown floating above many small head silhouettes"

# --- Collection ---------------------------------------------------------------
batch \
  col_gear_full "six glowing hexagonal gear slots arranged in a honeycomb" \
  col_loot_10 "an open glowing treasure crate with light spilling out" \
  col_loot_50 "a pile of glowing treasure crates and gold coins" \
  rank_top100 "a rising bar chart with a small flag on the tallest bar"

# --- Ranking ------------------------------------------------------------------
batch \
  rank_top10 "a golden laurel wreath medal on a podium" \
  rank_rating_1000 "a rising cyan star with a trail over a chart line" \
  rank_rating_5000 "a radiant diamond star emitting beams of light" \
  dmg_score_10k "a flaming fist impact with shockwave"

# --- Damage -------------------------------------------------------------------
batch \
  dmg_score_50k "a shattered porcelain mask with a cyan energy burst behind it" \
  dmg_score_100k "a massive glowing psychic explosion orb with rings" \
  dmg_dps_500 "two crossed glowing energy blades" \
  dmg_dps_1500 "a glowing third eye emitting a focused beam"

# --- Levels -------------------------------------------------------------------
batch \
  lvl_5 "a small sprouting seedling made of light" \
  lvl_10 "a glowing ascending staircase" \
  lvl_20 "an open ancient book with rising light particles" \
  lvl_40 "a deep spiral staircase descending into glow"

batch \
  lvl_60 "a radiant meditating figure with a halo of light, lotus pose" \
  boss_1 "a defeated shadow monster silhouette dissolving into particles" \
  boss_10 "a beast skull trophy with glowing eyes" \
  boss_50 "a crown made of beast fangs and claws"

# --- Boss ---------------------------------------------------------------------
batch \
  boss_nightmare "a dark swirling vortex with a single slit glowing eye" \
  boss_speed "a stopwatch with a lightning bolt" \
  boss_speed_nm "a shattered hourglass leaking dark energy" \
  fr_1 "two glowing hands in a handshake"

# --- Friends ------------------------------------------------------------------
batch \
  fr_5 "five interlocked glowing rings in a circle" \
  fr_10 "a constellation network of connected glowing nodes" \
  gear_t2 "an anvil with a glowing gear being forged" \
  gear_t4 "a radiant gear with small angelic wings ascending"

# --- Gear ---------------------------------------------------------------------
batch \
  gear_all_t2 "six polished glowing gems in a row" \
  gear_all_t4 "a full golden armor set with a halo, flat lay"

# --- Ship the icons: PNG -> webp into public/assets/ui/achievements -----------
python3 - <<'PY'
from pathlib import Path
from PIL import Image
src = Path("assets/work/achievements/icons")
dst = Path("public/assets/ui/achievements")
dst.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    img = Image.open(png).convert("RGBA").resize((256, 256), Image.LANCZOS)
    out = dst / (png.stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)
PY
echo "done"
