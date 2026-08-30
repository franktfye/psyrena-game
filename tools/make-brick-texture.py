#!/usr/bin/env python3
"""Generate a provably seamless running-bond brick albedo.

Why generated rather than AI-authored: an image model produces a convincing
brick *look* but cannot guarantee that the right edge continues into the left
edge. A wall texture is repeated dozens of times across a facade, so any wrap
discontinuity becomes a visible grid — the one defect that is fatal for a tiling
texture and invisible when you inspect a single tile.

Here seamlessness is structural, not checked after the fact: every feature size
divides the image size exactly, so the pattern's period tiles the canvas a whole
number of times. The half-brick stagger repeats every 2 courses, so the vertical
period is 2*COURSE_H, which must also divide SIZE.

Per-brick tonal variation comes from a seeded PRNG, so the texture is
byte-identical on every run and a regenerated asset does not show up as a diff.

Usage: make-brick-texture.py <out.png> [--size 2048]
"""

from __future__ import annotations

import argparse

import numpy as np
from PIL import Image

SIZE = 2048

# Feature sizes in pixels. Every one of these MUST divide SIZE, and 2*COURSE_H
# must divide SIZE too (the stagger's vertical period). At the 2 m tile the
# scene uses, this puts bricks at 0.25 m x 0.0625 m — real brick proportions.
BRICK_W = 256   # 2048 / 256 = 8 bricks per course
COURSE_H = 64   # 2048 / 64  = 32 courses; stagger period 128 -> 16 repeats
MORTAR = 6      # joint thickness

# Muted charcoal-brown, from the V2 sheet. Deliberately low-contrast: this sits
# behind neon signage and must not compete with it.
#
# Brightness is a considered value, not a default. PALETTE.shell is 0.045 linear
# — so dark that an untextured facade reads as a black slab. Brick at these
# values lands near 0.10 linear, roughly twice the pavement, which is enough for
# the courses and joints to be legible at plaza distance while still letting the
# emissive storefronts dominate the frame, which is the colour script's whole
# point (see the palette note in core/palette.ts).
BRICK_RGB = np.array([92, 78, 72], dtype=np.float32)
MORTAR_RGB = np.array([50, 46, 48], dtype=np.float32)
BRICK_JITTER = 13.0  # +/- per-brick tonal spread


def build(size: int) -> np.ndarray:
    for name, val in (("BRICK_W", BRICK_W), ("COURSE_H", COURSE_H), ("stagger", 2 * COURSE_H)):
        if size % val:
            raise SystemExit(f"{name}={val} does not divide size={size}; tile would seam")

    rng = np.random.default_rng(20260730)

    ys, xs = np.mgrid[0:size, 0:size]
    course = ys // COURSE_H

    # Running bond: every other course shifts by half a brick. Because the shift
    # is exactly BRICK_W/2 and BRICK_W divides size, the shifted course still
    # tiles horizontally.
    shift = (course % 2) * (BRICK_W // 2)
    bx = ((xs + shift) % size) // BRICK_W

    # Per-brick tone, indexed by (course, brick) so a brick is one flat colour.
    tone = rng.uniform(-BRICK_JITTER, BRICK_JITTER, size=(size // COURSE_H, size // BRICK_W))
    img = BRICK_RGB[None, None, :] + tone[course, bx][:, :, None]

    # Mortar joints. Modulo arithmetic on the shifted x means the vertical joints
    # wrap correctly; horizontal joints wrap because COURSE_H divides size.
    in_head_joint = ((xs + shift) % BRICK_W) < MORTAR
    in_bed_joint = (ys % COURSE_H) < MORTAR
    img[in_head_joint | in_bed_joint] = MORTAR_RGB

    return np.clip(img, 0, 255).astype(np.uint8)


def wrap_report(a: np.ndarray) -> None:
    """Prove the tile is seamless.

    Subtlety worth stating, because the naive test gives a false positive here:
    you cannot simply require the wrap delta to be SMALL. This pattern begins
    with a mortar joint at x=0 and ends mid-brick at x=size-1, so the wrap delta
    is legitimately large — a real joint lands on the tile boundary. That tiles
    perfectly; it just is not smooth.

    The meaningful question is whether the boundary transition looks like the
    equivalent transition inside the tile. So compare the wrap against the
    matching interior joint (brick->mortar at the next brick/course edge). If
    they agree, the seam is indistinguishable from any other joint on the wall.
    """
    f = a.astype(np.float32)

    h_wrap = np.abs(f[:, -1] - f[:, 0]).mean()
    h_ref = np.abs(f[:, BRICK_W - 1] - f[:, BRICK_W]).mean()
    v_wrap = np.abs(f[-1, :] - f[0, :]).mean()
    v_ref = np.abs(f[COURSE_H - 1, :] - f[COURSE_H, :]).mean()

    print(f"  horizontal wrap {h_wrap:.3f} vs equivalent interior joint {h_ref:.3f}")
    print(f"  vertical   wrap {v_wrap:.3f} vs equivalent interior joint {v_ref:.3f}")

    # Generous tolerance: per-brick tone jitter means two joints never match
    # exactly. A true seam is off by an order of magnitude, not by 40%.
    if h_wrap > h_ref * 1.6 + 2 or v_wrap > v_ref * 1.6 + 2:
        raise SystemExit("SEAM DETECTED — refusing to emit a seaming wall texture")
    print("  seamless OK — boundary matches interior joints")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=SIZE)
    args = ap.parse_args()

    arr = build(args.size)
    wrap_report(arr)
    Image.fromarray(arr).save(args.out)
    print(f"  wrote {args.out} {args.size}x{args.size}")


if __name__ == "__main__":
    main()
