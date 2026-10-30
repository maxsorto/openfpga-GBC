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
v7 (--v7): ver = 7, up to 2047 games, entries are title char[40] | flags u8 | pad u8 | accent u16 | size u32 |
crc32 u32 | path char[76], and each blob is padded to 65536 B so the core can stream any cover by index.
Entry flags: bit 0 = original Game Boy, bit 1 = favorite (--favorite), bit 2 = cartridge only (never set here).
accent = RGB565 color of the cover, for the core's glow (see accent()).
After the picker.log path struct, v7 has two more: /Saves/<platform>/common/favorites.cfg, then carts.cfg.
v7 unrecognized carts: at file offset 96, "CRT1" | u32 default art offset | u16 list_count | u16 flags (bit 0:
carts.cfg struct present) | 3 x u16 default art accents | u16 0. list_count is the browsable menu; the app adds
cartridge-only entries after it (this tool does not, so list_count = count). The default art (gray DMG, black
dual, clear GBC-only cart) is 3 blobs at a 65536 stride after the FPR2 table, 4096 aligned, ending the file;
RGB565 0x0000 is transparent there. Art is read from companion/server/assets/carts/{dmg,dual,cgb}-{128,80}.png,
or drawn as a placeholder when those are missing (same drawing as the app). CRT1 flags bit 1: a fourth image follows,
the All games tile Favorites mode shows after the favorites (opaque, 0x0000 written as 0x0001); written whenever
there are favorites (--favorite). It is a 3 x 3 mosaic of covers from the A to Z list with a dark band and the
label from companion/server/assets/tiles/all-games-384.png (made by make_tile_label.py).
v7 cartridge fingerprints, for Play Cartridge: at file offset 80, "FPR2" | u32 table offset | u16 entry count | u16 0.
The table follows the carts.cfg struct on a 4 byte boundary, before the default art: 8 bytes per entry, ROM bytes
0x14E, 0x14F (global checksum), 0x14D (header checksum), 0x143 (CGB flag), then u32 LE zlib CRC32 of the 11 byte
title area 0x134..0x13E; 8 zeros if the ROM is shorter than 0x150. The core matches the revision, then the title.
v7 games are in letter order: titles that start with anything but A to Z first ('#'), then A to Z, each
group sorted by title ignoring case. The reserved area then starts with a letter index for Up/Down jumps:
  16  "IDX1"   20  fav_count u16   22  played_count u16   24  27 x u16 section starts
  start 0 is '#', 1 to 26 are 'A' to 'Z': the index of the first game whose title (as written in the
  entry) starts with that letter, ignoring case, or 0xFFFF if none. With --favorite, favorites come first (the
  favorites section, counted in fav_count), then every game A to Z, so a favorite appears twice (both entries
  full copies, flags bit 1 on both). There is no play history here, so played_count is 0. The companion app
  does the same, with played games before the favorites.
Covers are matched to ROMs by file stem. Art is fitted on a blurred, darkened copy of itself (no black bars).

