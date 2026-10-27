/**
 * Things the Pocket leaves on the card that sync must respect:
 *   - suspend points (.sus) made with a different ROM than the one sync places
 *   - favorites.cfg, favorites set on the Pocket
 * Mirrors the real Silver case: a card's own Silver with a suspend point, replaced
 * by the library's Silver. Fake bytes; CRCs come from the bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'pocket');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');
const SAVES = path.join(CARD, 'Saves', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';

const { ensureDirs, BACKUP_DIR } = await import('../src/config.js');
ensureDirs();
const { crc32 } = await import('../src/roms.js');
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { buildLibrary } = await import('../src/library.js');
const { updateChoices, loadChoices } = await import('../src/choices.js');
const { readPackSummary } = await import('../src/pack.js');
const { parseFavorites, favoritesFile, emptyFavorites, FAV_FILE_BYTES } = await import('../src/pocketfav.js');
const { withoutNewSidecar } = await import('../src/io.js');

const SILVER = 'Pokemon - Silver Version';
const crcOf = (p: string) => crc32(fs.readFileSync(p));
const sync = async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  return plan;
};

// Library: the library's Silver, Tetris and Zelda. Card: its own Silver, a hack.
writeFakeRom(path.join(LIB, `${SILVER}.gbc`), 16384, 1);
writeFakeRom(path.join(LIB, 'Tetris.gb'), 8192, 2);
writeFakeRom(path.join(LIB, 'Zelda.gbc'), 8192, 3);
writeFakeRom(path.join(LIB, 'Wario Land.gb'), 8192, 4);
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(SAVES, { recursive: true });
writeFakeRom(path.join(ROMDIR, `${SILVER}.gbc`), 16384, 20);
writeFakeRom(path.join(ROMDIR, 'Crystal Clear.gbc'), 8192, 30);
const SILVER_LIB = crcOf(path.join(LIB, `${SILVER}.gbc`));
const SILVER_CARD = crcOf(path.join(ROMDIR, `${SILVER}.gbc`));
const HACK = crcOf(path.join(ROMDIR, 'Crystal Clear.gbc'));
const TETRIS = crcOf(path.join(LIB, 'Tetris.gb'));
const ZELDA = crcOf(path.join(LIB, 'Zelda.gbc'));
const WARIO = crcOf(path.join(LIB, 'Wario Land.gb'));

const SUS = path.join(SAVES, `${SILVER}.sus`);
const SAV = path.join(SAVES, `${SILVER}.sav`);
const susBytes = crypto.randomBytes(4096);
fs.writeFileSync(SUS, susBytes);
fs.writeFileSync(SAV, crypto.randomBytes(8192));
fs.writeFileSync(path.join(SAVES, 'Tetris.sus'), crypto.randomBytes(1024)); // Tetris is new: nothing was at that name
fs.writeFileSync(path.join(SAVES, 'Zelda.sus'), Buffer.alloc(0)); // empty: nothing to clear
const savBefore = fs.readFileSync(SAV);

test('first sync keeps the card\'s Silver, so its suspend point stays', async () => {
  const plan = await sync();
  assert.equal(plan.keptCard.length, 1);
  assert.deepEqual(plan.suspends, []);
  assert.ok(fs.readFileSync(SUS).equals(susBytes));
  // A new ROM never clears a suspend point: no ROM was at that name before.
  assert.equal(fs.statSync(path.join(SAVES, 'Tetris.sus')).size, 1024);
});

test('using the library\'s Silver clears the suspend point made with the card\'s Silver, after keeping a copy', async () => {
  updateChoices({ [SILVER_LIB]: { useLibraryCopy: true } });
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(
    plan.suspends.map((s) => [s.file, s.size, s.rom, s.oldCrc, s.newCrc]),
    [[`${SILVER}.sus`, 4096, `${SILVER}.gbc`, SILVER_CARD, SILVER_LIB]],
  );
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal(crcOf(path.join(ROMDIR, `${SILVER}.gbc`)), SILVER_LIB);
  assert.equal(fs.statSync(SUS).size, 0, 'the suspend point is empty, as after a resume');
  assert.ok(fs.readFileSync(SAV).equals(savBefore), 'the battery save is untouched');
  const kept = fs.readdirSync(path.join(BACKUP_DIR, 'suspends'));
  assert.equal(kept.length, 1);
  assert.ok(fs.readFileSync(path.join(BACKUP_DIR, 'suspends', kept[0])).equals(susBytes));
  assert.ok(!fs.readdirSync(SAVES).some((f) => f.startsWith('._')));
});

test('a library ROM that changed clears its suspend point too; unchanged ROMs and empty ones are left alone', async () => {
  const wario = Buffer.from(crypto.randomBytes(2048));
  fs.writeFileSync(path.join(SAVES, 'Wario Land.sus'), wario);
  fs.writeFileSync(path.join(SAVES, 'Zelda.sus'), Buffer.alloc(0));
  writeFakeRom(path.join(LIB, 'Wario Land.gb'), 8192, 444); // a new dump of the same game
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.copy.map((c) => [c.file, c.reason]), [['Wario Land.gb', 'changed']]);
  assert.deepEqual(plan.suspends.map((s) => [s.file, s.oldCrc]), [['Wario Land.sus', WARIO]]);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal(fs.statSync(path.join(SAVES, 'Wario Land.sus')).size, 0);
  assert.equal(fs.statSync(path.join(SAVES, 'Tetris.sus')).size, 1024);
  // Nothing changed now: nothing to clear.
  assert.deepEqual((await makePlan({ library: LIB, card: CARD })).plan.suspends, []);
});

test('a "._" file macOS makes for a save while sync writes it is removed; one that was there stays', async () => {
  const f = path.join(SAVES, 'Some.sus');
  fs.writeFileSync(f, 'x');
  await withoutNewSidecar(f, () => fs.writeFileSync(path.join(SAVES, '._Some.sus'), 'made by macOS'));
  assert.ok(!fs.existsSync(path.join(SAVES, '._Some.sus')));
  fs.writeFileSync(path.join(SAVES, '._Some.sus'), 'already there');
  await withoutNewSidecar(f, () => undefined);
  assert.equal(fs.readFileSync(path.join(SAVES, '._Some.sus'), 'utf8'), 'already there');
  fs.rmSync(path.join(SAVES, '._Some.sus'));
  fs.rmSync(f);
});

test('favorites.cfg: parsing, later records win, malformed files are ignored', () => {
  const ok = favoritesFile([
    { crc: TETRIS, favorite: true },
    { crc: ZELDA, favorite: true },
    { crc: TETRIS, favorite: false },
  ]);
  assert.equal(ok.length, FAV_FILE_BYTES);
  assert.deepEqual(parseFavorites(ok), { changes: [{ crc: ZELDA, favorite: true }, { crc: TETRIS, favorite: false }], records: 3 });
  const bad = (f: (b: Buffer) => void) => {
    const b = Buffer.from(ok);
    f(b);
    return parseFavorites(b);
  };
  assert.equal(bad((b) => b.write('FAV2', 0)), null);
  assert.equal(bad((b) => b.writeUInt16LE(2, 4)), null);
  assert.equal(bad((b) => b.writeUInt16LE(600, 6)), null);
  assert.equal(bad((b) => b.writeUInt8(7, 12)), null);
  assert.equal(parseFavorites(Buffer.from('FAV')), null);
  const empty = emptyFavorites();
  assert.deepEqual(parseFavorites(empty), { changes: [], records: 0 });
  assert.equal(empty.toString('latin1', 0, 4), 'FAV1');
  assert.ok(empty.subarray(8).every((b) => b === 0));
});

const FAV = path.join(SAVES, 'favorites.cfg');

test('favorites from the Pocket: shown in the plan, in the pack, saved by CRC, then the file is emptied', async () => {
  updateChoices({ [ZELDA]: { favorite: true } });
  // The card's Wario changed above; the Pocket recorded the CRC of the ROM it had, which is the current one.
  const WARIO_NOW = crcOf(path.join(ROMDIR, 'Wario Land.gb'));
  fs.writeFileSync(
    FAV,
    favoritesFile([
      { crc: TETRIS, favorite: true }, // starred on the Pocket
      { crc: ZELDA, favorite: false }, // unstarred on the Pocket
      { crc: HACK, favorite: true }, // a ROM only on the card
      { crc: WARIO_NOW, favorite: true },
      { crc: WARIO_NOW, favorite: false }, // changed its mind: the last one wins
    ]),
  );
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.pocketFavorites!.records, 5);
  assert.deepEqual(
    plan.pocketFavorites!.changes.map((c) => [c.crc, c.favorite, c.titles]),
    [
      [TETRIS, true, ['Tetris']],
      [ZELDA, false, ['Zelda']],
      [HACK, true, ['Crystal Clear']],
      [WARIO_NOW, false, ['Wario Land']],
    ],
  );
  // The pack this sync writes already has them: Crystal Clear and Tetris first.
  assert.deepEqual(plan.pack.titles.slice(0, 2), ['Crystal Clear', 'Tetris']);

  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const games = loadChoices().games;
  assert.equal(games[TETRIS].favorite, true);
  assert.equal(games[ZELDA].favorite, false);
  assert.equal(games[HACK].favorite, true);
  assert.equal(games[WARIO_NOW].favorite, false);
  const after = fs.readFileSync(FAV);
  assert.ok(after.equals(emptyFavorites()), 'favorites.cfg is empty again');
  assert.deepEqual(readPackSummary(fs.readFileSync(path.join(ROMDIR, 'covers.bin')))!.titles.slice(0, 2), ['Crystal Clear', 'Tetris']);
  const lib = await buildLibrary({ library: LIB, card: CARD });
  assert.equal(lib.games.find((g) => g.crc === HACK)!.favorite, true);

  // Next time there is nothing to apply, and the file is not rewritten.
  const mtime = fs.statSync(FAV).mtimeMs;
  const next = await sync();
  assert.deepEqual(next.pocketFavorites!.changes, []);
  assert.equal(fs.statSync(FAV).mtimeMs, mtime);
});

test('favorites.cfg changed after the plan: the plan is refused; a malformed file is ignored and left alone', async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  fs.writeFileSync(FAV, favoritesFile([{ crc: TETRIS, favorite: false }]));
  await assert.rejects(runSync({ library: LIB, card: CARD, signature: plan.signature }), /changed since this plan/);

  // The core makes the file as 4096 zeros before it first writes to it: no changes, left alone.
  fs.writeFileSync(FAV, Buffer.alloc(4096));
  const p1 = await sync();
  assert.deepEqual(p1.pocketFavorites && { changes: p1.pocketFavorites.changes, records: p1.pocketFavorites.records }, { changes: [], records: 0 });
  assert.ok(fs.readFileSync(FAV).equals(Buffer.alloc(4096)));

  const junk = Buffer.from('not a favorites file at all');
  fs.writeFileSync(FAV, junk);
  const p2 = await sync();
  assert.equal(p2.pocketFavorites, null);
  assert.ok(fs.readFileSync(FAV).equals(junk));
  assert.equal(loadChoices().games[TETRIS].favorite, true);
});
