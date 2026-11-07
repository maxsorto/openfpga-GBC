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
import { artBlobAndAccent } from '../src/pack-common.js';
import { allGamesTileBlob, tilePicks } from '../src/tile.js';
import { emptySlotBlob } from '../src/cartart.js';
import {
  buildPack,
  compareTitles,
  expectedPackSize,
  fingerprintTableOffset,
  packWriter,
  readPackSummary,
  BLOB_BYTES,
  CRT_HAS_V26,
  ENTRY_BYTES,
  NO_SECTION,
  STRIDE_V7,
  type PackGame,
  type StreamGame,
} from '../src/pack.js';
import { crc32, romFingerprint } from '../src/roms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'pack');
// COVER_PICKER_MAKE_PACK points the tests at another copy of the Python tool.
const MAKE_PACK = process.env.COVER_PICKER_MAKE_PACK ?? path.resolve(HERE, '../../../tools/make_cover_pack.py');

/**
 * The app always writes build 26 packs (CRT1 flags bit 4): REC1 at offset 128, recent.cfg and
 * settings.cfg after carts.cfg, the Settings tile last. When the Python tool does not write
 * those yet, compare against the app's pack with exactly those three things taken out
 * (everything after the trailer moves back by two path structs and the alignment that
 * follows). Once the tool sets bit 4, the files are compared as they are.
 */
function asPython(ts: Buffer, py: Buffer): Buffer {
  if (ts.readUInt16LE(4) !== 7 || ts.toString('ascii', 96, 100) !== 'CRT1') return ts;
  if (py.length >= 108 && py.toString('ascii', 96, 100) === 'CRT1' && py.readUInt16LE(106) & CRT_HAS_V26) return ts;
  const n = ts.readUInt16LE(6);
  const paths0 = 528 + n * (128 + STRIDE_V7);
  const table = ts.readUInt32LE(84);
  const art = ts.readUInt32LE(100);
  assert.equal(ts.toString('ascii', 128, 132), 'REC1');
  const oldTable = (paths0 + (n * 3 + 3) * 256 + 3) & ~3;
  const oldArt = (oldTable + n * 8 + 4095) & ~4095;
  const images = (ts.length - art) / STRIDE_V7 - 1; // all but the Settings tile
  const out = Buffer.alloc(oldArt + images * STRIDE_V7);
  ts.copy(out, 0, 0, oldTable); // through the carts.cfg path struct
  ts.copy(out, oldTable, table, table + n * 8);
  ts.copy(out, oldArt, art, art + images * STRIDE_V7);
  out.fill(0, 128, 136 + 2 * 32); // no REC1
  out.writeUInt32LE(oldTable, 84);
  out.writeUInt32LE(oldArt, 100);
  out.writeUInt16LE(ts.readUInt16LE(106) & ~CRT_HAS_V26, 106);
  return out;
}

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

function runPython(f: Fixture, out: string, v7 = false, favorites: string[] = []): Buffer {
  const fav = favorites.flatMap((x) => ['--favorite', x]);
  execFileSync(PYTHON, [MAKE_PACK, '--roms', f.roms, '--covers', f.covers, '--out', out, ...(v7 ? ['--v7'] : []), ...fav], { stdio: 'pipe' });
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
  assert.equal(ts.length, v7.expectedSize(3));
  assert.equal(asPython(ts, py).length, py.length, 'file size');
  assert.equal(firstDiff(asPython(ts, py), py), -1, `first differing byte at offset ${firstDiff(asPython(ts, py), py)}`);
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
  assert.equal(firstDiff(asPython(built, py), py), -1, 'in-memory build matches Python');

  const chunks: Buffer[] = [];
  let biggest = 0;
  const stream: StreamGame[] = games.map(({ art, ...g }) => {
    const { blob, accent } = artBlobAndAccent(art);
    return { ...g, accent, blob: async () => blob };
  });
  const n = await v7.write(stream, (c) => {
    chunks.push(c);
    biggest = Math.max(biggest, c.length);
  });
  assert.equal(n, built.length);
  assert.ok(Buffer.concat(chunks).equals(built), 'streamed write matches the in-memory build');
  assert.equal(firstDiff(asPython(Buffer.concat(chunks), py), py), -1, 'streamed write matches Python');
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

  // Nothing close to the whole pack is ever one buffer. The largest pieces are fixed size:
  // one cover, the path structs, or the tail (fingerprints and the 3 default cart images).
  assert.ok(biggest <= 6 * STRIDE_V7, `largest chunk ${biggest}`);
});

