/**
 * A card that already has ROMs you copied by hand, mirroring Max's card:
 *   - Pokemon Yellow is on the card as .gbc; the library has the same ROM as .gb. Adopt it, keep .gbc.
 *   - Pokemon Silver on the card is a different dump than the library's. Keep the card's copy.
 *   - A ROM hack only on the card stays in the menu and is never removed.
 *   - Saves are checked against the ROMs after sync, and never touched.
 * Fake bytes; the CRCs come from the bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'adopt');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');
const SAVES = path.join(CARD, 'Saves', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';

const { crc32 } = await import('../src/roms.js');
const { buildLibrary } = await import('../src/library.js');
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { updateChoices } = await import('../src/choices.js');
const { readPackSummary } = await import('../src/pack.js');
const { ensureDirs } = await import('../src/config.js');
ensureDirs();

const YELLOW = 'Pokemon - Yellow Version';
const SILVER = 'Pokemon - Silver Version';
const HACK = 'Pokemon - Crystal Clear';

// Library
writeFakeRom(path.join(LIB, 'GB', `${YELLOW}.gb`), 16384, 1);
writeFakeRom(path.join(LIB, 'GBC', `${SILVER}.gbc`), 16384, 2); // the library's dump
writeFakeRom(path.join(LIB, 'GB', 'Tetris.gb'), 8192, 3);
writeFakeRom(path.join(LIB, 'GBC', 'Zelda.gbc'), 8192, 4);
// Card: the same Yellow under .gbc, a different Silver, a hack.
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(path.join(CARD, 'Cores'), { recursive: true });
fs.copyFileSync(path.join(LIB, 'GB', `${YELLOW}.gb`), path.join(ROMDIR, `${YELLOW}.gbc`));
writeFakeRom(path.join(ROMDIR, `${SILVER}.gbc`), 16384, 20); // the card's dump
writeFakeRom(path.join(ROMDIR, `${HACK}.gbc`), 32768, 30);
fs.mkdirSync(SAVES, { recursive: true });
for (const n of [YELLOW, SILVER, HACK, 'Tetris', 'Zelda', 'Old Game']) fs.writeFileSync(path.join(SAVES, `${n}.sav`), crypto.randomBytes(8192));
fs.writeFileSync(path.join(SAVES, `${YELLOW}.sus`), crypto.randomBytes(1024));

const crcOf = (p: string) => crc32(fs.readFileSync(p));
const YELLOW_CRC = crcOf(path.join(LIB, 'GB', `${YELLOW}.gb`));
const SILVER_LIB = crcOf(path.join(LIB, 'GBC', `${SILVER}.gbc`));
const SILVER_CARD = crcOf(path.join(ROMDIR, `${SILVER}.gbc`));
const HACK_CRC = crcOf(path.join(ROMDIR, `${HACK}.gbc`));
assert.notEqual(SILVER_LIB, SILVER_CARD);

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, f));
    out[f] = `${crcOf(path.join(dir, f))}|${st.size}|${st.mtimeMs}`;
  }
  return out;
}
const savesBefore = snapshot(SAVES);
const manifest = () => JSON.parse(fs.readFileSync(path.join(ROMDIR, 'cover-picker.json'), 'utf8')) as { placed: { crc: string; file: string }[] };
const saveMap = (saves: { file: string; rom: string | null; state: string }[]) => Object.fromEntries(saves.map((s) => [s.file, [s.rom, s.state]]));

test('first sync: adopt the same ROM under its card name, keep a different dump, keep the hack', async () => {
  const lib = await buildLibrary({ library: LIB, card: CARD });
  const yellow = lib.games.find((g) => g.crc === YELLOW_CRC)!;
  assert.equal(yellow.cardState, 'adopt');
  assert.equal(yellow.file, `${YELLOW}.gbc`);
  const silverLib = lib.games.find((g) => g.crc === SILVER_LIB)!;
  assert.equal(silverLib.cardState, 'cardKept');
  assert.equal(silverLib.cardFile, `${SILVER}.gbc`);
  const cardOnly = lib.games.filter((g) => g.origin === 'card').map((g) => [g.file, g.crc]).sort();
  assert.deepEqual(cardOnly, [
    [`${HACK}.gbc`, HACK_CRC],
    [`${SILVER}.gbc`, SILVER_CARD],
  ]);

  // The hack is a favorite: it comes first like any game.
  updateChoices({ [HACK_CRC]: { favorite: true } });

  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.adopt.map((a) => [a.file, a.crc]), [[`${YELLOW}.gbc`, YELLOW_CRC]]);
  assert.deepEqual(plan.keptCard.map((k) => [k.libraryFile, k.cardFile, k.cardCrc, k.crc]), [[`GBC/${SILVER}.gbc`, `${SILVER}.gbc`, SILVER_CARD, SILVER_LIB]]);
  assert.deepEqual(plan.copy.map((c) => c.file).sort(), ['Tetris.gb', 'Zelda.gbc']);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.cardOnly, [`${HACK}.gbc`, `${SILVER}.gbc`]);
  assert.equal(plan.menuGames, 5);
  assert.deepEqual(plan.pack.titles, [HACK, 'Pokemon - Silver Version', 'Pokemon - Yellow Version', 'Tetris', 'Zelda']);
  assert.deepEqual(saveMap(plan.saves), {
    [`${HACK}.sav`]: [`${HACK}.gbc`, 'ok'],
    'Old Game.sav': [null, 'orphan'],
    [`${SILVER}.sav`]: [`${SILVER}.gbc`, 'ok'],
    'Tetris.sav': ['Tetris.gb', 'ok'],
    [`${YELLOW}.sav`]: [`${YELLOW}.gbc`, 'ok'],
    'Zelda.sav': ['Zelda.gbc', 'ok'],
  });

  const romsBefore = snapshot(ROMDIR);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const after = snapshot(ROMDIR);
  for (const f of [`${YELLOW}.gbc`, `${SILVER}.gbc`, `${HACK}.gbc`]) assert.equal(after[f], romsBefore[f], `${f} untouched`);
  assert.ok(!fs.existsSync(path.join(ROMDIR, `${YELLOW}.gb`)), 'the library copy of Yellow is not placed');
  assert.ok(!fs.readdirSync(ROMDIR).some((f) => f.startsWith(SILVER) && f !== `${SILVER}.gbc`), 'no second Silver');
  assert.deepEqual(manifest().placed.map((e) => [e.file, e.crc]).sort(), [
    [`${YELLOW}.gbc`, YELLOW_CRC],
    ['Tetris.gb', crcOf(path.join(LIB, 'GB', 'Tetris.gb'))],
    ['Zelda.gbc', crcOf(path.join(LIB, 'GBC', 'Zelda.gbc'))],
  ]);
  const pack = readPackSummary(fs.readFileSync(path.join(ROMDIR, 'covers.bin')))!;
  assert.equal(pack.count, 5);
  assert.equal(pack.titles[0], HACK);
  assert.ok(pack.roms.includes(`/Assets/gbc/common/${YELLOW}.gbc`));
  assert.deepEqual(snapshot(SAVES), savesBefore, 'saves untouched');
});

test('resync: nothing to adopt or copy; the kept card copy is still kept', async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.adopt, []);
  assert.deepEqual(plan.copy, []);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keptCard.length, 1);
  assert.equal(plan.unchanged, 3);
});

test('a game leaving the library: its ROM goes, its save stays, and the plan warns', async () => {
  fs.rmSync(path.join(LIB, 'GBC', 'Zelda.gbc'));
  fs.rmSync(path.join(LIB, 'GB', `${YELLOW}.gb`));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  // Yellow was adopted, so the app removes it like any ROM it placed.
  assert.deepEqual(plan.remove.map((r) => r.file).sort(), [`${YELLOW}.gbc`, 'Zelda.gbc']);
  assert.deepEqual(saveMap(plan.saves)['Zelda.sav'], [null, 'loses']);
  assert.deepEqual(saveMap(plan.saves)[`${YELLOW}.sav`], [null, 'loses']);
  assert.deepEqual(saveMap(plan.saves)[`${HACK}.sav`], [`${HACK}.gbc`, 'ok']);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.ok(!fs.existsSync(path.join(ROMDIR, 'Zelda.gbc')));
  assert.ok(fs.existsSync(path.join(ROMDIR, `${HACK}.gbc`)), 'card only ROM is never removed');
  assert.ok(fs.existsSync(path.join(ROMDIR, `${SILVER}.gbc`)));
  assert.deepEqual(snapshot(SAVES), savesBefore, 'saves untouched');
});

test('an empty library folder stops sync before it removes everything', async () => {
  const empty = path.join(OUT, 'empty-library');
  fs.mkdirSync(empty, { recursive: true });
  await assert.rejects(makePlan({ library: empty, card: CARD }), /no ROMs/);
});
