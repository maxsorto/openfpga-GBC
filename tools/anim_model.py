#!/usr/bin/env python3
"""Reference model of the menu's cartridge transitions: the curves the core uses, and a renderer that draws frames
the way the core's hi-res menu does (cover geometry, art sampling, reflections, corners, text, position bar), so the
animation can be tuned and previewed off the hardware. `tables` prints the curves as Verilog for cover_picker.sv.

Usage:
  anim_model.py preview PACK OUT.mp4 [--crystal N] [--list N] [--cart-art DIR]
  anim_model.py tables
"""
import argparse, math, os, struct, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 320, 288
D = 256                        # rows between the list row and the cartridge row (both fully off screen at the ends)

# ------------------------------------------------------------------ curves (one value per menu frame, ~59.7 Hz)
def ease_out_back(t, c1):
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2

def u_in():
    """A cart drops in: the rows travel D, overshoot a few rows as it seats, and settle."""
    n = 22
    return [min(int(round(D * ease_out_back(min(f + 1, n) / n, 0.75))), D + 15) for f in range(n)] + [D] * 2

def u_out():
    """A cart lifts out: a small dip, then an ease in and out over D."""
    dip = [-2, -4, -4, -3]
    n = 22
    rest = [int(round(D * (4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2))) for t in ((f + 1) / n for f in range(n))]
    return dip + rest

def seat_frame(u):
    return next(i for i, v in enumerate(u) if v >= D)

GLOW_REST = 87                 # glow level at rest in the cart view (0..255)
BLOOM = 204                    # glow level the moment a cart seats
RING_N = 30
TXT_IN, TXT_OUT = 16, 22       # transition frame after which the new title may fade in

def glow_step(g, t):           # one frame of the approach toward t: 1/16 of the way, at least one level
    d = t - g
    st = d >> 4
    if st == 0 and d != 0: st = 1 if d > 0 else -1
    return g + st

def ring_params(f):
    """Ring f frames after the seat: squared radius, band B (~10 r: |d^2 - r^2| < B is a 5 px half width) and the
    multiplier that turns B - |d^2 - r^2| into a 0..255 strength."""
    t = f / RING_N
    r = 64 + 190 * (1 - (1 - t) ** 3)
    amp = 0.85 * (1 - t) ** 1.6
    B = int(round(10 * r))
    return int(round(r * r)), B, int(round(amp * 255 * 65536 / B))

GLINT_W = [int(max(0, 1 - d / 16) ** 1.5 * 14) for d in range(16)]
BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
GLINT_N = 26

def glint_pos(f):              # band centre along x + y of the cover (0..254), sweeping past both corners
    t = f / (GLINT_N - 1)
    return int(round(-48 + (254 + 96) * (0.5 - 0.5 * math.cos(math.pi * t))))

def glow_lut():
    """Glow strength (0..255) by distance from the centre of the cart's cover, indexed by d^2 >> 8."""
    out = []
    for i in range(256):
        d = math.sqrt(i * 256 + 128)
        v = 0.70 * math.exp(-(max(d - 60, 0) / 26) ** 2) + 0.30 * math.exp(-(max(d - 40, 0) / 115) ** 2)
        out.append(int(round(255 * v)))
    return out

# ------------------------------------------------------------------ pack reading
class Pack:
    def __init__(self, path):
        self.f = open(path, 'rb')
        h = self.f.read(16)
        assert h[:4] == b'GBCV'
        self.ver, self.count = struct.unpack('<HH', h[4:8])
        self.blob0 = 528 + self.count * 128
    def entry(self, i):
        self.f.seek(528 + i * 128); e = self.f.read(128)
        return e[:40].split(b'\0')[0].decode('latin-1'), e[40]
    def find(self, needle):
        for i in range(self.count):
            if needle.lower() in self.entry(i)[0].lower(): return i
        raise KeyError(needle)
    def art(self, i):
        self.f.seek(self.blob0 + i * 65536); b = self.f.read(45568)
        w = np.frombuffer(b, '<u2')
        return w[:16384].reshape(128, 128), w[16384:16384 + 6400].reshape(80, 80)

def png_art(path):
    from PIL import Image
    im = np.asarray(Image.open(path).convert('RGBA')).astype(np.int32)
    r, g, b, a = im[..., 0], im[..., 1], im[..., 2], im[..., 3]
    w = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    w = np.where(w == 0, 1, w)
    return np.where(a == 0, 0, w).astype(np.uint16)

# ------------------------------------------------------------------ font
def load_font():
    rows = [int(l, 16) for l in open(os.path.join(HERE, '..', '..', 'cover-picker', 'sim', 'font_hr.hex'))]
    wid = [int(l, 16) for l in open(os.path.join(HERE, '..', '..', 'cover-picker', 'sim', 'font_hr_width.hex'))]
    return rows, wid

