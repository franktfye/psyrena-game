#!/usr/bin/env bash
# Generate Ainsworth's art via the Civitai orchestration API (tools/civitai-gen.mjs,
# default gpt-image-2.5-sunburst), then ship it: skill icons, her buff and
# debuff tiles, and the full-body cover.
#
# Same shape as tools/gen-erikson-assets.sh: raw PNGs in assets/work/ainsworth/,
# shipped webp in public/ (DOM <img>, so webp, not KTX2).
#
# Colour language, matched to the in-game tints (src/vfx/ainsworthCasts.ts):
#   CYAN   her heart-in-shield brooch: Safe Haven, the sheltering tiles
#   TEAL   her cardigan: Sensitivity, Proximity Maintenance (her own stance)
#   ROSE   Secure (warm, the healthy reunion)
#   STEEL  Avoidant (cool blue-grey, held at arm's length)
#   CORAL  Ambivalent (hot red-orange, cling and push)
#   VIOLET Disorganized (the freeze)
#   GOLD   her piping: Earned Security, Strange Situation's revealed boss
#
# Usage: tools/gen-ainsworth-assets.sh     (idempotent: existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/ainsworth/icons
COVER=assets/work/ainsworth/cover
mkdir -p "$RAW" "$COVER"

gen() { # $1 out  $2 prompt  [extra civitai-gen args]
  local out="$1" prompt="$2"; shift 2
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" "$@" \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

# The house icon style (Freud, Pavlov, Skinner, Erikson sets).
STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no numbers, no watermark, no border"
CYAN="soft cyan neon glow"
TEAL="deep teal and aqua neon glow"
ROSE="warm rose-pink neon glow"
STEEL="cool steel blue-grey neon glow"
CORAL="hot coral red-orange neon glow"
VIOLET="flickering violet neon glow"
GOLD="radiant golden neon glow"

batch() { # up to 4 icons in parallel: name prompt name prompt ...
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" --width 512 --height 512 --quality low & shift 2; done
  wait
}

# --- Skills -----------------------------------------------------------------------
batch \
  sensitivity "an open hand gently reaching toward a small pulse wave signal, $TEAL" \
  secure "two arcs, a large one sheltering a small one beneath it, with a small arrow leaving the small arc outward to explore, $ROSE" \
  avoidant "a closed round shell turned away from a small reaching hand, a gap between them, $STEEL" \
  ambivalent "two hands, one reaching to hold and one pushing away, overlapping in a tense knot, $CORAL"
batch \
  disorganized "a head silhouette split down the middle, one half stepping forward and one half turning back, jagged glitch lines, $VIOLET" \
  safe_haven "a glowing heart inside a shield with a soft dome of light over it, $CYAN" \
  strange_situation "an open doorway with a small figure inside and a larger figure stepping back in through the door, $GOLD" \
  earned_security "a cracked heart mended with golden seams, glowing whole, rays of light around it, $GOLD, the brightest and most powerful icon in the set"
batch \
  proximity_maintenance "a small circle tethered by a short glowing cord to a larger circle, both inside one ring, $TEAL"

# --- Buff / debuff tiles --------------------------------------------------------------
batch \
  exploration "a small footprint path leading away from a glowing home arc toward a star, $ROSE" \
  masked_distress "a calm smiling mask with a jagged heartbeat line hidden behind it, $STEEL" \
  resistant "a hand pushing away a glowing healing cross, $CORAL" \
  sheltered "a figure crouched safely under a glowing dome, falling shards bouncing off the dome, $VIOLET and cyan glow"
batch \
  stance_proximity_maintenance "two footprints planted firmly inside a glowing ring with a short cord leading out, $TEAL"

# --- The full-body cover (Style Lab tile), likeness from the approved plate -----
gen "$COVER/ainsworth_concept_full.png" \
  "Full-body 3D game character key art of exactly this woman, same face, curled silver-white bob, gold oval glasses, pearl earrings, deep-teal cable-knit cardigan-coat with gold piping and cream belt, cream blouse, cream trousers, burgundy ankle boots, the glowing cyan heart-in-shield brooch at her collar and the larger heart-shield locket at her hip. She stands in a calm, protective pose, one hand resting over the brooch on her heart, the other arm open low to her side as if inviting someone to shelter behind her, a warm reassuring smile. Behind her a dark teal sci-fi stage with a soft cyan dome of light arching over her and small glowing silhouettes of a child stepping out to explore and running back. Cinematic rim light, same stylised 3D render style as the reference, whole body from hair to boots visible, no text, no logo." \
  --image assets/work/ainsworth/concept/approved_front.png --width 1024 --height 1440 --quality high

# --- Ship ------------------------------------------------------------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image

src = Path("assets/work/ainsworth/icons")
BUFFS = {"exploration", "masked_distress", "resistant", "sheltered", "stance_proximity_maintenance"}
skills = Path("public/assets/ui/skills/ainsworth")
buffs = Path("public/assets/ui/buffs")
skills.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    dst = buffs if png.stem in BUFFS else skills
    out = dst / (png.stem + ".webp")
    Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS).save(out, "WEBP", quality=88)
    print("webp:", out)

cover = Path("assets/work/ainsworth/cover/ainsworth_concept_full.png")
if cover.exists():
    im = Image.open(cover).convert("RGB")
    w, h = im.size
    tw = round(h * 424 / 600)
    if tw <= w:
        im = im.crop(((w - tw) // 2, 0, (w - tw) // 2 + tw, h))
    else:
        th = round(w * 600 / 424)
        im = im.crop((0, 0, w, th))
    out = Path("public/assets/heroes/ainsworth_concept_full.webp")
    im.resize((424, 600), Image.LANCZOS).save(out, "WEBP", quality=86)
    print("webp:", out)
PY
echo "done"
