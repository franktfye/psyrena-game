#!/usr/bin/env bash
# Generate Erikson's art via the Civitai orchestration API (tools/civitai-gen.mjs,
# default gpt-image-2.5-sunburst), then ship it: skill icons, the per-stage
# faces of keys 1 and 2, the virtues buff tile, and the full-body cover.
#
# Same shape as tools/gen-skinner-assets.sh: raw PNGs in assets/work/erikson/,
# shipped webp in public/ (DOM <img>, so webp, not KTX2).
#
# Colour language, matched to the in-game tints (src/vfx/heroCasts.ts
# ERIKSON_TINTS): AMBER = a crisis (key 1, Life Stage), GOLD = the virtue it
# yields (key 2), CYAN = his hourglass charm (the add-on basic, the cover).
# Keys 1 and 2 change face with the stage, so each of the eight stages has an
# amber glyph for its crisis and a gold glyph for its virtue: the bar teaches
# the chart in pictures as well as words.
#
# Usage: tools/gen-erikson-assets.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/erikson/icons
COVER=assets/work/erikson/cover
mkdir -p "$RAW" "$COVER"

gen() { # $1 out  $2 prompt  [extra civitai-gen args]
  local out="$1" prompt="$2"; shift 2
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" "$@" \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

# The house icon style (Freud, Pavlov, Skinner sets).
STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no numbers, no watermark, no border"
AMBER="warm amber-orange neon glow"
GOLD="radiant golden neon glow"

batch() { # up to 4 icons in parallel: name prompt name prompt ...
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" --width 512 --height 512 --quality low & shift 2; done
  wait
}

# --- The six skills -----------------------------------------------------------
batch \
  relations "a small glowing dot at the centre surrounded by three widening concentric rings, each ring dotted with tiny person silhouettes, more people on each outer ring, cool cyan neon glow" \
  stage "a winding path rising in a spiral of eight glowing stepping stones from small to large, $AMBER" \
  virtue "a faceted gemstone radiating eight short rays of light, $GOLD" \
  moratorium "an hourglass lying on its side so the sand has stopped flowing, with a small pause symbol of two vertical bars beside it, soft violet neon glow"
batch \
  identity_crisis "a cracked round mirror reflecting two different head silhouettes facing opposite ways, amber and magenta neon glow" \
  life_review "an upright hourglass whose sand forms a glowing spiral of eight bright points from bottom to top, golden and cyan glow, the brightest and most powerful icon in the set" \
  virtues "a round flower of eight golden petals, each petal glowing, $GOLD"

# --- Key 1 faces: the eight crises, amber ---------------------------------------
batch \
  stage_1 "a tiny baby hand gripping one adult finger, $AMBER" \
  stage_2 "a small toddler shoe stepping forward beside a tiny footprint, $AMBER" \
  stage_3 "a paper airplane launching upward on a swooping trail, $AMBER" \
  stage_4 "a neat stack of three building blocks with a small hammer leaning against it, $AMBER"
batch \
  stage_5 "a masquerade mask held up beside a plain head silhouette, $AMBER" \
  stage_6 "two interlocking rings, $AMBER" \
  stage_7 "a young sapling sprouting from an open palm, $AMBER" \
  stage_8 "a winding path seen from a hilltop leading to a low setting sun, $AMBER"

# --- Key 2 faces: the eight virtues, gold ---------------------------------------
batch \
  virtue_1 "a sun rising over a flat horizon line, $GOLD" \
  virtue_2 "a small sprout pushing up through a crack in a stone slab, $GOLD" \
  virtue_3 "an arrow striking the exact centre of a round target, $GOLD" \
  virtue_4 "a single precise gear wheel with a small star at its hub, $GOLD"
batch \
  virtue_5 "a round compass with its needle pointing straight up, $GOLD" \
  virtue_6 "a glowing heart, $GOLD" \
  virtue_7 "two cupped hands holding a small glowing orb, $GOLD" \
  virtue_8 "a calm owl perched and facing forward, $GOLD"

# --- The full-body cover (Style Lab tile), likeness from the approved plate -----
gen "$COVER/erikson_concept_full.png" \
  "Full-body 3D game character key art of exactly this man, same face, white swept-back hair, walrus moustache, charcoal jacket, cream open-collar shirt, dark trousers and the small glowing cyan hourglass charm at his hip. He stands in a relaxed, warm storyteller pose, one hand raised holding a small glowing cyan hourglass, the other open in a welcoming gesture, a gentle smile. Behind him a dark teal sci-fi stage with a large glowing spiral of eight rings, amber near the centre turning gold at the outside, faint floating silhouettes of a child, a teenager and an old man along the spiral. Cinematic rim light, same stylised 3D render style as the reference, whole body from hair to shoes visible, no text, no logo." \
  --image assets/work/erikson/concept/approved_front.png --width 1024 --height 1440 --quality high

# --- Ship ------------------------------------------------------------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image

src = Path("assets/work/erikson/icons")
BUFFS = {"virtues"}
skills = Path("public/assets/ui/skills/erikson")
buffs = Path("public/assets/ui/buffs")
skills.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    dst = buffs if png.stem in BUFFS else skills
    out = dst / (png.stem + ".webp")
    Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS).save(out, "WEBP", quality=88)
    print("webp:", out)

# Cover: centre-crop to the 424x600 frame the other heroes ship at.
cover = Path("assets/work/erikson/cover/erikson_concept_full.png")
if cover.exists():
    im = Image.open(cover).convert("RGB")
    w, h = im.size
    tw = round(h * 424 / 600)
    if tw <= w:
        im = im.crop(((w - tw) // 2, 0, (w - tw) // 2 + tw, h))
    else:
        th = round(w * 600 / 424)
        im = im.crop((0, 0, w, th))
    out = Path("public/assets/heroes/erikson_concept_full.webp")
    im.resize((424, 600), Image.LANCZOS).save(out, "WEBP", quality=86)
    print("webp:", out)
PY
echo "done"
