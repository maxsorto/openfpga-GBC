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

test('streaming core: plan and sync write v7 with all 40 games, favorites first then A to Z', async () => {
  setCore(CARD, '1.4.0-cover2');
  const lib = await buildLibrary({ library: LIB, card: CARD });
  assert.equal(lib.pack.version, 7);
  assert.equal(lib.maxGames, 2047);
  const fav = ['Game Z0', 'Game C1'].map((t) => lib.games.find((g) => g.title === t)!.crc);
  updateChoices(Object.fromEntries(fav.map((c) => [c, { favorite: true }])));

  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.pack.version, 7);
  assert.equal(plan.pack.count, 40);
  assert.equal(plan.pack.limit, 2047);
  assert.equal(plan.pack.streaming, true);
  assert.equal(plan.pack.bytes, packWriter(7).expectedSize(40));
  assert.equal(plan.pack.reason, 'Streaming core found (1.4.0-cover2): all 40 games.');
  const rest = [...NAMES].filter((n) => n !== 'Game Z0' && n !== 'Game C1').sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  assert.deepEqual(plan.pack.titles, ['Game C1', 'Game Z0', ...rest]);
  // The space needed includes the whole v7 pack.
  assert.ok(plan.space.neededBytes >= plan.copyBytes + plan.pack.bytes);

  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const file = path.join(ROMDIR, 'covers.bin');
  assert.equal(fs.statSync(file).size, packWriter(7).expectedSize(40));
  const s = readPackSummary(fs.readFileSync(file))!;
  assert.equal(s.version, 7);
  assert.equal(s.count, 40);
  assert.deepEqual(s.titles, plan.pack.titles);
  // Each entry carries the CRC of the ROM file it points at.
  s.roms.forEach((rom, i) => assert.equal(s.crcs[i], crc32(fs.readFileSync(path.join(CARD, rom)))));
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
});

test('old covers.bin copies on the Mac are capped', async () => {
  for (let i = 0; i < BACKUPS_KEPT + 2; i++) {
    setCore(CARD, i % 2 ? '1.4.0-cover2' : '1.4.0-cover1');
    const { plan } = await makePlan({ library: LIB, card: CARD });
    await runSync({ library: LIB, card: CARD, signature: plan.signature });
  }
  const kept = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('covers-'));
  assert.equal(kept.length, BACKUPS_KEPT);
});
