#!/usr/bin/env python3
"""Build covers.bin (format v6, or v7 with --v7) for the GBC cover-picker core.

Layout (little-endian):
  0      header  16 B : "GBCV" | ver u16 = 6 | count u16 | 128 u16 | 80 u16 | 4 pad
  16     reserved 512 B
  528    entries count x 128 B : title char[40] | flags u8 (bit0 = original Game Boy) | pad[3] | size u32 | path char[80]
  528 + count*128  blobs, count x 45568 B : center 128x128 RGB565 | preview 80x80 RGB565 (row-major)
  then   path structs count x 3 x 256 B: ROM path, .sav path, .sus (suspend) path, NUL padded,
         read straight into the core's 0x0192 parameter struct
  then   one more 256 B path struct: the debug log, /Saves/<platform>/common/picker.log
v7 (--v7): ver = 7, up to 2047 games, entries are title char[40] | flags u8 | pad[3] | size u32 | crc32 u32 |
path char[76], and each blob is padded to 65536 B so the core can stream any cover by index.
Entry flags: bit 0 = original Game Boy, bit 1 = favorite (this tool has no favorites, so bit 1 is 0).
After the picker.log path struct, v7 has one more: /Saves/<platform>/common/favorites.cfg.
v7 games are in letter order: titles that start with anything but A to Z first ('#'), then A to Z, each
group sorted by title ignoring case. The reserved area then starts with a letter index for Up/Down jumps:
  16  "IDX1"   20  fav_count u16   22  played_count u16   24  27 x u16 section starts
  start 0 is '#', 1 to 26 are 'A' to 'Z': the index of the first game whose title (as written in the
  entry) starts with that letter, ignoring case, or 0xFFFF if none. This tool has no favorites or play
  history, so both counts are 0. The companion app puts played games, then favorites, before the A to Z part,
and lists every game in the A to Z part, so a favorite appears twice (both entries full copies).
Covers are matched to ROMs by file stem. Art is fitted on a blurred, darkened copy of itself (no black bars).

Usage: make_cover_pack.py --roms DIR --covers DIR --out covers.bin
"""
import argparse, os, struct, sys, zlib
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance

CEN, TH, MAXN, MAXN7, STRIDE7 = 128, 80, 31, 2047, 65536

def pack_title(stem): return stem.encode("ascii", "replace")[:39]

def letter_group(stem):
    """0 for '#', 1 to 26 for A to Z: the first character of the title as the Pocket shows it."""
    c = pack_title(stem)[:1].upper()
    return c[0] - 64 if c and 65 <= c[0] <= 90 else 0

def az_key(rom):
    stem = os.path.splitext(rom)[0]
    return (letter_group(stem), stem.lower(), rom)

def index_block(stems, fav_count=0, played_count=0):
    """The 512 byte reserved area of a v7 pack: the letter index, then zeros."""
    starts = [0xFFFF] * 27
    for i in range(played_count + fav_count, len(stems)):
        g = letter_group(stems[i])
        if starts[g] == 0xFFFF: starts[g] = i
    present = [x for x in starts if x != 0xFFFF]
    assert present == sorted(present), "letter sections must be in order"
    return struct.pack("<4sHH27H", b"IDX1", fav_count, played_count, *starts).ljust(512, b"\0")

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
    ap.add_argument("--out", required=True); ap.add_argument("--platform", default="gbc")
    ap.add_argument("--v7", action="store_true", help="format v7: up to 2047 games, streamed covers"); a = ap.parse_args()
    roms = sorted(f for f in os.listdir(a.roms) if f.lower().endswith((".gbc", ".gb")) and not f.startswith("._"))
    roms = sorted(roms, key=az_key)[:MAXN7] if a.v7 else roms[:MAXN]
    if not roms: sys.exit("no ROMs found")
    covers = {os.path.splitext(f)[0].lower(): os.path.join(a.covers, f) for f in os.listdir(a.covers) if f.lower().endswith((".png", ".jpg", ".jpeg"))}
    arts, entries, paths = [], [], []
    for rom in roms:
        stem = os.path.splitext(rom)[0]; path = f"/Assets/{a.platform}/common/{rom}"
        src = covers.get(stem.lower()); arts.append(Image.open(src) if src else placeholder(stem))
        flags = 1 if rom.lower().endswith(".gb") else 0
        base = f"/Saves/{a.platform}/common/{stem}"
        for q in (path, base + ".sav", base + ".sus"):
            if len(q.encode()) > 255: sys.exit(f"path too long: {q}")
            paths.append(q.encode().ljust(256, b"\0"))
        rp = os.path.join(a.roms, rom)
        if a.v7:
            crc = zlib.crc32(open(rp, "rb").read()) & 0xFFFFFFFF
            entries.append(struct.pack("<40sB3xII76s", pack_title(stem), flags, os.path.getsize(rp), crc, path.encode()[:75]))
        else:
            entries.append(struct.pack("<40sB3xI80s", stem.encode("ascii", "replace")[:39], flags, os.path.getsize(rp), path.encode()[:79]))
        print(f"{'cover ' if src else 'placeholder'}  {rom}")
    # v6: full-color RGB565 art, center CEN x CEN then preview TH x TH, row-major, little-endian words
    blobs = []
    for im in arts:
        c = fit(im, CEN); t = fit(im, TH)
        blobs.append(b"".join(struct.pack("<H", rgb565(p)) for p in c.getdata()) +
                     b"".join(struct.pack("<H", rgb565(p)) for p in t.getdata()))
    with open(a.out, "wb") as f:
        f.write(struct.pack("<4sHHHH4x", b"GBCV", 7 if a.v7 else 6, len(roms), CEN, TH))
        f.write(index_block([os.path.splitext(r)[0] for r in roms]) if a.v7 else bytes(512))
        f.write(b"".join(entries))
        f.write(b"".join(b.ljust(STRIDE7, b"\0") for b in blobs) if a.v7 else b"".join(blobs))
        f.write(b"".join(paths))
        f.write(f"/Saves/{a.platform}/common/picker.log".encode().ljust(256, b"\0"))
        if a.v7:  # the core opens favorites.cfg through this struct, right after the log one
            f.write(f"/Saves/{a.platform}/common/favorites.cfg".encode().ljust(256, b"\0"))
    print(f"wrote {a.out}: {len(roms)} entries, {os.path.getsize(a.out)} bytes")

if __name__ == "__main__": main()
