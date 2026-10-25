#!/usr/bin/env bash
# Dream Siege monster sounds, VOICED with VoxCPM2 (2026-10-25), replacing
# the Stable Audio Open takes for these four stems. (`hit` and `player_hit`
# were voiced too, as a yelp and a grunt over a beatboxed kick, and read as
# odd — they went back to Stable Audio as non-human impacts the same day, see
# assets/work/survival/sfx/README.md.) The rest of the pack is
# tools/gen-survival-sfx.py + ship-survival-sfx.sh.
#
# A TTS model only makes voices, so every sound here is a voice: a designed
# creature vocalisation, then shaped in ffmpeg into an effect.
#
#   1. --roll   N design rolls per stem on the vLLM-Omni server (:8647) ->
#               assets/work/survival/sfx/_vox/<stem>.<seed>.wav  (not committed)
#   2. --pick   keep one take per stem by measured length and level (no ears in
#               the loop: the shortest take inside the band for a hit, the
#               fullest for a roar) -> _vox/<stem>.wav
#   3. (default) post-FX + ship -> public/assets/survival/sfx/<stem>.webm
#
# Usage: tools/gen-survival-vox-sfx.sh --roll 3 && tools/gen-survival-vox-sfx.sh --pick && tools/gen-survival-vox-sfx.sh
#
# Kept takes (2026-10-25), audited with Whisper rather than the --pick score —
# long rolls are sustained vowels ("Aaaa…" for 16 s) and some short ones read
# as words: hit_defended 5003 (breathy, becomes the hiss-clank), die_minion
# 5006 "Eek!" (rolled again with "(…one very short squeaky death squeal, under
# one second)Eek!", seeds 5004–5008), die_elite 5003 (a sustained "Raaa", cut
# to its first 2.1 s and faded), boss_roar 5003 "ARRRR".
set -euo pipefail
cd "$(dirname "$0")/.."
API="${VOXCPM_API:-http://localhost:8647/v1/audio/speech}"
V=assets/work/survival/sfx/_vox
OUT=public/assets/survival/sfx
mkdir -p "$V" "$OUT"

# stem | design (the voice) | text (the sound) | length band in seconds after trim
SPECS=(
  "hit_defended|a monster, a short scornful hiss through bared teeth, sharp and dismissive|Hsst!|0.15-0.6"
  "die_minion|a tiny ghostly dream creature, a short squeaky dying wail fading into a breathy whisper|Eeeeiiii...|0.5-1.3"
  "die_elite|a large monster, a long agonised dying groan, deep, guttural and fading away|Uuuurrrghhhh...|1.0-2.4"
  "boss_roar|a colossal monster, a huge furious roar, guttural, booming and endless|Rrraaaaaaaarrrrgh!|1.2-3.0"
)

trimmed_len() { # wav -> seconds of sound between the first and last -40 dB
  local t; t=$(mktemp --suffix=.wav)
  ffmpeg -y -loglevel error -i "$1" -af "silenceremove=start_periods=1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_threshold=-40dB,areverse" "$t"
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$t" || echo 0
  rm -f "$t"
}

if [ "${1:-}" = "--roll" ]; then
  n="${2:-3}"
  for spec in "${SPECS[@]}"; do
    IFS='|' read -r stem design text band <<<"$spec"
    for i in $(seq 1 "$n"); do
      seed=$((5000 + i)); f="$V/$stem.$seed.wav"
      [ -s "$f" ] && continue
      echo "== $stem roll $seed"
      python3 - "$design" "$text" "$seed" <<'PY' | curl -sf -m 600 -X POST "$API" -H 'Content-Type: application/json' -d @- --output "$f"
import json, sys
d, t, s = sys.argv[1:4]
print(json.dumps({"model": "openbmb/VoxCPM2", "input": f"({d}){t}", "voice": "default", "response_format": "wav", "seed": int(s)}))
PY
    done
  done
  exit 0
fi

if [ "${1:-}" = "--pick" ]; then
  for spec in "${SPECS[@]}"; do
    IFS='|' read -r stem design text band <<<"$spec"
    lo=${band%-*}; hi=${band#*-}; best=""; bestv=""
    for f in "$V/$stem".*.wav; do
      [ -s "$f" ] || continue
      len=$(trimmed_len "$f")
      vol=$(ffmpeg -i "$f" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB/\1/p')
      inband=$(python3 -c "print(1 if $lo <= $len <= $hi else 0)")
      # Roars and death groans: the fullest in band. Everything else: the shortest in band.
      case "$stem" in boss_roar|die_elite) score=$(python3 -c "print(($inband*100) + $len*10 + $vol/10)");;
                      *)                    score=$(python3 -c "print(($inband*100) - $len*10 + $vol/10)");; esac
      echo "$stem $(basename "$f") len=$len vol=$vol score=$score"
      if [ -z "$bestv" ] || python3 -c "import sys; sys.exit(0 if $score > $bestv else 1)"; then best="$f"; bestv="$score"; fi
    done
    [ -n "$best" ] && cp "$best" "$V/$stem.wav" && echo "  -> $stem: $(basename "$best")"
  done
  exit 0
fi

# ---- post-FX + ship ----------------------------------------------------------
TRIM="silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.005,areverse,silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.02,areverse"
LEVEL="loudnorm=I=-18:TP=-1.5:LRA=11,aresample=48000"
ship() { # stem filtergraph(out label [o]) [extra inputs...]
  local stem="$1" graph="$2"; shift 2
  ffmpeg -y -loglevel error -i "$V/$stem.wav" "$@" -filter_complex "$graph" -map "[o]" \
    -ac 1 -ar 48000 -codec:a libopus -b:a 48k "$OUT/$stem.webm"
  echo "$stem $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$stem.webm")s"
}
# A hiss rung through a short comb: the blow glances off something hard.
ship hit_defended "[0:a]$TRIM,atrim=0:0.45,aecho=0.8:0.9:2.3|3.7|5.1:0.55|0.45|0.35,highpass=f=500,afade=t=out:st=0.3:d=0.15,$LEVEL[o]"
# Tiny wail: pitched up, swirling, a short tail.
ship die_minion "[0:a]$TRIM,rubberband=pitch=1.25,flanger=delay=3:depth=4:speed=0.8,atrim=0:1.0,aecho=0.7:0.6:80|140:0.35|0.22,afade=t=out:st=0.7:d=0.3,$LEVEL[o]"
# Death groan: pitched down, a sub double, a hall.
ship die_elite "[0:a]$TRIM,rubberband=pitch=0.75,asplit=2[m][s];[s]rubberband=pitch=0.5,lowpass=f=500,volume=0.4[sub];[m][sub]amix=inputs=2:normalize=0,atrim=0:2.1,aecho=0.8:0.75:120|230|380:0.4|0.28|0.18,afade=t=out:st=1.6:d=0.5,$LEVEL[o]"
# The roar: way down, a sub layer, grit, and the street it echoes down.
ship boss_roar "[0:a]$TRIM,rubberband=pitch=0.6,asplit=2[m][s];[s]rubberband=pitch=0.5,lowpass=f=400,volume=0.5[sub];[m][sub]amix=inputs=2:normalize=0,acrusher=bits=10:mix=0.25,atrim=0:2.6,aecho=0.85:0.8:140|260|420|640:0.45|0.33|0.22|0.14,afade=t=out:st=1.9:d=0.7,$LEVEL[o]"
