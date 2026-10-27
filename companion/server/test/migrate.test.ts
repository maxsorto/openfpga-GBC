/**
 * A new dump of the same game keeps your choices. "Same game" means the same place:
 * the same path in the library folder, or the same file name on the card. A file
 * that moved and changed at once is a different file, and nothing moves (nothing is
 * lost either: the old choices stay under the old CRC).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'migrate');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';

const { ensureDirs } = await import('../src/config.js');
ensureDirs();
const { crc32 } = await import('../src/roms.js');
const { buildLibrary } = await import('../src/library.js');
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { updateChoices, loadChoices, markMigrationsSeen } = await import('../src/choices.js');

const SILVER = 'Pokemon - Silver Version';
const crcOf = (p: string) => crc32(fs.readFileSync(p));
const ART = { kind: 'thumb' as const, repo: 'Nintendo_-_Game_Boy', name: 'Tetris (World) (Rev 1)' };
const game = async (crc: string) => (await buildLibrary({ library: LIB, card: CARD })).games.find((g) => g.crc === crc)!;
const sync = async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  return plan;
};

writeFakeRom(path.join(LIB, 'GB', 'Tetris.gb'), 8192, 1);
writeFakeRom(path.join(LIB, 'GB', 'Zelda.gb'), 8192, 2);
writeFakeRom(path.join(LIB, 'GB', 'Mole Mania.gb'), 8192, 3);
writeFakeRom(path.join(LIB, 'GBC', `${SILVER}.gbc`), 16384, 4);
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(path.join(CARD, 'Saves', 'gbc', 'common'), { recursive: true });
writeFakeRom(path.join(ROMDIR, `${SILVER}.gbc`), 16384, 40); // the card's own Silver, a different dump
writeFakeRom(path.join(ROMDIR, 'Crystal Clear.gbc'), 8192, 50); // a hack only on the card
const SAV = path.join(CARD, 'Saves', 'gbc', 'common', `${SILVER}.sav`);
fs.writeFileSync(SAV, Buffer.alloc(8192, 3));

const TETRIS1 = crcOf(path.join(LIB, 'GB', 'Tetris.gb'));
const ZELDA1 = crcOf(path.join(LIB, 'GB', 'Zelda.gb'));
const MOLE1 = crcOf(path.join(LIB, 'GB', 'Mole Mania.gb'));
const SILVER_LIB = crcOf(path.join(LIB, 'GBC', `${SILVER}.gbc`));
const SILVER_CARD = crcOf(path.join(ROMDIR, `${SILVER}.gbc`));
const HACK1 = crcOf(path.join(ROMDIR, 'Crystal Clear.gbc'));

test('setup: choices on the old dumps, first sync', async () => {
  updateChoices({
    [TETRIS1]: { favorite: true, title: 'Tetris (mine)', art: ART },
    [ZELDA1]: { favorite: true },
    [MOLE1]: { favorite: true },
    [SILVER_CARD]: { favorite: true, title: 'Silver (card)' },
    [HACK1]: { favorite: true },
  });
  const plan = await sync();
  assert.equal(plan.keptCard.length, 1);
});

test('library: a new dump at the same path keeps star, cover and title, once', async () => {
  writeFakeRom(path.join(LIB, 'GB', 'Tetris.gb'), 8192, 111);
  const TETRIS2 = crcOf(path.join(LIB, 'GB', 'Tetris.gb'));
  const lib = await buildLibrary({ library: LIB, card: CARD });
  const t = lib.games.find((g) => g.crc === TETRIS2)!;
  assert.equal(t.favorite, true);
  assert.equal(t.title, 'Tetris (mine)');
  assert.deepEqual(t.art, ART);
  assert.deepEqual(
    lib.migrated.map((m) => [m.title, m.kept, m.reason, m.where]),
    [['Tetris (mine)', ['star', 'cover', 'title'], 'library', 'GB/Tetris.gb']],
  );
  // Nothing is lost: the old CRC keeps its choices.
  assert.equal(loadChoices().games[TETRIS1].favorite, true);
  // Shown once: after the app marks it seen, it is not offered again, and a rescan does not move it twice.
  markMigrationsSeen(lib.migrated.map((m) => m.id));
  const again = await buildLibrary({ library: LIB, card: CARD });
  assert.deepEqual(again.migrated, []);
  assert.equal(loadChoices().migrations.length, 1);
});

test('library: the new dump\'s own choices win; only what it lacks is carried over', async () => {
  const next = path.join(OUT, 'tetris-v3.gb');
  writeFakeRom(next, 8192, 222);
  const TETRIS3 = crcOf(next);
  updateChoices({ [TETRIS3]: { title: 'Tetris DX?' } });
  fs.renameSync(next, path.join(LIB, 'GB', 'Tetris.gb'));
  const t = await game(TETRIS3);
  assert.equal(t.title, 'Tetris DX?');
  assert.equal(t.favorite, true);
  assert.deepEqual(t.art, ART);
});

test('card: "Use the library\'s" carries the card copy\'s own star and title to the library dump', async () => {
  updateChoices({ [SILVER_LIB]: { useLibraryCopy: true } });
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.carryOver.map((c) => [c.from, c.to, c.file, c.kept]), [[SILVER_CARD, SILVER_LIB, `${SILVER}.gbc`, ['star', 'title']]]);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const g = await game(SILVER_LIB);
  assert.equal(g.favorite, true);
  assert.equal(g.title, 'Silver (card)');
  const c = loadChoices();
  assert.equal(c.games[SILVER_LIB].useLibraryCopy, true);
  const m = c.migrations.find((x) => x.to === SILVER_LIB)!;
  assert.equal(m.reason, 'card');
  assert.equal(m.seen, true, 'the plan showed it');
  assert.ok(fs.readFileSync(SAV).equals(Buffer.alloc(8192, 3)), 'the battery save is untouched');
});

test('card: a ROM you put there yourself, replaced under the same name, keeps its star', async () => {
  writeFakeRom(path.join(ROMDIR, 'Crystal Clear.gbc'), 8192, 555);
  const HACK2 = crcOf(path.join(ROMDIR, 'Crystal Clear.gbc'));
  const lib = await buildLibrary({ library: LIB, card: CARD });
  assert.equal(lib.games.find((g) => g.crc === HACK2)!.favorite, true);
  assert.ok(lib.migrated.some((m) => m.reason === 'card' && m.where === 'Crystal Clear.gbc' && m.kept.includes('star')));
});

test('no move when the path changes at the same time as the contents', async () => {
  // Zelda.gb goes, Zelda DX.gb (a different file) comes.
  fs.rmSync(path.join(LIB, 'GB', 'Zelda.gb'));
  writeFakeRom(path.join(LIB, 'GB', 'Zelda DX.gb'), 8192, 666);
  // Mole Mania moves to another folder with new contents: same name on the card, but a different file.
  fs.rmSync(path.join(LIB, 'GB', 'Mole Mania.gb'));
  writeFakeRom(path.join(LIB, 'GBC', 'Mole Mania.gb'), 8192, 777);
  const before = loadChoices().migrations.length;
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.copy.map((c) => [c.file, c.reason]).sort(), [['Mole Mania.gb', 'changed'], ['Zelda DX.gb', 'new']]);
  assert.deepEqual(plan.carryOver, []);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal((await game(crcOf(path.join(LIB, 'GB', 'Zelda DX.gb')))).favorite, false);
  assert.equal((await game(crcOf(path.join(LIB, 'GBC', 'Mole Mania.gb')))).favorite, false);
  const c = loadChoices();
  assert.equal(c.migrations.length, before);
  // Nothing is lost: the old choices stay under the old CRCs.
  assert.equal(c.games[ZELDA1].favorite, true);
  assert.equal(c.games[MOLE1].favorite, true);
});