test('pack v7 fingerprints (FPR2) match make_cover_pack.py --v7, with a known title and a ROM shorter than the header', async () => {
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
  // Known cart header bytes: title "PM_CRYSTAL" (11 bytes with its NUL), CGB flag 0x80,
  // header checksum 0xAB, global checksum 0x1234.
  const rom = fs.readFileSync(path.join(f.roms, 'Known Header.gbc'));
  Buffer.from('PM_CRYSTAL\0', 'latin1').copy(rom, 0x134);
  rom[0x143] = 0x80;
  rom[0x14d] = 0xab;
  rom[0x14e] = 0x12;
  rom[0x14f] = 0x34;
  fs.writeFileSync(path.join(f.roms, 'Known Header.gbc'), rom);
  const py = runPython(f, path.join(OUT, 'v7-fingerprints', 'python.bin'), true);
  const ts = packWriter(7).build(letterOrder(await tsGames(f, 2047)));
  assert.equal(firstDiff(asPython(ts, py), py), -1, `first differing byte at offset ${firstDiff(asPython(ts, py), py)}`);
  const s = readPackSummary(ts)!;
  assert.equal(ts.toString('ascii', 80, 84), 'FPR2');
  assert.deepEqual(s.fingerprints, { offset: fingerprintTableOffset(2), count: 2 });
  const rec = (i: number) => [...ts.subarray(s.fingerprints!.offset + i * 8, s.fingerprints!.offset + i * 8 + 8)];
  assert.deepEqual(s.titles, ['Known Header', 'Tiny']);
  // zlib CRC32 of b"PM_CRYSTAL\0" is 0xFB07C0C0, stored little-endian.
  assert.deepEqual(rec(0), [0x12, 0x34, 0xab, 0x80, 0xc0, 0xc0, 0x07, 0xfb]);
  assert.deepEqual(rec(1), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('pack v7 with favorites matches make_cover_pack.py --v7 --favorite, All games tile included', async () => {
  const stems = ['Alleyway', 'Balloon Kid', 'Castlevania', 'Donkey Kong', 'Faceball', 'Gargoyle', 'Kirby', 'Mario Golf', 'Metroid II', 'Pinball', 'Shantae', 'Tetris', 'Wario Land', 'Zelda'];
  const roms: [string, number][] = stems.map((n, i) => [`${n}.${i % 2 ? 'gbc' : 'gb'}`, 4096 + i * 256]);
  const covers: [string, number, number][] = stems.map((n, i) => [`${n}.png`, 70 + (i % 4) * 30, 60 + (i % 3) * 40]);
  const f = makeFixture('v7-favorites-tile', roms, covers);
  const favorites = ['Tetris', 'Kirby'];
  const py = runPython(f, path.join(OUT, 'v7-favorites-tile', 'python.bin'), true, favorites);

  // The app's menu: the favorites section, then every game A to Z with favorites again.
  const all = letterOrder(await tsGames(f, 2047)).map((g) => ({ ...g, hasArt: true, favorite: favorites.includes(g.title) }));
  const list = [...all.filter((g) => g.favorite).map((g) => ({ ...g, section: 'favorite' as const })), ...all.map((g) => ({ ...g, section: 'az' as const }))];
  const v7 = packWriter(7);
  const ts = v7.build(list);
  assert.equal(ts.length, v7.expectedSize(16, true));
  assert.equal(firstDiff(asPython(ts, py), py), -1, `first differing byte at offset ${firstDiff(asPython(ts, py), py)}`);

  const s = readPackSummary(ts)!;
  assert.deepEqual(s.titles.slice(0, 2), ['Kirby', 'Tetris']);
  assert.equal(s.index!.favCount, 2);
  assert.equal(s.carts!.flags, 31); // carts.cfg path, the tile, the empty slot, entry positions, build 26
  // Images: 0 dmg, 1 dual, 2 cgb, 3 the empty slot, 4 the All games tile.
  const emptyAt = s.carts!.artOffset + 3 * STRIDE_V7;
  assert.ok(ts.subarray(emptyAt, emptyAt + BLOB_BYTES).equals(emptySlotBlob()!));
  assert.equal(ts.readUInt16LE(emptyAt), 0, 'the empty slot is keyed: its corner is transparent');
  const tileAt = s.carts!.artOffset + 4 * STRIDE_V7;

  // fav_pos and az_pos on every entry: Kirby is favorite 0, Tetris favorite 1, both in the
  // favorites section (entries 0, 1) and again in the A to Z list; others are not favorites.
  const azIndex = (t: string) => s.titles.lastIndexOf(t);
  assert.deepEqual([s.favPos[0], s.azPos[0]], [0, azIndex('Kirby')]);
  assert.deepEqual([s.favPos[1], s.azPos[1]], [1, azIndex('Tetris')]);
  assert.deepEqual([s.favPos[azIndex('Kirby')], s.azPos[azIndex('Kirby')]], [0, azIndex('Kirby')]);
  assert.deepEqual([s.favPos[azIndex('Tetris')], s.azPos[azIndex('Tetris')]], [1, azIndex('Tetris')]);
  const zelda = azIndex('Zelda');
  assert.deepEqual([s.favPos[zelda], s.azPos[zelda]], [0xffff, zelda]);
  for (let i = 2; i < s.count; i++) assert.equal(s.azPos[i], i, 'an A to Z entry points at itself');
  assert.equal(ts.length, tileAt + 2 * STRIDE_V7, 'the Settings tile follows the All games tile and ends the file');
  const tile = ts.subarray(tileAt, tileAt + BLOB_BYTES);
  for (let i = 0; i < tile.length; i += 2) assert.notEqual(tile.readUInt16LE(i), 0);

  // Streamed, with the tile built by the caller, the bytes are the same.
  const blob = allGamesTileBlob(tilePicks(list).map((g) => g.art));
  const chunks: Buffer[] = [];
  const stream: StreamGame[] = list.map(({ art, ...g }) => {
    const ba = artBlobAndAccent(art);
    return { ...g, accent: ba.accent, blob: async () => ba.blob };
  });
  await v7.write(stream, (c) => void chunks.push(c), { allGamesTile: blob });
  assert.equal(firstDiff(asPython(Buffer.concat(chunks), py), py), -1, 'streamed matches Python');
  await assert.rejects(v7.write(stream, () => undefined), /All games tile/);
});

test('All games tile picks: 9 covers spread across the A to Z list, not favorites, real art first', () => {
  const e = (title: string, o: { favorite?: boolean; hasArt?: boolean; section?: 'favorite' | 'az' } = {}) => ({ title, romFile: `${title}.gb`, platform: 'gbc', romSize: 1, section: o.section ?? ('az' as const), favorite: o.favorite, hasArt: o.hasArt ?? true });
  const az = Array.from({ length: 27 }, (_, i) => e(`Game ${String(i).padStart(2, '0')}`, { favorite: i === 4 }));
  const picks = tilePicks([e('Game 04', { favorite: true, section: 'favorite' }), ...az]).map((g) => g.title);
  // 26 games that are not favorites: index (2i + 1) * 26 / 18, the middle of each ninth.
  assert.deepEqual(picks, ['Game 01', 'Game 05', 'Game 08', 'Game 11', 'Game 14', 'Game 16', 'Game 19', 'Game 22', 'Game 25']);
  assert.ok(!picks.includes('Game 04'));
  // Fewer than 9 with art: any game is used, still spread out; a short list repeats evenly.
  const few = [e('A', { hasArt: false }), e('B'), e('C', { hasArt: false })];
  assert.deepEqual(tilePicks(few).map((g) => g.title), ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C']);
});

test('pack v7 cuts the entry path to 71 bytes plus a NUL, same as make_cover_pack.py', async () => {
  const long = 'A Very Long Game Name That Goes On And On Past The Field.gbc'; // path is 79 bytes
  const f = makeFixture('v7-long-path', [[long, 4096], ['Short.gb', 4096]], [[long.replace(/\.gbc$/, '.png'), 80, 80], ['Short.png', 80, 80]]);
  const py = runPython(f, path.join(OUT, 'v7-long-path', 'python.bin'), true);
  const ts = packWriter(7).build(letterOrder(await tsGames(f, 2047)));
  assert.equal(firstDiff(asPython(ts, py), py), -1, `first differing byte at offset ${firstDiff(asPython(ts, py), py)}`);
  const s = readPackSummary(ts)!;
  assert.equal(s.roms[0], `/Assets/gbc/common/${long}`.slice(0, 71));
  assert.equal(ts[528 + 52 + 71], 0, 'NUL after 71 bytes');
  // The full path is still in the path struct.
  const paths0 = 528 + 2 * (128 + STRIDE_V7);
  assert.equal(ts.toString('utf8', paths0, paths0 + 256).replace(/\0+$/, ''), `/Assets/gbc/common/${long}`);
});
