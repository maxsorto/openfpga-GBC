#!/usr/bin/env python3
"""Test pack for tb_vt.sv (vt.hex), or with --fav for tb_fav.sv (fav.hex: three favorites on top, the All games cover): pack v7, 8 real covers from a local pack, the CRT1 block with the three default cartridge
images, a carts.cfg path, and an FPR2 record for the test "PM_CRYSTAL" cart on game 5. Writes vt.hex (one byte per line)."""
import struct, sys, zlib
sys.path.insert(0, '../../openfpga-GBC/tools')
from PIL import Image
import numpy as np
src = open(sys.argv[1], 'rb'); src_count = struct.unpack('<H', src.read(16)[6:8])[0]
def src_entry(i):
    src.seek(528 + i * 128); return src.read(128)
def src_blob(i):
    src.seek(528 + src_count * 128 + i * 65536); return src.read(45568)
def find(name):
    for i in range(src_count):
        if src_entry(i)[:40].split(b'\0')[0].decode('latin-1') == name: return i
    raise KeyError(name)
names = ["Kirby's Dream Land", "Kirby's Dream Land 2", "Kirby's Pinball Land", "Dr. Mario", "Donkey Kong Land",
         "Pokemon - Crystal Version", "Pokemon - Gold Version", "Pokemon - Silver Version"]
FAV = '--fav' in sys.argv
games = [find(n) for n in names]
favs = [1, 5, 6] if FAV else []               # positions in names: favorites copied to the top
order = [(g, True) for g in (games[i] for i in favs)] + [(g, games.index(g) in favs) for g in games]
N = len(order)
def png565(path):
    im = np.asarray(Image.open(path).convert('RGBA')).astype(np.int32)
    w = ((im[..., 0] >> 3) << 11) | ((im[..., 1] >> 2) << 5) | (im[..., 2] >> 3)
    w = np.where(w == 0, 1, w); w = np.where(im[..., 3] == 0, 0, w)
    return w.astype('<u2').tobytes()
carts = '../../openfpga-GBC/companion/server/assets/carts/'
defaults = [png565(carts + f'{k}-128.png') + png565(carts + f'{k}-80.png') for k in ('dmg', 'dual', 'cgb')]
if FAV:                                       # the All games cover: a 3x3 mosaic, opaque
    from PIL import Image as I
    def art_img(g, size):
        b = src_blob(g); w = np.frombuffer(b[:32768], '<u2').reshape(128, 128).astype(np.int32)
        rgb = np.stack([((w >> 11) & 31) << 3, ((w >> 5) & 63) << 2, (w & 31) << 3], -1).astype(np.uint8)
        return I.fromarray(rgb).resize((size, size))
    def mosaic(S):
        m = I.new('RGB', (S, S), (12, 12, 16)); t = (S - 4) // 3
        for k in range(9):
            m.paste(art_img(games[k % len(games)], t), (1 + (k % 3) * (t + 1), 1 + (k // 3) * (t + 1)))
        a = np.asarray(m).astype(np.int32); a[S * 2 // 3:] = a[S * 2 // 3:] // 3
        w = ((a[..., 0] >> 3) << 11) | ((a[..., 1] >> 2) << 5) | (a[..., 2] >> 3); w = np.where(w == 0, 1, w)
        return w.astype('<u2').tobytes()
    defaults.append(mosaic(128) + mosaic(80))
acc = [0xA59F, 0x8A7F, 0x4E9A]
blob0 = 528 + N * 128
paths0 = blob0 + N * 65536
fpr = (paths0 + (N * 3 + 3) * 256 + 3) & ~3
art_off = (fpr + N * 8 + 4095) & ~4095
out = bytearray(art_off + len(defaults) * 65536)
out[0:16] = b'GBCV' + struct.pack('<HHHH', 7, N, 128, 80) + bytes(4)
# IDX1: no favorites or played; starts for the letters present
starts = [0xFFFF] * 27
for i, n in enumerate(names):
    c = n[0].upper(); k = (ord(c) - 64) if c.isalpha() else 0
    if starts[k] == 0xFFFF: starts[k] = i + len(favs)
out[16:24] = b'IDX1' + struct.pack('<HH', len(favs), 0)
for i, s_ in enumerate(starts): out[24 + i * 2:26 + i * 2] = struct.pack('<H', s_)
out[80:92] = b'FPR2' + struct.pack('<IHH', fpr, N, 0)
out[96:116] = b'CRT1' + struct.pack('<IHHHHHH', art_off, N, 3 if FAV else 1, *acc, 0)
for i, (g, fv) in enumerate(order):
    e = bytearray(src_entry(g))
    e[40] = (e[40] & 1) | (2 if fv else 0)
    e[42:44] = struct.pack('<H', 0x7D3F if g == games[5] else 0xFD20)
    out[528 + i * 128: 528 + (i + 1) * 128] = e
    b = src_blob(g); out[blob0 + i * 65536: blob0 + i * 65536 + len(b)] = b
    for k in range(3):
        p = f'/Assets/gbc/common/game{i}.{["gbc", "sav", "sus"][k]}'.encode()
        o = paths0 + (i * 3 + k) * 256; out[o:o + len(p)] = p
for k, p in enumerate((b'/Saves/gbc/common/picker.log', b'/Saves/gbc/common/favorites.cfg', b'/Saves/gbc/common/carts.cfg')):
    o = paths0 + (N * 3 + k) * 256; out[o:o + len(p)] = p
# FPR2: game 5 matches the test cart by title CRC (its header checksums differ: a different revision)
for i, (g, fv) in enumerate(order):
    rec = bytes([0x11, 0x22, 0x33, 0x80]) + struct.pack('<I', zlib.crc32(b'PM_CRYSTAL\0') if (g == games[5] and not FAV) else 0x01020304 + i)
    out[fpr + i * 8: fpr + i * 8 + 8] = rec
for k, d in enumerate(defaults): out[art_off + k * 65536: art_off + k * 65536 + len(d)] = d
open('fav.hex' if FAV else 'vt.hex', 'w').write('\n'.join(f'{b:02x}' for b in out) + '\n')
print('fav.hex' if FAV else 'vt.hex', len(out), 'bytes; default art at', art_off, 'FPR2 at', fpr)
