#!/usr/bin/env python3
"""Render the "All games" label for the closing tile of Favorites mode, as a grayscale mask.

The tile is a 3 x 3 mosaic of covers with a dark band across the bottom third; this label
goes in that band, white. It is drawn once here, into companion/server/assets/tiles/
all-games-384.png (L mode, 384 x 384, 0 = no text, 255 = text), and both the companion app
and make_cover_pack.py composite it the same way, so their packs stay byte-identical.

Font: Inter SemiBold if it is found (pass --font to point at it), else Helvetica Bold.
Usage: make_tile_label.py [--font PATH] [--out PATH]
"""
import argparse, glob, os
from PIL import Image, ImageDraw, ImageFont

B = 384          # the mosaic is built at 384 x 384, then fitted to 128 and 80 like a cover
BAND_TOP = 256   # the dark band is the bottom third
SIZE = 50        # about 17 px tall at 128

def find_font():
    pats = ["/Library/Fonts/Inter*SemiBold*.[ot]tf", os.path.expanduser("~/Library/Fonts/Inter*SemiBold*.[ot]tf"),
            "/Applications/*.app/Contents/Resources/*/Contents/Resources/Inter-SemiBold.ttf",
            "/Applications/*.app/Contents/Resources/*/Inter-SemiBold.ttf"]
    for p in pats:
        hits = sorted(glob.glob(p))
        if hits: return hits[0]
    return "/System/Library/Fonts/Helvetica.ttc"

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(); ap.add_argument("--font"); ap.add_argument("--out", default=os.path.join(here, "..", "companion", "server", "assets", "tiles", "all-games-384.png"))
    a = ap.parse_args()
    path = a.font or find_font()
    font = ImageFont.truetype(path, SIZE, index=1 if path.endswith(".ttc") else 0)
    im = Image.new("L", (B, B), 0)
    ImageDraw.Draw(im).text((B // 2, (BAND_TOP + B) // 2), "All games", fill=255, font=font, anchor="mm")
    im.save(a.out)
    print(f"wrote {a.out} with {os.path.basename(path)}")

if __name__ == "__main__": main()
