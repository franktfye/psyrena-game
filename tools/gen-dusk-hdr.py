"""Generate public/env/dusk.hdr — the procedural dusk IBL for the village hub.

Why procedural: PBR materials without an environment texture reflect nothing
and read flat/plasticky. A real captured HDR would do, but this keeps the
repo free of third-party assets, matches the locked palette exactly, and
weighs ~35 KB. Babylon prefilters it at load (HDRCubeTexture prefilterOnLoad).

Layout: 512x256 equirectangular, RGBE (Radiance .hdr), flat scanlines —
Babylon's parser falls back to non-RLE reading automatically.

Light logic mirrors src/scenes/villageHub.ts:
- warm sunset lobe at the key light's azimuth (key dir (0.55,-0.85,-0.35)
  => sun sits toward (-0.55, 0.35) in xz)
- cool blue-gray zenith (the ambient's sky color)
- faint cyan + magenta smudges near the horizon (storefront holo glow)
- near-black ground hemisphere with a warm bounce under the sunset side
"""
import math, struct, os

W, H = 512, 256
SUN_AZ = math.atan2(-0.55, 0.35)  # azimuth of the light SOURCE

def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

def pixel(u, v):
    az = u * 2 * math.pi - math.pi
    el = (0.5 - v) * math.pi          # +pi/2 zenith .. -pi/2 nadir
    d_sun = math.atan2(math.sin(az - SUN_AZ), math.cos(az - SUN_AZ))

    # Sky gradient: zenith blue-gray -> horizon haze
    horiz = smooth(0.9, 0.0, abs(el))
    r = 0.055 + 0.16 * horiz
    g = 0.070 + 0.16 * horiz
    b = 0.120 + 0.18 * horiz

    if el > -0.02:
        # Warm sunset lobe, widest at the horizon
        lobe = smooth(2.2, 0.0, abs(d_sun)) * smooth(0.55, 0.02, abs(el))
        r += 2.6 * lobe ** 2.2
        g += 1.1 * lobe ** 2.6
        b += 0.25 * lobe ** 3.0
        # Storefront holo smudges: cyan opposite the sun, magenta in between
        cy = smooth(1.6, 0.2, abs(abs(d_sun) - math.pi)) * smooth(0.35, 0.02, abs(el))
        r += 0.10 * cy; g += 0.55 * cy; b += 0.75 * cy
        mg = smooth(1.2, 0.1, abs(abs(d_sun) - math.pi / 2)) * smooth(0.25, 0.02, abs(el))
        r += 0.45 * mg; g += 0.08 * mg; b += 0.40 * mg
    else:
        # Ground: dark pavement with a hint of the sunset bounced back
        k = smooth(0.0, -0.6, el)
        warm = smooth(2.0, 0.0, abs(d_sun))
        r = r * (1 - k) + (0.030 + 0.05 * warm) * k
        g = g * (1 - k) + (0.028 + 0.02 * warm) * k
        b = b * (1 - k) + 0.034 * k
    return r, g, b

def rgbe(r, g, b):
    m = max(r, g, b)
    if m < 1e-9:
        return b"\x00\x00\x00\x00"
    e = math.frexp(m)[1]           # m = f * 2**e, f in [0.5,1)
    scale = (256.0 / 2 ** e)
    return struct.pack("4B", min(255, int(r * scale)), min(255, int(g * scale)),
                       min(255, int(b * scale)), e + 128)

rows = []
for y in range(H):
    v = (y + 0.5) / H
    row = b"".join(rgbe(*pixel((x + 0.5) / W, v)) for x in range(W))
    rows.append(row)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "env", "dusk.hdr")
with open(out, "wb") as f:
    f.write(b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n")
    f.write(f"-Y {H} +X {W}\n".encode())
    f.write(b"".join(rows))
print("wrote", out, W * H * 4 // 1024, "KB raw")
