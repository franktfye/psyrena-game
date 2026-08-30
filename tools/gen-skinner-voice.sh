#!/usr/bin/env bash
# Generate the Skinner — The Reinforcer VO pack with Qwen3-TTS.
# Same recipe as the Pavlov pack (assets/work/skinner/voice/README.md): design
# ONE reference voice with VoiceDesign, then CLONE every line from it with
# rich per-line --instruct emotion control, wav→webm (Opus) (no character post-FX —
# hero VO is clean).
#
# VOICE: designed, then cloned. Not a preset speaker (2026-08-05).
#
# Skinner is a MID-AGE American male (~45-55) and no preset fits: Dylan,
# Aiden and Ryan are young by Qwen's own descriptions, and Uncle_Fu — the one
# seasoned male — is elderly, Chinese-native, and already Freud's voice. Same
# dead end the Pavlov pack hit, same fix: design the voice to spec once.
#
# ⚠️ VoiceDesign is NOT deterministic (see the Pavlov README). Four rolls of
# the same prompt gave median F0 121 / 168 / 234 / 124 Hz — two of them
# outright juvenile. So the design ran ONCE, the best roll (124.5 Hz, 4.92%
# jitter proxy) was kept, and every line is CLONED from that single reference
# committed under voice/_ref/. THE PACK IS ONLY REPRODUCIBLE BECAUSE THAT WAV
# IS IN THE REPO.
#
# To re-roll the voice itself (not just a line): delete voice/_ref/*.wav, run
#   qwen3-tts --design -t "$(cat _ref/skinner_voice_ref.txt)" --lang English \
#     --instruct "$(tr '\n' ' ' < _ref/DESIGN_PROMPT.txt)" -o _ref/skinner_voice_ref.wav
# audition/measure it, then delete _raw_tts/*.wav and re-run this script.
#
# Raw takes -> assets/work/skinner/voice/_raw_tts/<stem>.wav
# Runtime   -> public/assets/heroes/voice/skinner/<stem>.webm  (Opus 24k mono)
#
# Usage: tools/gen-skinner-voice.sh   (idempotent — existing raw takes skip;
#        delete a stem's wav under _raw_tts to re-roll just that line)
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=assets/work/skinner/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/skinner
mkdir -p "$RAW" "$OUT"

REF=$WORK/_ref/skinner_voice_ref.wav
REF_TEXT="$(cat "$WORK/_ref/skinner_voice_ref.txt")"
STYLE="Confident mid-aged American scientist, dry wit, amused, crisp diction, speaking to teammates mid-battle."

# The cloned voice renders quieter than the shipped packs, so the transcode
# normalises rather than trusting the raw take. -23 LUFS sits between the two
# packs already shipping (pavlov -24.1, freud/uncle_fu -22.8), so the new
# lines slot in at the level the game is already mixed for.
#
# No pitch post-processing: the voice is the right age at source, which is the
# whole point of designing one instead of shifting a young one down.
gen() { # stem text emotion
  local stem="$1" text="$2" emotion="$3"
  if [ -s "$RAW/$stem.wav" ]; then echo "skip $stem"; else
    echo "== $stem =="
    qwen3-tts --clone --model clone-1.7b -t "$text" --lang English \
      --ref-audio "$REF" --ref-text "$REF_TEXT" \
      --instruct "$STYLE $emotion" \
      -o "$RAW/$stem.wav"
  fi
  # The clone renders dead air before the first word, and a cast line that
  # lags the button press reads as a bug. Trim to a 60 ms pad before
  # normalising — same treatment as the Pavlov pack.
  ffmpeg -y -loglevel error -i "$RAW/$stem.wav" \
    -af "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.06,loudnorm=I=-23:TP=-3:LRA=11" \
    -codec:a libopus -b:a 24k -ac 1 -application voip "$OUT/$stem.webm"
}

# ---- Skill casts -----------------------------------------------------------
# Keys 1-4 fire every few seconds in a rotation, so the cast lines are the
# bare skill names (2026-08-06) — the fun lines wore out on repeat. The
# per-line emotion instructs are unchanged, so the reads keep their color.
gen cast_fixed_ratio "Fixed ratio." \
  "Brisk and deadpan."

gen cast_variable_ratio "Variable ratio!" \
  "Gleeful and sly."

gen cast_fixed_interval "Fixed interval." \
  "Dry and instructive."

gen cast_variable_interval "Variable interval." \
  "Teasing."

gen toggle_positive "Now watching for output. Hit something, earn a treat." \
  "Crisp and upbeat."

gen toggle_negative "New contingency: don't get hit. I pay handsomely for dodges." \
  "Wry."

gen toggle_reinforcement "Reinforcement mode. Good behavior, warm feelings, hit points." \
  "Warm and amused."

gen toggle_punishment "Punishment mode. Relax. It decreases behavior. Mostly the boss's." \
  "Mock reassurance."

gen cast_shaping "Shaping! One approximation at a time. Go on, my magnificent data point!" \
  "Triumphant and delighted — the ultimate."

# ---- Idle musings ----------------------------------------------------------
gen idle_01 "It's not a cage. It's a chamber with unusually honest feedback." \
  "Musing."

gen idle_02 "Free will. Adorable. Press your buttons, I'll press mine." \
  "Dry amusement."

gen idle_03 "My pigeons invented a religion in one afternoon. You people take a whole loading screen." \
  "Fond exasperation."

echo "done. runtime files:"
ls -1 "$OUT"
