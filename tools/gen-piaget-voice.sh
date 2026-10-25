#!/usr/bin/env bash
# Generate the Piaget — The Constructor VO pack with VoxCPM2 on spark.
#
# Same engine and recipe as tools/gen-ainsworth-voice.sh: vLLM-Omni serving
# openbmb/VoxCPM2 on spark :8647, voice DESIGNED once, then every line CLONED
# from that reference with "(style, delivery)text" on a per-stem seed.
#
# VOICE: prompt B, seed 8101, out of 13 rolls across three prompts
# (_ref/design_rolls.jsonl, graded by tools/voice-rank.py on spark): a gentle
# baritone with a light French accent (Piaget: Neuchâtel, Switzerland), kind,
# unhurried and amused. Measured 157 Hz, jitter 2.28%, male 0.999, transcript
# word-perfect, WavLM similarity ≤ 0.86 to every other hero. VoxCPM's designed
# men all sit at 0.8–0.9 on that model; this one is the least like anyone and
# the most like a grandfather explaining a puzzle.
#
# Keys 1–4 are his four stages, and each line THINKS like a child at that
# stage: the infant's "again!", the preoperational fixation on one thing,
# concrete conservation, the formal hypothetical. Short for the GCD; the
# history and jokes live on E/R/F and the idles.
#
# Raw takes -> assets/work/piaget/voice/_raw_tts/<stem>.wav  (48 kHz)
# Runtime   -> public/assets/heroes/voice/piaget/<stem>.webm  (Opus 24k mono)
# Usage: tools/gen-piaget-voice.sh   (idempotent; delete a raw take to re-roll it)
set -euo pipefail
cd "$(dirname "$0")/.."

API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"
MODEL="openbmb/VoxCPM2"
WORK=assets/work/piaget/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/piaget
REF=$WORK/_ref/piaget_voice_ref.wav
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
  n="${2:-3}"; dir=/tmp/piaget-design; mkdir -p "$dir"
  prompt="$(tr '\n' ' ' < "$WORK/_ref/DESIGN_PROMPT.txt" | sed 's/ *$//')"
  for i in $(seq 1 "$n"); do
    echo "== design roll $i"
    speak "$dir/roll_$((4000 + i)).wav" "($prompt)$(cat "$WORK/_ref/piaget_voice_ref.txt")" $((4000 + i))
  done
  ls -1 "$dir"
  exit 0
fi

[ -s "$REF" ] || { echo "no $REF — run --design, audition, and keep a roll first" >&2; exit 1; }

STYLE="Gentle elderly Swiss professor with a light French accent, kind and amused"
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

# ---- Keys 1–4: the four stages, each thinking like that stage -------------
# Seeds pinned: these fire on the 1.5 s GCD and a new line cuts the old, so
# each was re-rolled (brisker delivery) until its speech fit ≤ 2.3 s. The
# stem seeds ran 2.6–3.4 s in his unhurried register; "Again! Again!" is the
# circular reaction itself, and no seed fit the longer first draft.
gen cast_sensorimotor    "Again! Again!"                              "delighted, brisk, warm chuckle of discovery" 602
gen cast_preoperational  "This one. Only this one."                   "quick, earnest and fixated, brisk" 500
gen cast_concrete        "Same amount. Different shape."              "quick and matter-of-fact, brisk" 500
gen cast_formal          "Hypothetically... you are already safe."    "sly and quick, a knowing smile" 509

# ---- E / R / F ----------------------------------------------------------------
# Seed pinned: the stem seed said "Then I changed".
gen cast_accommodation   "Ah, something new! Then I change, not you."                 "warm surprise, then gently adapting" 412
gen cast_object_permanence "Peekaboo! You are still there. I knew it."              "playful, then tender and reassuring"
# Seed pinned: the stem seed drifted off his voice (WavLM 0.65 to the reference).
gen cast_equilibration   "Assimilate, accommodate... and balance! Voila!"             "rising and delighted, triumphant but warm" 603

# ---- Idles -------------------------------------------------------------------
gen idle_01 "I published my first paper at ten. On an albino sparrow. The reviewers did not know I was ten."  "wry and proud"
gen idle_02 "I studied my own three children. Very cooperative subjects. They never read the consent forms." "mischievous, fond"
gen idle_03 "Every morning I cycle to the university with my pipe, thinking. Mostly about snails."           "dreamy and content"

echo "done:"; ls -1 "$OUT"
