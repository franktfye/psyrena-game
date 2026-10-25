#!/usr/bin/env bash
# Generate the Nightmare boss VO pack — all 27 lines — with VoxCPM2.
#
# 2026-10-25: the 17 main lines were re-voiced as a BOSS. The old main voice
# ("gender-neutral spectral, feminine-leaning", 192 Hz) read eerie, not
# commanding. The new one, `nightmare_boss`, is designed on the vLLM-Omni
# server (:8647, same API as the hero packs): "an ancient, colossal nightmare
# lord … very deep, booming bass … gravel … total contempt and dark
# amusement". 8 rolls (seeds 9101–9108) graded by tools/voice-rank.py; kept
# 9104: 81.5 Hz, the most gravel (jitter 2.0%), and the least like any hero
# (WavLM ≤ 0.88). Each line is cloned from it with its own delivery, then the
# BOSS_FX chain below. The 10 P2 memory reveals keep their five doll voices.
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

# The boss: pitched down 10% and slowed 6% (rubberband keeps the formants
# clean), a sub-octave double underneath, compression, then early reflections
# and a ~0.9 s hall. A filter graph, so it goes through -filter_complex.
BOSS_FX="[0:a]aresample=48000,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.06,\
rubberband=pitch=0.9:tempo=0.94,asplit=2[m][s];\
[s]rubberband=pitch=0.5,lowpass=f=700,volume=0.32[sub];[m]highpass=f=60[mm];\
[mm][sub]amix=inputs=2:normalize=0,acompressor=threshold=-18dB:ratio=3:attack=10:release=200,\
aecho=0.8:0.85:23|41|67:0.5|0.4|0.3,\
aecho=0.85:0.7:90|160|260|380|520|700|900:0.42|0.34|0.27|0.21|0.16|0.12|0.09,\
loudnorm=I=-18:TP=-2:LRA=11,aresample=48000"
BOSS_API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"

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

# The boss voice carries all 17 main lines: cloned from _ref/nightmare_boss.wav
# with "(style, delivery)text", raw takes under _raw_tts/boss/.
BOSS_STYLE="Ancient colossal nightmare lord, very deep booming bass with gravel, commanding and contemptuous"
void() { # stem text delivery [seed — pins a re-roll; default seed_for stem]
  local stem="$1" text="$2" delivery="$3" seed="${4:-}" raw="$RAW/boss/$1.wav"
  [ -n "$seed" ] || seed="$(seed_for "$stem")"
  mkdir -p "$RAW/boss"
  if [ -s "$raw" ]; then echo "skip $stem"; else
    echo "== $stem (boss) =="
    python3 - "$BOSS_STYLE, $delivery" "$text" "$seed" "$REF/nightmare_boss.wav" <<'PY' \
      | curl -sf -m 600 -X POST "$BOSS_API" -H 'Content-Type: application/json' -d @- --output "$raw"
import base64, json, sys
style, text, seed, ref = sys.argv[1:5]
print(json.dumps({"model": "openbmb/VoxCPM2", "input": f"({style}){text}", "voice": "default",
                  "response_format": "wav", "seed": int(seed),
                  "ref_audio": "data:audio/wav;base64," + base64.b64encode(open(ref, "rb").read()).decode()}))
PY
  fi
  ffmpeg -y -loglevel error -i "$raw" -filter_complex "$BOSS_FX" \
    -codec:a libopus -b:a 32k -ac 1 "$OUT/$stem.webm"
}
# Each P2 stage has its own designed voice and its own per-line direction.
mem() { gen "$1" "$2" "$3" "$4" "$MEMORY_FX"; }

# ---- Bookends --------------------------------------------------------------
void start_activate "Ahh… you opened the door. Good. I was starving." "slow and savouring, a low amused growl that turns hungry"
void end_defeated   "So this is waking… how rude. Sleep well without me." "fading and bitter, a last contemptuous chuckle"

# ---- Phase entries ---------------------------------------------------------
void phase_p1_onslaught  "One by one. Desire does not wait its turn." "relentless and commanding, rising menace"
void phase_p2_shapeshift "Watch me grow. Every age wants something different." "grand and theatrical, slow and swelling"
void phase_p3_fortress   "I refuse. Denial wears better armor than steel." "cold, absolute and defiant"
void phase_p4_terror     "Feel it. The pulse of every buried want." "booming and terrifying, building to a roar"

# ---- P2 age stages (doll lines) --------------------------------------------
void stage_infant_oral     "Feed me. The void has a mouth." "ravenous, a deep hungry rumble"
void stage_toddler_anal    "Mine. Not yours. Mine." "possessive, each word a hammer blow"
void stage_child_phallic   "Look at me! I dare you to look away." "booming, a vain thundering dare"
void stage_teen_latency    "Quiet now… I'm studying how you break." "low and quiet, a menacing near-whisper"
# Seed pinned: the stem seed said "Oh, at last"; 503 says "Whole" (Whisper hears the homophone "Hole").
void stage_adult_genital   "Whole at last. Now pay me what desire is owed." "triumphant and regal, a slow verdict" 503

# ---- Defense-mechanism barks (P3) ------------------------------------------
void defense_repression   "What hit? I felt nothing. Nothing at all." "dismissive and bored"
void defense_denial       "That didn't happen. Your eyes are lying." "flat, utterly certain contempt"
void defense_projection   "You're the monster here. I merely reflect." "mocking, a dark smile in the voice"
void defense_displacement "Not you. Them. Anger needs a smaller target." "cruel and amused"
void defense_sublimation  "I turned my hunger into art. Admire the blast." "proud and grandiose"
void defense_regression   "Fine! Back to the crib. The void was happier small." "a furious roar that sinks into a sulking growl"

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
