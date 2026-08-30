#!/usr/bin/env bash
# Generate Pavlov's skill-icon and buff-tile set via the Civitai orchestration
# API (gpt-image-2), then ship them as webp.
#
# Same shape as tools/gen-buff-icons.sh — raw PNGs land in
# assets/work/pavlov/icons, the shipped tiles go to
# public/assets/ui/skills/pavlov and public/assets/ui/buffs (DOM <img>, so webp
# not KTX2, same reasoning as the Freud icon set).
#
# The kit these belong to: docs/03-heroes.md §8 and shared/heroes/pavlov.ts.
#
# Usage: tools/gen-pavlov-assets.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/pavlov/icons
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

# --- Skills (S5, S1 ×2, S2, S3, S4, stance) -----------------------------------
# ns and cs are deliberately THE SAME BELL: cool and silent before conditioning,
# blazing amber and ringing after. The pair is the lesson, so do not restyle one
# without the other.
batch \
  ns "a small simple hand-bell drawn in thin cool gray-blue strokes, silent, hanging still, no sound waves and no glow around it — deliberately the plainest and dimmest icon in the set" \
  ucs "a food bowl seen from a low three-quarter angle with a rising warm amber aroma curl above it" \
  cs "a hand-bell blazing warm amber mid-swing with three concentric sound rings radiating outward from it" \
  spontaneous_recovery "a green upward-curving arrow looping back on itself around a small heart"

batch \
  generalization "a winged pocket-watch clock face in flight, warm amber, with curved motion arcs trailing behind it" \
  extinction "a wide bell-shaped dome of translucent cyan light standing over a flat ground line, with a crossed-out sound-wave symbol above it" \
  discrimination "two hand-bells side by side, the left one bright amber and ringing with sound waves, the right one dark gray and crossed out"

# --- Buff / debuff tiles ------------------------------------------------------
batch \
  ucr "a stylized dog's head in profile with three warm amber droplets falling below its muzzle" \
  pairing "a small hand-bell and a small food bowl linked together by a short glowing amber chain" \
  conditioned "a bright amber hand-bell inside a closed circular arrow loop" \
  stance_discrimination "a deep amber shield outline with a hand-bell inside it, radiating a heavy glow"

batch \
  dome_extinction "a cyan dome outline with a downward arrow inside it"

# --- Pet Park tile for Druzhok ------------------------------------------------
# Different style block on purpose: the pet tiles are a rendered 3D pet on a
# navy rounded tile with a cyan rim glow, not a neon glyph. Match the shipped
# corgi/husky/dino tiles, not the skill icons above.
TILE=assets/work/pavlov/pettile
mkdir -p "$TILE"
gen "$TILE/druzhok.png" "Video game UI pet icon tile: one cute stylized 3D-rendered German Shepherd dog with soft rounded toy-like proportions, black-and-tan saddle markings, upright pointed ears, friendly alert expression, wearing a dark leather collar with a small polished brass bell, standing in a three-quarter view facing right, centered and filling most of the frame, soft cyan rim glow around the silhouette. Background: a dark navy rounded square tile with a slightly lighter navy border frame around the edge, flat and simple, soft vignette. Clean game-icon rendering, soft studio lighting, no text, no letters, no watermark."

# --- Ship: PNG -> 160px webp, skills and buffs to their own folders ------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image

src = Path("assets/work/pavlov/icons")
# Everything not in BUFFS is a skill icon.
BUFFS = {"ucr", "pairing", "conditioned", "stance_discrimination", "dome_extinction"}
skills = Path("public/assets/ui/skills/pavlov")
buffs = Path("public/assets/ui/buffs")
skills.mkdir(parents=True, exist_ok=True)
buffs.mkdir(parents=True, exist_ok=True)

for png in sorted(src.glob("*.png")):
    dst = buffs if png.stem in BUFFS else skills
    img = Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS)
    out = dst / (png.stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)

# The pet tile ships at 384², matching the rest of public/assets/ui/pets.
tile = Path("assets/work/pavlov/pettile/druzhok.png")
if tile.exists():
    pets = Path("public/assets/ui/pets")
    pets.mkdir(parents=True, exist_ok=True)
    out = pets / "druzhok.webp"
    Image.open(tile).convert("RGB").resize((384, 384), Image.LANCZOS).save(out, "WEBP", quality=90)
    print("webp:", out)
PY
echo "done"
