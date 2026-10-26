"""Dump each Pillow step of make_cover_pack.fit() as raw RGB, for the TypeScript port tests.

Usage: pillow_stages.py IMAGE SIZE OUTDIR
Writes OUTDIR/<stage>.rgb plus OUTDIR/<stage>.json with the width and height.
"""
import json, os, sys
from PIL import Image, ImageEnhance, ImageFilter

src, size, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
os.makedirs(out, exist_ok=True)

def dump(name, im):
    with open(os.path.join(out, name + ".rgb"), "wb") as f: f.write(im.tobytes())
    with open(os.path.join(out, name + ".json"), "w") as f: json.dump({"w": im.width, "h": im.height}, f)

img = Image.open(src).convert("RGB"); dump("input", img)
bg = img.copy(); s = max(size / bg.width, size / bg.height)
bg = bg.resize((max(1, round(bg.width * s)), max(1, round(bg.height * s))), Image.LANCZOS); dump("bg_resize", bg)
bg = bg.crop(((bg.width - size) // 2, (bg.height - size) // 2, (bg.width - size) // 2 + size, (bg.height - size) // 2 + size)); dump("bg_crop", bg)
bl = bg.filter(ImageFilter.GaussianBlur(size / 10)); dump("bg_blur", bl)
bg = ImageEnhance.Brightness(bl).enhance(0.45); dump("bg_dark", bg)
fg = img.copy(); fg.thumbnail((size, size), Image.LANCZOS); dump("fg_thumb", fg)
dump("fg_smooth", fg.filter(ImageFilter.SMOOTH))
fg = ImageEnhance.Sharpness(fg).enhance(1.4); dump("fg_sharp", fg)
bg.paste(fg, ((size - fg.width) // 2, (size - fg.height) // 2)); dump("fit", bg)
