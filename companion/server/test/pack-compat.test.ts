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
import { artBlob as artBlobOf } from '../src/pack-common.js';
import { buildPack, compareTitles, expectedPackSize, packWriter, readPackSummary, BLOB_BYTES, ENTRY_BYTES, NO_SECTION, STRIDE_V7, type PackGame, type StreamGame } from '../src/pack.js';
import { crc32, romFingerprint } from '../src/roms.js';

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

function runPython(f: Fixture, out: string, v7 = false): Buffer {
  execFileSync(PYTHON, [MAKE_PACK, '--roms', f.roms, '--covers', f.covers, '--out', out, ...(v7 ? ['--v7'] : [])], { stdio: 'pipe' });
  return fs.readFileSync(out);
}

/** Same inputs, built the way the app does it (title = file stem, as the Python tool does). */
async function tsGames(f: Fixture, max: number): Promise<PackGame[]> {
  const roms = fs
    .readdirSync(f.roms)
    .filter((x) => /\.(gbc|gb)$/i.test(x))
    .sort(codepointSort)
    .slice(0, max);
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
      crc: crc32(fs.readFileSync(path.join(f.roms, rom))),
      fingerprint: romFingerprint(path.join(f.roms, rom)),
    });
  }
  return games;
}

/** v7 order, as the app's menuOrder() gives it with no favorites: '#' first, then A to Z. */
function letterOrder(games: PackGame[]): PackGame[] {
  return [...games].sort((a, b) => compareTitles({ ...a, file: a.romFile, crc: '', favorite: false }, { ...b, file: b.romFile, crc: '', favorite: false }));
}

