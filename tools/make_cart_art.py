#!/usr/bin/env python3
"""Draw the default cartridge art the menu shows for a cart that isn't in your library.

Three original illustrations, no logos or text: a gray cart (original Game Boy), a black cart (works on both) and a
clear cart (Game Boy Color only, no corner notch, its board showing through). Each is drawn at 8x with signed
distance fields, so edges, bevels and the label recess shade smoothly, then reduced to the pack's two art sizes.
Alpha is binary: the core draws RGB565 0x0000 in these images as transparent, so the glow behind shows through.

Usage: make_cart_art.py OUT_DIR [--preview preview.png]
Writes dmg-128.png, dmg-80.png, dual-128.png, dual-80.png, cgb-128.png, cgb-80.png (RGBA).
"""
import argparse, os
import numpy as np
from PIL import Image

S = 1024                      # canvas, 8x the 128 px art
BG = np.array([11, 12, 16]) / 255.0   # what edge pixels are blended against before the alpha is made binary

def hexc(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)]) / 255.0

yy, xx = np.mgrid[0:S, 0:S].astype(np.float64) + 0.5

def sd_round_rect(cx, cy, hw, hh, r):
    qx = np.abs(xx - cx) - (hw - r); qy = np.abs(yy - cy) - (hh - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r

def sd_plane(px, py, nx, ny):           # positive on the side the normal points to
    n = np.hypot(nx, ny); return ((xx - px) * nx + (yy - py) * ny) / n

def sd_triangle(p0, p1, p2):
    gx_ = (p0[0] + p1[0] + p2[0]) / 3; gy_ = (p0[1] + p1[1] + p2[1]) / 3
    d = None
    for (ax, ay), (bx, by) in ((p0, p1), (p1, p2), (p2, p0)):
        nx, ny = by - ay, ax - bx
        if (gx_ - ax) * nx + (gy_ - ay) * ny > 0: nx, ny = -nx, -ny   # point the normal away from the middle
        e = sd_plane(ax, ay, nx, ny)
        d = e if d is None else np.maximum(d, e)
    return d

def cover(d, aa=1.2):                   # 1 inside, 0 outside, smooth over ~aa px
    return np.clip(0.5 - d / aa, 0, 1)

def grad(d):
    gy, gx = np.gradient(d); n = np.hypot(gx, gy) + 1e-9
    return gx / n, gy / n

LX, LY = -0.62, -0.78                    # light from the top left

def bevel(d, width, raised=True):
    """Shade an edge band of the given width inside a shape: +1 lit, -1 in shadow."""
    nx, ny = grad(d)
    lam = -(nx * LX + ny * LY)           # outward normal against the light
    t = np.clip(1 + d / width, 0, 1)     # 1 at the edge, 0 at width inside
    prof = t ** 1.6 * (d <= 0)
    return lam * prof * (1 if raised else -1)

def mix(a, b, t):
    t = t[..., None] if np.ndim(t) == 2 else t
    return a * (1 - t) + b * t

def vgrad(top, bottom, y0, y1):
    t = np.clip((yy - y0) / (y1 - y0), 0, 1)[..., None]
    return top * (1 - t) + bottom * t

def draw(kind):
    # proportions of a real cart: 57 x 65 mm
    H = 944; W = H * 57 / 65
    cx, cy = S / 2, S / 2
    x0, x1, y0, y1 = cx - W / 2, cx + W / 2, cy - H / 2, cy + H / 2
    body = sd_round_rect(cx, cy, W / 2, H / 2, 30)
    notch = kind in ('dmg', 'dual')
    if notch:                            # the top right corner is cut so the power switch can lock the cart in
        c = 84
        body = np.maximum(body, sd_plane(x1 - c, y0, 1, -1))
    alpha = cover(body)

    pal = {
        'dmg':  dict(top=hexc('#b9b7b1'), bot=hexc('#96948e'), lab0=hexc('#f1ece0'), lab1=hexc('#d8d1c0'),
                     band=hexc('#34428a'), ink=hexc('#6d7080'), sheen=0.10, spec=0.10),
        'dual': dict(top=hexc('#2c2c31'), bot=hexc('#141417'), lab0=hexc('#30357a'), lab1=hexc('#6a3f9a'),
                     band=hexc('#ece6ff'), ink=hexc('#d9d0ff'), sheen=0.22, spec=0.30),
        'cgb':  dict(top=hexc('#8f99a8'), bot=hexc('#5d6676'), lab0=hexc('#0d6b72'), lab1=hexc('#23aaa3'),
                     band=hexc('#effffd'), ink=hexc('#d6fffa'), sheen=0.18, spec=0.34),
    }[kind]

    col = vgrad(pal['top'], pal['bot'], y0, y1)

    if kind == 'cgb':                    # clear shell: the board, chip and contacts show through a smoky tint
        board = sd_round_rect(cx, cy + 40, W / 2 - 46, H / 2 - 70, 30)
        pcb = cover(board, 40)                # a soft edge: seen through smoky plastic
        inner = vgrad(hexc('#1d4a37'), hexc('#123323'), y0, y1)
        inner = mix(hexc('#20232b'), inner, pcb * 0.95)
        for i in range(7):               # traces
            ty = cy - 40 + i * 52
            inner = mix(inner, hexc('#2f7a55'), cover(np.abs(yy - ty) - 3) * pcb * 0.8)
        chip = sd_round_rect(cx - 120, cy + 150, 130, 95, 10)
        inner = mix(inner, hexc('#141416'), cover(chip))
        chip2 = sd_round_rect(cx + 190, cy + 150, 60, 60, 8)
        inner = mix(inner, hexc('#18181b'), cover(chip2))
        for i in range(30):              # gold fingers along the bottom edge
            fx = x0 + 96 + i * (W - 192) / 29
            finger = sd_round_rect(fx, y1 - 40, 9, 26, 3)
            inner = mix(inner, hexc('#d1ab52'), cover(finger))
        col = mix(inner, col, 0.46)      # the shell over it

    # top band: three grip grooves and a raised arrow pointing into the slot
    for i in range(3):
        gy_ = y0 + 64 + i * 30
        groove = sd_round_rect(cx - (24 if notch else 0), gy_, W / 2 - (150 if notch else 120), 6, 6)
        col = mix(col, col * 0.62, cover(groove))
        col = mix(col, np.minimum(col * 1.25 + 0.04, 1), cover(np.abs(yy - (gy_ + 8)) - 1.5) * cover(groove - 10) * (1 - cover(groove)))
    ax, ay = cx, y0 + 204
    arrow = sd_triangle((ax - 58, ay - 30), (ax + 58, ay - 30), (ax, ay + 36)) - 6
    ac = cover(arrow)                    # pressed into the plastic: dark fill, light lip on the lower right
    lip = np.clip(np.roll(np.roll(ac, 7, 0), 7, 1) - ac, 0, 1)
    col = mix(col, col * 0.62, ac)
    col = mix(col, np.minimum(col * 1.3 + 0.06, 1), lip * 0.8)

    # label recess and the label
    lw, lh = W / 2 - 64, 300
    lcy = cy + 140
    recess = sd_round_rect(cx, lcy, lw + 14, lh + 14, 26)
    col = mix(col, col * 0.78, cover(recess))
    rb = bevel(recess, 14, raised=False)
    col = np.clip(col + (rb * 0.20)[..., None], 0, 1)
    label = sd_round_rect(cx, lcy, lw, lh, 16)
    lab = vgrad(pal['lab0'], pal['lab1'], lcy - lh, lcy + lh)
    band = sd_round_rect(cx, lcy - lh + 58, lw, 58, 16)
    band = np.maximum(band, sd_plane(0, lcy - lh + 116, 0, 1))
    lab = mix(lab, pal['band'], cover(band))
    for i, frac in enumerate((0.72, 0.52, 0.60)):   # three lines where a title would be printed
        ly = lcy - 40 + i * 74
        line = sd_round_rect(cx - lw + 80 + lw * frac - 30, ly, lw * frac - 30, 12, 12)
        lab = mix(lab, pal['ink'], cover(line) * 0.55)
    # a soft diagonal sheen across the label paper
    t = (xx - (cx - lw)) / (2 * lw) * 0.8 + (yy - (lcy - lh)) / (2 * lh) * 0.2
    lab = np.clip(lab + (np.exp(-((t - 0.28) / 0.10) ** 2) * pal['sheen'])[..., None], 0, 1)
    col = mix(col, lab, cover(label))

    # body bevel and a glossy streak
    bb = bevel(body, 22, raised=True)
    col = np.clip(col + (bb * 0.28)[..., None], 0, 1)
    streak = (xx - x0) / W * 0.75 - (yy - y0) / H * 0.25
    col = np.clip(col + (np.exp(-((streak - 0.14) / 0.06) ** 2) * pal['spec'] * 0.6 * (1 - cover(label)))[..., None], 0, 1)
    # a thin dark outline so the silhouette reads against any glow
    rim = cover(np.abs(body + 2.5) - 2.5)
    col = mix(col, col * 0.45, rim * 0.8)
    return col, alpha

def reduce(col, alpha, size):
    pre = np.dstack([col * alpha[..., None], alpha])
    img = Image.fromarray((pre * 255 + 0.5).astype(np.uint8))
    img = img.resize((size, size), Image.Resampling.LANCZOS)
    a = np.asarray(img).astype(np.float64) / 255.0
    al = a[..., 3]
    rgb = a[..., :3] + BG * (1 - al[..., None])         # premultiplied over the dark background
    out = np.zeros((size, size, 4), np.uint8)
    keep = al >= 0.5
    out[..., :3] = np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.where(keep, 255, 0)
    out[~keep, :3] = 0
    return Image.fromarray(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--preview')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    tiles = []
    for kind in ('dmg', 'dual', 'cgb'):
        col, alpha = draw(kind)
        for size in (128, 80):
            im = reduce(col, alpha, size)
            im.save(os.path.join(a.out, f'{kind}-{size}.png'))
            if size == 128: tiles.append(im)
    if a.preview:
        pv = Image.new('RGB', (3 * 128 * 3 + 4 * 24, 128 * 3 + 48), (0, 0, 0))
        for i, t in enumerate(tiles):
            big = t.resize((384, 384), Image.Resampling.NEAREST)
            pv.paste(big, (24 + i * (384 + 24), 24), big)
        pv.save(a.preview)

if __name__ == '__main__': main()
