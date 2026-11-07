#!/usr/bin/env python3
"""Draw the Settings tile: the cover the Pocket shows on the Settings stop of its menu ring.

It sits next to the All games tile, so it is made the same way: a 384 x 384 RGB image on
the tile's dark gutter color, a dark band across the bottom third with the label in white
(Inter SemiBold, the same size and place as "All games"), then fitted to 128 and 80 like
any cover. Here the picture is a gear instead of a mosaic.

The image is drawn once, into companion/server/assets/tiles/settings-384.png. The app
(tile.ts) and make_cover_pack.py both read that file and fit it the same way, so their
packs stay byte-identical. Nothing here runs at sync time.

Usage: make_settings_tile.py [--font PATH] [--out PATH]
"""
import argparse, glob, math, os
from PIL import Image, ImageDraw, ImageFont

B = 384          # built at 384 x 384, like the All games tile
BAND_TOP = 256   # the dark band is the bottom third
SIZE = 50        # label size, as in make_tile_label.py
SS = 4           # supersampling for smooth edges
GUTTER = (16, 16, 20)

def find_font():
    pats = ["/Library/Fonts/Inter*SemiBold*.[ot]tf", os.path.expanduser("~/Library/Fonts/Inter*SemiBold*.[ot]tf"),
            "/Applications/*.app/Contents/Resources/*/Contents/Resources/Inter-SemiBold.ttf",
            "/Applications/*.app/Contents/Resources/*/Inter-SemiBold.ttf"]
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits: return hits[0]
    return "/System/Library/Fonts/Helvetica.ttc"

def lerp(a, b, t): return tuple(round(x + (y - x) * t) for x, y in zip(a, b))

def gear_outline(cx, cy, r_out, r_root, teeth, top_frac=0.36, base_frac=0.56, steps=24):
    """Points around a gear: flat topped teeth with slanted flanks."""
    pts = []
    pitch = 2 * math.pi / teeth
    base, top = pitch * base_frac / 2, pitch * top_frac / 2
    arc = lambda r, a0, a1: [(cx + r * math.cos(a0 + (a1 - a0) * s / steps), cy + r * math.sin(a0 + (a1 - a0) * s / steps)) for s in range(steps + 1)]
    for k in range(teeth):
        a0 = k * pitch - math.pi / 2  # this tooth's middle; the first one points straight up
        pts += arc(r_root, a0 - pitch / 2, a0 - base)
        for s in range(steps + 1):
            a = a0 - base + (base - top) * s / steps
            r = r_root + (r_out - r_root) * s / steps
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        for s in range(steps + 1):
            a = a0 - top + 2 * top * s / steps
            pts.append((cx + r_out * math.cos(a), cy + r_out * math.sin(a)))
        for s in range(steps + 1):
            a = a0 + top + (base - top) * s / steps
            r = r_out - (r_out - r_root) * s / steps
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        pts += arc(r_root, a0 + base, a0 + pitch / 2)
    return pts

def ring_points(cx, cy, r, n=360):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(); ap.add_argument("--font"); ap.add_argument("--out", default=os.path.join(here, "..", "assets", "tiles", "settings-384.png"))
    a = ap.parse_args()
    S = B * SS
    # Background: the gutter color, lifted a little toward the middle of the picture area.
    small = Image.new("RGB", (B, B), GUTTER)
    px = small.load()
    for y in range(B):
        for x in range(B):
            px[x, y] = lerp((44, 46, 58), GUTTER, min(1.0, math.hypot(x - B / 2, y - (BAND_TOP / 2 + 4)) / (B * 0.62)))
    bg = small.resize((S, S), Image.BICUBIC)
    cx, cy = S / 2, (BAND_TOP / 2 + 4) * SS
    # The gear: a light body with a soft vertical shade, a hole, and an inner ring.
    r_out, r_root = 92 * SS, 74 * SS
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(gear_outline(cx, cy, r_out, r_root, 8), fill=255)
    md.polygon(ring_points(cx, cy, 34 * SS), fill=0)
    shade = Image.new("RGB", (S, S))
    sd = ImageDraw.Draw(shade)
    for y in range(S):
        t = min(1.0, max(0.0, (y - (cy - r_out)) / (2 * r_out)))
        sd.line([(0, y), (S, y)], fill=lerp((236, 238, 246), (176, 180, 196), t))
    bg.paste(shade, (0, 0), mask)
    # A groove ring on the face of the gear, for depth.
    groove = Image.new("L", (S, S), 0)
    gd = ImageDraw.Draw(groove)
    gd.polygon(ring_points(cx, cy, 58 * SS), fill=255)
    gd.polygon(ring_points(cx, cy, 52 * SS), fill=0)
    bg.paste(Image.new("RGB", (S, S), (140, 144, 162)), (0, 0), groove)
    im = bg.resize((B, B), Image.LANCZOS)
    # The band and the label, exactly as the All games tile does it.
    path = a.font or find_font()
    font = ImageFont.truetype(path, SIZE, index=1 if path.endswith(".ttc") else 0)
    label = Image.new("L", (B, B), 0)
    ImageDraw.Draw(label).text((B // 2, (BAND_TOP + B) // 2), "Settings", fill=255, font=font, anchor="mm")
    p = bytearray(im.tobytes()); m = label.tobytes()
    for y in range(BAND_TOP, B):
        for x in range(B):
            al = m[y * B + x]; o = (y * B + x) * 3
            for ch in range(3):
                v = (p[o + ch] * 72) >> 8
                p[o + ch] = (v * (255 - al) + 255 * al + 127) // 255
    Image.frombytes("RGB", (B, B), bytes(p)).save(a.out)
    print(f"wrote {a.out} with {os.path.basename(path)}")

if __name__ == "__main__": main()
