#!/usr/bin/env python3
"""Turn the bookshelf artwork into a transparent badge.

    python3 tools/make_bundle_icon.py art/bundle-source.jpeg

The background is cream and so are the page tops, so keying on colour would
eat the pages along with it. The background is flood-filled from the edges
instead: only cream reachable from outside the drawing is removed, and cream
enclosed by the books is left alone.
"""

import sys
from collections import deque
from pathlib import Path

from PIL import Image

# How far a pixel may drift from the corner colour and still count as
# background. JPEG leaves a haze around hard edges, so this cannot be exact.
TOLERANCE = 26

# The badge is drawn at about 20 CSS pixels. This is generous headroom for a
# high-density screen without carrying a 736px image around.
OUTPUT_EDGE = 144


def close_enough(a, b):
    return all(abs(x - y) <= TOLERANCE for x, y in zip(a, b))


def lift_background(image):
    """Flood-fill from every edge pixel, clearing what it reaches."""
    width, height = image.size
    pixels = image.load()
    background = pixels[0, 0][:3]

    seen = bytearray(width * height)
    queue = deque()

    def consider(x, y):
        if not (0 <= x < width and 0 <= y < height):
            return
        at = y * width + x
        if seen[at]:
            return
        if not close_enough(pixels[x, y][:3], background):
            return
        seen[at] = 1
        queue.append((x, y))

    for x in range(width):
        consider(x, 0)
        consider(x, height - 1)
    for y in range(height):
        consider(0, y)
        consider(width - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (255, 255, 255, 0)
        consider(x + 1, y)
        consider(x - 1, y)
        consider(x, y + 1)
        consider(x, y - 1)

    return image


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    source = Path(sys.argv[1])
    out = Path(sys.argv[2] if len(sys.argv) > 2 else 'app/src/main/assets/www/img/bundle.png')
    out.parent.mkdir(parents=True, exist_ok=True)

    image = lift_background(Image.open(source).convert('RGBA'))

    # The soft drop shadow is part of the artwork and survives the fill, being
    # nowhere near the background colour. It is not wanted on a book cover.
    pixels = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a and r > 190 and 140 < g < 200 and 120 < b < 180 and r - b > 40:
                pixels[x, y] = (r, g, b, 0)

    box = image.getbbox()
    if box:
        image = image.crop(box)

    # Square, so it scales predictably wherever it is placed.
    side = max(image.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)

    square.resize((OUTPUT_EDGE, OUTPUT_EDGE), Image.LANCZOS).save(out)
    print(f'{out}  {out.stat().st_size // 1024}kB  ({OUTPUT_EDGE}px)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
