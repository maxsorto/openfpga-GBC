#!/usr/bin/env python3
"""Build covers.bin for the GBC cover-picker core.

Layout (little-endian):
  header  : magic "GBCV" (4) | version u16 = 1 | count u16 | cover_w u16 | cover_h u16 | reserved (4)  = 16 bytes
  entries : count x 128 bytes:  title char[44] (NUL padded, ASCII) | size u32 (ROM file size in bytes) | path char[80] (NUL padded, e.g. "/Assets/gbc/common/Pokemon - Crystal Version.gbc")
  images  : count x (512 + cover_w*cover_h) bytes: 256-entry RGB565 palette, then 8-bit indices row-major

Usage: make_cover_pack.py --roms "/Volumes/Pocket/Assets/gbc/common" --covers ./covers --out covers.bin [--size 112]
A cover image is matched to a ROM by file stem (Pokemon - Crystal Version.png -> Pokemon - Crystal Version.gbc).
ROMs without a cover get a generated placeholder with the title text.
"""
import argparse, os, struct, sys
from PIL import Image, ImageDraw, ImageFont

def rgb565(img):
    out = bytearray()
    for r, g, b in img.convert("RGB").getdata():
        out += struct.pack("<H", ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3))
    return bytes(out)

def placeholder(title, size):
    img = Image.new("RGB", (size, size), (24, 24, 32))
    d = ImageDraw.Draw(img)
    try: font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 14)
    except Exception: font = ImageFont.load_default()
    words, lines, cur = title.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) > size - 10 and cur: lines.append(cur); cur = w
        else: cur = t
    if cur: lines.append(cur)
    y = size // 2 - 8 * len(lines)
    for ln in lines[:5]:
        d.text(((size - d.textlength(ln, font=font)) / 2, y), ln, fill=(230, 230, 230), font=font); y += 16
    return img

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--roms", required=True); ap.add_argument("--covers", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--size", type=int, default=96); ap.add_argument("--platform", default="gbc")
    a = ap.parse_args()
    roms = sorted(f for f in os.listdir(a.roms) if f.lower().endswith((".gbc", ".gb")))
    if not roms: sys.exit("no ROMs found")
    covers = {os.path.splitext(f)[0].lower(): os.path.join(a.covers, f) for f in os.listdir(a.covers) if f.lower().endswith((".png", ".jpg", ".jpeg"))}
    entries, images = [], []
    for rom in roms:
        stem = os.path.splitext(rom)[0]
        path = f"/Assets/{a.platform}/common/{rom}"
        if len(path.encode()) > 79: sys.exit(f"path too long (max 79 bytes): {path}")
        src = covers.get(stem.lower())
        img = Image.open(src) if src else placeholder(stem, a.size)
        img = img.convert("RGB"); img.thumbnail((a.size, a.size))
        canvas = Image.new("RGB", (a.size, a.size), (0, 0, 0)); canvas.paste(img, ((a.size - img.width) // 2, (a.size - img.height) // 2))
        entries.append(struct.pack("<44sI80s", stem.encode("ascii", "replace")[:43], os.path.getsize(os.path.join(a.roms, rom)), path.encode()[:79]))
        q = canvas.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
        pal = (q.getpalette() or [])[:768]; pal += [0] * (768 - len(pal))
        pal565 = b"".join(struct.pack("<H", ((pal[i] >> 3) << 11) | ((pal[i+1] >> 2) << 5) | (pal[i+2] >> 3)) for i in range(0, 768, 3))
        images.append(pal565 + bytes(q.getdata()))
        print(f"{'cover ' if src else 'placeholder'}  {rom}")
    with open(a.out, "wb") as f:
        f.write(struct.pack("<4sHHHH4x", b"GBCV", 3, len(roms), a.size, a.size)); f.write(b"".join(entries)); f.write(b"".join(images))
    print(f"wrote {a.out}: {len(roms)} entries, {os.path.getsize(a.out)} bytes")

if __name__ == "__main__": main()
