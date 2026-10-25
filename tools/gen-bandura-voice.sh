#!/usr/bin/env bash
# Generate the Bandura — The Mirror VO pack with VoxCPM2 on spark.
#
# Same engine and recipe as tools/gen-ainsworth-voice.sh: vLLM-Omni serving
# openbmb/VoxCPM2 on spark :8647, voice DESIGNED once, then every line CLONED
# from that reference with "(style, delivery)text" on a per-stem seed.
#
# VOICE: prompt C, seed 9205, out of 18 rolls across four prompts
# (_ref/design_rolls.jsonl, graded by tools/voice-rank.py on spark): a bright,
# friendly prairie tenor, quick and energetic (Bandura: Mundare, Alberta, a
# town of four hundred). Measured 197 Hz, jitter 1.72%, male 0.999, transcript
# word-perfect, WavLM similarity 0.82 at most to every other hero (the lowest
# of any roll) and 0.84 to Piaget, forty hertz above him.
#
# Keys 1–4 hold COPIES of his model's skills, so their lines are about the
# copying, not the copied skill: one per slot, all under two seconds. History
# (the Bobo doll, Mundare, the car-pool course) lives on E/R/F and the idles.
#
# Raw takes -> assets/work/bandura/voice/_raw_tts/<stem>.wav  (48 kHz)
# Runtime   -> public/assets/heroes/voice/bandura/<stem>.webm  (Opus 24k mono)
# Usage: tools/gen-bandura-voice.sh   (idempotent; delete a raw take to re-roll it)
set -euo pipefail
cd "$(dirname "$0")/.."

API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"
MODEL="openbmb/VoxCPM2"
WORK=assets/work/bandura/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/bandura
REF=$WORK/_ref/bandura_voice_ref.wav
mkdir -p "$RAW" "$OUT"

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
  n="${2:-3}"; dir=/tmp/bandura-design; mkdir -p "$dir"
  prompt="$(tr '\n' ' ' < "$WORK/_ref/DESIGN_PROMPT.txt" | sed 's/ *$//')"
  for i in $(seq 1 "$n"); do
    echo "== design roll $i"
    speak "$dir/roll_$((4000 + i)).wav" "($prompt)$(cat "$WORK/_ref/bandura_voice_ref.txt")" $((4000 + i))
  done
  ls -1 "$dir"
  exit 0
fi

[ -s "$REF" ] || { echo "no $REF — run --design, audition, and keep a roll first" >&2; exit 1; }

STYLE="Bright, friendly Canadian professor in his sixties, quick and energetic"
gen() { # stem text delivery [seed — pins a re-roll; default seed_for stem]
  local stem="$1" text="$2" delivery="$3" seed="${4:-}"
  [ -n "$seed" ] || seed="$(seed_for "$stem")"
  if [ -s "$RAW/$stem.wav" ]; then echo "skip $stem"; else
    echo "== $stem"
    speak "$RAW/$stem.wav" "($STYLE, $delivery)$text" "$seed" "$REF"
  fi
  # 60 ms lead pad and -23 LUFS, as every shipped pack. The aresample steps
  # pin the format around loudnorm: py2's ffmpeg 7.1.5 aborts on
  # silenceremove→loudnorm for some takes ("Assertion best_input >= 0",
  # cast_ambivalent), though each filter alone is fine.
  ffmpeg -y -loglevel error -i "$RAW/$stem.wav" \
    -af "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.06,aresample=48000,loudnorm=I=-23:TP=-3:LRA=11,aresample=48000" \
    -codec:a libopus -b:a 24k -ac 1 -application voip "$OUT/$stem.webm"
}

# ---- Keys 1–4: reproductions, one line per retention slot ---------------
gen cast_observe_1 "Watch and learn."                   "confident and cheerful"
gen cast_observe_2 "Saw that. Doing that."              "quick and pleased with himself"
gen cast_observe_3 "Monkey see... professor do!"        "playful, a little cheeky"
gen cast_observe_4 "Thanks for the demonstration!"      "bright and grateful, a wink in it"

# ---- E / R / F ----------------------------------------------------------------
gen cast_self_efficacy "I believe I can. So I can."                          "firm, calm and certain"
gen cast_bobo_doll     "Bobo! Show them what the children learned."          "mischievous showman, gleeful"
gen cast_reciprocal_determinism "Person, behaviour, environment. Everything pushes back!" "rising and powerful, then emphatic"

# ---- Idles -------------------------------------------------------------------
gen idle_01 "I grew up in a town of four hundred people. Two teachers for the whole high school. We taught ourselves." "warm and nostalgic"
gen idle_02 "The Bobo doll got punched a few thousand times for science. He is fine. He bounces back." "dry, amused"
gen idle_03 "I took my first psychology course because it fit my car-pool schedule. Best accident of my life." "light and laughing"

echo "done:"; ls -1 "$OUT"
