#!/usr/bin/env python3
"""Generate a low-RAM equirectangular starfield for the boss-arena void sky.

Procedural on purpose: no third-party asset, byte-stable (fixed seed table),
and small enough that a 512×256 KTX2 is a few dozen KB on disk / GPU.

Usage: gen-stars-sky.py [out.png]
"""

from __future__ import annotations

import math
import struct
import sys
import zlib

W, H = 512, 256  # equirect — plenty for a star field looked at through fog

# Deterministic pseudo-random (no import random — reproducible asset).
def _hash(i: int) -> float:
    x = (i * 1103515245 + 12345) & 0x7FFFFFFF
    return x / 0x7FFFFFFF


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "public/env/stars.png"
    # RGB buffer, black void base.
    buf = bytearray(W * H * 3)

    def put(x: int, y: int, r: int, g: int, b: int, a: float = 1.0) -> None:
        if x < 0 or x >= W or y < 0 or y >= H:
            return
        i = (y * W + x) * 3
        buf[i] = min(255, int(buf[i] * (1 - a) + r * a))
        buf[i + 1] = min(255, int(buf[i + 1] * (1 - a) + g * a))
        buf[i + 2] = min(255, int(buf[i + 2] * (1 - a) + b * a))

    # Soft milky-band haze (cheap depth, not a texture).
    for y in range(H):
        v = (y + 0.5) / H
        el = (0.5 - v) * math.pi  # +pi/2 zenith … -pi/2 nadir
        for x in range(W):
            u = (x + 0.5) / W
            az = u * 2 * math.pi
            # Band around a tilted great-circle.
            band = math.sin(az * 1.0 + 0.7) * 0.55 + math.cos(el * 2.0) * 0.35
            glow = max(0.0, 0.045 * (1.0 - abs(band) * 1.6))
            if glow <= 0:
                continue
            i = (y * W + x) * 3
            buf[i] = min(255, buf[i] + int(18 * glow))
            buf[i + 1] = min(255, buf[i + 1] + int(22 * glow))
            buf[i + 2] = min(255, buf[i + 2] + int(40 * glow))

    # Stars — many tiny, few bright. Azimuth-periodic by construction (x wraps).
    n_stars = 1400
    for s in range(n_stars):
        x = int(_hash(s * 3 + 1) * W) % W
        y = int(_hash(s * 3 + 2) * H) % H
        # Bias slightly away from pure nadir (void under the rock stays darker).
        if y > int(H * 0.92) and _hash(s * 7) > 0.35:
            continue
        bright = _hash(s * 3 + 3)
        # Power curve: mostly dim, rare bright.
        b = bright ** 2.4
        size = 1 if b < 0.55 else (2 if b < 0.85 else 3)
        # Cool white → faint violet/cyan tint (matches arena palette).
        tint = _hash(s * 5 + 9)
        if tint < 0.15:
            col = (180, 200, 255)
        elif tint < 0.30:
            col = (220, 180, 255)
        else:
            col = (230, 235, 255)
        intensity = 0.35 + 0.65 * b
        r = int(col[0] * intensity)
        g = int(col[1] * intensity)
        bl = int(col[2] * intensity)
        put(x, y, r, g, bl, 1.0)
        if size >= 2:
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                put((x + dx) % W, y + dy, r, g, bl, 0.45)
        if size >= 3:
            for dx, dy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                put((x + dx) % W, y + dy, r, g, bl, 0.25)
            # Soft cross flare on the brightest few.
            put((x + 2) % W, y, r, g, bl, 0.2)
            put((x - 2) % W, y, r, g, bl, 0.2)
            put(x, y + 2, r, g, bl, 0.2)
            put(x, y - 2, r, g, bl, 0.2)

    # Write a tiny unfiltered PNG (no deps).
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(
            ">I", zlib.crc32(tag + data) & 0xFFFFFFFF
        )

    raw = b"".join(b"\x00" + bytes(buf[y * W * 3 : (y + 1) * W * 3]) for y in range(H))
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(out, "wb") as f:
        f.write(png)
    print(f"wrote {out}  {W}x{H}  {len(png) // 1024} KB")


if __name__ == "__main__":
    main()
