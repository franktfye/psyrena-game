#!/usr/bin/env bash
# Generate the Ainsworth — The Safe Haven VO pack with VoxCPM2 on gpu-box.
#
# Same engine and recipe as tools/gen-erikson-voice.sh (read its header for the
# API details): vLLM-Omni serving openbmb/VoxCPM2 on spark :8647, voice
# DESIGNED once, then every line CLONED from that reference with
# "(style, delivery)text" on a per-stem seed. The "(…)" prefix is never spoken.
#
# VOICE: the reference is `(DESIGN_PROMPT)reftext` on seed _ref/SEED, chosen out
# of 18 rolls across three prompts (_ref/design_rolls.jsonl, graded by
# tools/voice-rank.py on spark). Kept: prompt A, seed 4004 — a warm, clear alto
# in her sixties with a gentle North American accent (Ainsworth: born in Ohio,
# raised in Toronto). Measured 183 Hz, jitter 1.75%, female 0.999, transcript
# word-perfect, WavLM similarity ≤ 0.58 to every other hero (Skinner 0.58,
# Erikson 0.47, Nightmare 0.45, Pavlov 0.31, Freud 0.29): her own voice, and
# below Freud's 235 Hz preset.
#
# Keys 1–4 are the four attachment styles. Each line acts out that style's
# REUNION (what the Strange Situation actually classifies on): secure greets
# and lets go, avoidant shrugs it off, ambivalent clings and pushes away,
# disorganized freezes and then shields the team (the key's 3 s immunity).
# They sit on the GCD rotation and a new line cuts the old one, so each is
# ~≤2.3 s. Jokes and history live on E/R/F, the stance and the idles.
#
# Raw takes -> assets/work/ainsworth/voice/_raw_tts/<stem>.wav  (48 kHz)
# Runtime   -> public/assets/heroes/voice/ainsworth/<stem>.webm  (Opus 24k mono)
#
# Usage:
#   tools/gen-ainsworth-voice.sh            clone every missing line, transcode all
#   tools/gen-ainsworth-voice.sh --design N roll the design on seeds 4001..4000+N
#                                           into /tmp/ainsworth-design/roll_<seed>.wav
# Idempotent: existing raw takes skip; delete one to re-roll that line.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"
MODEL="openbmb/VoxCPM2"
WORK=assets/work/ainsworth/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/ainsworth
REF=$WORK/_ref/ainsworth_voice_ref.wav
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
  n="${2:-3}"; dir=/tmp/ainsworth-design; mkdir -p "$dir"
  prompt="$(tr '\n' ' ' < "$WORK/_ref/DESIGN_PROMPT.txt" | sed 's/ *$//')"
  for i in $(seq 1 "$n"); do
    echo "== design roll $i"
    speak "$dir/roll_$((4000 + i)).wav" "($prompt)$(cat "$WORK/_ref/ainsworth_voice_ref.txt")" $((4000 + i))
  done
  ls -1 "$dir"
  exit 0
fi

[ -s "$REF" ] || { echo "no $REF — run --design, audition, and keep a roll first" >&2; exit 1; }

STYLE="Warm, kind older woman professor with a gentle North American accent"
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

# ---- Keys 1–4: the four attachment styles, each acting its reunion ---------
gen cast_secure       "There you are! Off you go."          "delighted warm greeting, then a gentle, encouraging send-off"
gen cast_avoidant     "I'm fine. I don't need anyone."      "cool, flat and offhand, deliberately not looking"
# Seeds pinned (re-rolls): the stem seeds paced these past the GCD rhythm with
# a long dramatic pause (3.0 s and 3.7 s of speech). Disorganized also lost
# words: the freeze is the beat between "Wait" and "behind me".
gen cast_ambivalent   "Don't leave me! No, go away!"        "clingy plea that flips into a cross, huffy push-away, comic, quick" 204
gen cast_disorganized "Wait... behind me!"                  "startled and frozen for a beat, then suddenly fierce and protective" 302

# ---- E / R / F, and the threat stance ---------------------------------------
gen cast_safe_haven       "Come here, dear. Nothing can reach you here."                      "soft and sheltering, lowering her voice"
gen cast_strange_situation "Mother leaves the room... and mother returns! Write that down."   "playful researcher narrating, mock-solemn, then delighted"
gen cast_earned_security  "It's never too late to feel secure. Come, all of you!"            "rising, radiant and deeply moved"
gen cast_proximity_maintenance "Stay close to me."                                            "calm, steady and protective"

# ---- Idles -------------------------------------------------------------------
gen idle_01 "Eight episodes, twenty minutes, one stranger. Best twenty minutes in psychology." "fond and a little proud"
gen idle_02 "John Bowlby had the theory. I had the clipboard. And the babies."                   "teasing, affectionate"
gen idle_03 "I was a major in the Canadian army, you know. Toddlers are much harder to command." "dry and amused"

echo "done:"; ls -1 "$OUT"
