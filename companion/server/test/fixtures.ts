import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/** Small deterministic PRNG so fixtures are the same on every run. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Write a synthetic "box art" PNG: gradients, hard edged shapes and noise, so
 * resampling, blur and sharpening all get exercised. No real artwork is used.
 */
export function writeFixturePng(file: string, width: number, height: number, seed: number): void {
  const rnd = prng(seed);
  const png = new PNG({ width, height });
  const shapes = Array.from({ length: 6 }, () => ({
    x: rnd() * width,
    y: rnd() * height,
    r: 8 + rnd() * Math.min(width, height) * 0.3,
    c: [rnd() * 255, rnd() * 255, rnd() * 255],
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = (x / width) * 200 + 30;
      let g = (y / height) * 180 + 40;
      let b = ((x + y) / (width + height)) * 255;
      for (const s of shapes) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 < s.r * s.r) [r, g, b] = s.c;
      }
      if ((x >> 3) % 7 === 0 && y % 23 < 3) [r, g, b] = [250, 250, 250];
      const n = (rnd() - 0.5) * 40;
      png.data[i] = Math.max(0, Math.min(255, Math.round(r + n)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(g + n)));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(b - n)));
      png.data[i + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Write a fake ROM: random bytes, never real game content. */
export function writeFakeRom(file: string, bytes: number, seed: number): void {
  const rnd = prng(seed);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(rnd() * 256);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

export const PYTHON =
  process.env.COVER_PICKER_PYTHON ?? '/Users/max/Documents/analogue-pocket/cover-picker/.venv/bin/python';
