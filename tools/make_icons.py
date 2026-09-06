#!/usr/bin/env python3
"""Generate launcher icons from a single source illustration.

Kept in the repo so the icons are reproducible rather than mystery binaries:

    python3 tools/make_icons.py art/icon-source.jpg

Adaptive icons are a 108dp canvas of which only the centre 66dp is guaranteed
visible -- launchers mask the rest to a circle, squircle, rounded square or
whatever the OEM decided. The source art fills ~91% of its frame, so pasting it
at full bleed would clip the book's corners on any round mask. Everything below
exists to avoid that.

The themed-icon (monochrome) layer is NOT generated here. Android tints it a
single colour, so a luminance threshold of a detailed illustration comes out as
speckle with holes through the middle. It is drawn by hand instead, as a
vector: res/drawable/ic_launcher_monochrome.xml.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# Adaptive icon geometry, in dp.
CANVAS_DP = 108
SAFE_DP = 66

# Launcher densities: mdpi is 1x at 48dp for the legacy icon, 108dp adaptive.
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

# Sampled from the source corners. The background layer has to match, or the
# foreground's faded edge shows as a halo.
BG_TOP = "#241454"
BG_BOTTOM = "#0a0c20"

# How much of the source frame the subject occupies, measured once from the
# art. Used to scale the subject into the safe zone rather than guessing.
SUBJECT_FRACTION = 0.913


def build_foreground(source: Image.Image, size: int) -> Image.Image:
    """The subject, scaled so it sits inside the safe circle, on transparency."""
    safe = size * SAFE_DP / CANVAS_DP
    # Scale the whole frame so the subject lands at the safe diameter.
    frame = int(round(safe / SUBJECT_FRACTION))
    art = source.resize((frame, frame), Image.LANCZOS).convert("RGBA")

    # Feather the square edge into nothing. The art's corners are near-black
    # and the background layer is the same family, so this reads as the
    # illustration floating rather than as a pasted tile.
    mask = Image.new("L", (frame, frame), 0)
    draw = ImageDraw.Draw(mask)
    inset = int(frame * 0.02)
    draw.ellipse((inset, inset, frame - inset, frame - inset), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(frame * 0.055))
    art.putalpha(mask)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - frame) // 2
    canvas.paste(art, (offset, offset), art)
    return canvas


def build_legacy(source: Image.Image, size: int) -> Image.Image:
    """Pre-adaptive square icon: background baked in, art nearly full bleed."""
    canvas = vertical_gradient(size, BG_TOP, BG_BOTTOM)
    frame = int(size * 0.94)
    art = source.resize((frame, frame), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (frame, frame), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, frame, frame), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(frame * 0.05))
    art.putalpha(mask)
    offset = (size - frame) // 2
    canvas.paste(art, (offset, offset), art)

    # Round the corners a little so it does not look raw on launchers that
    # apply no mask of their own.
    radius = int(size * 0.18)
    rounded = Image.new("L", (size, size), 0)
    ImageDraw.Draw(rounded).rounded_rectangle((0, 0, size - 1, size - 1), radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), rounded)
    return out


def vertical_gradient(size: int, top: str, bottom: str) -> Image.Image:
    top_rgb = tuple(int(top[i:i + 2], 16) for i in (1, 3, 5))
    bottom_rgb = tuple(int(bottom[i:i + 2], 16) for i in (1, 3, 5))
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top_rgb, bottom_rgb)))
    return grad.resize((size, size), Image.NEAREST).convert("RGBA")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source_path = Path(sys.argv[1])
    res = Path(sys.argv[2] if len(sys.argv) > 2 else "app/src/main/res")

    source = Image.open(source_path).convert("RGB")
    if source.width != source.height:
        side = min(source.size)
        left = (source.width - side) // 2
        top = (source.height - side) // 2
        source = source.crop((left, top, left + side, top + side))

    written = []
    for density, scale in DENSITIES.items():
        out = res / f"mipmap-{density}"
        out.mkdir(parents=True, exist_ok=True)

        adaptive = int(CANVAS_DP * scale)
        build_foreground(source, adaptive).save(out / "ic_launcher_foreground.png")

        legacy = int(48 * scale)
        icon = build_legacy(source, legacy)
        icon.save(out / "ic_launcher.png")
        icon.save(out / "ic_launcher_round.png")

        written += [out / n for n in
                    ("ic_launcher_foreground.png", "ic_launcher.png", "ic_launcher_round.png")]

    for path in written:
        print(f"{path}  {path.stat().st_size // 1024}kB")
    print(f"\n{len(written)} files written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
