#!/usr/bin/env python3
"""Crossfade the left/right edges of equirect sky panoramas so the 0°/360° join
is seamless. Run after regenerating village_sky / void_sky masters:

  python3 tools/seam-blend-sky.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "assets" / "work" / "env"
OUT = ROOT / "public" / "env"
BLEND_PX = 64


def seam_blend(src: Path, dst: Path, blend_px: int = BLEND_PX) -> None:
    im = Image.open(src).convert("RGB")
    a = np.array(im, dtype=np.float32)
    h, w, _ = a.shape
    b = min(blend_px, w // 8)
    out = a.copy()

    for i in range(b):
        t = (i + 0.5) / b
        t = t * t * (3 - 2 * t)  # smoothstep
        src_r = a[:, w - b + i]
        src_l = a[:, i]
        avg = 0.5 * (src_l + src_r)
        out[:, i] = src_l * t + avg * (1 - t)
        j = w - 1 - i
        src_l2 = a[:, b - 1 - i]
        src_r2 = a[:, j]
        avg2 = 0.5 * (src_l2 + src_r2)
        out[:, j] = src_r2 * t + avg2 * (1 - t)

    edge = 0.5 * (out[:, 0] + out[:, -1])
    out[:, 0] = edge
    out[:, -1] = edge

    ker = np.array([0.15, 0.2, 0.3, 0.2, 0.15], dtype=np.float32)

    def blur_band(cols: list[int]) -> None:
        for c in cols:
            acc = np.zeros((h, 3), dtype=np.float32)
            for k, wgt in enumerate(ker):
                acc += out[:, (c + k - 2) % w] * wgt
            out[:, c] = acc

    blur_band(list(range(0, b)))
    blur_band(list(range(w - b, w)))
    edge = 0.5 * (out[:, 0] + out[:, -1])
    out[:, 0] = edge
    out[:, -1] = edge

    result = np.clip(out, 0, 255).astype(np.uint8)
    dst.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(result).save(dst, optimize=True)
    d = np.abs(result[:, 0].astype(np.float32) - result[:, -1].astype(np.float32)).mean()
    print(f"wrote {dst.relative_to(ROOT)}  {w}x{h}  mean|L-R|={d:.3f}")


def main() -> None:
    for name in ("village_sky", "void_sky"):
        jpg = WORK / f"{name}_master.jpg"
        master = WORK / f"{name}_pre_seam.png"
        if jpg.exists():
            im = Image.open(jpg).convert("RGB")
            im = im.resize((1024, 512), Image.Resampling.LANCZOS)
            im.save(master)
        elif not master.exists():
            src = OUT / f"{name}.png"
            if not src.exists():
                print(f"skip {name}: no master")
                continue
            Image.open(src).save(master)
        seam_blend(master, OUT / f"{name}.png")


if __name__ == "__main__":
    main()