async function runTs(f: Fixture): Promise<Buffer> {
  return buildPack(await tsGames(f, 31));
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

const V7_ROMS: [string, number][] = [
  ['Pokemon - Crystal Version.gbc', 65536],
  ['Tetris.gb', 32768],
  ["Legend of Zelda, The - Link's Awakening DX.gbc", 49152],
];
const V7_COVERS: [string, number, number][] = [
  ['Pokemon - Crystal Version.png', 512, 512],
  ['tetris.png', 300, 217],
  ["Legend of Zelda, The - Link's Awakening DX.png", 256, 340],
];

test('pack v7 is byte-identical to make_cover_pack.py --v7 (3 ROMs, all with art)', async () => {
  const f = makeFixture('v7-with-art', V7_ROMS, V7_COVERS);
  const py = runPython(f, path.join(OUT, 'v7-with-art', 'python.bin'), true);
  const v7 = packWriter(7);
  const ts = v7.build(letterOrder(await tsGames(f, 2047)));
  assert.equal(py.length, v7.expectedSize(3));
  assert.equal(ts.length, py.length, 'file size');
  assert.equal(firstDiff(ts, py), -1, `first differing byte at offset ${firstDiff(ts, py)}`);
  const s = readPackSummary(ts)!;
  assert.equal(s.version, 7);
  assert.deepEqual(s.crcs, letterOrder(await tsGames(f, 2047)).map((g) => g.crc));
  // L, P and T sections; Pokemon is P at 1, Legend at 0, Tetris at 2.
  assert.deepEqual(s.index && { fav: s.index.favCount, played: s.index.playedCount }, { fav: 0, played: 0 });
  assert.equal(s.index!.starts[12], 0);
  assert.equal(s.index!.starts[16], 1);
  assert.equal(s.index!.starts[20], 2);
});

test('pack v7 streamed write equals the in-memory build, and holds more than 31 games', async () => {
  // 40 ROMs with small art, so the Python tool runs fast. Titles start with digits,
  // punctuation and lower case letters, and several letters have no game at all.
  const stems = [
    '1942', '~Tilde Quest', '3D Pocket', '[Bracket]', 'alleyway', 'Asteroids', 'Balloon Kid', 'batman',
    'Castlevania', 'Donkey Kong', 'dr. Mario', 'Final Fantasy', 'Kirby', 'kwirk', 'Mario Golf', 'Metroid II',
    'Mole Mania', 'Pokemon Blue', 'Pokemon Red', 'pokemon yellow', 'Quarth', 'R-Type', 'Shantae', 'Tetris',
    'The Legend of Zelda', 'tetris attack', 'Wario Land', 'Wave Race', 'Yoshi', 'Zelda DX',
    'Amazing Penguin', 'Bomberman', 'Catrap', 'Duck Tales', 'Faceball', 'Gargoyle', 'Kid Icarus', 'Mega Man', 'Pinball', 'Sneaky Snakes',
  ];
  const roms: [string, number][] = stems.map((n, i) => [`${n}.${i % 3 ? 'gbc' : 'gb'}`, 4096 + i * 512]);
  const covers: [string, number, number][] = stems.map((n, i) => [`${n}.png`, 64 + (i % 5) * 20, 60 + (i % 4) * 25]);  const f = makeFixture('v7-forty', roms, covers);
  const py = runPython(f, path.join(OUT, 'v7-forty', 'python.bin'), true);
  const v7 = packWriter(7);
  const games = letterOrder(await tsGames(f, 2047));
  assert.equal(games.length, 40);
  const built = v7.build(games);
  assert.equal(firstDiff(built, py), -1, 'in-memory build matches Python');

  const chunks: Buffer[] = [];
  let biggest = 0;
  const stream: StreamGame[] = games.map(({ art, ...g }) => ({ ...g, blob: async () => artBlobOf(art) }));
  const n = await v7.write(stream, (c) => {
    chunks.push(c);
    biggest = Math.max(biggest, c.length);
  });
  assert.equal(n, py.length);
  assert.equal(firstDiff(Buffer.concat(chunks), py), -1, 'streamed write matches Python');
  // The letter index: '#' first, missing letters 0xFFFF, starts in order.
  const idx = readPackSummary(built)!.index!;
  const titles = games.map((g) => g.title);
  assert.deepEqual(titles.slice(0, 4), ['1942', '3D Pocket', '[Bracket]', '~Tilde Quest']);
  assert.equal(idx.starts[0], 0);
  assert.equal(titles[idx.starts[1]], 'alleyway');
  assert.equal(titles[idx.starts[20]], 'Tetris');
  assert.equal(titles[idx.starts[16]], 'Pinball');
  for (const missing of ['E', 'H', 'I', 'J', 'L', 'N', 'O', 'U', 'V', 'X']) assert.equal(idx.starts[missing.charCodeAt(0) - 64], NO_SECTION, missing);
  const present = idx.starts.filter((x) => x !== NO_SECTION);
  assert.deepEqual(present, [...present].sort((a, b) => a - b));

  // Nothing close to the whole pack is ever one buffer: the largest piece is the path structs.
  assert.ok(biggest <= Math.max(STRIDE_V7, 40 * 3 * 256 + 256), `largest chunk ${biggest}`);
});

test('pack v7 fingerprints match make_cover_pack.py --v7, including a ROM shorter than the header', async () => {
  const f = makeFixture(
    'v7-fingerprints',
    [
      ['Known Header.gbc', 32768],
      ['Tiny.gb', 200],
    ],
    [
      ['Known Header.png', 120, 100],
      ['Tiny.png', 90, 80],
    ],
  );
  // Known cart header bytes: CGB flag 0x80, header checksum 0xAB, global checksum 0x1234.
  const rom = fs.readFileSync(path.join(f.roms, 'Known Header.gbc'));
  rom[0x143] = 0x80;
  rom[0x14d] = 0xab;
  rom[0x14e] = 0x12;
  rom[0x14f] = 0x34;
  fs.writeFileSync(path.join(f.roms, 'Known Header.gbc'), rom);
  const py = runPython(f, path.join(OUT, 'v7-fingerprints', 'python.bin'), true);
  const ts = packWriter(7).build(letterOrder(await tsGames(f, 2047)));
  assert.equal(firstDiff(ts, py), -1, `first differing byte at offset ${firstDiff(ts, py)}`);
  const s = readPackSummary(ts)!;
  assert.deepEqual(s.fingerprints, { offset: ts.length - 2 * 4, count: 2 });
  const rec = (i: number) => [...ts.subarray(s.fingerprints!.offset + i * 4, s.fingerprints!.offset + i * 4 + 4)];
  assert.deepEqual(s.titles, ['Known Header', 'Tiny']);
  assert.deepEqual(rec(0), [0x12, 0x34, 0xab, 0x80]);
  assert.deepEqual(rec(1), [0, 0, 0, 0]);
});
