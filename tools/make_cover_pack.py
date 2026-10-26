#!/usr/bin/env python3
"""Build covers.bin (format v6) for the GBC cover-picker core.

Layout (little-endian):
  0      header  16 B : "GBCV" | ver u16 = 6 | count u16 | 128 u16 | 80 u16 | 4 pad
  16     reserved 512 B
  528    entries count x 128 B : title char[40] | flags u8 (bit0 = original Game Boy) | pad[3] | size u32 | path char[80]
  528 + count*128  blobs, count x 45568 B : center 128x128 RGB565 | preview 80x80 RGB565 (row-major)
  then   path structs count x 3 x 256 B: ROM path, .sav path, .sus (suspend) path, NUL padded,
         read straight into the core's 0x0192 parameter struct
Covers are matched to ROMs by file stem. Art is fitted on a blurred, darkened copy of itself (no black bars).

Usage: make_cover_pack.py --roms DIR --covers DIR --out covers.bin
"""
import argparse, os, struct, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance

CEN, TH, MAXN = 128, 80, 31

def rgb565(rgb): r, g, b = rgb; return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)

def placeholder(title):
    img = Image.new("RGB", (256, 256), (40, 48, 72)); d = ImageDraw.Draw(img)
    try: font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 34)
    except Exception: font = ImageFont.load_default()
    d.multiline_text((128, 128), "\n".join(title.split(" - ")), fill=(235, 235, 245), font=font, anchor="mm", align="center")
    return img

def fit(img, size):
    """Contain the art in a square, on a blurred and darkened 'cover' fill of itself."""
    img = img.convert("RGB")
    bg = img.copy(); s = max(size / bg.width, size / bg.height)
    bg = bg.resize((max(1, round(bg.width * s)), max(1, round(bg.height * s))), Image.LANCZOS)
    bg = bg.crop(((bg.width - size) // 2, (bg.height - size) // 2, (bg.width - size) // 2 + size, (bg.height - size) // 2 + size))
    bg = ImageEnhance.Brightness(bg.filter(ImageFilter.GaussianBlur(size / 10))).enhance(0.45)
    fg = img.copy(); fg.thumbnail((size, size), Image.LANCZOS)
    fg = ImageEnhance.Sharpness(fg).enhance(1.4)
    bg.paste(fg, ((size - fg.width) // 2, (size - fg.height) // 2)); return bg

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--roms", required=True); ap.add_argument("--covers", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--platform", default="gbc"); a = ap.parse_args()
    roms = sorted(f for f in os.listdir(a.roms) if f.lower().endswith((".gbc", ".gb")))[:MAXN]
    if not roms: sys.exit("no ROMs found")
    covers = {os.path.splitext(f)[0].lower(): os.path.join(a.covers, f) for f in os.listdir(a.covers) if f.lower().endswith((".png", ".jpg", ".jpeg"))}
    arts, entries, paths = [], [], []
    for rom in roms:
        stem = os.path.splitext(rom)[0]; path = f"/Assets/{a.platform}/common/{rom}"
        if len(path.encode()) > 79: sys.exit(f"path too long (max 79 bytes): {path}")
        src = covers.get(stem.lower()); arts.append(Image.open(src) if src else placeholder(stem))
        flags = 1 if rom.lower().endswith(".gb") else 0
        base = f"/Saves/{a.platform}/common/{stem}"
        for q in (path, base + ".sav", base + ".sus"):
            if len(q.encode()) > 255: sys.exit(f"path too long: {q}")
            paths.append(q.encode().ljust(256, b"\0"))
        entries.append(struct.pack("<40sB3xI80s", stem.encode("ascii", "replace")[:39], flags, os.path.getsize(os.path.join(a.roms, rom)), path.encode()[:79]))
        print(f"{'cover ' if src else 'placeholder'}  {rom}")
    # v6: full-color RGB565 art, center CEN x CEN then preview TH x TH, row-major, little-endian words
    blobs = []
    for im in arts:
        c = fit(im, CEN); t = fit(im, TH)
        blobs.append(b"".join(struct.pack("<H", rgb565(p)) for p in c.getdata()) +
                     b"".join(struct.pack("<H", rgb565(p)) for p in t.getdata()))
    with open(a.out, "wb") as f:
        f.write(struct.pack("<4sHHHH4x", b"GBCV", 6, len(roms), CEN, TH))
        f.write(bytes(512))
        f.write(b"".join(entries)); f.write(b"".join(blobs)); f.write(b"".join(paths))
    print(f"wrote {a.out}: {len(roms)} entries, {os.path.getsize(a.out)} bytes")

if __name__ == "__main__": main()