FONT = None
def text_mask(s):
    """2-bit alpha columns for a string, as the layout lays them out (advance widths include the spacing)."""
    global FONT
    if FONT is None: FONT = load_font()
    rows, wid = FONT
    cols = []
    for ch in s:
        c = ord(ch) & 0x7F; gw = wid[c]
        for col in range(gw):
            cols.append([(rows[c * 16 + r] >> (2 * col)) & 3 if col < 12 else 0 for r in range(16)])
    return np.array(cols, np.int32).T if cols else np.zeros((16, 0), np.int32)

TAL = np.array([0, 5, 11, 16])

# ------------------------------------------------------------------ renderer
def expand(p):
    r = ((p >> 11) & 31); g = (p >> 5) & 63; b = p & 31
    return np.stack([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)], -1).astype(np.int32)

def mixw(a, b, w):                 # a*(16-w)/16 + b*w/16, the core's mix()
    return (a * (16 - w) + b * w) >> 4

BAYER = np.array(BAYER4) * 16 + 8

def render(sc):
    yy, xx = np.mgrid[0:H, 0:W]
    out = np.zeros((H, W, 3), np.int32)
    # background: the cart's glow
    g = sc.get('glow', 0)
    if g:
        lut = np.array(glow_lut())
        dx = xx - 160; dy = yy - 96
        I = lut[np.minimum((dx * dx + dy * dy) >> 8, 255)]
        acc = expand(np.uint16(sc['accent']))
        k = (I * g) >> 8                                  # 0..255
        v = acc * k[..., None] + BAYER[yy & 3, xx & 3][..., None]
        out = np.clip(v >> 8, 0, 255)
    if sc.get('ring') is not None:
        r2, B, M = ring_params(sc['ring'])
        dx = xx - 160; dy = yy - 96
        e = np.abs(dx * dx + dy * dy - r2)
        w8 = np.where(e < B, ((B - e) * M) >> 16, 0)
        acc = expand(np.uint16(sc['accent']))
        lite = (acc + 255) >> 1
        out = np.maximum(out, (lite * w8[..., None]) >> 8)
    bg = out.copy()
    # covers
    for cv in sc['covers']:
        S, x0, b = cv['S'], cv['x'], cv['b']
        top = 96 - S // 2 + cv.get('y', 0)
        R = (S * 7) >> 5
        art = cv['art128'] if S > 80 else cv['art80']
        AS = 128 if S > 80 else 80
        step = 256 if S == 0 else (80 * 256) // S if S <= 80 else (128 * 256) // S
        lx = xx - x0; ly = yy - top
        m = (lx >= 0) & (lx < S) & (ly >= 0) & (ly < S + R)
        if not m.any(): continue
        refl = ly >= S
        row = np.where(refl, S - 1 - (ly - S), ly)
        sy = (row * step) >> 8
        sx = (np.clip(lx, 0, S - 1) * step) >> 8
        pix = art[np.clip(sy, 0, AS - 1), np.clip(sx, 0, AS - 1)]
        c = expand(pix)
        if b != 16: c = (c * b) >> 4
        hm = S - 1
        ax = np.where(lx < 6, lx, np.where(lx > hm - 6, hm - lx, 6))
        ay = np.where(ly < 6, ly, np.where(~refl & (ly > hm - 6), hm - ly, 6))
        cut = ~refl & (ax < 6) & (ay < 6) & ((6 - ax) ** 2 + (6 - ay) ** 2 > 30)
        a = np.where(refl, (R - 1 - (ly - S)) >> 2, 16)
        # the shine that crosses a cart as it seats
        if cv.get('glint') is not None:
            dd = np.abs(lx + ly - cv['glint'])
            gw = np.where(refl | (dd >= 16), 0, np.array(GLINT_W)[np.minimum(dd, 15)])
            c = mixw(c, 255, gw[..., None])
        keyed = (pix == 0) & cv.get('key', False)
        draw = m & ~cut & ~keyed
        val = mixw(bg, c, a[..., None])
        out = np.where(draw[..., None], val, out)
    # text
    tl = sc.get('tl', 8)
    for s, y0, colr in ((sc.get('title', ''), 200, (246, 246, 250)), (sc.get('plat', ''), 222, (128, 140, 168))):
        msk = text_mask(s)
        if msk.shape[1] == 0 or tl == 0: continue
        wdt = msk.shape[1]; st = 160 - (wdt >> 1)
        al = TAL[msk]; al = ((al * (tl * 2)) >> 4)
        reg = out[y0:y0 + 16, st:st + wdt]
        colr = np.array(colr)
        out[y0:y0 + 16, st:st + wdt] = np.where((al > 0)[..., None], mixw(reg, colr, al[..., None]), reg)
    # position
    cnt, idx = sc.get('cnt', 1), sc.get('idx', 0)
    HD = 256
    if cnt <= 1: pass                    # no position for a single item (the cart view)
    elif cnt > 32:
        pos = idx * 120 // (cnt - 1)
        for y in range(HD, HD + 4):
            for x in range(96, 224):
                hdx = x - 96; cur = pos <= hdx < pos + 8; px = hdx - pos
                if cur and not ((px in (0, 7)) and y in (HD, HD + 3)): out[y, x] = (232, 236, 244)
                elif not cur and y in (HD + 1, HD + 2): out[y, x] = (74, 82, 104)
    else:
        st = 160 - cnt * 4
        for y in range(HD, HD + 4):
            for x in range(st, st + cnt * 8):
                hdx = x - st; cur = hdx >> 3 == idx; px = hdx & 7
                if cur and not ((px in (0, 7)) and y in (HD, HD + 3)): out[y, x] = (232, 236, 244)
                elif not cur and 2 <= px < 6: out[y, x] = (74, 82, 104)
    return np.clip(out, 0, 255).astype(np.uint8)

