#!/usr/bin/env python3
"""Generate public/env/day.hdr — bright daylight IBL + visible sky for the hub.

Companion to gen-dusk-hdr.py, same RGBE writer and the same reason for being
procedural: no third-party asset in the repo, and the sky colours stay tied to
the palette.

Three jobs from one file, which is why it is worth the resolution:
  * IBL — PBR materials reflect nothing without `scene.environmentTexture`, and
    read plasticky.
  * SKYBOX — 360° blue sky + clouds above the floating hub.
  * SEA HORIZON — the lower hemisphere is open ocean (not dirt), so looking past
    the island edge reads as water under sky with zero extra textures.

Clouds wrap correctly in azimuth because every cloud term uses an INTEGER number
of cycles around the sphere; a non-integer frequency would leave a visible seam
running down the sky where az wraps at +/-pi.

1024x512 equirectangular. Larger than dusk.hdr's 512x256 because a skybox is
looked AT, whereas a pure-IBL probe only needs colour and gradient.

Usage: gen-day-hdr.py [out.hdr]
"""

import math
import struct
import sys

W, H = 1024, 512

# Sun placement. Mirrors the key light in villageHub.ts: a light travelling in
# direction d appears to come FROM -d, so the disc sits opposite the vector the
# scene uses. Keep these in step if the key light moves.
KEY_DIR = (0.38, -0.90, -0.22)
SUN_VEC = (-KEY_DIR[0], -KEY_DIR[1], -KEY_DIR[2])
SUN_AZ = math.atan2(SUN_VEC[0], SUN_VEC[2])
SUN_EL = math.asin(SUN_VEC[1] / math.sqrt(sum(c * c for c in SUN_VEC)))

# Deterministic phases: a fixed table rather than an RNG so the asset is
# byte-identical on every run and does not show up as a spurious diff.
PHASES = [0.7, 2.1, 4.4, 5.9, 1.3, 3.6]
# (az cycles, el cycles) per octave. Both MUST be integers so every term
# closes on itself at the azimuth wrap; mismatched pairs decorrelate the
# two axes so clouds do not line up in rows.
CLOUD_FREQ = [(2, 3), (3, 5), (5, 4), (8, 11), (13, 7), (21, 17)]


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def _fbm(az, el):
    """Sum of integer-frequency terms; periodic in azimuth by construction."""
    v, total = 0.0, 0.0
    for i, (nx, ny) in enumerate(CLOUD_FREQ):
        amp = 1.0 / (i + 1.4)
        # Adding the two products (rather than taking one) breaks up the
        # rectangular lattice that a single sin(x)*cos(y) term always forms —
        # separable products have axis-aligned zero crossings, which read as
        # boxy clouds.
        v += amp * (
            math.sin(nx * az + PHASES[i]) * math.cos(ny * el * 2.0 + PHASES[(i + 3) % 6])
            + math.cos(ny * az + PHASES[(i + 1) % 6]) * math.sin(nx * el * 1.7 + PHASES[(i + 4) % 6])
        ) * 0.5
        total += amp
    return v / total


def cloud_field(az, el):
    """Puffy cumulus coverage in [0,1], periodic in azimuth."""
    # Domain warp: displace the lookup by a low-frequency copy of itself. This
    # is what turns regular interference into irregular, billowing shapes.
    wx = _fbm(az * 0.5 + 1.1, el * 0.5) * 0.55
    wy = _fbm(az * 0.5 + 3.7, el * 0.5 + 2.2) * 0.35
    n = _fbm(az + wx, el + wy)  # -1..1

    # Threshold into distinct puffs rather than a smooth haze.
    cover = smooth(0.02, 0.40, n)
    # Thin out toward the zenith and fade into horizon haze, so the band of
    # cloud sits where cloud actually reads from ground level.
    cover *= smooth(0.02, 0.35, el) * smooth(1.45, 0.75, el)
    return cover


def sea_field(az, el):
    """Subtle wave shimmer for the ocean hemisphere. Periodic in azimuth."""
    # Low-frequency swell — integer az cycles so the equirect seam is invisible.
    s = (
        math.sin(3 * az + 0.4) * math.cos(5 * el * 2.2 + 1.1)
        + math.cos(5 * az + 2.0) * math.sin(3 * el * 1.8 + 0.7)
        + 0.45 * math.sin(8 * az + 4.2) * math.cos(7 * el * 2.5)
    ) * 0.5
    return 0.5 + 0.5 * s  # 0..1


