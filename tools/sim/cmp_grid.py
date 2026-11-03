#!/usr/bin/env python3
"""Compare a tb_grid frame with the model's grid at rest.
Usage: cmp_grid.py frame.ppm idx top    (idx: selected game, top: list row shown as the top lattice row)"""
import sys, os, struct
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.expanduser('~/Documents/analogue-pocket/openfpga-GBC/tools'))
import anim_model as m, grid_model as g
ppm, idx, top = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pack = bytes(int(l, 16) for l in open(os.path.expanduser('~/Documents/analogue-pocket/cover-picker/sim/grid.hex')))

class HexPack:
    def __init__(self, b):
        self.b = b; self.count = struct.unpack('<H', b[6:8])[0]; self.blob0 = 528 + self.count * 128
    def entry(self, i):
        e = self.b[528 + i * 128: 528 + (i + 1) * 128]
        return e[:40].split(b'\0')[0].decode('latin-1'), e[40]
    def art(self, i):
        o = self.blob0 + i * 65536
        w = np.frombuffer(self.b[o:o + 45568], '<u2'); return w[:16384].reshape(128, 128), w[16384:16384 + 6400].reshape(80, 80)

p = HexPack(pack)
gr = g.Grid(p, idx); gr.top = top
t, pl = gr.title(idx)
x, y = gr.cell_xy(idx, top)
want = g.compose(gr.lattice(top, skip=idx) + [gr.pop(idx, x - 4, y - 4)], t, pl, p.count, idx, leg=(3, 3, True)).astype(int)
got = np.asarray(Image.open(ppm).convert('RGB')).astype(int)
d = np.abs(want - got).max(-1)
print(f'pixels differing: {(d > 0).sum()} of {d.size}; > 2 levels: {(d > 2).sum()}; max {d.max()}')
ys, xs = np.nonzero(d > 2)
if len(ys): print('first bad at', xs[0], ys[0], 'want', want[ys[0], xs[0]], 'got', got[ys[0], xs[0]], ' bbox', xs.min(), ys.min(), xs.max(), ys.max())
Image.fromarray(np.concatenate([want, got, np.minimum(d * 40, 255)[..., None].repeat(3, -1)], 1).astype(np.uint8)).save(ppm + '.cmp.png')
