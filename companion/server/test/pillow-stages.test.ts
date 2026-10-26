/**
 * Compares each step of the TypeScript fit() port against Pillow on synthetic
 * images. When the pack test fails, this one shows which step drifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PYTHON, writeFixturePng } from './fixtures.js';
import { decodeImage } from '../src/image.js';
import * as P from '../src/pillow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'stages');

const CASES: [string, number, number, number][] = [
  ['landscape', 300, 217, 1],
  ['portrait', 256, 340, 2],
  ['small', 90, 60, 3],
  ['large', 1003, 701, 4],
  ['tall', 140, 641, 5],
  ['exact', 128, 128, 6],
];

function load(dir: string, name: string): P.RGBImage {
  const { w, h } = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  return { width: w, height: h, data: new Uint8Array(fs.readFileSync(path.join(dir, `${name}.rgb`))) };
}

function diff(a: P.RGBImage, b: P.RGBImage): string | null {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} vs ${b.width}x${b.height}`;
  let n = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d) {
      n++;
      max = Math.max(max, d);
    }
  }
  return n ? `${n} channel values differ, max diff ${max}` : null;
}

for (const [name, w, h, seed] of CASES) {
  for (const size of [128, 80]) {
    test(`fit() stages match Pillow: ${name} ${w}x${h} -> ${size}`, async () => {
      const dir = path.join(OUT, `${name}-${size}`);
      const png = path.join(OUT, `${name}.png`);
      writeFixturePng(png, w, h, seed);
      execFileSync(PYTHON, [path.join(HERE, 'pillow_stages.py'), png, String(size), dir]);

      const img = await decodeImage(fs.readFileSync(png));
      assert.equal(diff(img, load(dir, 'input')), null, 'decode');

      const s = Math.max(size / img.width, size / img.height);
      const bgr = P.resize(img, [Math.max(1, P.pyRound(img.width * s)), Math.max(1, P.pyRound(img.height * s))]);
      assert.equal(diff(bgr, load(dir, 'bg_resize')), null, 'bg resize');
      const cx = Math.floor((bgr.width - size) / 2);
      const cy = Math.floor((bgr.height - size) / 2);
      const crop = P.crop(bgr, cx, cy, cx + size, cy + size);
      assert.equal(diff(crop, load(dir, 'bg_crop')), null, 'bg crop');
      // Feed Pillow's own intermediate results forward so each step is isolated.
      const blur = P.gaussianBlur(load(dir, 'bg_crop'), size / 10);
      assert.equal(diff(blur, load(dir, 'bg_blur')), null, 'blur');
      assert.equal(diff(P.brightness(load(dir, 'bg_blur'), 0.45), load(dir, 'bg_dark')), null, 'brightness');
      const thumb = P.thumbnail(img, size, size);
      assert.equal(diff(thumb, load(dir, 'fg_thumb')), null, 'thumbnail');
      assert.equal(diff(P.smooth(load(dir, 'fg_thumb')), load(dir, 'fg_smooth')), null, 'smooth');
      assert.equal(diff(P.sharpness(load(dir, 'fg_thumb'), 1.4), load(dir, 'fg_sharp')), null, 'sharpness');
      assert.equal(diff(P.fit(img, size), load(dir, 'fit')), null, 'fit');
    });
  }
}