def pixel(u, v):
    az = u * 2 * math.pi - math.pi
    el = (0.5 - v) * math.pi
    d_sun = math.atan2(math.sin(az - SUN_AZ), math.cos(az - SUN_AZ))

    # Floating-island hub: the lower hemisphere is OCEAN, not dirt. The plaza
    # sits above the sea; this band is what the player sees past the block edge
    # and what PBR undersides bounce from. Keep it bright enough to fill.
    if el <= 0.02:
        # Near-horizon sea is sun-glanced and pale; nadir is deep teal.
        depth = smooth(0.02, -0.85, el)
        wave = sea_field(az, el)
        # Deep ocean → sunlit shallows at the horizon band.
        deep = (0.02, 0.10, 0.22)
        mid = (0.05, 0.28, 0.42)
        rim = (0.42, 0.62, 0.78)  # haze meeting the sky
        base = tuple(
            deep[i] * depth + mid[i] * (1 - depth) * 0.55 + rim[i] * (1 - depth) * 0.45
            for i in range(3)
        )
        # Specular glitter tracks the sun azimuth across the water.
        glitter = smooth(1.1, 0.0, abs(d_sun)) * smooth(0.35, -0.05, el) * (0.35 + 0.65 * wave)
        r = base[0] + 0.55 * glitter + 0.04 * wave
        g = base[1] + 0.48 * glitter + 0.03 * wave
        b = base[2] + 0.40 * glitter + 0.06 * wave
        # Soft sun path on the water (not a hard disc — that lives in the sky).
        path = smooth(0.55, 0.0, abs(d_sun)) * smooth(0.25, -0.02, el) ** 1.4
        r += 1.8 * path
        g += 1.4 * path
        b += 0.7 * path
        return r, g, b

    # Rayleigh-ish gradient: saturated blue overhead easing to pale haze.
    t = smooth(0.0, 1.25, el)
    r = 0.62 * (1 - t) + 0.16 * t
    g = 0.74 * (1 - t) + 0.34 * t
    b = 0.92 * (1 - t) + 0.78 * t

    # Broad warm glow around the sun, then the disc itself.
    halo = smooth(1.5, 0.0, abs(d_sun)) * smooth(1.3, 0.0, abs(el - SUN_EL))
    r += 0.55 * halo ** 2.0
    g += 0.42 * halo ** 2.2
    b += 0.22 * halo ** 2.6

    ang = math.acos(max(-1.0, min(1.0, math.cos(el) * math.cos(SUN_EL) * math.cos(d_sun)
                                  + math.sin(el) * math.sin(SUN_EL))))
    disc = smooth(0.055, 0.015, ang)
    r += 46.0 * disc
    g += 42.0 * disc
    b += 34.0 * disc

    # Clouds: bright, slightly warm on the sunward side, cooler in shadow.
    c = cloud_field(az, el)
    if c > 0.0:
        lit = 0.5 + 0.5 * smooth(2.4, 0.0, abs(d_sun))
        cr = 1.05 + 0.55 * lit
        cg = 1.05 + 0.52 * lit
        cb = 1.08 + 0.42 * lit
        r = r * (1 - c) + cr * c
        g = g * (1 - c) + cg * c
        b = b * (1 - c) + cb * c

    return r, g, b


def rgbe(r, g, b):
    m = max(r, g, b)
    if m < 1e-9:
        return b"\x00\x00\x00\x00"
    e = math.frexp(m)[1]
    scale = 256.0 / 2 ** e
    return struct.pack(
        "4B",
        min(255, int(r * scale)),
        min(255, int(g * scale)),
        min(255, int(b * scale)),
        e + 128,
    )


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "public/env/day.hdr"
    rows = []
    for y in range(H):
        v = (y + 0.5) / H
        rows.append(b"".join(rgbe(*pixel((x + 0.5) / W, v)) for x in range(W)))

    with open(out, "wb") as f:
        f.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n")
        f.write(f"-Y {H} +X {W}\n".encode())
        f.write(b"".join(rows))
    print(f"wrote {out}  {W}x{H}  {W * H * 4 // 1024} KB")


if __name__ == "__main__":
    main()
