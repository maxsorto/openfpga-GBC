#!/usr/bin/env python3
"""Build the Vitrine site's media (site/assets/) from the simulation frames, the menu model and the screenshots.

  build_site.py stills    the before and after screens, the cover wall, the link preview, the favicon, the app shot
  build_site.py loops     the looping clips, each from a range of simulation frames (the table LOOPS below)

Simulation frames come from tools/sim (tb_vt -DSCEN_B / -DSCEN_C / -DSCEN_F, tb_grid, tb_fav with FIRST=0), run in
the folder that holds the packs. Menu screens are drawn at 4x with nearest neighbour scaling, so every pixel the
Pocket draws stays a crisp square.
"""
import os, sys, shutil, subprocess, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, 'site', 'assets')
SIM = os.path.expanduser('~/Documents/analogue-pocket/cover-picker/sim')
PACK = os.path.expanduser('~/Library/Caches/GBC Cover Companion/covers-backups/covers-2026-10-27T04-52-56-210Z.bin')
FONTS = os.path.expanduser('~/Documents/analogue-pocket/fonts/inter/extras/ttf')
sys.path.insert(0, HERE)

S = 4                                  # screen scale: 320x288 -> 1280x1152

def x4(img):
    if isinstance(img, np.ndarray): img = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    return img.convert('RGB').resize((320 * S, 288 * S), Image.NEAREST)

def font(name, size): return ImageFont.truetype(os.path.join(FONTS, name), size)

# ------------------------------------------------------------------ stills
STOCK_FILES = ['Pipe Dream.gb', 'Pitfall - Beyond the Jungle.gbc', 'Pocket Billiards - Funk the 9-Ball.gbc',
               'Pokemon - Blue Version.gb', 'Pokemon - Card GB2 - Great Rocket-Dan Sanjou!.gbc',
               'Pokemon - Crystal Version.gbc', 'Pokemon - Gold Version.gbc', 'Pokemon - Green Version.gb',
               'Pokemon - Picross.gbc', 'Pokemon - Pinball.gbc', 'Pokemon - Puzzle Challenge.gbc',
               'Pokemon - Red Version.gb']
STOCK_SEL = 5

def stock_screen():
    """The stock file browser, recreated at the menu's size: a path, a list of file names, a highlight, a scrollbar."""
    W, H = 320 * S, 288 * S
    im = Image.new('RGB', (W, H), (0, 0, 0)); d = ImageDraw.Draw(im)
    head, row = font('Inter-Medium.ttf', 34), font('Inter-Medium.ttf', 40)
    d.text((56, 44), 'Assets / gbc / common', font=head, fill=(128, 134, 148))
    d.text((W - 56, 44), '441 of 702', font=head, fill=(128, 134, 148), anchor='ra')
    d.line((56, 108, W - 56, 108), fill=(38, 41, 48), width=3)
    y0, rh = 132, 82
    for k, name in enumerate(STOCK_FILES):
        y = y0 + k * rh
        if k == STOCK_SEL:
            d.rounded_rectangle((40, y - 6, W - 84, y + rh - 14), radius=14, fill=(232, 233, 238))
            d.text((64, y + 8), name, font=row, fill=(10, 10, 12))
        else:
            d.text((64, y + 8), name, font=row, fill=(214, 216, 222))
    d.rounded_rectangle((W - 52, 132, W - 44, H - 40), radius=4, fill=(30, 32, 38))
    d.rounded_rectangle((W - 52, 520, W - 44, 600), radius=4, fill=(120, 126, 140))
    return im

def pack():
    import anim_model as m
    return m.Pack(PACK)

def vitrine_screen(p):
    """The menu at rest in Favorites on Pokemon Crystal, drawn by the model (pixel for pixel the core's output)."""
    import anim_model as m
    i = 19                                                   # Pokemon - Crystal Version in the favorites block
    covers = []
    for gi, x, S_, b in ((i - 1, 12, 80, 9), (i, 96, 128, 16), (i + 1, 228, 80, 9)):
        a128, a80 = p.art(gi); covers.append(dict(art128=a128, art80=a80, x=x, S=S_, b=b))
    t, fl = p.entry(i)
    return m.render(dict(covers=covers, title=t, plat='GAME BOY' if fl & 1 else 'GAME BOY COLOR', cnt=42, idx=i,
                         leg=(2, 2, True)))

