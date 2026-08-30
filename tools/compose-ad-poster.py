#!/usr/bin/env python3
"""Composite crisp advertising copy over a generated poster background.

Why the text is NOT generated with the artwork: diffusion models spell badly.
Ask one for a phone number and you get plausible-looking digits that are wrong,
kerning that drifts, and letterforms that dissolve at the small sizes a rooftop
hoarding is actually read at. Real poster design has always been artwork plus
typography as separate layers, and doing it that way here means the slogan and
the number are exactly what we intend, pin-sharp at any texture resolution.

The background prompt therefore asks for empty space top and bottom, and
negative-prompts text away, leaving clean plates for these layers.

Colours are pulled toward the hub's palette (holographic cyan / magenta on a
dark ground) so the boards read as part of the same world as the storefronts.

Usage:
  compose-ad-poster.py <bg.png> <out.png> --headline "..." --slogan "..."
                       --phone "..." --brand "..." [--accent cyan|magenta]
"""

from __future__ import annotations

import argparse

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BOLD = "/usr/share/fonts/liberation/LiberationSans-Bold.ttf"
REG = "/usr/share/fonts/liberation/LiberationSans-Regular.ttf"

ACCENTS = {
    "cyan": (120, 240, 255),
    "magenta": (255, 90, 200),
}


def fit_font(draw, text, path, target_w, start, min_size=14):
    """Largest size at which `text` still fits `target_w`."""
    size = start
    while size > min_size:
        f = ImageFont.truetype(path, size)
        if draw.textlength(text, font=f) <= target_w:
            return f
        size -= 2
    return ImageFont.truetype(path, min_size)


def glow_text(base, xy, text, font, fill, anchor="mm", glow=(0, 0, 0), radius=10):
    """Draw text twice: a blurred copy underneath, then the crisp glyphs.

    The blurred pass is what sells it as an emissive sign rather than a sticker.
    The scene's bloom only reacts to what is already bright, so a hard-edged
    glyph on a dark plate reads as printed; a soft halo behind it reads as lit.
    """
    layer = Image.new("RGB", base.size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text(xy, text, font=font, fill=glow or fill, anchor=anchor)
    layer = layer.filter(ImageFilter.GaussianBlur(radius))
    base_px = Image.blend(base, Image.new("RGB", base.size, (0, 0, 0)), 0.0)
    base_px = Image.fromarray(
        __import__("numpy").clip(
            __import__("numpy").asarray(base_px, dtype=int)
            + __import__("numpy").asarray(layer, dtype=int),
            0, 255).astype("uint8")
    )
    d2 = ImageDraw.Draw(base_px)
    d2.text(xy, text, font=font, fill=fill, anchor=anchor)
    return base_px


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("bg")
    ap.add_argument("out")
    ap.add_argument("--headline", required=True)
    ap.add_argument("--slogan", default="")
    ap.add_argument("--phone", default="")
    ap.add_argument("--brand", default="")
    ap.add_argument("--accent", default="cyan", choices=list(ACCENTS))
    args = ap.parse_args()

    im = Image.open(args.bg).convert("RGB")
    W, H = im.size
    accent = ACCENTS[args.accent]
    draw = ImageDraw.Draw(im)
    margin = int(W * 0.08)
    inner = W - margin * 2

    # Darken the top and bottom so type always has contrast to sit on, whatever
    # the generator put there — as GRADIENTS, not flat bands. A hard-edged band
    # leaves a visible horizontal seam straight across the poster, which reads as
    # a compositing mistake; a gradient that fades to nothing is invisible.
    def shade(top: bool, height: int, strength: float) -> None:
        grad = Image.new("L", (1, height))
        for y in range(height):
            t = 1.0 - (y / height) if top else (y / height)
            # Ease the falloff so the darkening is strongest at the very edge.
            grad.putpixel((0, y), int(255 * strength * (t ** 1.6)))
        mask = grad.resize((W, height))
        y0 = 0 if top else H - height
        region = im.crop((0, y0, W, y0 + height))
        im.paste(Image.composite(Image.new("RGB", region.size, (0, 0, 0)), region, mask), (0, y0))

    shade(True, int(H * 0.34), 0.80)
    shade(False, int(H * 0.34), 0.85)

    # Brand line, small, above the headline.
    if args.brand:
        f = fit_font(draw, args.brand, REG, inner, int(H * 0.030))
        im = glow_text(im, (W // 2, int(H * 0.055)), args.brand, f, accent,
                       glow=tuple(c // 3 for c in accent), radius=8)

    # Headline — the thing read from across the plaza.
    f = fit_font(draw, args.headline, BOLD, inner, int(H * 0.105))
    im = glow_text(im, (W // 2, int(H * 0.125)), args.headline, f, (255, 255, 255),
                   glow=accent, radius=16)

    # Slogan.
    if args.slogan:
        f = fit_font(draw, args.slogan, REG, inner, int(H * 0.040))
        im = glow_text(im, (W // 2, int(H * 0.195)), args.slogan, f, (225, 240, 250),
                       glow=tuple(c // 4 for c in accent), radius=8)

    # Phone number, bottom, boxed by two rules so it reads as a call to action.
    if args.phone:
        f = fit_font(draw, args.phone, BOLD, inner, int(H * 0.070))
        y = int(H * 0.90)
        im = glow_text(im, (W // 2, y), args.phone, f, accent, glow=accent, radius=18)
        d = ImageDraw.Draw(im)
        for dy in (int(H * 0.055), -int(H * 0.055)):
            d.line([(margin, y + dy), (W - margin, y + dy)], fill=accent, width=2)

    im.save(args.out)
    print(f"wrote {args.out} {W}x{H}")


if __name__ == "__main__":
    main()
