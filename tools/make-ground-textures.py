#!/usr/bin/env python3
"""Generate provably seamless ground albedos: plaza paving and asphalt road.

Same reasoning as `make-brick-texture.py`: a ground texture tiles across a 60 m
plaza, so any wrap discontinuity becomes a visible grid. Seamlessness is
structural here rather than checked by eye —

  * grid patterns (paving) use feature sizes that divide the image size, so the
    period tiles a whole number of times;
  * organic variation uses a sum of sinusoids at INTEGER frequencies, which is
    periodic over the image by construction. Ordinary per-pixel or Perlin noise
    would not wrap, and blurring the edges to fake it softens the whole texture.

Usage: make-ground-textures.py <outdir> [--size 2048]
Writes paving_albedo_src.png and road_albedo_src.png.
"""

from __future__ import annotations

import argparse
import pathlib

import numpy as np
from PIL import Image

# --- Paving: pale stone slabs, matching the plaza in V3 -----------------------
# SLAB must divide SIZE. At the 4 m tile the scene uses this gives 1 m slabs.
SLAB = 512
SLAB_JOINT = 7
PAVING_RGB = np.array([124, 126, 132], dtype=np.float32)
PAVING_JOINT_RGB = np.array([86, 88, 95], dtype=np.float32)
PAVING_JITTER = 7.0

# --- Road: dark asphalt ------------------------------------------------------
ROAD_RGB = np.array([64, 65, 70], dtype=np.float32)
# Mottling amplitude. Was 9.0, which at the plaza's 4 m tile produced dark
# blotches that read as stains rather than as asphalt — the low octaves of the
# periodic noise are broad, so a large amplitude paints metre-wide patches. 2.5
# keeps the tonal break-up that stops the ring looking like flat vinyl, without
# any patch being readable as a shape.
ROAD_GRAIN = 2.5


def periodic_noise(size: int, rng: np.random.Generator, octaves=(2, 4, 8, 16)) -> np.ndarray:
    """Smooth noise in [-1,1] that tiles exactly.

    Built from sinusoids whose frequencies are whole numbers of cycles across
    the image, so f(0) == f(size) on both axes for every term — the sum is
    therefore periodic and the texture wraps with no seam.
    """
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    u, v = xs / size * 2 * np.pi, ys / size * 2 * np.pi
    out = np.zeros((size, size), dtype=np.float32)
    amp_total = 0.0
    for f in octaves:
        amp = 1.0 / f
        for _ in range(2):  # two random-phase terms per octave, decorrelated
            px, py = rng.uniform(0, 2 * np.pi, 2)
            fx, fy = rng.integers(1, f + 1, 2)  # integer cycles => periodic
            out += amp * np.sin(fx * u + px) * np.cos(fy * v + py)
            amp_total += amp
    return out / max(amp_total, 1e-6)


def build_paving(size: int, rng: np.random.Generator) -> np.ndarray:
    if size % SLAB:
        raise SystemExit(f"SLAB={SLAB} does not divide size={size}")
    ys, xs = np.mgrid[0:size, 0:size]
    sx, sy = xs // SLAB, ys // SLAB

    tone = rng.uniform(-PAVING_JITTER, PAVING_JITTER, size=(size // SLAB, size // SLAB))
    img = PAVING_RGB[None, None, :] + tone[sy, sx][:, :, None]
    # Gentle mottling so a 30x30 repeat does not read as a checkerboard.
    img += (periodic_noise(size, rng)[:, :, None] * 6.0)

    joint = ((xs % SLAB) < SLAB_JOINT) | ((ys % SLAB) < SLAB_JOINT)
    img[joint] = PAVING_JOINT_RGB
    return np.clip(img, 0, 255).astype(np.uint8)


def build_road(size: int, rng: np.random.Generator) -> np.ndarray:
    """Asphalt: smooth periodic mottling only — deliberately NO per-pixel grain.

    Adding white noise for "aggregate" is tempting and wrong twice over. It is
    incompressible, so the KTX2 ballooned to ~10x the other ground maps for
    detail invisible beyond arm's length; and `derive-pbr-maps.py` reads the
    albedo as a height field, so per-pixel noise becomes a chaotic normal map
    that glitters under specular like wet sandpaper. Smooth mottling gives the
    tonal variation asphalt needs without either problem.
    """
    base = ROAD_RGB[None, None, :] + periodic_noise(size, rng)[:, :, None] * ROAD_GRAIN
    return np.clip(base, 0, 255).astype(np.uint8)


def assert_seamless(a: np.ndarray, name: str) -> None:
    """Wrap delta must fall inside the range of ordinary interior deltas.

    Stated this way the test works for both pattern families: a paving joint
    landing on the boundary is fine because interior joints produce the same
    delta, while for asphalt the wrap delta is simply typical. Requiring the
    wrap to be SMALL would wrongly reject a joint on the seam.
    """
    f = a.astype(np.float32)
    h_wrap = np.abs(f[:, -1] - f[:, 0]).mean()
    v_wrap = np.abs(f[-1, :] - f[0, :]).mean()
    h_cols = np.abs(f[:, 1:] - f[:, :-1]).mean(axis=(0, 2))
    v_rows = np.abs(f[1:, :] - f[:-1, :]).mean(axis=(1, 2))
    print(f"  {name}: h wrap {h_wrap:.3f} (interior {h_cols.min():.3f}..{h_cols.max():.3f})")
    print(f"  {name}: v wrap {v_wrap:.3f} (interior {v_rows.min():.3f}..{v_rows.max():.3f})")
    if h_wrap > h_cols.max() + 1e-3 or v_wrap > v_rows.max() + 1e-3:
        raise SystemExit(f"SEAM DETECTED in {name} — refusing to emit")
    print(f"  {name}: seamless OK")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("--size", type=int, default=2048)
    args = ap.parse_args()

    out = pathlib.Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    for name, fn in (("paving", build_paving), ("road", build_road)):
        rng = np.random.default_rng(20260730)  # per-pattern, so output is stable
        arr = fn(args.size, rng)
        assert_seamless(arr, name)
        path = out / f"{name}_albedo_src.png"
        Image.fromarray(arr).save(path)
        print(f"  wrote {path} {args.size}x{args.size}\n")


if __name__ == "__main__":
    main()
