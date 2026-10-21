"""
Grade voice takes: median F0, a jitter proxy, duration, and a Whisper transcript.

    python tools/voice-qa.py take1.wav take2.wav ... [--expect "text" ...]

Runs where librosa + transformers + a GPU live (gpu-box, vllm-omni venv:
`~/vllm-omni/.venv/bin/python`). Prints one JSON object per file.

- median F0: librosa.pyin over 60-400 Hz, voiced frames only. The register
  check when rolling a designed voice (see the hero voice READMEs).
- jitter proxy: median |ΔF0| / F0 between consecutive voiced frames, in
  percent. Calibrated 2026-10-18 on the shipped packs: Pavlov's and Skinner's
  references and a Freud line all read 1.2-2.0%. Treat ~5%+ as a degenerate
  roll (creak, warble). Not the same scale as the older packs' frame proxy.
- transcript: Whisper large-v3-turbo, English. Catches a take that garbles a word
  or reads its "(instruction)" prefix aloud.

`--expect` takes one string per file, in order; the output then carries a
word-level match ratio against it.
"""
import argparse
import difflib
import json
import re
import sys

import librosa
import numpy as np

WHISPER = "openai/whisper-large-v3-turbo"  # downloaded once into the HF cache


def words(s: str) -> list[str]:
    return re.findall(r"[a-z']+", s.lower())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--expect", nargs="*", default=[])
    args = ap.parse_args()

    from transformers import pipeline

    asr = pipeline("automatic-speech-recognition", model=WHISPER, device=0)
    for i, path in enumerate(args.files):
        y, sr = librosa.load(path, sr=16000, mono=True)
        f0, voiced, _ = librosa.pyin(y, fmin=60, fmax=400, sr=sr)
        f0 = f0[voiced & ~np.isnan(f0)]
        jitter = float(np.median(np.abs(np.diff(f0)) / f0[1:]) * 100) if len(f0) > 2 else None
        text = asr({"raw": y, "sampling_rate": sr}, generate_kwargs={"language": "en"})["text"].strip()
        out = {
            "file": path.split("/")[-1],
            "dur_s": round(len(y) / sr, 2),
            "f0_hz": round(float(np.median(f0)), 1) if len(f0) else None,
            "jitter_pct": round(jitter, 2) if jitter is not None else None,
            "text": text,
        }
        if i < len(args.expect):
            out["match"] = round(difflib.SequenceMatcher(None, words(args.expect[i]), words(text)).ratio(), 2)
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    sys.exit(main())
