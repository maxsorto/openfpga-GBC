/**
 * Default cartridge art for carts the pack does not know: the core shows one of
 * these with the cart's header title. Three kinds, in this order in the pack:
 *   0 gray DMG cart, 1 black dual-mode cart, 2 clear GBC-only cart
 *
 * Art comes from server/assets/carts/{dmg,dual,cgb}-128.png and -80.png (RGBA, alpha
 * 0 or 255). Until those exist, a simple drawn placeholder is used; the same drawing
 * is in tools/make_cover_pack.py, so packs stay identical either way.
 *
 * Encoding: alpha 0 is RGB565 0x0000, which the core treats as transparent in these
 * three images only. An opaque pixel that would encode to 0x0000 becomes 0x0001.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { BLOB_BYTES, CEN, TH } from './pack-common.js';

export const CART_KINDS = ['dmg', 'dual', 'cgb'] as const;
export type CartKind = (typeof CART_KINDS)[number];

/** Accent (RGB565) for each default art, for the glow behind it. Tune here. */
export const CART_ACCENTS: Record<CartKind, number> = {
  dmg: 0xa59f, // soft blue-white
  dual: 0x8a7f, // violet
  cgb: 0x4e9a, // teal
};

export const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'carts');

interface Rgba {
  size: number;
  data: Uint8Array; // RGBA
}

/** Placeholder colors: body, label, grip. */
const COLORS: Record<CartKind, [number, number, number][]> = {
  dmg: [
    [164, 164, 172],
    [220, 220, 228],
    [120, 120, 128],
  ],
  dual: [
    [36, 36, 44],
    [90, 90, 110],
    [20, 20, 26],
  ],
  cgb: [
    [186, 214, 222],
    [236, 244, 248],
    [140, 170, 180],
  ],
};

/** A flat cartridge silhouette, all integer math (mirrored in the Python tool). */
export function placeholderCart(kind: CartKind, S: number): Rgba {
  const data = new Uint8Array(S * S * 4);
  const [body, label, grip] = COLORS[kind];
  const pct = (p: number) => Math.floor((S * p) / 100);
  const x0 = pct(16);
  const x1 = S - x0;
  const y0 = pct(6);
  const y1 = S - pct(6);
  const c = pct(12);
  const lx0 = x0 + pct(8);
  const lx1 = x1 - pct(8);
  const ly0 = y0 + pct(14);
  const ly1 = y0 + pct(58);
  const gy0 = y1 - pct(16);
  const gy1 = y1 - pct(6);
  const gx0 = x0 + pct(10);
  const gx1 = x1 - pct(10);
  const step = Math.max(1, Math.floor(S / 32));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let col: [number, number, number] | null = null;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        col = body;
        if (x >= x1 - c && y < y0 + c && x - (x1 - c) > y - y0) col = null; // the cut corner
        else if (x >= lx0 && x < lx1 && y >= ly0 && y < ly1) col = label;
        else if (x >= gx0 && x < gx1 && y >= gy0 && y < gy1 && Math.floor((y - gy0) / step) % 2 === 0) col = grip;
      }
      if (col) {
        const o = (y * S + x) * 4;
        data[o] = col[0];
        data[o + 1] = col[1];
        data[o + 2] = col[2];
        data[o + 3] = 255;
      }
    }
  }
  return { size: S, data };
}

function loadPng(kind: CartKind, S: number): Rgba | null {
  const file = path.join(ASSETS_DIR, `${kind}-${S}.png`);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const png = PNG.sync.read(buf);
  if (png.width !== S || png.height !== S) throw new Error(`${path.basename(file)} must be ${S}x${S}`);
  return { size: S, data: new Uint8Array(png.data) };
}

/** RGBA to RGB565 with the transparency key. */
export function encodeKeyed(img: Rgba): Buffer {
  const n = img.size * img.size;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let v = 0;
    if (img.data[o + 3] !== 0) {
      v = ((img.data[o] >> 3) << 11) | ((img.data[o + 1] >> 2) << 5) | (img.data[o + 2] >> 3);
      if (v === 0) v = 1;
    }
    out.writeUInt16LE(v, i * 2);
  }
  return out;
}

let memo: Buffer[] | null = null;

/** The three default art blobs (45568 bytes each), from the PNGs or the placeholder. */
export function defaultCartBlobs(): Buffer[] {
  if (memo) return memo;
  memo = CART_KINDS.map((kind) => {
    const parts = [CEN, TH].map((S) => encodeKeyed(loadPng(kind, S) ?? placeholderCart(kind, S)));
    const blob = Buffer.concat(parts);
    if (blob.length !== BLOB_BYTES) throw new Error('Default cart art has the wrong size');
    return blob;
  });
  return memo;
}

/** True when real art files are there (the placeholder is used otherwise). */
export function hasCartArtFiles(): boolean {
  return CART_KINDS.every((k) => [CEN, TH].every((S) => fs.existsSync(path.join(ASSETS_DIR, `${k}-${S}.png`))));
}
