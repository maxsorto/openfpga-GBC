/**
 * Pack format by core: the card's Cores/maxsorto.GBC/core.json decides.
 * "-cover2" or higher gets v7 with every game; anything else gets v6 with 31.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'format');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';

const { choosePack, coverGeneration, readCore } = await import('../src/core.js');
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { buildLibrary } = await import('../src/library.js');
const { updateChoices } = await import('../src/choices.js');
const { packWriter, readPackSummary } = await import('../src/pack.js');
const { crc32 } = await import('../src/roms.js');
const { ensureDirs, BACKUP_DIR, BACKUPS_KEPT } = await import('../src/config.js');
ensureDirs();

function setCore(card: string, version: string | null, raw?: string): void {
  const dir = path.join(card, 'Cores', 'maxsorto.GBC');
  fs.rmSync(dir, { recursive: true, force: true });
  if (version === null && raw === undefined) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'core.json'), raw ?? JSON.stringify({ core: { magic: 'APF_VER_1', metadata: { shortname: 'GBC', version } } }));
}

test('cover generation from the version string', () => {
  assert.equal(coverGeneration('1.4.0-cover1'), 1);
  assert.equal(coverGeneration('1.4.0-cover2'), 2);
  assert.equal(coverGeneration('2.0.0-cover10'), 10);
  assert.equal(coverGeneration('1.4.0'), null);
  assert.equal(coverGeneration('1.4.0-coverage'), null);
});

test('format choice: cover1 gives v6, cover2 and up give v7, missing or unreadable gives v6', () => {
  const card = path.join(OUT, 'core-only');
  fs.mkdirSync(card, { recursive: true });

  setCore(card, '1.4.0-cover1');
  let c = choosePack(card, 702);
  assert.equal(c.version, 6);
  assert.equal(c.limit, 31);
  assert.match(c.reason, /shows 31 games\. Install build 17 to see all/);

  setCore(card, '1.4.0-cover2');
  c = choosePack(card, 702);
  assert.equal(c.version, 7);
  assert.equal(c.limit, 2047);
  assert.equal(c.streaming, true);
  assert.equal(c.reason, 'Streaming core found (1.4.0-cover2): all 702 games.');

  setCore(card, '1.5.0-cover3');
  assert.equal(choosePack(card, 10).version, 7);

  setCore(card, '1.4.0');
  assert.equal(choosePack(card, 10).version, 6);

  setCore(card, null);
  c = choosePack(card, 702);
  assert.equal(c.version, 6);
  assert.equal(c.core.found, false);
  assert.match(c.reason, /No cover picker core found/);

  setCore(card, null, '{ not json');
  assert.equal(readCore(card).error !== undefined, true);
  assert.equal(choosePack(card, 10).version, 6);

  assert.equal(choosePack(null, 10).version, 6);
});

// A library of 40 games, two starred.
const NAMES = Array.from({ length: 40 }, (_, i) => `Game ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`);
NAMES.forEach((n, i) => writeFakeRom(path.join(LIB, i % 2 ? 'GBC' : 'GB', `${n}.${i % 2 ? 'gbc' : 'gb'}`), 4096 + i * 256, 500 + i));
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(path.join(CARD, 'Saves', 'gbc', 'common'), { recursive: true });

test('streaming core: v7 lists favorites at the top and again under their letter, with all 40 games A to Z', async () => {
  setCore(CARD, '1.4.0-cover2');
  const lib = await buildLibrary({ library: LIB, card: CARD });
  assert.equal(lib.pack.version, 7);
  assert.equal(lib.maxGames, 2047);
  const fav = ['Game Z0', 'Game C1'].map((t) => lib.games.find((g) => g.title === t)!.crc);
  updateChoices(Object.fromEntries(fav.map((c) => [c, { favorite: true }])));

  const { plan } = await makePlan({ library: LIB, card: CARD });
  const all = [...NAMES].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  assert.equal(plan.pack.version, 7);
  assert.equal(plan.pack.count, 42); // 2 favorites + all 40
  assert.equal(plan.pack.favCount, 2);
  assert.equal(plan.pack.limit, 2047);
  assert.equal(plan.pack.streaming, true);
  assert.equal(plan.pack.bytes, packWriter(7).expectedSize(42));
  assert.equal(plan.pack.reason, 'Streaming core found (1.4.0-cover2): all 40 games.');
  assert.deepEqual(plan.pack.titles, ['Game C1', 'Game Z0', ...all]);
  // The space needed includes the whole v7 pack.
  assert.ok(plan.space.neededBytes >= plan.copyBytes + plan.pack.bytes);

  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const file = path.join(ROMDIR, 'covers.bin');
  assert.equal(fs.statSync(file).size, packWriter(7).expectedSize(42));
  const s = readPackSummary(fs.readFileSync(file))!;
  assert.equal(s.version, 7);
  assert.equal(s.count, 42);
  assert.deepEqual(s.titles, plan.pack.titles);
  assert.equal(s.index!.favCount, 2);
  // Each entry carries the CRC of the ROM file it points at.
  s.roms.forEach((rom, i) => assert.equal(s.crcs[i], crc32(fs.readFileSync(path.join(CARD, rom)))));
  // Flags bit 1 marks every entry of a favorite, at the top and under its letter.
  s.crcs.forEach((crc, i) => assert.equal((s.flags[i] & 2) !== 0, fav.includes(crc), s.titles[i]));
  assert.equal(s.crcs.filter((c) => fav.includes(c)).length, 4);
  // A favorite's second entry is a full copy: same path structs and art.
  const buf = fs.readFileSync(file);
  const top = s.titles.indexOf('Game C1');
  const again = s.titles.lastIndexOf('Game C1');
  assert.notEqual(top, again);
  const art = (i: number) => buf.subarray(528 + 42 * 128 + i * 65536, 528 + 42 * 128 + (i + 1) * 65536);
  const paths = (i: number) => buf.subarray(528 + 42 * (128 + 65536) + i * 768, 528 + 42 * (128 + 65536) + (i + 1) * 768);
  assert.ok(art(top).equals(art(again)));
  assert.ok(paths(top).equals(paths(again)));
  assert.ok(buf.subarray(528 + top * 128, 528 + top * 128 + 128).equals(buf.subarray(528 + again * 128, 528 + again * 128 + 128)));
  // The core finds favorites.cfg at paths0 + (count * 3 + 1) * 256, right after the log path.
  const paths0 = 528 + 42 * (128 + 65536);
  const struct = (k: number) => buf.toString('utf8', paths0 + k * 256, paths0 + (k + 1) * 256).replace(/\0+$/, '');
  assert.equal(struct(42 * 3), '/Saves/gbc/common/picker.log');
  assert.equal(struct(42 * 3 + 1), '/Saves/gbc/common/favorites.cfg');
  // Then the cartridge fingerprint table, one record per entry (duplicates included), ending the file.
  const table = paths0 + (42 * 3 + 2) * 256;
  assert.equal(buf.toString('ascii', 80, 84), 'FPR1');
  assert.equal(buf.readUInt32LE(84), table);
  assert.equal(buf.readUInt16LE(88), 42);
  assert.equal(buf.readUInt16LE(90), 0);
  assert.equal(table % 4, 0);
  assert.equal(buf.length, table + 42 * 4);
  const rec = (i: number) => buf.subarray(table + i * 4, table + i * 4 + 4);
  s.roms.forEach((r, i) => {
    const romBytes = fs.readFileSync(path.join(CARD, r));
    assert.deepEqual([...rec(i)], [romBytes[0x14e], romBytes[0x14f], romBytes[0x14d], romBytes[0x143]], s.titles[i]);
  });
  assert.ok(rec(top).equals(rec(again)), 'a favorite\'s two entries have the same fingerprint');
  assert.ok(!fs.existsSync(path.join(ROMDIR, '.covers.bin.part')));
});

test('back to a 31 game core: v6, cut to 31, same order', async () => {
  setCore(CARD, '1.4.0-cover1');
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.pack.version, 6);
  assert.equal(plan.pack.count, 31);
  assert.deepEqual(plan.pack.titles.slice(0, 2), ['Game C1', 'Game Z0']);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const s = readPackSummary(fs.readFileSync(path.join(ROMDIR, 'covers.bin')))!;
  assert.equal(s.version, 6);
  assert.equal(s.count, 31);
  assert.deepEqual(s.titles, plan.pack.titles);
  // v6 has no favorites.cfg path and no duplicates: it ends with the log path.
  const buf = fs.readFileSync(path.join(ROMDIR, 'covers.bin'));
  assert.equal(buf.toString('utf8', buf.length - 256).replace(/\0+$/, ''), '/Saves/gbc/common/picker.log');
  assert.ok(buf.subarray(16, 528).every((x) => x === 0), 'no FPR1 in v6');
  assert.equal(new Set(s.crcs.length ? s.crcs : s.roms).size, 31);
});

test('old covers.bin: not copied when the app wrote it, copied and capped when it did not', async () => {
  const before = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('covers-')).length;
  // The card has the pack the app wrote last time: no copy, no full read of the card.
  let { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal(fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('covers-')).length, before);
  // A covers.bin from elsewhere (another tool, another Mac) is kept on this Mac first.
  for (let i = 0; i < BACKUPS_KEPT + 2; i++) {
    fs.writeFileSync(path.join(ROMDIR, 'covers.bin'), `not ours ${i}`);
    ({ plan } = await makePlan({ library: LIB, card: CARD }));
    await runSync({ library: LIB, card: CARD, signature: plan.signature });
  }
  const kept = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('covers-'));
  assert.equal(kept.length, BACKUPS_KEPT);
  assert.equal(fs.readFileSync(path.join(BACKUP_DIR, kept.sort().at(-1)!), 'utf8'), `not ours ${BACKUPS_KEPT + 1}`);
});

test('v7 index on a synced card: favorites counted, listed again under their letter, # first, missing letters 0xFFFF', async () => {
  const lib2 = path.join(OUT, 'library-index');
  const card2 = path.join(OUT, 'card-index');
  const stems = ['1942', '3D Pocket', 'alleyway', 'Asteroids', 'Balloon Kid', 'Tetris', 'Tetris DX', 'The Legend of Zelda', 'Wario Land', 'Zelda'];
  stems.forEach((n, i) => writeFakeRom(path.join(lib2, `${n}.gb`), 4096 + i * 128, 900 + i));
  fs.mkdirSync(path.join(card2, 'Assets', 'gbc', 'common'), { recursive: true });
  setCore(card2, '1.4.0-cover2');
  const lib = await buildLibrary({ library: lib2, card: card2 });
  const crcOf = (t: string) => lib.games.find((g) => g.title === t)!.crc;
  updateChoices({ [crcOf('Tetris')]: { favorite: true }, [crcOf('Zelda')]: { favorite: true } });

  const { plan } = await makePlan({ library: lib2, card: card2 });
  assert.deepEqual(plan.pack.titles, [
    'Tetris', 'Zelda',
    '1942', '3D Pocket', 'alleyway', 'Asteroids', 'Balloon Kid', 'Tetris', 'Tetris DX', 'The Legend of Zelda', 'Wario Land', 'Zelda',
  ]);
  await runSync({ library: lib2, card: card2, signature: plan.signature });
  const s = readPackSummary(fs.readFileSync(path.join(card2, 'Assets', 'gbc', 'common', 'covers.bin')))!;
  assert.deepEqual(s.titles, plan.pack.titles);
  const idx = s.index!;
  assert.equal(idx.favCount, 2);
  assert.equal(idx.playedCount, 0);
  const at = (l: string) => idx.starts[l === '#' ? 0 : l.charCodeAt(0) - 64];
  assert.equal(at('#'), 2);
  assert.equal(at('A'), 4);
  assert.equal(at('B'), 6);
  assert.equal(at('T'), 7); // Tetris again, under T
  assert.equal(at('W'), 10);
  assert.equal(at('Z'), 11); // Zelda is a favorite, and is also under Z
  for (const l of 'CDEFGHIJKLMNOPQRSUVXY') assert.equal(at(l), 0xffff, l);
  const present = idx.starts.filter((x) => x !== 0xffff);
  assert.deepEqual(present, [...present].sort((a, b) => a - b));
  // The reserved area holds only the index and the FPR1 block.
  const head = fs.readFileSync(path.join(card2, 'Assets', 'gbc', 'common', 'covers.bin')).subarray(16, 528);
  // After the index (it ends at file offset 78): zeros, then FPR1 at 80 (12 bytes), then zeros.
  assert.ok(head.subarray(24 - 16 + 27 * 2, 80 - 16).every((b) => b === 0));
  assert.equal(head.toString('ascii', 80 - 16, 84 - 16), 'FPR1');
  assert.ok(head.subarray(92 - 16).every((b) => b === 0));
});

test('v6 has no index: the reserved area stays zero', async () => {
  setCore(CARD, '1.4.0-cover1');
  const { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const buf = fs.readFileSync(path.join(ROMDIR, 'covers.bin'));
  assert.ok(buf.subarray(16, 528).every((b) => b === 0));
  assert.equal(readPackSummary(buf)!.index, null);
});
