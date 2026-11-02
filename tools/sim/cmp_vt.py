#!/usr/bin/env python3
"""Compare a tb_vt frame with the model: cart view at rest. Usage: cmp_vt.py frame.ppm glow accent_hex game|dmg title"""
import sys, os
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.expanduser('~/Documents/analogue-pocket/openfpga-GBC/tools'))
import anim_model as m
ppm, glow, acc, which, title = sys.argv[1], int(sys.argv[2]), int(sys.argv[3], 16), sys.argv[4], sys.argv[5]
pack = bytes(int(l, 16) for l in open(os.path.expanduser('~/Documents/analogue-pocket/cover-picker/sim/vt.hex')))
N = 8; blob0 = 528 + N * 128
def art(i, base=None):
    o = (blob0 + i * 65536) if base is None else base
    w = np.frombuffer(pack[o:o + 45568], '<u2'); return w[:16384].reshape(128, 128), w[16384:16384 + 6400].reshape(80, 80)
import struct
art_off = struct.unpack('<I', pack[100:104])[0]
if which == 'dmg': a = art(0, art_off); key = True
else: a = art(int(which)); key = False
sc = dict(covers=[m.cart_cover(a[0], a[1], key=key)], glow=glow, accent=acc, title=title, plat='CARTRIDGE', cnt=1, idx=0)
want = m.render(sc).astype(int)
got = np.asarray(Image.open(ppm).convert('RGB')).astype(int)
d = np.abs(want - got).max(-1)
print(f'pixels differing: {(d > 0).sum()} of {d.size}; > 2 levels: {(d > 2).sum()}; max {d.max()}')
ys, xs = np.nonzero(d > 2)
if len(ys): print('first bad at', xs[0], ys[0], 'want', want[ys[0], xs[0]], 'got', got[ys[0], xs[0]], ' bbox', xs.min(), ys.min(), xs.max(), ys.max())
Image.fromarray(np.concatenate([want, got, np.minimum(d * 40, 255)[..., None].repeat(3, -1)], 1).astype(np.uint8)).save(ppm + '.cmp.png')
