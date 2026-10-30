/**
 * The accent color of a cover: the core draws an ambient glow behind a cart's
 * cover in it. Computed from the 128x128 fitted art, the same way as
 * tools/make_cover_pack.py (which uses Python's colorsys), so packs stay identical:
 *
 *   per pixel, in HSV (0 to 1): skip v < 0.15; weight w = s * s * v
 *   weighted mean RGB; if the total weight is under 2% of the pixel count, use #C8D4FF
 *   then in HSV: s = min(1, s * 1.3), v = 1; encode RGB565
 *
 * The math is plain doubles in the same order as the Python, so both agree bit for bit.
 */
import type { RGBImage } from './pillow.js';

/** Python's float %: the result has the sign of the divisor. */
function pyMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}

/** colorsys.rgb_to_hsv */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const rangec = maxc - minc;
  const v = maxc;
  if (minc === maxc) return [0, 0, v];
  const s = rangec / maxc;
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;
  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2.0 + rc - bc;
  else h = 4.0 + gc - rc;
  h = pyMod(h / 6.0, 1.0);
  return [h, s, v];
}

/** colorsys.hsv_to_rgb */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0.0) return [v, v, v];
  let i = Math.trunc(h * 6.0);
  const f = h * 6.0 - i;
  const p = v * (1.0 - s);
  const q = v * (1.0 - s * f);
  const t = v * (1.0 - s * (1.0 - f));
  i = pyMod(i, 6);
  if (i === 0) return [v, t, p];
  if (i === 1) return [q, v, p];
  if (i === 2) return [p, v, t];
  if (i === 3) return [p, q, v];
  if (i === 4) return [t, p, v];
  return [v, p, q];
}

/** RGB in 0..1 to RGB565, rounding each channel to 8 bits first. */
export function rgb565FromUnit(r: number, g: number, b: number): number {
  const c = (x: number) => Math.floor(x * 255 + 0.5);
  return ((c(r) >> 3) << 11) | ((c(g) >> 2) << 5) | (c(b) >> 3);
}

/** Neutral cool white, used when a cover has almost no color. */
export const NEUTRAL_ACCENT: [number, number, number] = [0xc8, 0xd4, 0xff];

export function accentOf(img: RGBImage): number {
  const d = img.data;
  const n = img.width * img.height;
  let total = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 3] / 255.0;
    const g = d[i * 3 + 1] / 255.0;
    const b = d[i * 3 + 2] / 255.0;
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const v = maxc;
    if (v < 0.15) continue;
    const s = maxc === minc ? 0.0 : (maxc - minc) / maxc;
    const w = s * s * v;
    total += w;
    sr += w * r;
    sg += w * g;
    sb += w * b;
  }
  let mr: number;
  let mg: number;
  let mb: number;
  if (total < 0.02 * n) {
    [mr, mg, mb] = NEUTRAL_ACCENT.map((x) => x / 255.0) as [number, number, number];
  } else {
    mr = sr / total;
    mg = sg / total;
    mb = sb / total;
  }
  const [h, s] = rgbToHsv(mr, mg, mb);
  const [r2, g2, b2] = hsvToRgb(h, Math.min(1.0, s * 1.3), 1.0);
  return rgb565FromUnit(r2, g2, b2);
}
