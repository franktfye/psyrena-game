#!/usr/bin/env bash
# Generate the Erikson — The Life Cycle VO pack with VoxCPM2 on gpu-box.
#
# Engine: vLLM-Omni serving openbmb/VoxCPM2 (spark: ~/vllm-omni/run-voxcpm2.sh,
# port 8647; recipe ~/vllm-omni/recipes/OpenBMB/VoxCPM2.md). OpenAI-style
# POST /v1/audio/speech, 48 kHz mono WAV. Two request shapes, from the recipe
# and its Gradio demo:
#   voice design         input "(<description>)<text>", no reference
#   controllable cloning ref_audio (base64 data URI) + input "(<style>)<text>"
# The "(…)" prefix is a control instruction, never spoken (checked by
# transcript, tools/voice-qa.py).
#
# VOICE: designed once, then cloned — the house recipe (Pavlov, Skinner,
# Nightmare). This server takes a `seed`: one request + one seed = one exact
# take (checked 2026-10-18: four identical unseeded requests gave byte-equal
# WAVs; two seeds gave two takes). So design rolls are seeds 1001..100N, the
# kept roll is committed as voice/_ref/erikson_voice_ref.wav (plus its seed in
# _ref/SEED: the reference is `(DESIGN_PROMPT)reftext` on that seed), and every
# line clones from it on a per-stem seed. The roll was chosen out of 34 across
# four prompts by pitch band, jitter, transcript, a gender classifier (one
# prompt that said "grandfather" still rolled female every time) and WavLM
# speaker similarity to the other heroes — see voice/README.md. Raw takes are
# committed as well, as the other packs do: a server/model upgrade can change
# what a seed renders.
#
# Distinct from the roster on purpose (measured, voice-qa.py): Pavlov 103 Hz
# booming Russian bass, Skinner 120 Hz dry American baritone, Freud a 235 Hz
# preset. Erikson is a light, warm, twinkly elderly tenor with a soft German
# accent, targeted at ~140-175 Hz.
#
# Keys 1 and 2 speak the stage's crisis and its virtue (the bar's labels,
# heard as well as read). They fire every ~1.5 s (the GCD) and a new line cuts
# the last, so they are short; the fun is the DELIVERY — each stage acted in
# its age's register. Jokes live on E/R/F and the idles, which play rarely
# (Skinner's lesson: rotation punchlines wear out on repeat).
#
# Raw takes -> assets/work/erikson/voice/_raw_tts/<stem>.wav  (48 kHz)
# Runtime   -> public/assets/heroes/voice/erikson/<stem>.webm  (Opus 24k mono)
#
# Usage:
#   tools/gen-erikson-voice.sh            clone every missing line, transcode all
#   tools/gen-erikson-voice.sh --design N roll the design on seeds 1001..1000+N
#                                         into /tmp/erikson-design/roll_<seed>.wav
#   (audition with tools/voice-qa.py on spark, copy the winner to _ref/)
# Idempotent: existing raw takes skip; delete one to re-roll that line.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"
MODEL="openbmb/VoxCPM2"
WORK=assets/work/erikson/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/erikson
REF=$WORK/_ref/erikson_voice_ref.wav
mkdir -p "$RAW" "$OUT"

# Per-stem seed, so re-running a deleted take reproduces it (zlib.crc32, the
# nightmare pack's scheme).
seed_for() {
  python3 -c 'import zlib,sys; print(7000 + zlib.crc32(sys.argv[1].encode()) % 10000)' "$1"
}

# One request. $1 output wav, $2 full input text, $3 seed, $4 optional reference wav.
speak() {
  python3 - "$MODEL" "$2" "$3" "${4:-}" <<'PY' | curl -sf -m 600 -X POST "$API" \
      -H 'Content-Type: application/json' -d @- --output "$1"
import base64, json, sys
model, text, seed, ref = sys.argv[1:5]
body = {"model": model, "input": text, "voice": "default", "response_format": "wav", "seed": int(seed)}
if ref:
    body["ref_audio"] = "data:audio/wav;base64," + base64.b64encode(open(ref, "rb").read()).decode()
print(json.dumps(body))
PY
}

