#!/usr/bin/env bash
# Generate gear/skin/pet/hall UI icons + 5 backup gear sets via the Civitai
# orchestration API (gpt-image-2). Icons land in assets/work/gear/icons as PNG,
# then get converted to public/assets/ui/gear/*.webp (the shipped path).
# Item sets stay in assets/work/gear/sets — backup only, NOT wired into the UI.
#
# Usage: tools/gen-gear-assets.sh          (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/gear
mkdir -p "$RAW/icons" "$RAW/sets"

gen() { # $1 out  $2 prompt  $3 size  $4 quality
  local out="$1" prompt="$2" size="${3:-512}" q="${4:-low}"
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" \
    --width "$size" --height "$size" --quality "$q" \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

ICON_STYLE="flat minimalist video game UI icon, one centered object, dark navy blue rounded square background, subtle cyan rim light, clean bold silhouette, slight glossy game-icon finish, no text, no watermark, no border"

# --- UI icons (512px, low quality is plenty at render size) -------------------
gen "$RAW/icons/gear.png"        "$ICON_STYLE: a tactical vest merged with a mechanical gear cog emblem" 512 low &
gen "$RAW/icons/slot-hat.png"    "$ICON_STYLE: a modern baseball cap" 512 low &
gen "$RAW/icons/slot-armor.png"  "$ICON_STYLE: a modern hooded jacket shown as body armor" 512 low &
wait
gen "$RAW/icons/slot-gloves.png" "$ICON_STYLE: a pair of modern fingerless tactical gloves" 512 low &
gen "$RAW/icons/slot-pants.png"  "$ICON_STYLE: modern cargo pants" 512 low &
gen "$RAW/icons/slot-shoes.png"  "$ICON_STYLE: a modern high-top sneaker" 512 low &
wait
gen "$RAW/icons/slot-pet.png"    "$ICON_STYLE: a cute animal paw print" 512 low &
gen "$RAW/icons/skin.png"        "$ICON_STYLE: a t-shirt with a color palette and a sparkle, fashion style icon" 512 low &
gen "$RAW/icons/hall.png"        "$ICON_STYLE: a golden trophy cup with a laurel wreath" 512 low &
wait

# --- Backup item sets (1024px, flat-lay, modern style, level 1 -> 5) ----------
SET_STYLE="video game equipment set concept art, full outfit flat lay with all items neatly arranged on a dark charcoal background, no person, no mannequin head, no text, no watermark, modern 2026 fashion"
gen "$RAW/sets/set1-street-basic.png"     "$SET_STYLE: plain grey hoodie, blue jeans, white sneakers, black baseball cap, simple knit gloves — beginner level casual street outfit" 1024 low &
gen "$RAW/sets/set2-urban-commuter.png"   "$SET_STYLE: tan bomber jacket, black chinos, white leather sneakers, dark beanie, touchscreen gloves — mid-level urban commuter outfit" 1024 low &
wait
gen "$RAW/sets/set3-techwear.png"         "$SET_STYLE: black waterproof techwear jacket with strap details, black cargo pants, tactical gloves, black high-top sneakers, dark cap — high-level techwear outfit" 1024 low &
gen "$RAW/sets/set4-neon-vanguard.png"    "$SET_STYLE: futuristic streetwear with glowing cyan LED trim, sculpted jacket, slim pants, light-up sneakers, visor cap, glow-accent gloves — elite neon outfit" 1024 low &
wait
gen "$RAW/sets/set5-apex-operative.png"   "$SET_STYLE: premium futuristic tactical fashion with holographic accents, sleek armored jacket, reinforced pants, gauntlet gloves, mag-sole sneakers, high-collar half helmet — max-level apex operative outfit" 1024 medium
wait

# --- Ship the icons: PNG -> webp into public/assets/ui/gear -------------------
python3 - <<'PY'
from pathlib import Path
from PIL import Image
src = Path("assets/work/gear/icons")
dst = Path("public/assets/ui/gear")
dst.mkdir(parents=True, exist_ok=True)
for png in sorted(src.glob("*.png")):
    img = Image.open(png).convert("RGBA").resize((256, 256), Image.LANCZOS)
    out = dst / (png.stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)
PY
echo "done"
