#!/usr/bin/env bash
# Generate one image with the Grok CLI's Imagine tool (image_gen / image_edit).
# The second image backend beside tools/civitai-gen.mjs (OpenAI gpt-image).
#
# Usage:
#   tools/grok-gen.sh --prompt "..." --out assets/concept/foo.jpg [--aspect 1:1|16:9|9:16|3:2|2:3]
#   tools/grok-gen.sh --prompt-file p.txt --image ref.png --out edited.jpg   (image_edit)
#
# Grok runs headless with ONLY its image tools allowed (plus search_tool, which
# it needs to load them) under dontAsk — no shell, no file writes, no web. The
# image lands in grok's own session folder; this script copies it to --out.
# Output is JPEG whatever the extension says; convert before shipping.

set -euo pipefail

prompt="" out="" aspect="auto" images=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) prompt="$2"; shift 2 ;;
    --prompt-file) prompt="$(cat "$2")"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --aspect) aspect="$2"; shift 2 ;;
    --image) images+=("$(realpath "$2")"); shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$prompt" && -n "$out" ]] || { echo "Need --prompt/--prompt-file and --out" >&2; exit 1; }

workdir="$(mktemp -d /tmp/grok-gen.XXXXXX)"
sid="$(cat /proc/sys/kernel/random/uuid)"
if [[ ${#images[@]} -gt 0 ]]; then
  for i in "${!images[@]}"; do cp "${images[$i]}" "$workdir/ref_$i.${images[$i]##*.}"; done
  tool="image_edit"
  ask="Call image_edit exactly once on the reference image(s) in the current directory ($(cd "$workdir" && ls ref_* | tr '\n' ' ')) with this prompt, verbatim: $prompt"
else
  tool="image_gen"
  ask="Call image_gen exactly once with aspect_ratio $aspect and this prompt, verbatim: $prompt"
fi

(cd "$workdir" && grok -p "$ask" --session-id "$sid" \
  --tools "$tool,search_tool" --allow "$tool" --allow search_tool \
  --permission-mode dontAsk --disable-web-search --no-subagents --output-format plain >&2)

shopt -s nullglob
found=("$HOME"/.grok/sessions/*/"$sid"/images/*)
[[ ${#found[@]} -gt 0 ]] || { echo "grok produced no image (session $sid)" >&2; exit 1; }
mkdir -p "$(dirname "$out")"
cp "${found[-1]}" "$out"
rm -rf "$workdir"
echo "$out"
