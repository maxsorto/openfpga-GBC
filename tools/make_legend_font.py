#!/usr/bin/env python3
"""The legend's font: Inter SemiBold at 9 px as a 2-bit alpha ROM (like make_font.py), with the button pictures in
glyph codes 1 to 14. Writes font_sm.hex (64 slots x 16 rows, 24 bits a row: slot 0 blank, 1..26 A to Z, 27 space, 28..41 the pictures)
and font_sm_width.hex (one width per slot), and a preview. The core's leg_code() maps characters to slots the same way.

Pictures: 1 Y, 2 X, 3 A, 4 B (the face button diamond with that button lit), 5 D-pad left and right, 6 D-pad up and
down, 7 Select, 11 L shoulder, 12 R shoulder, 14 D-pad all four. Each is 12 px wide. Code 9 (tab) and 10 (newline)
stay empty. tools/legend_model.py draws the legend from this file the way the core does.

Usage: make_legend_font.py TTF OUT_DIR [--size 9]
"""
import argparse, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SS = 8
CY = 8.0                       # the pictures sit on the text's cap centre (baseline row 12, caps about 6 tall)

def canvas(): return np.zeros((16 * SS, 12 * SS), np.float64)
def disc(c, cx, cy, r, v=1.0):
    yy, xx = np.mgrid[0:16 * SS, 0:12 * SS]
    d = np.hypot((xx + 0.5) / SS - cx, (yy + 0.5) / SS - cy)
    c[:] = np.maximum(c, v * np.clip(r - d + 0.5, 0, 1))
def rrect(c, x0, y0, x1, y1, r, v=1.0):
    yy, xx = np.mgrid[0:16 * SS, 0:12 * SS]
    px = (xx + 0.5) / SS; py = (yy + 0.5) / SS
    qx = np.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r); qy = np.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r)
    d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
    c[:] = np.maximum(c, v * np.clip(0.5 - d, 0, 1))
def quant(c):
    a = c.reshape(16, SS, 12, SS).mean((1, 3))
    return np.where(a < 0.14, 0, np.where(a < 0.45, 1, np.where(a < 0.78, 2, 3)))

def face(lit):
    c = canvas()
    for k, (cx, cy) in dict(x=(6.0, CY - 3.6), y=(2.4, CY), a=(9.6, CY), b=(6.0, CY + 3.6)).items():
        if k == lit: disc(c, cx, cy, 1.9)
        else: disc(c, cx, cy, 1.15, 0.55)
    return quant(c)
def dpad(dirs):
    c = canvas(); w = 1.15
    for d, (x0, y0, x1, y1) in dict(l=(0.8, CY - w, 6, CY + w), r=(6, CY - w, 11.2, CY + w), u=(6 - w, CY - 5.2, 6 + w, CY), d=(6 - w, CY, 6 + w, CY + 5.2)).items():
        rrect(c, x0, y0, x1, y1, 0.7, 1.0 if d in dirs else 0.5)
    return quant(c)
def pill():
    c = canvas(); rrect(c, 1.2, CY - 1.8, 10.8, CY + 1.8, 1.8); return quant(c)
def shoulder(side, ttf=None):
    """L or R: the letter inside a small key outline (a rounded rectangle), so it reads as a labelled button."""
    c = canvas()
    outer = canvas(); rrect(outer, 0.8, CY - 5.0, 11.2, CY + 5.0, 2.2)
    inner = canvas(); rrect(inner, 1.9, CY - 3.9, 10.1, CY + 3.9, 1.4)
    c[:] = np.clip(outer - inner, 0, 1) * 0.55               # the outline, dim like the unlit dots
    # the letter, drawn with the same Inter at 8 px and centred in the key
    f = ImageFont.truetype(ttf, 8)
    im = Image.new("L", (12 * SS, 16 * SS), 0); d = ImageDraw.Draw(im)
    ch = 'L' if side == 'l' else 'R'
    w = f.getlength(ch)
    big = ImageFont.truetype(ttf, 8 * SS)
    d.text(((12 * SS - big.getlength(ch)) / 2, (CY + 2.9) * SS), ch, font=big, fill=255, anchor="ls")
    letter = np.asarray(im).astype(np.float64) / 255.0
    c[:] = np.maximum(c, letter)
    return quant(c)

PICTURES = {1: face('y'), 2: face('x'), 3: face('a'), 4: face('b'), 5: dpad('lr'), 6: dpad('ud'), 7: pill(), 14: dpad('lrud')}

COMPACT = {chr(65 + i): 1 + i for i in range(26)}; COMPACT[' '] = 27
for k in range(1, 15): COMPACT[chr(k)] = 27 + k          # pictures 1..14 at 28..41

def build(ttf, size):
    """64 glyph slots: 0 blank, 1..26 A to Z, 27 space, 28..41 the pictures, the rest blank."""
    PICTURES[11] = shoulder('l', ttf); PICTURES[12] = shoulder('r', ttf)
    f = ImageFont.truetype(ttf, size)
    BASE = 12
    rows = [0] * (64 * 16); widths = [0] * 64
    for ch, code in COMPACT.items():
        c = ord(ch)
        if c in PICTURES:
            g = PICTURES[c]
            for y in range(16):
                w = 0
                for x in range(12): w |= int(g[y, x]) << (2 * x)
                rows[code * 16 + y] = w
            widths[code] = 12; continue
        adv = int(round(f.getlength(ch)))
        im = Image.new("L", (24, 24), 0); d = ImageDraw.Draw(im)
        d.text((0, BASE + 2), ch, font=f, fill=255, anchor="ls")
        for y in range(16):
            w = 0
            for x in range(12):
                v = im.getpixel((x, y + 2)) / 255.0
                q = 0 if v < 0.14 else 1 if v < 0.45 else 2 if v < 0.78 else 3
                w |= q << (2 * x)
            rows[code * 16 + y] = w
        widths[code] = min(12, max(1, adv)) if ch != " " else max(3, adv)
    return rows, widths

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ttf'); ap.add_argument('out'); ap.add_argument('--size', type=int, default=9)
    a = ap.parse_args()
    rows, widths = build(a.ttf, a.size)
    os.makedirs(a.out, exist_ok=True)
    open(os.path.join(a.out, 'font_sm.hex'), 'w').write('\n'.join(f'{r:06x}' for r in rows) + '\n')
    open(os.path.join(a.out, 'font_sm_width.hex'), 'w').write('\n'.join(f'{w:x}' for w in widths) + '\n')
    pv = Image.new('RGB', (12 * 32 * 4, 16 * 2 * 4), (20, 24, 36)); px = pv.load()
    for c in range(64):
        gx, gy = c % 32, c // 32
        for y in range(16):
            for x in range(12):
                q = (rows[c * 16 + y] >> (2 * x)) & 3
                col = tuple(int(p + (q2 - p) * q / 3) for p, q2 in zip((20, 24, 36), (128, 140, 168)))
                for yy in range(4):
                    for xx in range(4): px[(gx * 12 + x) * 4 + xx, (gy * 16 + y) * 4 + yy] = col
    pv.save(os.path.join(a.out, 'font_sm_preview.png'))
    print('font_sm: widths A..Z', widths[1:27], 'space', widths[27])

if __name__ == '__main__': main()
