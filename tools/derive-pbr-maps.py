#!/usr/bin/env python3
"""Derive tangent-space normal + packed ORM maps from a tiling albedo PNG.

Why this exists: an image generator produces a convincing *albedo*, but a PBR
material also needs a normal map and an occlusion/roughness/metallic pack, and
generators cannot make those directly — a "normal map" drawn as a picture is
just a blue image with no valid surface encoding. For an architectural tiling
texture the albedo's own luminance is a good height proxy (recessed mortar reads
darker than the brick face), so the maps can be derived rather than authored.

Everything here is wrap-aware (`np.roll`): the gradients wrap across the image
edges, so a seamless albedo yields a seamless normal map. Deriving with a
non-wrapping filter would put a visible seam ridge on every tile boundary.

Usage:
  derive-pbr-maps.py <albedo.png> <outdir> <basename> [--strength 2.0]

Writes <basename>_albedo.png, _normal.png, _orm.png — sizes matched to input.
"""

from __future__ import annotations

import argparse
import pathlib

import numpy as np
from PIL import Image

# Rec. 709 luma. Brick and mortar differ mostly in value, not hue, so luma is a
# better height proxy here than any single channel.
LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# Roughness range. Fired brick is matte but not chalky; mortar is rougher still.
ROUGH_BRICK = 0.82
ROUGH_MORTAR = 0.94

# How much darker-than-average pixels are treated as occluded. Kept mild: baking
# heavy AO into a tiling texture makes every repeat visibly identical.
AO_STRENGTH = 0.35


def _luma(rgb: np.ndarray) -> np.ndarray:
    return (rgb * LUMA).sum(axis=2)


def normal_from_height(height: np.ndarray, strength: float) -> np.ndarray:
    """Sobel-style central differences, wrapping at the edges."""
    # np.roll wraps, which is exactly the tiling behaviour we need.
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5

    # Tangent-space normal: X across, Y up, Z out of the surface. dy is negated
    # because image rows increase downward while the green channel points up
    # (OpenGL convention — Babylon's default, matching the "NormalGL" maps tripo
    # already ships for the props).
    nx = -dx * strength
    ny = dy * strength
    nz = np.ones_like(height)

    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / length, ny / length, nz / length

    # [-1,1] -> [0,1]
    return np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5], axis=2)


def orm_from_height(height: np.ndarray) -> np.ndarray:
    """Occlusion (R) / roughness (G) / metallic (B), linear."""
    # Normalise height to 0..1 so the split is relative to this texture's own
    # contrast rather than an absolute grey level.
    lo, hi = float(height.min()), float(height.max())
    norm = (height - lo) / (hi - lo) if hi > lo else np.zeros_like(height)

    occlusion = 1.0 - (1.0 - norm) * AO_STRENGTH
    # Darker (recessed mortar) -> rougher.
    roughness = ROUGH_MORTAR + (ROUGH_BRICK - ROUGH_MORTAR) * norm
    metallic = np.zeros_like(height)  # brick is a dielectric, always.

    return np.stack([occlusion, roughness, metallic], axis=2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("albedo")
    ap.add_argument("outdir")
    ap.add_argument("basename")
    ap.add_argument("--strength", type=float, default=2.0)
    args = ap.parse_args()

    out = pathlib.Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    src = Image.open(args.albedo).convert("RGB")
    rgb = np.asarray(src, dtype=np.float32) / 255.0
    height = _luma(rgb)

    normal = normal_from_height(height, args.strength)
    orm = orm_from_height(height)

    def save(arr: np.ndarray, suffix: str) -> None:
        img = Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8))
        path = out / f"{args.basename}_{suffix}.png"
        img.save(path)
        print(f"{path}  {img.size[0]}x{img.size[1]}")

    src.save(out / f"{args.basename}_albedo.png")
    print(f"{out / f'{args.basename}_albedo.png'}  {src.size[0]}x{src.size[1]}")
    save(normal, "normal")
    save(orm, "orm")


if __name__ == "__main__":
    main()
