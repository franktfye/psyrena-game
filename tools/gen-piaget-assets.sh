#!/usr/bin/env bash
# Generate Piaget's art via the Civitai orchestration API (tools/civitai-gen.mjs,
# default gpt-image-2.5-sunburst), then ship it: skill icons, his buff tiles,
# and the full-body cover. Same shape as tools/gen-ainsworth-assets.sh.
#
# Colour language, matched to the in-game tints (src/vfx/piagetCasts.ts):
#   EMERALD  his spiral brooch and building-block charm: healing, Assimilation,
#            Accommodation (the healer's own colour)
#   AMBER    Sensorimotor (infancy, warm, tactile)
#   CORAL    Preoperational (play, symbols, one thing at a time)
#   SKY      Concrete operational (logic you can hold)
#   VIOLET   Formal operational (the abstract and the hypothetical)
#   GOLD     Equilibration and Object Permanence
#
# Usage: tools/gen-piaget-assets.sh     (idempotent: existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/piaget/icons
COVER=assets/work/piaget/cover
mkdir -p "$RAW" "$COVER"

gen() { # $1 out  $2 prompt  [extra civitai-gen args]
  local out="$1" prompt="$2"; shift 2
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" "$@" \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no numbers, no watermark, no border"
EMERALD="soft emerald green neon glow"
AMBER="warm amber neon glow"
CORAL="playful coral pink neon glow"
SKY="clear sky blue neon glow"
VIOLET="deep violet neon glow"
GOLD="radiant golden neon glow"

batch() { # up to 4 icons in parallel: name prompt name prompt ...
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" --width 512 --height 512 --quality low & shift 2; done
  wait
}

# --- Skills -----------------------------------------------------------------------
batch \
  assimilation "a small square block sliding neatly into a matching square slot in a larger shape, $EMERALD" \
  sensorimotor "a baby's open hand reaching for a rattle, with a looping circular arrow around them, $AMBER" \
  preoperational "two clear laboratory beakers of water, one tall and thin, one short and wide, and one big eye staring only at the tall beaker, $CORAL" \
  concrete "two glasses of different shapes holding the same level of liquid, an equals sign of light between them, $SKY"
batch \
  formal "a glowing lightbulb made of a branching tree of question marks shapes and arrows, abstract and futuristic, $VIOLET" \
  accommodation "a round shape gently reshaping itself to fit around a new star shape, a soft protective dome over both, $EMERALD" \
  object_permanence "a small toy ball half hidden behind a cloth, its outline still glowing through the cloth, $GOLD" \
  equilibration "a perfectly balanced set of scales with a spiral at its centre, rays of light around it, $GOLD, the brightest and most powerful icon in the set"

# --- Buff / debuff tiles --------------------------------------------------------------
batch \
  circular_reaction "a looping circular arrow wrapped around a small glowing heart that pulses, $AMBER and emerald glow" \
  hypothetical "a translucent shield drawn in dotted lines, a question mark shape inside, as if it does not exist yet, $VIOLET" \
  invariant_sequence "four stepping stones rising in a staircase from small to large, each glowing brighter, $EMERALD" \
  conserved "an hourglass whose sand is perfectly level in both halves, $SKY"

# --- The full-body cover (Style Lab tile), likeness from the approved plate -----
gen "$COVER/piaget_concept_full.png" \
  "Full-body 3D game character key art of exactly this man, same face, round gold spectacles, black wool beret, wispy white hair and white moustache, tailored charcoal-black three-piece suit with emerald piping, ivory shirt and slim black tie, the glowing emerald spiral brooch at his lapel and the emerald stacked-blocks charm at his hip, pipe holstered on his belt. He stands in a gentle healer's pose, one hand raised at chest height with a small emerald spiral of light turning above his palm, the other hand resting kindly at his side, a curious, warm smile. Behind him a dark emerald sci-fi stage where four translucent glowing steps rise in a staircase, amber, coral, sky blue and violet, with floating building blocks and balanced scales of light. Cinematic rim light, same stylised 3D render style as the reference, whole body from beret to shoes visible, no text, no logo." \
  --image assets/work/piaget/concept/approved_front.png --width 1024 --height 1440 --quality high

# --- Ship ------------------------------------------------------------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image

src = Path("assets/work/piaget/icons")
BUFFS = {"circular_reaction", "hypothetical", "invariant_sequence", "conserved"}
skills = Path("public/assets/ui/skills/piaget")
buffs = Path("public/assets/ui/buffs")
skills.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    dst = buffs if png.stem in BUFFS else skills
    out = dst / (png.stem + ".webp")
    Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS).save(out, "WEBP", quality=88)
    print("webp:", out)

cover = Path("assets/work/piaget/cover/piaget_concept_full.png")
if cover.exists():
    im = Image.open(cover).convert("RGB")
    w, h = im.size
    tw = round(h * 424 / 600)
    if tw <= w:
        im = im.crop(((w - tw) // 2, 0, (w - tw) // 2 + tw, h))
    else:
        im = im.crop((0, 0, w, round(w * 600 / 424)))
    out = Path("public/assets/heroes/piaget_concept_full.webp")
    im.resize((424, 600), Image.LANCZOS).save(out, "WEBP", quality=86)
    print("webp:", out)
PY
echo "done"
