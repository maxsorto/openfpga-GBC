/**
 * covers.bin from the TypeScript builder must be byte-identical to the one
 * tools/make_cover_pack.py writes for the same ROMs and art.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PYTHON, writeFakeRom, writeFixturePng } from './fixtures.js';
import { decodeImage, placeholderImage } from '../src/image.js';
import { buildPack, expectedPackSize, BLOB_BYTES, ENTRY_BYTES, type PackGame } from '../src/pack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'pack');
const MAKE_PACK = path.resolve(HERE, '../../../tools/make_cover_pack.py');

function codepointSort(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Fixture {
  roms: string;
  covers: string;
}

function makeFixture(name: string, roms: [string, number][], covers: [string, number, number][]): Fixture {
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const f = { roms: path.join(dir, 'roms'), covers: path.join(dir, 'covers') };
  fs.mkdirSync(f.covers, { recursive: true });
  roms.forEach(([file, size], i) => writeFakeRom(path.join(f.roms, file), size, 100 + i));
  covers.forEach(([file, w, h], i) => writeFixturePng(path.join(f.covers, file), w, h, 200 + i));
  return f;
}

function runPython(f: Fixture, out: string): Buffer {
  execFileSync(PYTHON, [MAKE_PACK, '--roms', f.roms, '--covers', f.covers, '--out', out], { stdio: 'pipe' });
  return fs.readFileSync(out);
}

/** Same inputs, built the way the app does it (title = file stem, as the Python tool does). */
async function runTs(f: Fixture): Promise<Buffer> {
  const roms = fs
    .readdirSync(f.roms)
    .filter((x) => /\.(gbc|gb)$/i.test(x))
    .sort(codepointSort)
    .slice(0, 31);
  const covers = new Map(
    fs
      .readdirSync(f.covers)
      .filter((x) => /\.(png|jpe?g)$/i.test(x))
      .map((x) => [x.replace(/\.[^.]+$/, '').toLowerCase(), path.join(f.covers, x)]),
  );
  const games: PackGame[] = [];
  for (const rom of roms) {
    const stem = rom.replace(/\.[^.]+$/, '');
    const cover = covers.get(stem.toLowerCase());
    games.push({
      title: stem,
      romFile: rom,
      platform: 'gbc',
      romSize: fs.statSync(path.join(f.roms, rom)).size,
      art: cover ? await decodeImage(fs.readFileSync(cover)) : await placeholderImage(stem),
    });
  }
  return buildPack(games);
}

function firstDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

test('covers.bin is byte-identical to make_cover_pack.py (3 ROMs, all with art)', async () => {
  const f = makeFixture(
    'with-art',
    [
      ['Pokemon - Crystal Version.gbc', 65536],
      ['Tetris.gb', 32768],
      ['Legend of Zelda, The - Link\'s Awakening DX.gbc', 49152],
    ],
    [
      ['Pokemon - Crystal Version.png', 512, 512],
      ['tetris.png', 300, 217],
      ["Legend of Zelda, The - Link's Awakening DX.png", 256, 340],
    ],
  );
  const py = runPython(f, path.join(OUT, 'with-art', 'python.bin'));
  const ts = await runTs(f);
  assert.equal(py.length, expectedPackSize(3));
  assert.equal(ts.length, py.length, 'file size');
  const at = firstDiff(ts, py);
  assert.equal(at, -1, `first differing byte at offset ${at}`);
});

test('placeholder art: everything but the placeholder blob is byte-identical', async () => {
  const f = makeFixture(
    'placeholder',
    [
      ['Pokemon - Cock 2.gbc', 40000],
      ['Tetris (World) (Rev 1).gb', 32768],
    ],
    [['Tetris (World) (Rev 1).png', 160, 144]],
  );
  const py = runPython(f, path.join(OUT, 'placeholder', 'python.bin'));
  const ts = await runTs(f);
  assert.equal(ts.length, py.length, 'file size');
  // Entry 0 ("Pokemon - Cock 2") has no art, so its blob is the text placeholder.
  const blobStart = 528 + 2 * ENTRY_BYTES;
  const blobEnd = blobStart + BLOB_BYTES;
  assert.equal(firstDiff(ts.subarray(0, blobStart), py.subarray(0, blobStart)), -1, 'header and entries');
  assert.equal(firstDiff(ts.subarray(blobEnd), py.subarray(blobEnd)), -1, 'other art and path structs');

  // Report how far the placeholder drifts, as RGB565 words that differ.
  let words = 0;
  for (let i = blobStart; i < blobEnd; i += 2) if (ts.readUInt16LE(i) !== py.readUInt16LE(i)) words++;
  const pct = ((words / (BLOB_BYTES / 2)) * 100).toFixed(1);
  console.log(`placeholder blob: ${words} of ${BLOB_BYTES / 2} pixels differ (${pct}%). Text is rendered by a different engine.`);
});
