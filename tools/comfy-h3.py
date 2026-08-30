#!/usr/bin/env python3
"""MiniMax H3 image-to-video on Comfy Cloud.

Builds the flattened API-format graph from the "MiniMax H3: Image to Video"
template (first/last-frame fl2va, native audio) and runs it via comfy-sdk.
Key: ~/.comfyui.api.env (export COMFY_API_KEY=...).

  python3 tools/comfy-h3.py --prompt-file p.txt --first start.png \
      [--last end.png] --duration 15 --out clip.mp4
"""

import argparse
import os
import re
import sys
from pathlib import Path

from comfy_sdk import Comfy


def load_key() -> str:
    text = (Path.home() / ".comfyui.api.env").read_text()
    m = re.search(r"COMFY_API_KEY=([^\s\"']+)", text)
    if not m:
        sys.exit("COMFY_API_KEY not found in ~/.comfyui.api.env")
    return m.group(1)


def snap_length(seconds: float) -> int:
    # H3 frame grid: 17k+5 at 24fps, minimum 5 frames
    n = max(5, round(seconds * 24))
    return n + (5 - (n % 17)) % 17


def build_graph(prompt: str, width: int, height: int, length: int, seed: int,
                has_last: bool) -> dict:
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "4": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "5": {"class_type": "LoadImage", "inputs": {"image": "first.png"}},
        "7": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "first_frame": ["5", 0],
            "prompt": prompt, "width": width, "height": height, "length": length}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "10": {"class_type": "BasicScheduler", "inputs": {
            "model": ["1", 0], "scheduler": "simple", "steps": 20, "denoise": 1.0}},
        "11": {"class_type": "BasicGuider", "inputs": {
            "model": ["1", 0], "conditioning": ["7", 0]}},
        "12": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["8", 0], "guider": ["11", 0], "sampler": ["9", 0],
            "sigmas": ["10", 0], "latent_image": ["7", 1]}},
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["3", 0]}},
        "14": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["12", 0], "vae": ["4", 0]}},
        "15": {"class_type": "CreateVideo", "inputs": {
            "images": ["13", 0], "audio": ["14", 0], "fps": 24}},
        "16": {"class_type": "SaveVideo", "inputs": {
            "video": ["15", 0], "filename_prefix": "video/psyrena_h3",
            "format": "auto", "codec": "auto"}},
    }
    if has_last:
        g["6"] = {"class_type": "LoadImage", "inputs": {"image": "last.png"}}
        g["7"]["inputs"]["last_frame"] = ["6", 0]
    return g


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--first", required=True)
    ap.add_argument("--last")
    ap.add_argument("--duration", type=float, default=15)
    ap.add_argument("--width", type=int, default=1344)
    ap.add_argument("--height", type=int, default=768)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    prompt = Path(args.prompt_file).read_text()
    length = snap_length(args.duration)
    print(f"length {length} frames ({length / 24:.2f}s)")

    client = Comfy(api_key=load_key())
    wf = client.workflows.from_json(
        build_graph(prompt, args.width, args.height, length, args.seed,
                    has_last=bool(args.last)))
    wf.set_input("5", "image", client.assets.from_file(args.first))
    if args.last:
        wf.set_input("6", "image", client.assets.from_file(args.last))

    job = client.run(wf)
    print(f"job {getattr(job, 'id', '?')} state {getattr(job, 'state', '?')}")
    outs = job.outputs
    if not outs:
        sys.exit(f"no outputs; job: {job!r}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    outs[0].to_file(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