# ------------------------------------------------------------------ the preview's story
def list_row(p, i, y=0, ylag=None):
    n = p.count
    covers = []
    for k, (gi, x, S, b) in enumerate((((i - 1) % n, 12, 80, 9), (i, 96, 128, 16), ((i + 1) % n, 228, 80, 9))):
        a128, a80 = p.art(gi)
        covers.append(dict(art128=a128, art80=a80, x=x, S=S, b=b, y=(y if k == 1 or ylag is None else ylag)))
    return covers

def cart_cover(art128, art80, y=0, key=False, glint=None):
    return dict(art128=art128, art80=art80, x=96, S=128, b=16, y=y, key=key, glint=glint)

def story(p, list_i, cart_i, cart_art):
    """List at rest, a known cart in, rest, out, an unknown cart in, rest."""
    frames = []
    title_l, gb_l = p.entry(list_i)
    plat_l = 'GAME BOY' if gb_l & 1 else 'GAME BOY COLOR'
    a128, a80 = p.art(cart_i)
    title_c = p.entry(cart_i)[0]
    acc_known = 0x7D3F                   # a warm gold, what the app would compute for the Crystal cover
    acc_unk = 0xA59F
    unk128, unk80 = cart_art
    uin, uout = u_in(), u_out()
    seat = seat_frame(uin)
    st = dict(glow=0.0, accent=acc_known)

    def rest_list(n, plat=plat_l):
        for _ in range(n):
            frames.append(render(dict(covers=list_row(p, list_i), title=title_l, plat=plat, cnt=p.count, idx=list_i, glow=0)))

    def drop_in(art, title, accent, key, fade_from):
        g = fade_from or 0; tl = 8
        for f in range(seat + GLINT_N + 40):
            u = uin[f] if f < len(uin) else D
            lag = uin[max(f - 2, 0)] if f < len(uin) else D
            if f < seat: g = max(0, g - 38)
            elif f == seat: g = BLOOM
            else: g = glow_step(g, GLOW_REST)
            gl = glint_pos(f - seat) if seat <= f < seat + GLINT_N else None
            covers = [cart_cover(art[0], art[1], y=u - D, key=key, glint=gl)]
            if fade_from is None:            # coming from the list: it is pushed down and out
                covers += [c for c in list_row(p, list_i, y=u, ylag=lag)]
            tl_now = max(tl - 3 * f, 0) if f < 3 else (min(2 * (f - seat - 4), 8) if f > seat + 4 else 0)
            showing_new = f >= 3
            rg = f - seat if seat <= f < seat + RING_N else None
            frames.append(render(dict(covers=covers, glow=g, accent=accent, ring=rg,
                                      title=title if showing_new else title_l, plat='CARTRIDGE' if showing_new else plat_l,
                                      tl=tl_now, cnt=1 if showing_new else p.count, idx=0 if showing_new else list_i)))
        return g

    def lift_out(art, accent, key, g):
        for f in range(len(uout) + 24):
            u = uout[f] if f < len(uout) else D
            lag = uout[max(f - 3, 0)] if f < len(uout) else D
            g = max(0, g - 15)
            covers = [cart_cover(art[0], art[1], y=-u, key=key)] + list_row(p, list_i, y=D - u, ylag=D - lag)
            tl_now = max(8 - 3 * f, 0) if f < 3 else (min(2 * (f - len(uout)), 8) if f > len(uout) else 0)
            showing_new = f >= 3
            frames.append(render(dict(covers=covers, glow=g, accent=accent, title=title_l if showing_new else title_c,
                                      plat='CARTRIDGE REMOVED' if showing_new else 'CARTRIDGE', tl=tl_now,
                                      cnt=p.count if showing_new else 1, idx=list_i if showing_new else 0)))

    def rest_cart(n, art, title, accent, key):
        for _ in range(n):
            frames.append(render(dict(covers=[cart_cover(art[0], art[1], key=key)], glow=GLOW_REST, accent=accent,
                                      title=title, plat='CARTRIDGE', cnt=1, idx=0)))

    rest_list(40)
    g = drop_in((a128, a80), title_c, acc_known, False, None)
    rest_cart(50, (a128, a80), title_c, acc_known, False)
    lift_out((a128, a80), acc_known, False, GLOW_REST)
    rest_list(40, 'CARTRIDGE REMOVED')
    drop_in((unk128, unk80), 'KLAX', acc_unk, True, None)
    rest_cart(60, (unk128, unk80), 'KLAX', acc_unk, True)
    return frames

