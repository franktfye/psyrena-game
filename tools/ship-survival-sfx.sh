#!/usr/bin/env bash
# Finish the Dream Siege SFX (raw Stable Audio Open takes from
# tools/gen-survival-sfx.py): trim the lead-in silence, cut to the length in
# sfx.tsv with a short fade-out, mono, level, Opus-in-WebM.
#   assets/work/survival/sfx/_raw/<stem>.wav -> public/assets/survival/sfx/<stem>.webm
set -euo pipefail
cd "$(dirname "$0")/.."
W=assets/work/survival/sfx
OUT=public/assets/survival/sfx
mkdir -p "$OUT"
grep -v '^#' "$W/sfx.tsv" | while IFS=$'\t' read -r stem secs prompt; do
  [ -s "$W/_raw/$stem.wav" ] || { echo "missing raw $stem" >&2; continue; }
  fade=$(python3 -c "print(max(0.05, min(0.4, $secs * 0.25)))")
  start=$(python3 -c "print($secs - $fade)")
  ffmpeg -y -loglevel error -i "$W/_raw/$stem.wav" -af \
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01,atrim=0:$secs,afade=t=out:st=$start:d=$fade,loudnorm=I=-18:TP=-1.5:LRA=11" \
    -ac 1 -ar 48000 -codec:a libopus -b:a 48k "$OUT/$stem.webm"
  echo "$stem $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$stem.webm")"
done