Usage: make_cover_pack.py --roms DIR --covers DIR --out covers.bin
"""
import argparse, colorsys, os, struct, sys, zlib
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

FPR_AT = 80  # file offset of "FPR2", in the reserved area after the letter index
CRT_AT = 96  # file offset of "CRT1", after FPR2
CART_KINDS = ("dmg", "dual", "cgb")
CART_ACCENTS = (0xA59F, 0x8A7F, 0x4E9A)  # must match CART_ACCENTS in companion/server/src/cartart.ts
CART_ART = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "companion", "server", "assets", "carts")
CART_COLORS = {"dmg": ((164, 164, 172), (220, 220, 228), (120, 120, 128)),
               "dual": ((36, 36, 44), (90, 90, 110), (20, 20, 26)),
               "cgb": ((186, 214, 222), (236, 244, 248), (140, 170, 180))}

def placeholder_cart(kind, S):
    """A flat cartridge silhouette, RGBA rows; the same integer drawing as placeholderCart() in the app."""
    body, label, grip = CART_COLORS[kind]; pct = lambda p: S * p // 100
    x0 = pct(16); x1 = S - x0; y0 = pct(6); y1 = S - pct(6); c = pct(12)
    lx0, lx1, ly0, ly1 = x0 + pct(8), x1 - pct(8), y0 + pct(14), y0 + pct(58)
    gy0, gy1, gx0, gx1 = y1 - pct(16), y1 - pct(6), x0 + pct(10), x1 - pct(10)
    step = max(1, S // 32); px = []
    for y in range(S):
        for x in range(S):
            col = None
            if x0 <= x < x1 and y0 <= y < y1:
                col = body
                if x >= x1 - c and y < y0 + c and x - (x1 - c) > y - y0: col = None
                elif lx0 <= x < lx1 and ly0 <= y < ly1: col = label
                elif gx0 <= x < gx1 and gy0 <= y < gy1 and ((y - gy0) // step) % 2 == 0: col = grip
            px.append((0, 0, 0, 0) if col is None else (*col, 255))
    return px

def cart_blob(kind):
    """Default art for an unrecognized cart: 128 then 80, keyed (alpha 0 is 0x0000, opaque 0x0000 becomes 0x0001)."""
    out = b""
    for S in (CEN, TH):
        f = os.path.join(CART_ART, f"{kind}-{S}.png")
        px = list(Image.open(f).convert("RGBA").getdata()) if os.path.exists(f) else placeholder_cart(kind, S)
        for r, g, b, al in px:
            v = 0 if al == 0 else (rgb565((r, g, b)) or 1)
            out += struct.pack("<H", v)
    return out

def accent(img):
    """RGB565 accent of a 128x128 cover: weighted mean color by s*s*v (skip v < 0.15), more saturated, full value."""
    total = sr = sg = sb = 0.0
    for r, g, b in img.getdata():
        r, g, b = r / 255.0, g / 255.0, b / 255.0
        maxc, minc = max(r, g, b), min(r, g, b); v = maxc
        if v < 0.15: continue
        s = 0.0 if maxc == minc else (maxc - minc) / maxc
        w = s * s * v; total += w; sr += w * r; sg += w * g; sb += w * b
    if total < 0.02 * img.width * img.height: mr, mg, mb = 0xC8 / 255.0, 0xD4 / 255.0, 0xFF / 255.0
    else: mr, mg, mb = sr / total, sg / total, sb / total
    h, s, _ = colorsys.rgb_to_hsv(mr, mg, mb)
    r, g, b = colorsys.hsv_to_rgb(h, min(1.0, s * 1.3), 1.0)
    q = lambda x: int(x * 255 + 0.5)
    return ((q(r) >> 3) << 11) | ((q(g) >> 2) << 5) | (q(b) >> 3)

def fingerprint(path):
    """What Play Cartridge matches on: header bytes 0x14E, 0x14F, 0x14D, 0x143, then the title area's CRC32."""
    with open(path, "rb") as f: h = f.read(0x150)
    if len(h) < 0x150: return bytes(8)
    return bytes([h[0x14E], h[0x14F], h[0x14D], h[0x143]]) + struct.pack("<I", zlib.crc32(h[0x134:0x13F]) & 0xFFFFFFFF)

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

TILE_B, TILE_G, TILE_CELL, TILE_BAND = 384, 6, 120, 256  # the All games tile, built at 384 x 384
TILE_GUTTER = (16, 16, 20)
TILE_LABEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "companion", "server", "assets", "tiles", "all-games-384.png")