def vcase(name, width, vals, iw, signed=False, default=None):
    sg = 'signed ' if signed else ''
    body = ' '.join(f'{i}: {name} = {v};' for i, v in enumerate(vals))
    d = vals[-1] if default is None else default
    return (f'function {sg}[{width - 1}:0] {name}(input [{iw - 1}:0] i);\n'
            f'    case (i) {body} default: {name} = {d}; endcase\nendfunction')

def verilog():
    ui, uo = u_in(), u_out()
    rp = [ring_params(f) for f in range(RING_N)]
    out = [f'// ---- generated by tools/anim_model.py tables: do not edit by hand',
           f'localparam [5:0] VN_IN = {len(ui)}, VN_OUT = {len(uo)}, V_SEAT = {seat_frame(ui)}, V_TXT_IN = {TXT_IN}, V_TXT_OUT = {TXT_OUT};',
           f'localparam [4:0] RING_N = {RING_N}, GLINT_N = {GLINT_N};',
           f'localparam [7:0] GLOW_REST = {GLOW_REST}, GLOW_BLOOM = {BLOOM};',
           vcase('u_in_f', 11, ui, 6, True),
           vcase('u_out_f', 11, [v if v >= 0 else f"-11'sd{-v}" for v in uo], 6, True),
           vcase('glint_p', 11, [v if v >= 0 else f"-11'sd{-v}" for v in (glint_pos(f) for f in range(GLINT_N))], 5, True, 400),
           vcase('glint_w', 4, GLINT_W, 4),
           vcase('ring_r2', 17, [r[0] for r in rp], 5, False, 0),
           vcase('ring_b', 12, [r[1] for r in rp], 5, False, 0),
           vcase('ring_m', 15, [r[2] for r in rp], 5, False, 0),
           'function [7:0] glow_i(input [7:0] i);',
           '    case (i) ' + ' '.join(f'{i}: glow_i = {v};' for i, v in enumerate(glow_lut()) if v) + ' default: glow_i = 0; endcase',
           'endfunction',
           '// ---- end of generated tables']
    return '\n'.join(out)

def write_mp4(frames, out, scale=3):
    h, w = frames[0].shape[:2]
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', '59.73',
           '-i', '-', '-vf', f'scale={w * scale}:{h * scale}:flags=neighbor', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
           '-crf', '12', '-preset', 'slow', out]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames: pr.stdin.write(f.tobytes())
    pr.stdin.close(); pr.wait()

def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    pv = sp.add_parser('preview'); pv.add_argument('pack'); pv.add_argument('out')
    pv.add_argument('--crystal', default='Pokemon - Crystal'); pv.add_argument('--list', default="Kirby's Dream Land 2")
    pv.add_argument('--cart-art', default=os.path.join(HERE, '..', 'companion', 'server', 'assets', 'carts'))
    pv.add_argument('--stills')
    sp.add_parser('tables')
    a = ap.parse_args()
    if a.cmd == 'tables':
        print(verilog()); return
    p = Pack(a.pack)
    li, ci = p.find(a.list), p.find(a.crystal)
    art = (png_art(os.path.join(a.cart_art, 'dmg-128.png')), png_art(os.path.join(a.cart_art, 'dmg-80.png')))
    frames = story(p, li, ci, art)
    if a.stills:
        from PIL import Image
        os.makedirs(a.stills, exist_ok=True)
        for i, f in enumerate(frames): Image.fromarray(f).save(os.path.join(a.stills, f'f{i:03d}.png'))
    write_mp4(frames, a.out)
    print(len(frames), 'frames')

if __name__ == '__main__': main()
