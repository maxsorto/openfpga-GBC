/**
 * The "All games" tile: the cover Favorites mode shows after your favorites. A on it
 * switches to the full A to Z list. It is a 3 x 3 mosaic of covers from the A to Z
 * list (not favorites), picked evenly across the alphabet so it reads as the whole
 * library, with thin dark gutters and a dark band across the bottom third that says
 * "All games". No count: the core prints that under the cover.
 *
 * Built the same way as tools/make_cover_pack.py, so packs stay byte-identical:
 *   a 384 x 384 mosaic: gutters of 6 px, cells of 120 px, each cell a cover fitted with fit()
 *   the bottom third darkened: p * 72 >> 8
 *   the label composited in white from assets/tiles/all-games-384.png (a grayscale mask)
 *   then fitted to 128 and 80 like any cover, RGB565, with 0x0000 written as 0x0001
 *   (this tile is opaque; only the cartridge images use 0x0000 as transparent)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { CEN, TH, type PackEntry } from './pack-common.js';
import { fit, newImage, toRgb565, type RGBImage } from './pillow.js';

export const TILE_BASE = 384;
export const TILE_GUTTER = 6;
export const TILE_CELL = (TILE_BASE - 4 * TILE_GUTTER) / 3; // 120
export const TILE_BAND_TOP = 256;
export const TILE_GUTTER_RGB: [number, number, number] = [16, 16, 20];
export const TILE_PICKS = 9;

export const LABEL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tiles', 'all-games-384.png');

/**
 * The 9 covers for the mosaic: from the A to Z list, not favorites, spread evenly
 * across it (the middle of each ninth). Covers with real art first; if there are fewer
 * than 9 of those, any game; if every game is a favorite, the favorites too.
 */
export function tilePicks<T extends PackEntry & { hasArt?: boolean }>(entries: T[]): T[] {
  const az = entries.filter((e) => (e.section ?? 'az') === 'az');
  const notFav = az.filter((e) => !e.favorite);
  const withArt = notFav.filter((e) => e.hasArt);
  const pool = withArt.length >= TILE_PICKS ? withArt : notFav.length ? notFav : az;
  if (!pool.length) return [];
  return Array.from({ length: TILE_PICKS }, (_, i) => pool[Math.floor(((2 * i + 1) * pool.length) / (2 * TILE_PICKS))]);
}

let labelMemo: Uint8Array | null | undefined;

/** The label mask, one byte per pixel, or null if the file is missing (then the tile has no text). */
function labelMask(): Uint8Array | null {
  if (labelMemo !== undefined) return labelMemo;
  try {
    const png = PNG.sync.read(fs.readFileSync(LABEL_FILE));
    if (png.width !== TILE_BASE || png.height !== TILE_BASE) throw new Error('all-games-384.png must be 384 x 384');
    const m = new Uint8Array(TILE_BASE * TILE_BASE);
    for (let i = 0; i < m.length; i++) m[i] = png.data[i * 4];
    labelMemo = m;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    labelMemo = null;
  }
  return labelMemo;
}

/** The 384 x 384 mosaic with its band and label. */
export function composeTile(covers: RGBImage[]): RGBImage {
  const B = TILE_BASE;
  const out = newImage(B, B);
  for (let i = 0; i < out.data.length; i += 3) out.data.set(TILE_GUTTER_RGB, i);
  covers.slice(0, TILE_PICKS).forEach((cover, k) => {
    const cell = fit(cover, TILE_CELL);
    const x0 = TILE_GUTTER + (k % 3) * (TILE_CELL + TILE_GUTTER);
    const y0 = TILE_GUTTER + Math.floor(k / 3) * (TILE_CELL + TILE_GUTTER);
    for (let y = 0; y < TILE_CELL; y++) {
      const src = y * TILE_CELL * 3;
      out.data.set(cell.data.subarray(src, src + TILE_CELL * 3), ((y0 + y) * B + x0) * 3);
    }
  });
  const mask = labelMask();
  for (let y = TILE_BAND_TOP; y < B; y++) {
    for (let x = 0; x < B; x++) {
      const o = (y * B + x) * 3;
      const a = mask ? mask[y * B + x] : 0;
      for (let c = 0; c < 3; c++) {
        const p = (out.data[o + c] * 72) >> 8;
        out.data[o + c] = Math.floor((p * (255 - a) + 255 * a + 127) / 255);
      }
    }
  }
  return out;
}

/** RGB565 with no 0x0000: this tile is drawn like a normal cover. */
function opaque565(im: RGBImage): Buffer {
  const b = toRgb565(im);
  for (let i = 0; i < b.length; i += 2) if (b.readUInt16LE(i) === 0) b.writeUInt16LE(1, i);
  return b;
}

/** The tile's 45568 byte art blob: 128 x 128, then 80 x 80. */
export function allGamesTileBlob(covers: RGBImage[]): Buffer {
  const mosaic = composeTile(covers);
  return Buffer.concat([opaque565(fit(mosaic, CEN)), opaque565(fit(mosaic, TH))]);
}
