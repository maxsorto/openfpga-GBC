#!/usr/bin/env python3
"""The button legend as the core draws it: the strings per context (mirrors leg_char in cover_picker.sv) and a
renderer that lays them out with font_sm (tools/make_legend_font.py) at rows 266 to 281, centred, in the second
line's gray. anim_model.render adds it when a scene has a 'leg' context.

Contexts (leg_ctx): 0 none, 1 flow All games, 2 flow Favorites, 3 grid All games, 4 grid Favorites, 5 options open,
6 cartridge view, 7 the All games cover, 8 no cartridge, 9 settings. The Select hint names the next ring stop
(leg_next): 0 none, 1 FAVORITES, 2 ALL GAMES, 3 CARTRIDGE."""
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_font = None
def font():
    global _font
    if _font is None:
        d = os.path.join(HERE, '..', 'src', 'core')
        rows = [int(l, 16) for l in open(os.path.join(d, 'font_sm.hex'))]
        wid = [int(l, 16) for l in open(os.path.join(d, 'font_sm_width.hex'))]
        _font = (rows, wid)
    return _font

Y, X, A, B, LR, UD, SEL, SL, SR = (chr(c) for c in (1, 2, 3, 4, 5, 6, 7, 11, 12))
NEXT = {0: '', 1: 'FAVORITES', 2: 'ALL GAMES', 3: 'CARTRIDGE'}
GAP = '   '                    # between hints (three spaces of the small font)

def hint(pic, word): return pic + ' ' + word

def legend_string(ctx, nxt=0, letters=True):
    """The same string the core lays out. letters: the list has a letter index (L R LETTER shown in All games)."""
    sel = [hint(SEL, NEXT[nxt])] if nxt else []
    if ctx in (1, 3):
        h = [hint(Y, 'FLOW' if ctx == 3 else 'GRID'), hint(X, 'OPTIONS'), hint(A, 'PLAY')] + sel + ([hint(SL + SR, 'LETTER')] if letters else [])
    elif ctx in (2, 4):
        h = [hint(Y, 'FLOW' if ctx == 4 else 'GRID'), hint(X, 'OPTIONS'), hint(A, 'PLAY')] + sel
    elif ctx == 5: h = [hint(LR, 'CHOOSE'), hint(A, 'OK'), hint(B, 'BACK')]
    elif ctx == 6: h = [hint(A, 'PLAY CART')] + sel
    elif ctx == 7: h = [hint(A, 'ALL GAMES'), hint(Y, 'GRID')] + sel
    elif ctx == 8: h = sel
    elif ctx == 9: h = [hint(UD, 'SETTING'), hint(LR, 'CHANGE'), hint(B, 'BACK')]
    else: return ''
    return GAP.join(h)

def code(ch):                  # the core's leg_code: compact font slots
    c = ord(ch)
    if 65 <= c <= 90: return c - 64
    if ch == ' ': return 27
    if 1 <= c <= 14: return 27 + c
    return 0

def mask(s):
    rows, wid = font()
    cols = []
    for ch in s:
        c = code(ch); gw = wid[c]
        for col in range(gw):
            cols.append([(rows[c * 16 + r] >> (2 * col)) & 3 if col < 12 else 0 for r in range(16)])
    return np.array(cols, np.int32).T if cols else np.zeros((16, 0), np.int32)

LEG_Y = 266
COLOR = (128, 140, 168)
TAL = np.array([0, 5, 11, 16])

def draw(out, s, tl=8):
    """Draw the legend string onto a frame (int array), like anim_model draws the second line."""
    msk = mask(s)
    if msk.shape[1] == 0 or tl == 0: return out
    wdt = msk.shape[1]; st = 160 - (wdt >> 1)
    if st < 0: msk = msk[:, -st:]; wdt = msk.shape[1]; st = 0
    if st + wdt > 320: msk = msk[:, :320 - st]; wdt = msk.shape[1]
    al = TAL[msk]; al = (al * (tl * 2)) >> 4
    reg = out[LEG_Y:LEG_Y + 16, st:st + wdt]
    colr = np.array(COLOR)
    out[LEG_Y:LEG_Y + 16, st:st + wdt] = np.where((al > 0)[..., None], (reg * (16 - al[..., None]) + colr * al[..., None]) >> 4, reg)
    return out
