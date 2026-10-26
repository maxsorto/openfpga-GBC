#!/usr/bin/env python3
"""Render an antialiased 2-bit font ROM for the hi-res menu from a TTF (default: Inter SemiBold, OFL).
Writes font_hr.hex: 128 glyphs x 16 rows, one 24-bit word per row (12 px x 2 bits, pixel 0 in bits [1:0]),
and font_hr_width.hex: advance width per glyph (0 = skip)."""
import sys
from PIL import Image, ImageDraw, ImageFont
ttf, size, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
f = ImageFont.truetype(ttf, size)
asc, desc = f.getmetrics()
BASE = 12                      # baseline row in the 16-row cell
rows, widths = [], []
for c in range(128):
    ch = chr(c)
    if c < 32 or c > 126:
        rows += [0] * 16; widths.append(0); continue
    adv = int(round(f.getlength(ch)))
    im = Image.new("L", (24, 24), 0); d = ImageDraw.Draw(im)
    d.text((0, BASE + 2), ch, font=f, fill=255, anchor="ls")
    for y in range(16):
        w = 0
        for x in range(12):
            v = im.getpixel((x, y + 2)) / 255.0
            q = 0 if v < 0.14 else 1 if v < 0.45 else 2 if v < 0.78 else 3
            w |= q << (2 * x)
        rows.append(w)
    widths.append(min(12, max(1, adv)) if ch != " " else max(3, adv))
open(out + ".hex", "w").write("\n".join(f"{r:06x}" for r in rows) + "\n")
open(out + "_width.hex", "w").write("\n".join(f"{w:x}" for w in widths) + "\n")
# preview
pv = Image.new("RGB", (12 * 32 * 4, 16 * 3 * 4), (20, 24, 36)); px = pv.load()
for c in range(32, 128):
    gx, gy = (c - 32) % 32, (c - 32) // 32
    for y in range(16):
        for x in range(12):
            q = (rows[c * 16 + y] >> (2 * x)) & 3
            col = tuple(int(a + (b - a) * q / 3) for a, b in zip((20, 24, 36), (246, 246, 250)))
            for yy in range(4):
                for xx in range(4): px[(gx * 12 + x) * 4 + xx, (gy * 16 + y) * 4 + yy] = col
pv.save(out + "_preview.png")
print("widths", widths[65:91])
