#!/usr/bin/env bash
# Generate Bandura's art via the Civitai orchestration API (tools/civitai-gen.mjs,
# default gpt-image-2.5-sunburst), then ship it: skill icons, his buff tiles,
# and the full-body cover. Same shape as tools/gen-ainsworth-assets.sh.
#
# Colour language, matched to the in-game tints (src/vfx/banduraCasts.ts):
#   SILVER   his mirror brooch and charm: observation, the empty Retention slots
#   CYAN     the squares on his tie: Reproduction, Modeled Aggression
#   VIOLET   the mirror's reflective face: Motivation, vicarious reinforcement
#   RED      the Bobo doll (red and white, as the 1961 film's)
#   GOLD     Self-Efficacy and Reciprocal Determinism
#
# Usage: tools/gen-bandura-assets.sh     (idempotent: existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/bandura/icons
COVER=assets/work/bandura/cover
mkdir -p "$RAW" "$COVER"

gen() { # $1 out  $2 prompt  [extra civitai-gen args]
  local out="$1" prompt="$2"; shift 2
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" "$@" \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no numbers, no watermark, no border"
SILVER="cool silver-white neon glow"
CYAN="bright cyan neon glow"
VIOLET="iridescent violet neon glow"
RED="vivid red neon glow with white accents"
GOLD="radiant golden neon glow"

batch() { # up to 4 icons in parallel: name prompt name prompt ...
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" --width 512 --height 512 --quality low & shift 2; done
  wait
}

# --- Skills -----------------------------------------------------------------------
batch \
  modeled_aggression "a small fist punching forward with a faint mirrored copy of the same fist behind it, $CYAN" \
  observe "an empty round hand mirror with a watchful eye reflected faintly in its glass, $SILVER" \
  self_efficacy "a figure standing tall with a fist over its heart, a rising arrow behind it, $GOLD" \
  bobo_doll "a round-bottomed inflatable clown punching doll leaning back as it is struck, $RED"
batch \
  reciprocal_determinism "a triangle of three glowing nodes, a person silhouette, a footstep and a small house, linked by arrows flowing both ways, $GOLD, the brightest and most powerful icon in the set" \
  reproduction "two hands, one copying the gesture of the other through a mirror line, $CYAN"

# --- Buff / debuff tiles --------------------------------------------------------------
batch \
  motivated "a small star reflected in a mirror, the reflection shining brighter, $VIOLET" \
  being_modeled "a person silhouette with a soft spotlight cone above it and a small eye watching from the side, $SILVER" \
  efficacy "a staircase of rising bars with a small figure climbing to the top, $GOLD" \
  triad "three interlocking rings forming a triangle, $GOLD and cyan glow"

# --- The full-body cover (Style Lab tile), likeness from the approved plate -----
gen "$COVER/bandura_concept_full.png" \
  "Full-body 3D game character key art of exactly this man, same face, silver rectangular glasses, bald crown with trimmed silver-white sides, sharply tailored slate-grey suit with silver piping, ice-blue shirt, charcoal tie with small glowing cyan squares, the silver mirror brooch at his lapel and the glowing hand-mirror charm at his hip. He stands in a confident, poised pose, one hand raised palm-out as if mirroring someone, a faint translucent cyan mirror-image of the same gesture beside him, the other hand relaxed, a composed knowing smile. Behind him a dark slate sci-fi stage with tall panels of reflective glass showing faint silhouettes copying each other, and a small red-and-white inflatable clown doll in the background. Cinematic rim light, same stylised 3D render style as the reference, whole body from head to shoes visible, no text, no logo." \
  --image assets/work/bandura/concept/approved_front.png --width 1024 --height 1440 --quality high

# --- Ship ------------------------------------------------------------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image
import shutil

src = Path("assets/work/bandura/icons")
BUFFS = {"motivated", "being_modeled", "efficacy", "triad"}
skills = Path("public/assets/ui/skills/bandura")
buffs = Path("public/assets/ui/buffs")
skills.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    dst = buffs if png.stem in BUFFS else skills
    out = dst / (png.stem + ".webp")
    Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS).save(out, "WEBP", quality=88)
    print("webp:", out)
# The four Retention slots share one empty-slot face (the bar swaps in the
# copied skill's own icon once a slot holds something).
if (skills / "observe.webp").exists():
    for i in range(1, 5):
        shutil.copy(skills / "observe.webp", skills / f"observe_{i}.webp")

cover = Path("assets/work/bandura/cover/bandura_concept_full.png")
if cover.exists():
    im = Image.open(cover).convert("RGB")
    w, h = im.size
    tw = round(h * 424 / 600)
    if tw <= w:
        im = im.crop(((w - tw) // 2, 0, (w - tw) // 2 + tw, h))
    else:
        im = im.crop((0, 0, w, round(w * 600 / 424)))
    out = Path("public/assets/heroes/bandura_concept_full.webp")
    im.resize((424, 600), Image.LANCZOS).save(out, "WEBP", quality=86)
    print("webp:", out)
PY
echo "done"