def cover_wall(p, cols=8, rows=5, size=128, gap=16, radius=10):
    """Box art from the favorites block (the first entries of the pack), as rounded tiles on transparent black."""
    W, H = cols * (size + gap) - gap, rows * (size + gap) - gap
    wall = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    import anim_model as m
    for k in range(cols * rows):
        a128, _ = p.art(k)
        tile = Image.fromarray(m.expand(a128).astype(np.uint8)).convert('RGBA'); tile.putalpha(mask)
        wall.alpha_composite(tile, ((k % cols) * (size + gap), (k // cols) * (size + gap)))
    return wall

def og_image(screen):
    W, H = 1200, 630
    im = Image.new('RGB', (W, H), (7, 8, 11))
    glow = Image.new('RGB', (W, H), (0, 0, 0)); gd = ImageDraw.Draw(glow)
    gd.ellipse((560, 40, 1240, 620), fill=(70, 86, 150)); glow = glow.filter(ImageFilter.GaussianBlur(120))
    im = Image.blend(im, glow, 0.55)
    sc = screen.resize((560, 504), Image.NEAREST)
    frame = Image.new('RGB', (sc.width + 20, sc.height + 20), (24, 26, 32)); frame.paste(sc, (10, 10))
    im.paste(frame, (W - frame.width - 56, (H - frame.height) // 2))
    d = ImageDraw.Draw(im)
    d.text((64, 196), 'Vitrine', font=font('InterDisplay-Bold.ttf', 128), fill=(246, 246, 250))
    d.text((68, 352), 'Your Game Boy library,', font=font('InterDisplay-SemiBold.ttf', 44), fill=(200, 205, 218))
    d.text((68, 408), 'face out.', font=font('InterDisplay-SemiBold.ttf', 44), fill=(200, 205, 218))
    d.text((68, 500), 'For Analogue Pocket', font=font('Inter-Medium.ttf', 26), fill=(128, 134, 150))
    return im

FAVICON = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#0b0c10"/>
<rect x="6" y="20" width="14" height="20" rx="3" fill="#5b6478"/>
<rect x="44" y="20" width="14" height="20" rx="3" fill="#5b6478"/>
<rect x="20" y="13" width="24" height="32" rx="4" fill="#f4f5f9"/>
<rect x="20" y="49" width="24" height="3" rx="1.5" fill="#3a4152"/>
</svg>
'''

def legend_strips():
    """The legend line in three contexts (the core's own strings and font), cropped to its text, 4x."""
    import legend_model as lm
    out = []
    for name, ctx, nxt in (('browse', 1, 1), ('options', 5, 0), ('cart', 6, 1)):
        frame = np.zeros((288, 320, 3), np.int32)
        frame = lm.draw(frame, lm.legend_string(ctx, nxt, True))
        band = np.clip(frame[lm.LEG_Y + 1:lm.LEG_Y + 15], 0, 255).astype(np.uint8)
        cols = np.nonzero(band.max(axis=(0, 2)) > 0)[0]
        band = band[:, max(cols.min() - 3, 0):min(cols.max() + 4, 320)]
        Image.fromarray(band).resize((band.shape[1] * S, band.shape[0] * S), Image.NEAREST).save(
            os.path.join(OUT, f'legend_{name}.png'), optimize=True)
        out.append((name, band.shape[1] * S, band.shape[0] * S))
    return out

def stills():
    os.makedirs(OUT, exist_ok=True)
    p = pack()
    stock = stock_screen(); stock.save(os.path.join(OUT, 'stock.png'), optimize=True)
    vit = x4(vitrine_screen(p)); vit.save(os.path.join(OUT, 'vitrine.png'), optimize=True)
    cover_wall(p).save(os.path.join(OUT, 'wall.webp'), 'WEBP', quality=82, method=6)
    og_image(vit).save(os.path.join(OUT, 'og.png'), optimize=True)
    open(os.path.join(OUT, 'favicon.svg'), 'w').write(FAVICON)
    app = Image.open(os.path.join(REPO, 'docs', 'images', 'companion-library.png')).convert('RGB').crop((0, 0, 2880, 1180))
    app.resize((1600, round(1600 * app.height / app.width)), Image.LANCZOS).save(os.path.join(OUT, 'app.jpg'), quality=86, optimize=True)
    pause = Image.open(os.path.join(REPO, 'docs', 'images', 'pause-home.png')).convert('RGB')
    pause.resize((1280, 1152), Image.NEAREST).save(os.path.join(OUT, 'pause.webp'), 'WEBP', quality=90, method=6)
    print('legend strips', legend_strips())
    print('stills written to', OUT)

# ------------------------------------------------------------------ loops
# Each loop is a list of segments (simulation folder, frame numbers; a number repeated holds that frame). Segments are
# joined with a crossfade of JOIN frames, and the end crossfades back into the start (LOOP frames) so it loops cleanly.
# poster: the frame (in the finished loop) used as the still before the video plays.
def hold(n, k): return [n] * k
LOOPS = {
    # a cart goes into the list, seats with its ring and glow, and is pulled out again (tb_vt -DSCEN_C)
    'hero':    dict(segs=[('vt_c', hold(20, 40) + list(range(20, 93)) + hold(92, 50) + list(range(93, 134)) + hold(133, 36))],
                    join=0, loop=12, poster=90),
    # the flow, Y into the grid, moves and a scroll; then L and R letter jumps and Y back (tb_grid), skipping the
    # stretch where the testbench's slow host is still filling the third row
    'browse':  dict(segs=[('grid', hold(8, 45) + list(range(8, 33)) + hold(32, 24) + list(range(33, 107))),
                          ('grid', list(range(290, 347)) + hold(346, 45))], join=8, loop=12, poster=90),
    # the empty slot, then a cart drops in, seats and glows (tb_vt -DSCEN_F -DLONGREST)
    'cart':    dict(segs=[('vt_f', hold(44, 30) + list(range(44, 166)))], join=0, loop=12, poster=74),
    # a cart that is not in the pack drops in as a drawing of its shell (tb_vt -DSCEN_B)
    'unknown': dict(segs=[('vt_b', hold(20, 30) + list(range(20, 51)) + hold(50, 50) + list(range(51, 87)) + hold(86, 30))],
                    join=0, loop=10, poster=80),
    # unstarring a favorite in Favorites: its cover lifts out and the next slides into its place (tb_fav)
    'fav':     dict(segs=[('fav', hold(285, 50) + list(range(285, 312)) + hold(311, 50))], join=0, loop=12, poster=20),
    # a game is chosen: its cover grows toward the screen as the menu fades into the game (tb_vt -DSCEN_F -DLONGREST)
    'resume':  dict(segs=[('vt_f', hold(260, 30) + list(range(260, 319)) + hold(318, 24))], join=0, loop=12, poster=20),
}

def load(folder, n):
    return np.asarray(x4(Image.open(os.path.join(SIM, folder, f'f_{n:03d}.ppm')))).astype(np.float32)

def xfade(a, b, k):
    """a's last k frames dissolve into b's first k frames."""
    if k == 0: return a + b
    mid = [a[len(a) - k + j] * (1 - (j + 1) / (k + 1)) + b[j] * ((j + 1) / (k + 1)) for j in range(k)]
    return a[:len(a) - k] + mid + b[k:]

def encode(name, imgs, poster=0, fps=59.73):
    tmp = tempfile.mkdtemp()
    for i, a in enumerate(imgs): Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(os.path.join(tmp, f'{i:04d}.png'))
    out = os.path.join(OUT, name + '.mp4')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', os.path.join(tmp, '%04d.png'),
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                    '-an', out], check=True)
    Image.fromarray(np.clip(imgs[min(poster, len(imgs) - 1)], 0, 255).astype(np.uint8)).save(
        os.path.join(OUT, name + '.webp'), 'WEBP', quality=88, method=6)
    shutil.rmtree(tmp)
    print(f'{name}: {len(imgs)} frames, {len(imgs) / fps:.1f} s, {os.path.getsize(out) // 1024} KB')

def build_loop(spec):
    cache = {}
    def get(folder, n):
        if (folder, n) not in cache: cache[(folder, n)] = load(folder, n)
        return cache[(folder, n)]
    seq = None
    for folder, nums in spec['segs']:
        frames = [get(folder, n) for n in nums]
        seq = frames if seq is None else xfade(seq, frames, spec['join'])
    k = spec['loop']
    if k:                                              # the end dissolves into the start; the loop begins after it
        head, body = seq[:k], seq[k:]
        tail = [body[len(body) - k + j] * (1 - (j + 1) / (k + 1)) + head[j] * ((j + 1) / (k + 1)) for j in range(k)]
        seq = body[:len(body) - k] + tail
    return seq

def loops(only=None):
    os.makedirs(OUT, exist_ok=True)
    for name, spec in LOOPS.items():
        if only and name not in only: continue
        encode(name, build_loop(spec), poster=spec['poster'])

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'stills'
    if cmd == 'stills': stills()
    elif cmd == 'loops': loops(sys.argv[2:] or None)
