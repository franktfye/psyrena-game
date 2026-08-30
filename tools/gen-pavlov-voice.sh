#!/usr/bin/env bash
# Generate the Pavlov — The Conditioner VO pack with Qwen3-TTS.
# Same recipe as the Freud pack (assets/work/freud/voice/README.md): CustomVoice
# 1.7B, one speaker, rich per-line --instruct emotion control, wav→webm (Opus) (no
# character post-FX — hero VO is clean, unlike the nightmare's void FX).
#
# VOICE: designed, then cloned. Not a preset speaker (2026-08-04, third pass).
#
# Qwen's own speaker descriptions explain why the first two passes failed:
#
#   Dylan     "Youthful Beijing male voice"          <- pass 1. Youthful.
#   Aiden     "Sunny American male voice, clear midrange"  <- pass 2. Sunny.
#   Ryan      "Dynamic male voice with strong rhythmic drive"
#   Uncle_Fu  "Seasoned male voice with a low, mellow timbre"   (Freud's)
#
# Only Uncle_Fu is old, he is already Freud, and his native language is
# Chinese — rendering him in English measured centroid 995 Hz / HNR 1.8 dB,
# i.e. bright and noisy, exactly the degradation Qwen warns about when a
# speaker is taken off their native language. There is no old English-speaking
# male preset to pick. So we stop picking.
#
# Qwen3-TTS-12Hz-1.7B-VoiceDesign synthesises a voice from a description, so
# Pavlov gets one built to his age instead of a young preset instructed to act
# old. The design prompt and its output are committed under voice/_ref/ —
# THE PACK IS ONLY REPRODUCIBLE BECAUSE THAT WAV IS IN THE REPO.
#
# ⚠️ Design is NOT deterministic: the same prompt twice gave 104 Hz/363 Hz and
# 96 Hz/428 Hz, and two of four prompt variants collapsed into noise (jitter
# 18% and 37%). A nine-line pack generated that way would change voice line to
# line. So the design runs ONCE and every line is CLONED from that single
# reference, which measures tight: F0 93-107 Hz, centroid 316-363 Hz across
# lines, against a reference of 104/363.
#
# To re-roll the voice itself (not just a line): delete voice/_ref/*.wav, run
# the design command in _ref/DESIGN_PROMPT.txt, audition it, then delete
# _raw_tts/*.wav and re-run this script.
#
# Raw takes -> assets/work/pavlov/voice/_raw_tts/<stem>.wav
# Runtime   -> public/assets/heroes/voice/pavlov/<stem>.webm  (Opus 24k mono)
#
# NS (the basic) deliberately has NO line: it fires every 2 s — a bell that
# talked would drown the pack. Same reason Freud's basic ships silent.
#
# Usage: tools/gen-pavlov-voice.sh   (idempotent — existing raw takes skip;
#        delete a stem's wav under _raw_tts to re-roll just that line)
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=assets/work/pavlov/voice
RAW=$WORK/_raw_tts
OUT=public/assets/heroes/voice/pavlov
mkdir -p "$RAW" "$OUT"

REF=$WORK/_ref/pavlov_voice_ref.wav
REF_TEXT="$(cat "$WORK/_ref/pavlov_voice_ref.txt")"
STYLE="An old man's voice. Ivan Pavlov, the Russian physiologist, in his eighties — elderly, weathered, unhurried, with a dry wit. He speaks quietly and never shouts."

# dylan renders ~6 dB quieter than the retired eric pack, so the transcode
# normalises instead of trusting the raw take. -23 LUFS sits between the two
# packs already shipping (pavlov/eric -24.1, freud/uncle_fu -22.8), so the new
# lines slot in at the level the game is already mixed for.
# The cloned voice renders quieter than the retired eric pack, so the transcode
# normalises rather than trusting the raw take. -23 LUFS sits between the two
# packs already shipping (pavlov/eric -24.1, freud/uncle_fu -22.8).
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
  # The clone renders 0.1–0.75 s of dead air before the first word, and a cast
  # line that lags the button press reads as a bug. Trim to a 60 ms pad — the
  # Freud pack's natural onset — before normalising.
  ffmpeg -y -loglevel error -i "$RAW/$stem.wav" \
    -af "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.06,loudnorm=I=-23:TP=-3:LRA=11" \
    -codec:a libopus -b:a 24k -ac 1 -application voip "$OUT/$stem.webm"
}

# ---- Idle musings ----------------------------------------------------------
gen idle_01 "You hear the bell. You feel hungry. Congratulations — you are science!" \
  "A lecture punchline, told slowly and with quiet pride."

gen idle_02 "I miss my dogs. You drool less… but you learn slower." \
  "Wistful about the dogs, then a flat deadpan insult."

gen idle_03 "Stand still much longer, and you become the control group." \
  "A dry mock warning, amused."

# ---- Skill casts -----------------------------------------------------------
gen cast_ucs "Food first. Philosophy later." \
  "A quiet, unhurried remark to himself, waving away the armchair. Low and level."

gen cast_cs "The bell alone… and still it learned. Ha. Haa." \
  "Delighted astonishment, then a warm old laugh."

gen cast_spontaneous_recovery "Rest. Even a reflex deserves a holiday." \
  "A doctor's order, softening into kindness."

gen cast_generalization "A clock, a bell… your nerves cannot tell the difference." \
  "Mocking showmanship, giving away an old trick."

gen cast_extinction "Bell… no food. Bell… no food. Now… forget." \
  "A slow ritual incantation, then one grave command."

gen cast_discrimination "This bell. Not that bell. Look at me." \
  "An affronted bark from a man who will not be ignored."

echo "done. runtime files:"
ls -1 "$OUT"
