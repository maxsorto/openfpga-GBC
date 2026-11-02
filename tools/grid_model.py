#!/usr/bin/env python3
"""Reference model of grid mode: the lattice geometry, the pop cover, the moves, the row scroll and the morph between
cover flow and the grid. Frames come from anim_model's renderer, so the covers, reflections, corners, text and
position bar are the ones the core draws.

Usage:
  grid_model.py preview PACK OUT.mp4 [--game TITLE] [--stills DIR]
  grid_model.py tables            (the easing curves as Verilog case tables)
"""
import argparse, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from anim_model import Pack, render, list_row, write_mp4, W, H

# ------------------------------------------------------------------ geometry (320 x 288 menu)
COLS, ROWS = 4, 2              # visible lattice
CELL = 72                      # cell art size (sampled from the 80 px art, step 284)
GAP = 4                        # same gap as the cover flow's side covers
PITCH_X = CELL + GAP           # 76
COL_X = [10 + c * PITCH_X for c in range(COLS)]        # 10, 86, 162, 238
ROW_Y = [8, 102]               # row tops; art 72 + reflection 15 ends at 95 and 189
PITCH_Y = ROW_Y[1] - ROW_Y[0]  # 94
POP = 80                       # the selected cell, drawn 4 px larger on each side so it fills its gaps
CLIP_Y = 192                   # the lattice is cut here; the title block below is the cover flow's
DIM = 9                        # brightness of the other cells (the cover flow's side covers use 9 too)

