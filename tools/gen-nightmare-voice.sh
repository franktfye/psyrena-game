#!/usr/bin/env bash
# Generate the Nightmare boss VO pack — all 27 lines — with VoxCPM2.
#
# Replaces the retired Qwen3-TTS recipe (gen-nightmare-memory-voice.sh, which
# only ever covered the 10 P2 memory lines; the other 17 had no script at all).
#
# VOICE: designed, then cloned — the same discipline as the Pavlov and Skinner
# hero packs. VoxCPM has no preset speakers, so the void voice and the five P2
# age-stage voices are each DESIGNED ONCE from a prompt, the best roll kept, and
# every line CLONED from that single reference. THE PACK IS ONLY REPRODUCIBLE
# BECAUSE THOSE REFERENCE WAVS ARE IN THE REPO (voice/_ref/).
#
# ⚠️ Design is NOT deterministic. Three rolls of the toddler prompt measured
# 291 / 301 / 250 Hz; one roll of the void prompt collapsed to 50 Hz. Rolls are
# graded on median F0 against a target band, then on jitter. See
# assets/work/nightmare/voice/README.md for the kept-roll table.
#
# Two post-FX chains, matching what the pack shipped with:
#   void   — the 17 main lines: 10% pitch-down + a ~0.55 s dense reverb tail.
#   memory — the 10 P2 reveals: the deeper 0.82 pitch-down + tempo correction
#            and slap echo, carried over verbatim from the Qwen recipe.
#
# Raw takes -> assets/work/nightmare/voice/_raw_tts/<stem>.wav
# Runtime   -> public/assets/bosses/voice/<stem>.webm  (Opus 24k mono)
#
# Usage: tools/gen-nightmare-voice.sh   (idempotent — existing raw takes skip;
#        delete a stem's wav under _raw_tts to re-roll just that line)
#
# To re-roll a VOICE rather than a line — say the toddler reads too old — roll
# the design a few times, audition, then clone the pack from the winner:
#
#   V=nm_toddler; W=assets/work/nightmare/voice   # (needs jq, or hand-roll the JSON)
#   for i in 1 2 3; do
#     curl -s -X POST http://localhost:8731/tts -H 'Content-Type: application/json' \
#       -d "$(jq -nc --arg t "$(cat $W/_ref/$V.reftext.txt)" \
#                    --arg c "$(cat $W/_ref/$V.prompt.txt)" --argjson s $((1000+i)) \
#                    '{text:$t, voice_design:$c, seed:$s}')" --output /tmp/$V.$i.wav
#   done
#   cp /tmp/$V.<best>.wav $W/_ref/$V.wav
#   rm $RAW/stage_*_{laugh,age}.wav   # only that voice's lines
#   tools/gen-nightmare-voice.sh
#
# Requires the local VoxCPM2 server:  systemctl start voxcpm-tts
#   health: curl http://localhost:8731/health
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=assets/work/nightmare/voice
RAW=$WORK/_raw_tts
REF=$WORK/_ref
OUT=public/assets/bosses/voice
API=http://localhost:8731/tts
mkdir -p "$RAW" "$OUT"

# Checked lazily, on the first take that actually needs synthesising — a re-run
# that only re-applies post-FX to existing raws must not demand the GPU server.
checked_health=0
require_server() {
  [ "$checked_health" = 1 ] && return 0
  curl -sf -m 5 http://localhost:8731/health >/dev/null || {
    echo "VoxCPM2 server is not up on :8731 — systemctl start voxcpm-tts" >&2
    exit 1
  }
  checked_health=1
}

# Deterministic per-stem seed, so deleting one take and re-running reproduces
# the same roll instead of rolling a new voice for that line. zlib.crc32 via
# python, NOT cksum — coreutils' cksum is a different CRC, and the shipped
# takes were seeded with zlib's.
seed_for() {
  python3 -c 'import zlib,sys; print(7000 + zlib.crc32(sys.argv[1].encode()) % 10000)' "$1"
}

VOID_FX="aresample=24000,asetrate=24000*0.9,aresample=24000,\
aecho=0.8:0.9:7|11|13|17:0.9|0.85|0.8|0.75,\
aecho=0.85:0.8:60|110|170|240|320|410|520:0.45|0.36|0.29|0.23|0.18|0.14|0.11"
MEMORY_FX="aresample=24000,asetrate=24000*0.82,aresample=24000,atempo=1.2195,\
aecho=0.8:0.6:40|70|110:0.28|0.2|0.12"