def tile_picks(az, favset, has_art):
    """The 9 covers for the All games tile: from the A to Z list, not favorites, the middle of each ninth;
    covers with real art if there are 9 of those, else any game, else (all favorites) the favorites too."""
    stem = lambda r: os.path.splitext(r)[0]
    not_fav = [r for r in az if stem(r) not in favset]
    with_art = [r for r in not_fav if has_art(r)]
    pool = with_art if len(with_art) >= 9 else (not_fav or az)
    return [pool[(2 * i + 1) * len(pool) // 18] for i in range(9)] if pool else []

def all_games_tile(images):
    """Favorites mode's closing cover: a 3 x 3 mosaic with a dark band and the label; same steps as tile.ts in the app."""
    m = Image.new("RGB", (TILE_B, TILE_B), TILE_GUTTER)
    for k, im in enumerate(images[:9]):
        m.paste(fit(im, TILE_CELL), (TILE_G + (k % 3) * (TILE_CELL + TILE_G), TILE_G + (k // 3) * (TILE_CELL + TILE_G)))
    px = bytearray(m.tobytes())
    mask = Image.open(TILE_LABEL).convert("L").tobytes() if os.path.exists(TILE_LABEL) else bytes(TILE_B * TILE_B)
    for y in range(TILE_BAND, TILE_B):
        for x in range(TILE_B):
            al = mask[y * TILE_B + x]; o = (y * TILE_B + x) * 3
            for ch in range(3):
                p = (px[o + ch] * 72) >> 8
                px[o + ch] = (p * (255 - al) + 255 * al + 127) // 255
    m = Image.frombytes("RGB", (TILE_B, TILE_B), bytes(px))
    opaque = lambda im: b"".join(struct.pack("<H", rgb565(p) or 1) for p in im.getdata())  # no 0x0000: drawn like a cover
    return opaque(fit(m, CEN)) + opaque(fit(m, TH))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--roms", required=True); ap.add_argument("--covers", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--platform", default="gbc")
    ap.add_argument("--v7", action="store_true", help="format v7: up to 2047 games, streamed covers")
    ap.add_argument("--favorite", action="append", default=[], metavar="STEM",
                    help="v7: mark a game (ROM file name without extension) as a favorite; can be given more than once"); a = ap.parse_args()
    roms = sorted(f for f in os.listdir(a.roms) if f.lower().endswith((".gbc", ".gb")) and not f.startswith("._"))
    roms = sorted(roms, key=az_key) if a.v7 else roms[:MAXN]
    if not roms: sys.exit("no ROMs found")
    favset = set(a.favorite) if a.v7 else set()
    stem_of = lambda r: os.path.splitext(r)[0]
    # v7 menu: the favorites section, then every game A to Z (so a favorite is listed twice). v6: each game once.
    favs = [r for r in roms if stem_of(r) in favset]
    menu = ([(r, "favorite") for r in favs] + [(r, "az") for r in roms])[:MAXN7] if a.v7 else [(r, "az") for r in roms]
    covers = {os.path.splitext(f)[0].lower(): os.path.join(a.covers, f) for f in os.listdir(a.covers) if f.lower().endswith((".png", ".jpg", ".jpeg"))}
    art_of, blob_of, accent_of = {}, {}, {}
    for rom in roms:
        stem = stem_of(rom); src = covers.get(stem.lower())
        art_of[rom] = Image.open(src) if src else placeholder(stem)
        print(f"{'cover ' if src else 'placeholder'}  {rom}")
    # full-color RGB565 art, center CEN x CEN then preview TH x TH, row-major, little-endian words
    for rom, _ in menu:
        if rom in blob_of: continue
        c = fit(art_of[rom], CEN); t = fit(art_of[rom], TH)
        blob_of[rom] = (b"".join(struct.pack("<H", rgb565(p)) for p in c.getdata()) +
                        b"".join(struct.pack("<H", rgb565(p)) for p in t.getdata()))
        if a.v7: accent_of[rom] = accent(c)
    entries, paths, blobs = [], [], []
    for rom, _ in menu:
        stem = stem_of(rom); path = f"/Assets/{a.platform}/common/{rom}"; rp = os.path.join(a.roms, rom)
        flags = (1 if rom.lower().endswith(".gb") else 0) | (2 if stem in favset else 0)
        base = f"/Saves/{a.platform}/common/{stem}"
        for q in (path, base + ".sav", base + ".sus"):
            if len(q.encode()) > 255: sys.exit(f"path too long: {q}")
            paths.append(q.encode().ljust(256, b"\0"))
        if a.v7:
            crc = zlib.crc32(open(rp, "rb").read()) & 0xFFFFFFFF
            entries.append(struct.pack("<40sBxHII76s", pack_title(stem), flags, accent_of[rom], os.path.getsize(rp), crc, path.encode()[:75]))
        else:
            entries.append(struct.pack("<40sB3xI80s", stem.encode("ascii", "replace")[:39], flags, os.path.getsize(rp), path.encode()[:79]))
        blobs.append(blob_of[rom])
    n = len(menu)
    fav_count = sum(1 for _, sec in menu if sec == "favorite")
    paths0 = 16 + 512 + n * (128 + STRIDE7)
    table_at = (paths0 + (n * 3 + 3) * 256 + 3) & ~3  # after the carts.cfg struct, 4 byte aligned
    art_at = (table_at + n * 8 + 4095) & ~4095  # default cart art, 4096 aligned
    tile = None
    if a.v7 and fav_count:  # Favorites mode's closing cover, after the three cartridges
        az = [r for r, sec in menu if sec == "az"]
        tile = all_games_tile([art_of[r] for r in tile_picks(az, favset, lambda r: stem_of(r).lower() in covers)])
    reserved = bytes(512)
    if a.v7:
        reserved = bytearray(index_block([stem_of(r) for r, _ in menu], fav_count=fav_count))
        reserved[FPR_AT - 16:FPR_AT - 16 + 12] = struct.pack("<4sIHH", b"FPR2", table_at, n, 0)
        reserved[CRT_AT - 16:CRT_AT - 16 + 20] = struct.pack("<4sIHH3HH", b"CRT1", art_at, n, 1 | (2 if tile else 0), *CART_ACCENTS, 0)
    with open(a.out, "wb") as f:
        f.write(struct.pack("<4sHHHH4x", b"GBCV", 7 if a.v7 else 6, n, CEN, TH))
        f.write(bytes(reserved))
        f.write(b"".join(entries))
        f.write(b"".join(b.ljust(STRIDE7, b"\0") for b in blobs) if a.v7 else b"".join(blobs))
        f.write(b"".join(paths))
        f.write(f"/Saves/{a.platform}/common/picker.log".encode().ljust(256, b"\0"))
        if a.v7:  # the core opens favorites.cfg through this struct, right after the log one
            f.write(f"/Saves/{a.platform}/common/favorites.cfg".encode().ljust(256, b"\0"))
            f.write(f"/Saves/{a.platform}/common/carts.cfg".encode().ljust(256, b"\0"))
            f.write(bytes(table_at - f.tell()))
            f.write(b"".join(fingerprint(os.path.join(a.roms, r)) for r, _ in menu))
            f.write(bytes(art_at - f.tell()))
            f.write(b"".join(cart_blob(k).ljust(STRIDE7, b"\0") for k in CART_KINDS))
            if tile: f.write(tile.ljust(STRIDE7, b"\0"))
    print(f"wrote {a.out}: {n} entries, {os.path.getsize(a.out)} bytes")

if __name__ == "__main__": main()
