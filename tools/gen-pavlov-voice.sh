#!/usr/bin/env bash
# Generate the Pavlov — The Conditioner VO pack with VoxCPM2 on gpu-box.
#
# Same engine and recipe as the Erikson pack (tools/gen-erikson-voice.sh,
# assets/work/erikson/voice/README.md): vLLM-Omni serving openbmb/VoxCPM2
# (spark: ~/vllm-omni/run-voxcpm2.sh, port 8647), POST /v1/audio/speech,
# 48 kHz mono WAV.
#   voice design         input "(<description>)<text>", no reference
#   controllable cloning ref_audio (base64 data URI) + input "(<style>)<text>"
# The "(…)" prefix is a control instruction, never spoken.
#
# The pack was Qwen3-TTS until 2026-10-21 (design-then-clone with a
# non-deterministic VoiceDesign). It moved to VoxCPM2 with a rewrite of every
# line: VoxCPM takes a `seed`, so the reference and every take are
# reproducible from the script, and its voice design holds an accent.
#
# VOICE: designed once, then cloned. Design rolls are seeds 1001..100N; the
# kept roll is committed as voice/_ref/pavlov_voice_ref.wav with its seed in
# _ref/SEED (the reference is `(DESIGN_PROMPT)reftext` on that seed). Every
# line clones from it on a per-stem seed. Raw takes are committed too: a
# server/model upgrade can change what a seed renders. Target register: a
# booming Russian bass, ~95-120 Hz, clear of Skinner (120 Hz American
# baritone) and Erikson (164 Hz German tenor). See voice/README.md.
#
# Key 1 (UCS), the CS face of LMB and the key-4 stance fire often and a new
# line cuts the last, so they stay ≤ ~2.3 s. The jokes live on E/R/F and the
# idles. NS (the basic) has no line: a bell that talked every 2 s would drown
# the pack.
#
# Raw takes -> assets/work/pavlov/voice/_raw_tts/<stem>.wav  (48 kHz)
# Runtime   -> public/assets/heroes/voice/pavlov/<stem>.webm  (Opus 24k mono)
#
# Usage:
#   tools/gen-pavlov-voice.sh            clone every missing line, transcode all
#   tools/gen-pavlov-voice.sh --design N roll the design on seeds 1001..1000+N
#                                        into $DESIGN_DIR (default /tmp/pavlov-design)
#   (audition with tools/voice-rank.py on spark, copy the winner to _ref/)
# Idempotent: existing raw takes skip; delete one to re-roll that line.
set -euo pipefail
cd "$(dirname "$0")/.."

API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"
MODEL="openbmb/VoxCPM2"
WORK=assets/work/pavlov/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/pavlov
REF=$WORK/_ref/pavlov_voice_ref.wav
mkdir -p "$RAW" "$OUT"

# Per-stem seed, so re-running a deleted take reproduces it.
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
  n="${2:-3}"; dir="${DESIGN_DIR:-/tmp/pavlov-design}"; mkdir -p "$dir"
  prompt="$(tr '\n' ' ' < "$WORK/_ref/DESIGN_PROMPT.txt" | sed 's/ *$//')"
  for i in $(seq 1 "$n"); do
    echo "== design roll $i"
    speak "$dir/roll_$((1000 + i)).wav" "($prompt)$(cat "$WORK/_ref/pavlov_voice_ref.txt")" $((1000 + i))
  done
  ls -1 "$dir"
  exit 0
fi

[ -s "$REF" ] || { echo "no $REF — run --design, audition, and keep a roll first" >&2; exit 1; }

STYLE="Elderly Russian professor, deep resonant bass, heavy Russian accent"
gen() { # stem text delivery [seed — pins a re-roll; default seed_for stem]
  local stem="$1" text="$2" delivery="$3" seed="${4:-}"
  [ -n "$seed" ] || seed="$(seed_for "$stem")"
  if [ -s "$RAW/$stem.wav" ]; then echo "skip $stem"; else
    echo "== $stem"
    speak "$RAW/$stem.wav" "($STYLE, $delivery)$text" "$seed" "$REF"
  fi
  # Trim the clone's lead-in air to a 60 ms pad (a cast line that lags the
  # press reads as a bug) and level to -23 LUFS, where the shipped packs sit.
  # The aresample is a no-op on 48 kHz input; without it ffmpeg 7.1 aborts
  # ("best_input >= 0" assertion) on some takes between these two filters.
  ffmpeg -y -loglevel error -i "$RAW/$stem.wav" \
    -af "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.06,aresample=48000,loudnorm=I=-23:TP=-3:LRA=11" \
    -codec:a libopus -b:a 24k -ac 1 -application voip "$OUT/$stem.webm"
}

# Every seed is pinned: each line was picked from 4-6 seeds on transcript,
# voiced fraction, register and length (voice/README.md). Exclaimed commands
# ("Salivate!") and "barks" rolled into unvoiced rasp on most seeds, so the
# short lines are written calm and use commas, not full stops: each full stop
# costs this slow voice ~0.5-1 s of pause.

# ---- Key 1 / LMB / key 4: short, they repeat --------------------------------
gen cast_ucs            "Meat powder. Now, salivate."   "firm, matter-of-fact, pleased"        11
gen cast_cs             "Only the bell now. Good dog."  "proud and pleased, a satisfied smile" 15
gen cast_discrimination "This bell, not that one."      "quick and stern"                      1

# ---- E / R / F ---------------------------------------------------------------
gen cast_spontaneous_recovery "Rest. The reflex was only sleeping."              "a doctor's calm order, then warm"    3
gen cast_generalization       "Bell, metronome, clock, to you it is all dinner." "mocking showman, savouring it"       1
gen cast_extinction           "Bell, no food. Bell, no food. Now, forget."       "slow ritual, then one grave command" 2

# ---- Idles ---------------------------------------------------------------------
gen idle_01 "Nobel Prize, nineteen oh four, for digestion. The bell came later."    "dry, proud, deadpan"              2
gen idle_02 "My dogs learned faster than you, and they could not read the tooltip." "flat, quiet deadpan, amused"      2
gen idle_03 "Standing still? Noted: subject is not hungry."                         "clinical, dry, scribbling a note" 3

echo "done:"; ls -1 "$OUT"