def ytop(top, S):              # anim_model places a cover by its centre row: top = 96 - S//2 + y
    return top - (96 - S // 2)

# ------------------------------------------------------------------ curves (one value per frame)
def ease_out(t, p=3):
    return 1 - (1 - t) ** p

MOVE_N = 6                     # the pop slides to the next cell
SCROLL_N = 8                   # the rows slide one pitch
MORPH_N = 12                   # flow <-> grid

def move_curve():              # 0..256 over MOVE_N frames
    return [int(round(256 * ease_out((f + 1) / MOVE_N))) for f in range(MOVE_N)]

def scroll_curve():            # 0..PITCH_Y over SCROLL_N frames
    return [int(round(PITCH_Y * ease_out((f + 1) / SCROLL_N))) for f in range(SCROLL_N)]

def morph_curve():             # 0..256 over MORPH_N frames
    return [int(round(256 * ease_out((f + 1) / MORPH_N))) for f in range(MORPH_N)]

def lerp(a, b, k):             # k is 0..256
    return a + (((b - a) * k) >> 8)

# ------------------------------------------------------------------ scenes
def compose(covers, title, plat, cnt, idx, tl=8):
    """Lattice frame: covers clipped above CLIP_Y, the text block from a text-only render below it."""
    top = render(dict(covers=covers, cnt=1))
    txt = render(dict(covers=[], title=title, plat=plat, cnt=cnt, idx=idx, tl=tl))
    top[CLIP_Y:] = txt[CLIP_Y:]
    return top

class Grid:
    def __init__(self, p, idx):
        self.p = p; self.n = p.count
        self.idx = idx
        self.top = idx // COLS           # list row shown as the first visible row
        self.cache = {}

    def art(self, g):
        if g not in self.cache: self.cache[g] = self.p.art(g)
        return self.cache[g]

    def cell(self, g, x, top, b=DIM, S=CELL):
        a128, a80 = self.art(g)
        return dict(art128=a128, art80=a80, x=x, S=S, b=b, y=ytop(top, S))

    def lattice(self, top_row, dy=0, rows=(0, 1), b=DIM, skip=None):
        covers = []
        for r in rows:
            lr = top_row + r
            for c in range(COLS):
                g = lr * COLS + c
                if g >= self.n or g == skip: continue
                covers.append(self.cell(g, COL_X[c], ROW_Y[0] + r * PITCH_Y + dy, b=b))
        return covers

    def pop(self, g, x, top, S=POP, b=16):
        return self.cell(g, x, top, b=b, S=S)

    def cell_xy(self, g, top_row):
        r = g // COLS - top_row; c = g % COLS
        return COL_X[c], ROW_Y[0] + r * PITCH_Y

    def title(self, g):
        t, fl = self.p.entry(g)
        return t, ('GAME BOY' if fl & 1 else 'GAME BOY COLOR')

def story(p, start):
    frames = []
    gr = Grid(p, start)
    title, plat = gr.title(start)
    n = p.count

    def flow_rest(k, g):
        t, pl = gr.title(g)
        for _ in range(k):
            frames.append(render(dict(covers=list_row(p, g), title=t, plat=pl, cnt=n, idx=g)))

    def grid_rest(k, g):
        t, pl = gr.title(g)
        x, top = gr.cell_xy(g, gr.top)
        for _ in range(k):
            frames.append(compose(gr.lattice(gr.top, skip=g) + [gr.pop(g, x - 4, top - 4)], t, pl, n, g))

    def morph(g, to_grid):
        """The centre cover shrinks (or grows) between the flow's 128 at (96, 32) and the pop at its cell; the side
        covers fade over the first half, the lattice over the second."""
        t, pl = gr.title(g)
        x1, top1 = gr.cell_xy(g, gr.top)
        curve = morph_curve()
        for f in range(MORPH_N):
            k = curve[f] if to_grid else 256 - curve[f]
            S = lerp(128, POP, k); x = lerp(96, x1 - 4, k); top = lerp(32, top1 - 4, k)
            # the side covers go over the first four frames, then the lattice comes in over the last eight: never both
            # in one frame, so a line never has to fetch the side covers and a lattice row together
            fo = f if to_grid else MORPH_N - 1 - f
            side_b = max(0, DIM - (DIM * (fo + 1)) // 4)
            lat_b = min(DIM, max(0, (DIM * (fo - 3)) // 8))
            covers = []
            if lat_b: covers += gr.lattice(gr.top, b=lat_b, skip=g)
            if side_b:
                for cv in list_row(p, g):
                    if cv['S'] == 80: cv['b'] = side_b; covers.append(cv)
            covers.append(gr.pop(g, x, top, S=S))
            frames.append(compose(covers, t, pl, n, g))

    def move(g0, g1):
        """The pop slides from cell g0 to cell g1 inside the window; the title fades out then in."""
        t0, pl0 = gr.title(g0); t1, pl1 = gr.title(g1)
        x0, top0 = gr.cell_xy(g0, gr.top); x1, top1 = gr.cell_xy(g1, gr.top)
        for f, k in enumerate(move_curve()):
            x = lerp(x0, x1, k); top = lerp(top0, top1, k)
            tl = max(8 - 4 * f, 0) if f < 2 else min(4 * (f - 2), 8)
            t, pl = (t0, pl0) if f < 2 else (t1, pl1)
            covers = gr.lattice(gr.top, skip=g1 if f == MOVE_N - 1 else None) + [gr.pop(g1, x - 4, top - 4)]
            frames.append(compose(covers, t, pl, n, g1, tl=tl))
        gr.idx = g1

    def scroll(g0, g1, down=True):
        """g1 is in the row past the window: the rows slide one pitch, the new row enters from the edge, and the pop
        moves with the lattice from g0's cell to g1's."""
        t0, pl0 = gr.title(g0); t1, pl1 = gr.title(g1)
        new_top = gr.top + (1 if down else -1)
        x0, top0 = gr.cell_xy(g0, gr.top)
        x1, top1 = gr.cell_xy(g1, new_top)
        rows = (0, 1, 2) if down else (-1, 0, 1)
        for f, s in enumerate(scroll_curve()):
            dy = -s if down else s
            k = move_curve()[min(f, MOVE_N - 1)]
            x = lerp(x0, x1, k); top = lerp(top0, top1, k)
            tl = max(8 - 4 * f, 0) if f < 2 else min(4 * (f - 2), 8)
            t, pl = (t0, pl0) if f < 2 else (t1, pl1)
            covers = gr.lattice(gr.top, dy=dy, rows=rows) + [gr.pop(g1, x - 4, top - 4)]
            frames.append(compose(covers, t, pl, n, g1, tl=tl))
        gr.top = new_top; gr.idx = g1

    def go(g1):
        """Move the selection to g1: a slide inside the window, or a row scroll when its row is outside it."""
        g0 = gr.idx; r = g1 // COLS - gr.top
        if 0 <= r < ROWS: move(g0, g1)
        else: scroll(g0, g1, down=r >= ROWS)

    g = start
    flow_rest(30, g)
    morph(g, True)
    grid_rest(24, g)
    for _ in range(3):
        g += 1; go(g); grid_rest(12, g)        # Right wraps into the next row at a row end
    g += COLS; go(g); grid_rest(16, g)         # Down
    g += COLS; go(g); grid_rest(20, g)         # Down again
    g -= 1; go(g); grid_rest(12, g)            # Left
    g -= COLS; go(g); grid_rest(20, g)         # Up
    morph(g, False)
    flow_rest(30, g)
    return frames

# ------------------------------------------------------------------ Verilog tables
def side_b_tab():              # the flow's side covers during the morph (frames 0..3 going in)
    return [max(0, DIM - (DIM * (f + 1)) // 4) for f in range(MORPH_N)]

def lat_b_tab():               # the lattice during the morph (frames 4..11 going in)
    return [min(DIM, max(0, (DIM * (f - 3)) // 8)) for f in range(MORPH_N)]

def vcase(name, width, vals, iw):
    lines = [f'function [{width-1}:0] {name}(input [{iw-1}:0] i);']
    lines.append('    case (i) ' + ' '.join(f'{i}: {name} = {v};' for i, v in enumerate(vals)) + f' default: {name} = {vals[-1]}; endcase')
    lines.append('endfunction')
    return '\n'.join(lines)

def verilog():
    return '\n'.join(['// ---- generated by tools/grid_model.py tables: do not edit by hand',
                      f'localparam [3:0] GN_MOVE = {MOVE_N}, GN_SCROLL = {SCROLL_N}, GN_MORPH = {MORPH_N};',
                      vcase('grid_move', 9, move_curve(), 3), vcase('grid_scroll', 7, scroll_curve(), 3),
                      vcase('grid_morph', 9, morph_curve(), 4), vcase('grid_sideb', 5, side_b_tab(), 4), vcase('grid_latb', 5, lat_b_tab(), 4),
                      '// ---- end of generated tables'])

def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    pv = sp.add_parser('preview'); pv.add_argument('pack'); pv.add_argument('out')
    pv.add_argument('--game', default="Kirby's Dream Land 2"); pv.add_argument('--stills')
    sp.add_parser('tables')
    a = ap.parse_args()
    if a.cmd == 'tables':
        print(verilog()); return
    p = Pack(a.pack)
    frames = story(p, p.find(a.game))
    if a.stills:
        from PIL import Image
        os.makedirs(a.stills, exist_ok=True)
        for i, f in enumerate(frames): Image.fromarray(f).save(os.path.join(a.stills, f'f{i:03d}.png'))
    write_mp4(frames, a.out)
    print(len(frames), 'frames')

if __name__ == '__main__': main()