gen() { # stem voice text control fx
  local stem="$1" voice="$2" text="$3" control="$4" fx="$5"
  if [ -s "$RAW/$stem.wav" ]; then echo "skip $stem"; else
    echo "== $stem ($voice) =="
    require_server
    # JSON built by python, not jq (not installed here) and not by hand — the
    # lines contain apostrophes, ellipses and em dashes that must survive.
    python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1],"voice_design":sys.argv[2],"clone_ref":sys.argv[3],"seed":int(sys.argv[4])}))' \
      "$text" "$control" "$PWD/$REF/$voice.wav" "$(seed_for "$stem")" \
      | curl -sf -m 900 -X POST "$API" -H 'Content-Type: application/json' \
             -d @- --output "$RAW/$stem.wav"
  fi
  ffmpeg -y -loglevel error -i "$RAW/$stem.wav" -af "$fx" \
    -codec:a libopus -b:a 24k -ac 1 -application voip "$OUT/$stem.webm"
}

# The void voice carries all 17 main lines; the manifest stores one shared
# instruct for them, so the control string is constant.
VOID="Dark, mocking, gleeful cruelty; hollow void resonance."
void() { gen "$1" nightmare "$2" "$VOID" "$VOID_FX"; }
# Each P2 stage has its own designed voice and its own per-line direction.
mem() { gen "$1" "$2" "$3" "$4" "$MEMORY_FX"; }

# ---- Bookends --------------------------------------------------------------
void start_activate "Ahh… you opened the door. Good. I was starving."
void end_defeated   "So this is waking… how rude. Sleep well without me."

# ---- Phase entries ---------------------------------------------------------
void phase_p1_onslaught  "One by one. Desire does not wait its turn."
void phase_p2_shapeshift "Watch me grow. Every age wants something different."
void phase_p3_fortress   "I refuse. Denial wears better armor than steel."
void phase_p4_terror     "Feel it. The pulse of every buried want."

# ---- P2 age stages (doll lines) --------------------------------------------
void stage_infant_oral     "Feed me. The void has a mouth."
void stage_toddler_anal    "Mine. Not yours. Mine."
void stage_child_phallic   "Look at me! I dare you to look away."
void stage_teen_latency    "Quiet now… I'm studying how you break."
void stage_adult_genital   "Whole at last. Now pay me what desire is owed."

# ---- Defense-mechanism barks (P3) ------------------------------------------
void defense_repression   "What hit? I felt nothing. Nothing at all."
void defense_denial       "That didn't happen. Your eyes are lying."
void defense_projection   "You're the monster here. I merely reflect."
void defense_displacement "Not you. Them. Anger needs a smaller target."
void defense_sublimation  "I turned my hunger into art. Admire the blast."
void defense_regression   "Fine! Back to the crib. The void was happier small."

# ---- P2 worst-memory reveals — one designed voice per age stage -------------
LAUGH="Hahahaha! Let me show you your worst memory."

mem stage_infant_laugh  nm_infant  "$LAUGH" "wheezing giggle, hungry delight"
mem stage_infant_age    nm_infant  "Let me show you who you were when you were one year old." \
                                   "cooing mock-tenderness turning cold"
mem stage_toddler_laugh nm_toddler "$LAUGH" "bright cruel laughter, possessive glee"
mem stage_toddler_age   nm_toddler "Let me show you who you were when you were three years old." \
                                   "sing-song taunt, petulant menace"
mem stage_child_laugh   nm_child   "$LAUGH" "booming cruel laughter, triumphant"
mem stage_child_age     nm_child   "Let me show you who you were when you were six years old." \
                                   "theatrical dare, swelling menace"
mem stage_teen_laugh    nm_teen    "$LAUGH" "quiet breathy laugh, studying cruelty"
mem stage_teen_age      nm_teen    "Let me show you who you were when you were ten years old." \
                                   "hushed conspiratorial whisper, patient malice"
mem stage_adult_laugh   nm_adult   "$LAUGH" "slow velvet laughter, intimate and merciless"
mem stage_adult_age     nm_adult   "Let me show you who you were when you were sixteen years old." \
                                   "smooth possessive calm, inevitable doom"

echo "done. runtime files:"
ls -1 "$OUT"
