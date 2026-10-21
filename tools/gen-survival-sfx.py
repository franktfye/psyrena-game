"""Generate the Dream Siege SFX with Stable Audio Open (vLLM-Omni) on spark.

    scp tools/gen-survival-sfx.py assets/work/survival/sfx/sfx.tsv gpu-box:/tmp/svsfx/
    ssh gpu-box 'cd ~/vllm-omni && .venv/bin/python /tmp/svsfx/gen-survival-sfx.py /tmp/svsfx/sfx.tsv /tmp/svsfx/out'

One model load, every row of sfx.tsv (stem, seconds, prompt), seeded per stem
so a re-run reproduces the pack. Raw 44.1 kHz stereo wavs; trimming, fades,
loudness and the Opus encode happen on py2 (tools/ship-survival-sfx.sh).
Model: stabilityai/stable-audio-open-1.0 (Stability AI Community License).
"""
import sys
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

from vllm_omni.entrypoints.omni import Omni
from vllm_omni.inputs.data import OmniDiffusionSamplingParams
from vllm_omni.platforms import current_omni_platform

tsv, out = Path(sys.argv[1]), Path(sys.argv[2])
model = str(Path.home() / "LLMs/stable-audio-open-1.0")
# Optional: re-roll only some stems, N variants each (<stem>_v<k>.wav), to pick by ear or CLAP.
only = sys.argv[3].split(",") if len(sys.argv) > 3 else None
variants = int(sys.argv[4]) if len(sys.argv) > 4 else 1
out.mkdir(parents=True, exist_ok=True)
rows = [l.rstrip("\n").split("\t") for l in tsv.read_text().splitlines() if l.strip() and not l.startswith("#")]
omni = Omni(model=model)
jobs = [(stem, secs, prompt, k) for stem, secs, prompt in rows if not only or stem in only for k in range(variants)]
for stem, secs, prompt, k in jobs:
    dst = out / (f"{stem}.wav" if variants == 1 else f"{stem}_v{k}.wav")
    if dst.exists():
        print("skip", dst.name)
        continue
    seed = 1000 + zlib.crc32(stem.encode()) % 9000 + k * 7919
    params = OmniDiffusionSamplingParams(
        generator=torch.Generator(device=current_omni_platform.device_type).manual_seed(seed),
        guidance_scale=7.0, num_inference_steps=100, num_outputs_per_prompt=1, seed=seed,
    )
    # Generate a little longer than needed; the ship step trims to the onset.
    params.extra_args = {"audio_start_in_s": 0.0, "audio_end_in_s": max(1.0, float(secs) + 0.8)}
    res = omni.generate({"prompt": prompt + ", sound effect, isolated, high quality",
                         "negative_prompt": "music, speech, low quality, noise, distortion"}, params)
    o = res[0]
    o = getattr(o, "request_output", o)
    audio = o.multimodal_output.get("audio")
    if isinstance(audio, torch.Tensor):
        audio = audio.cpu().float().numpy()
    if audio.ndim == 3:
        audio = audio[0]
    sf.write(dst, audio.T if audio.ndim == 2 else audio, 44100)
    print("done", stem, flush=True)