if [ "${1:-}" = "--design" ]; then
  n="${2:-3}"; dir=/tmp/erikson-design; mkdir -p "$dir"
  prompt="$(tr '\n' ' ' < "$WORK/_ref/DESIGN_PROMPT.txt" | sed 's/ *$//')"
  for i in $(seq 1 "$n"); do
    echo "== design roll $i"
    speak "$dir/roll_$((1000 + i)).wav" "($prompt)$(cat "$WORK/_ref/erikson_voice_ref.txt")" $((1000 + i))
  done
  ls -1 "$dir"
  exit 0
fi

[ -s "$REF" ] || { echo "no $REF — run --design, audition, and keep a roll first" >&2; exit 1; }

STYLE="Kindly elderly storyteller with a soft German accent"
gen() { # stem text delivery [seed — pins a re-roll; default seed_for stem]
  local stem="$1" text="$2" delivery="$3" seed="${4:-}"
  [ -n "$seed" ] || seed="$(seed_for "$stem")"
  if [ -s "$RAW/$stem.wav" ]; then echo "skip $stem"; else
    echo "== $stem"
    speak "$RAW/$stem.wav" "($STYLE, $delivery)$text" "$seed" "$REF"
  fi
  # Trim the clone's lead-in air to a 60 ms pad (a cast line that lags the
  # press reads as a bug) and level to -23 LUFS, where the shipped packs sit.
  ffmpeg -y -loglevel error -i "$RAW/$stem.wav" \
    -af "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.06,loudnorm=I=-23:TP=-3:LRA=11" \
    -codec:a libopus -b:a 24k -ac 1 -application voip "$OUT/$stem.webm"
}

# ---- Key 1: the eight crises, each acted in its age ------------------------
gen stage_1 "Trust versus mistrust."             "tender cooing, as if soothing a newborn"
gen stage_2 "Autonomy versus shame and doubt!"   "playful toddler stubbornness, foot-stamping"
gen stage_3 "Initiative versus guilt!"           "bright, eager, adventurous child"
gen stage_4 "Industry versus inferiority."       "brisk schoolteacher, rolling up the sleeves"
gen stage_5 "Identity versus role confusion."    "exaggerated weary teenage sigh, comic drama"
gen stage_6 "Intimacy versus isolation."         "warm, tender, a little romantic"
gen stage_7 "Generativity versus stagnation!"    "hearty, proud, full of energy"
# Seed pinned: the stem seed paced this line to 3 s, past the 1-2 rhythm.
gen stage_8 "Integrity versus despair."          "wistful and serene, but brief" 103

# ---- Key 2: the virtue each one yields -------------------------------------
gen virtue_1 "Hope."        "soft, glowing"
gen virtue_2 "Will! My own will!" "triumphant, toddler-proud"
gen virtue_3 "Purpose!"     "rallying, onward"
gen virtue_4 "Competence."  "proud, satisfied nod"
gen virtue_5 "Fidelity."    "sincere, quietly certain"
gen virtue_6 "Love."        "warm, smiling"
gen virtue_7 "Care."        "gentle, generous"
gen virtue_8 "Wisdom."      "deep contented sigh"

# ---- E / R / F ---------------------------------------------------------------
gen cast_moratorium     "A moratorium! Even heroes deserve a gap year."          "cheerful, mischievous"
gen cast_identity_crisis "Who am I? Who are you? Identity crisis!"               "theatrical mock panic, then a laugh"
gen cast_life_review    "Let me tell you the story of a whole life. Every stage of it!" "grand, warm, building to a flourish"

# ---- Idles ---------------------------------------------------------------------
gen idle_01 "I named myself Erikson. Erik, son of Erik. Now that is identity formation." "amused, confiding"
gen idle_02 "Freud stopped at puberty. I kept going. Somebody has to look after the grandparents." "teasing, fond"
gen idle_03 "No university degree, and still they gave me an office at Harvard. Industry beats inferiority." "twinkling, a little proud"

echo "done:"; ls -1 "$OUT"
