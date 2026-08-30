#!/usr/bin/env bash
# Generate Skinner's skill-icon set via the Civitai orchestration API
# (gpt-image-2), then ship them as webp.
#
# Same shape as tools/gen-pavlov-assets.sh — raw PNGs land in
# assets/work/skinner/icons, the shipped tiles go to
# public/assets/ui/skills/skinner (DOM <img>, so webp not KTX2, same reasoning
# as the Freud and Pavlov icon sets).
#
# The kit these belong to: docs/03-heroes.md §7. Skinner has no kit module yet
# (shared/heroes/ has freud.ts and pavlov.ts only) — the art lands first, the
# same order Pavlov went in.
#
# Colour language, and the reason the set reads at 24 px: Skinner's whole kit is
# the four-quadrant matrix, so the quadrant icons are colour-coded by AXIS, not
# by skill. Green = behaviour increases (reinforcement). Violet = behaviour
# decreases (punishment). Within each pair, a PLUS badge means a stimulus is
# added and a MINUS badge means one is removed. Four icons, two colours, two
# badges — the player learns the matrix from the action bar itself.
#
# Usage: tools/gen-skinner-assets.sh     (idempotent — existing files skip)
set -uo pipefail
cd "$(dirname "$0")/.."

RAW=assets/work/skinner/icons
mkdir -p "$RAW"

gen() { # $1 out  $2 prompt
  local out="$1" prompt="$2"
  if [ -s "$out" ]; then echo "skip $(basename "$out")"; return 0; fi
  node tools/civitai-gen.mjs --prompt "$prompt" --out "$out" \
    --width 512 --height 512 --quality low \
    > "$out.log" 2>&1 && echo "ok   $(basename "$out")" || echo "FAIL $(basename "$out") (see $out.log)"
}

# Matches the shipped Freud and Pavlov skill icons: one neon glyph on a dark
# tile, each effect keyed to its own color so a 24 px tile still reads.
STYLE="flat minimalist video game UI skill icon, one centered glowing neon glyph drawn in clean light strokes, dark charcoal rounded square tile background filling the whole frame, soft rim glow, bold simple silhouette, no text, no letters, no watermark, no border"

batch() { # run up to 4 gens in parallel, then wait
  while [ "$#" -gt 0 ]; do gen "$RAW/$1.png" "$STYLE: $2" & shift 2; done
  wait
}

# --- The chain: Q open, E quadrants, R schedule, F shaping, Q' ult ------------
batch \
  open_chamber "a translucent cyan glass chamber shaped like a tall cube with its single door swung wide open toward the viewer, empty inside, thin bright cyan edge lines tracing every corner of the cube" \
  schedule "a segmented circular dial divided into four unequal wedges like a slot-machine wheel, one wedge blazing bright amber and the other three dim gray-blue, a small pointer at the top" \
  shaping "three ascending rectangular steps climbing left to right in signal-green, with a curved arrow arcing up and over them toward a small bright target dot above the highest step" \
  skinner_box "a cyan glass cube chamber sealed shut with a dark silhouette trapped inside it, brilliant white-cyan light bursting out through the seams of every edge, the brightest and most powerful icon in the set"

# --- The four quadrants ------------------------------------------------------
# Green pair = behaviour increases. Violet pair = behaviour decreases.
# Plus badge = stimulus added. Minus badge = stimulus removed.
batch \
  positive_reinforcement "a signal-green upward arrow with a small round food pellet beside it and a bold green plus sign badge in the corner, warm and rewarding, bright clean green glow" \
  negative_reinforcement "a signal-green upward arrow beside a small alarm speaker that is switched off and crossed out with a single slash, and a bold green minus sign badge in the corner, green glow, relief rather than reward" \
  positive_punishment "a cool violet downward arrow with a sharp jagged lightning bolt striking beside it and a bold violet plus sign badge in the corner, harsh violet glow" \
  negative_punishment "a cool violet downward arrow beside a small toy cube being lifted away on a hook, leaving an empty dashed outline where it was, and a bold violet minus sign badge in the corner, violet glow"

# --- 2026-08-04 healer redesign icons ----------------------------------------
# Skinner rebuilt as a healer: schedules of reinforcement are the healing
# spells (warm gold/green glow), contingency and consequence toggles keep the
# green/violet + plus/minus colour language from the quadrant set above. The
# eight icons from the old kit design stay untouched — same RAW dir, gen()
# skips them.
batch \
  response_rate "a rising cumulative-record graph line stepping upward on a small chart, warm amber glow" \
  fixed_ratio "four identical small food pellets in a neat 2x2 grid, every pellet glowing the same steady warm gold, evenly spaced" \
  variable_ratio "a slot machine lever arm beside three small pellets and one oversized brilliant jackpot pellet, gold and green glow" \
  fixed_interval "a clock face with four evenly spaced glowing tick marks, a small pellet at each tick, calm green glow"

batch \
  variable_interval "a clock face with randomly scattered glowing tick marks of different sizes, soft green glow trailing off" \
  contingency_positive "an upward arrow striking a target dot with a small plus badge, green glyph" \
  contingency_negative "a figure silhouette dodging aside from a crossed-out arrow, small minus badge, green glyph" \
  consequence_reinforcement "an open palm offering a glowing food pellet, radiant green glow"

batch \
  consequence_punishment "a rounded shield with a downward arrow, violet glow" \
  response_strength "a bar chart of ten ascending glowing bars, amber-to-white at the peak" \
  approximation "three ascending stepping stones with a small glowing pigeon perched on the top step, soft cyan-green glow"

# --- 2026-08-05 combo cells --------------------------------------------------
# One icon per E × R cell of the operant matrix. Reading rule at 24 px: the
# LEFT glyph is the watched behaviour (arrow striking a target = damage dealt,
# figure dodging = damage avoided), the RIGHT glyph is the payout (palm with
# pellet = heal, shield = mitigation), and the glow colour repeats the payout
# axis — green pays, violet protects. RETIRED from the bar the same day (two
# buttons wearing the same live-cell icon read as one — the E/R buttons are
# per-axis ACTION faces now, contingency_*/consequence_*); kept for future
# HUD/codex use of the live-cell readout.
batch \
  combo_positive_reinforcement "on the left an upward arrow striking a small target dot, on the right an open palm offering a glowing food pellet, radiant warm green glow" \
  combo_positive_punishment "on the left an upward arrow striking a small target dot, on the right a rounded protective shield, cool violet glow" \
  combo_negative_reinforcement "on the left a figure silhouette dodging aside from a crossed-out arrow, on the right an open palm offering a glowing food pellet, radiant warm green glow" \
  combo_negative_punishment "on the left a figure silhouette dodging aside from a crossed-out arrow, on the right a rounded protective shield, cool violet glow"

# --- Ship: PNG -> 160px webp, skills and buffs to their own folders -----------
python3 - <<'PY'
from pathlib import Path
from PIL import Image

src = Path("assets/work/skinner/icons")
# Everything not in BUFFS is a skill icon (same split as gen-pavlov-assets.sh).
BUFFS = {"response_strength", "approximation"}
skills = Path("public/assets/ui/skills/skinner")
buffs = Path("public/assets/ui/buffs")
skills.mkdir(parents=True, exist_ok=True)
buffs.mkdir(parents=True, exist_ok=True)

for png in sorted(src.glob("*.png")):
    dst = buffs if png.stem in BUFFS else skills
    img = Image.open(png).convert("RGBA").resize((160, 160), Image.LANCZOS)
    out = dst / (png.stem + ".webp")
    img.save(out, "WEBP", quality=88)
    print("webp:", out)
PY
echo "done"
