/**
 * Library scan, sync plan and sync, end to end, on a fake library and a fake
 * card in test/.out/sync. Nothing here touches a real card or real ROMs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'sync');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');
const SAVES = path.join(CARD, 'Saves', 'gbc', 'common');

// Settings, choices and caches go to the test folder; no downloads.
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

const GB = [
  'Alleyway', 'Balloon Kid', 'Castlevania - The Adventure', 'Dr. Mario', 'Final Fantasy Adventure',
  "Kirby's Dream Land", 'Kirby\'s Dream Land 2', 'Link\'s Awakening', 'Mega Man - Dr. Wily\'s Revenge', 'Metroid II - Return of Samus',
  'Pokemon - Blue Version', 'Pokemon - Red Version', 'Super Mario Land', 'Super Mario Land 2 - 6 Golden Coins', 'Tetris',
  'Wario Land - Super Mario Land 3', 'Wario Land II', 'Donkey Kong', 'Gargoyle\'s Quest', 'Mole Mania',
];
const GBC = [
  'Pokemon - Crystal Version', 'Pokemon - Gold Version', 'Pokemon - Silver Version', 'Pokemon Pinball', 'Pokemon Trading Card Game',
  'Shantae', 'Tetris DX', 'Wario Land 3', 'Wario Land II', 'Dragon Warrior Monsters', 'Harvest Moon GBC',
  'Metal Gear Solid', 'Mario Golf', 'Mario Tennis', 'Survival Kids', 'The Legend of Zelda - Oracle of Ages', 'Kirby Tilt \'n\' Tumble',
];

let seed = 1;
const rom = (rel: string, bytes = 8192 + (seed % 7) * 1024) => writeFakeRom(path.join(LIB, rel), bytes, seed++);
for (const n of GB) rom(`GB/${n}.gb`);
for (const n of GBC) rom(`GBC/${n}.gbc`);
// Content duplicates: same bytes under another name or folder.
fs.mkdirSync(path.join(LIB, 'GBC', 'Extra'), { recursive: true });
fs.copyFileSync(path.join(LIB, 'GBC', 'Tetris DX.gbc'), path.join(LIB, 'GBC', 'Extra', 'Tetris DX copy.gbc'));
fs.copyFileSync(path.join(LIB, 'GB', 'Tetris.gb'), path.join(LIB, 'GB', 'Tetris (copy).gb'));
fs.copyFileSync(path.join(LIB, 'GB', 'Mole Mania.gb'), path.join(LIB, 'GBC', 'Mole Mania.gb'));
// An AppleDouble file and a hidden folder: both must be skipped.
fs.writeFileSync(path.join(LIB, 'GB', '._Tetris.gb'), Buffer.alloc(4096, 7));
writeFakeRom(path.join(LIB, '.hidden', 'Secret.gb'), 4096, 999);
// Not ROMs.
fs.writeFileSync(path.join(LIB, 'rename-log.csv'), 'a,b\n');

const UNIQUE = GB.length + GBC.length; // 37; the three duplicates merge

// The card: a save, a suspend file, and a ROM put there by hand.
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(path.join(CARD, 'Cores'), { recursive: true });
fs.mkdirSync(SAVES, { recursive: true });
fs.writeFileSync(path.join(SAVES, 'some.sav'), crypto.randomBytes(8192));
fs.writeFileSync(path.join(SAVES, 'Tetris.sav'), crypto.randomBytes(8192));
fs.writeFileSync(path.join(SAVES, 'Tetris.sus'), crypto.randomBytes(4096));
writeFakeRom(path.join(ROMDIR, 'Handmade.gb'), 4096, 4242);

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        const st = fs.statSync(abs);
        out[path.relative(dir, abs)] = `${crc32(fs.readFileSync(abs))}|${st.size}|${st.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

const savesBefore = snapshot(path.join(CARD, 'Saves'));
const handBefore = snapshot(ROMDIR)['Handmade.gb'];
const fileCrc = (f: string) => crc32(fs.readFileSync(path.join(ROMDIR, f)));
const manifest = () => JSON.parse(fs.readFileSync(path.join(ROMDIR, 'cover-picker.json'), 'utf8'));

function assertCardSafe() {
  assert.deepEqual(snapshot(path.join(CARD, 'Saves')), savesBefore, 'saves untouched');
  assert.equal(snapshot(ROMDIR)['Handmade.gb'], handBefore, 'hand placed ROM untouched');
  assert.ok(!fs.readdirSync(ROMDIR).some((f) => f.startsWith('.')), 'no hidden or partial files left');
}

test('library scan: recursive, skips hidden and AppleDouble files, merges duplicates', async () => {
  const lib = await buildLibrary({ library: LIB, card: null });
  assert.equal(lib.source.files, UNIQUE + 3);
  assert.equal(lib.source.duplicates, 3);
  assert.equal(lib.games.length, UNIQUE);
  const tetrisDx = lib.games.find((g) => g.file === 'Tetris DX.gbc')!;
  assert.deepEqual(tetrisDx.paths, ['GBC/Tetris DX.gbc', 'GBC/Extra/Tetris DX copy.gbc']);
  assert.ok(!lib.games.some((g) => g.paths.some((p) => p.includes('._') || p.includes('.hidden'))));
  // Same name before the extension means the same save file, so one is renamed.
  const wario = lib.games.filter((g) => /^Wario Land II/.test(g.file)).map((g) => g.file).sort();
  assert.deepEqual(wario, ['Wario Land II (GBC).gbc', 'Wario Land II.gb']);
  // Mole Mania is in two folders with the same bytes: one game.
  assert.equal(lib.games.filter((g) => g.file.startsWith('Mole Mania')).length, 1);
});

test('first sync: plan, copy, verify, pack with favorites first', async () => {
  const lib = await buildLibrary({ library: LIB, card: CARD });
  const fav = ['Shantae', 'Balloon Kid'].map((t) => lib.games.find((g) => g.title === t)!.crc);
  updateChoices(Object.fromEntries(fav.map((c) => [c, { favorite: true }])));

  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.copy.length, UNIQUE);
  assert.ok(plan.copy.every((c) => c.reason === 'new'));
  assert.equal(plan.remove.length, 0);
  assert.deepEqual(plan.cardOnly, ['Handmade.gb']);
  assert.equal(plan.manifest.exists, false);
  assert.equal(plan.pack.count, 31);
  assert.equal(plan.pack.limit, 31);
  assert.deepEqual(plan.pack.titles.slice(0, 2), ['Balloon Kid', 'Shantae']);
  const rest = plan.pack.titles.slice(2);
  assert.deepEqual(rest, [...rest].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  assert.ok(plan.space.enough);

  const events: string[] = [];
  await runSync({ library: LIB, card: CARD, signature: plan.signature }, (e) => events.push(e.type === 'file' ? `file:${e.state}` : e.type));
  assert.equal(events.filter((e) => e === 'file:verified').length, UNIQUE);
  assert.ok(events.includes('done'));

  for (const c of plan.copy) assert.equal(fileCrc(c.file), c.crc, c.file);
  const m = manifest();
  assert.equal(m.version, 1);
  assert.equal(m.placed.length, UNIQUE);
  assert.ok(!m.placed.some((e: { file: string }) => e.file === 'Handmade.gb'));
  assert.ok(!fs.existsSync(path.join(ROMDIR, '._Tetris.gb')));
  const pack = readPackSummary(fs.readFileSync(path.join(ROMDIR, 'covers.bin')))!;
  assert.equal(pack.version, 6);
  assert.equal(pack.count, 31);
  assert.deepEqual(pack.titles.slice(0, 2), ['Balloon Kid', 'Shantae']);
  assertCardSafe();
});

test('resync with no changes copies and removes nothing', async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.remove.length, 0);
  assert.equal(plan.unchanged, UNIQUE);
  const before = snapshot(ROMDIR);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const after = snapshot(ROMDIR);
  for (const f of Object.keys(before)) if (/\.gbc?$/.test(f)) assert.equal(after[f], before[f], `${f} not rewritten`);
});

test('library changes: remove one, add one, change one; only manifest files are removed', async () => {
  fs.rmSync(path.join(LIB, 'GB', 'Alleyway.gb'));
  writeFakeRom(path.join(LIB, 'GBC', 'Zebra Run.gbc'), 16384, 777);
  const kirby = path.join(LIB, 'GB', "Kirby's Dream Land.gb");
  writeFakeRom(kirby, 8192, 778);
  // Manifest entries that try to reach outside the ROM folder are ignored.
  const m = manifest();
  m.placed.push({ crc: '00000000', file: '../../../Saves/gbc/common/some.sav', size: 1 });
  m.placed.push({ crc: '00000000', file: 'some.sav', size: 1 });
  m.placed.push({ crc: '00000000', file: '.hidden.gb', size: 1 });
  fs.writeFileSync(path.join(ROMDIR, 'cover-picker.json'), JSON.stringify(m));

  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.manifest.ignored, 3);
  assert.deepEqual(plan.copy.map((c) => [c.file, c.reason]).sort(), [["Kirby's Dream Land.gb", 'changed'], ['Zebra Run.gbc', 'new']]);
  assert.deepEqual(plan.remove.map((r) => r.file), ['Alleyway.gb']);
  assert.equal(plan.unchanged, UNIQUE - 2);

  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.ok(!fs.existsSync(path.join(ROMDIR, 'Alleyway.gb')));
  assert.equal(fileCrc("Kirby's Dream Land.gb"), crc32(fs.readFileSync(kirby)));
  assert.ok(fs.existsSync(path.join(ROMDIR, 'Zebra Run.gbc')));
  const after = manifest();
  assert.equal(after.placed.length, UNIQUE);
  assert.ok(!after.placed.some((e: { file: string }) => e.file === 'Alleyway.gb' || e.file.includes('sav')));
  assertCardSafe();
});

test('not enough space: the plan says so and sync writes nothing', async () => {
  writeFakeRom(path.join(LIB, 'GB', 'Yoshi.gb'), 32768, 31337);
  const { plan } = await makePlan({ library: LIB, card: CARD, freeBytesOverride: 10_000 });
  assert.equal(plan.space.enough, false);
  const before = snapshot(CARD);
  await assert.rejects(runSync({ library: LIB, card: CARD, freeBytesOverride: 10_000 }), /Not enough space/);
  assert.deepEqual(snapshot(CARD), before);
  fs.rmSync(path.join(LIB, 'GB', 'Yoshi.gb'));
});

test('a stale plan is refused', async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  writeFakeRom(path.join(LIB, 'GB', 'Late Arrival.gb'), 4096, 5150);
  const before = snapshot(CARD);
  await assert.rejects(runSync({ library: LIB, card: CARD, signature: plan.signature }), /changed since this plan/);
  assert.deepEqual(snapshot(CARD), before);
  fs.rmSync(path.join(LIB, 'GB', 'Late Arrival.gb'));
});

test('a file the app did not place is never overwritten: the game gets another name', async () => {
  // Someone copies a different ROM onto the card under a name the library will want.
  writeFakeRom(path.join(ROMDIR, 'Quarth.gb'), 4096, 6001);
  writeFakeRom(path.join(LIB, 'GB', 'Quarth.gb'), 4096, 6002);
  const hand = fileCrc('Quarth.gb');
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.copy.map((c) => c.file), ['Quarth (GB).gb']);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal(fileCrc('Quarth.gb'), hand);
  assert.ok(!manifest().placed.some((e: { file: string }) => e.file === 'Quarth.gb'));
  fs.rmSync(path.join(LIB, 'GB', 'Quarth.gb'));
});

test('renaming a ROM in the library changes nothing on the card', async () => {
  fs.renameSync(path.join(LIB, 'GB', 'Tetris.gb'), path.join(LIB, 'GB', 'Tetris (World).gb'));
  fs.rmSync(path.join(LIB, 'GB', 'Tetris (copy).gb'));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  // Quarth (GB).gb left the library, so it is the only change.
  assert.deepEqual(plan.copy, []);
  assert.deepEqual(plan.remove.map((r) => r.file), ['Quarth (GB).gb']);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.ok(fs.existsSync(path.join(ROMDIR, 'Tetris.gb')));
  assertCardSafe();
});

test('with no library folder, the card is the library and sync copies nothing', async () => {
  const { plan } = await makePlan({ library: null, card: CARD });
  assert.equal(plan.source.kind, 'card');
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.remove.length, 0);
  assert.ok(plan.pack.count > 0);
});

test('when space is tight but removals free enough, sync removes first', async () => {
  fs.rmSync(path.join(LIB, 'GBC', 'Zebra Run.gbc'));
  writeFakeRom(path.join(LIB, 'GBC', 'Yak Attack.gbc'), 8192, 8080);
  const probe = await makePlan({ library: LIB, card: CARD });
  const free = probe.plan.space.neededBytes - 1;
  const { plan } = await makePlan({ library: LIB, card: CARD, freeBytesOverride: free });
  assert.equal(plan.space.removeFirst, true);
  assert.equal(plan.space.enough, true);
  const order: string[] = [];
  await runSync({ library: LIB, card: CARD, freeBytesOverride: free, signature: plan.signature }, (e) => {
    if (e.type === 'file' && (e.state === 'removed' || e.state === 'verified')) order.push(`${e.state}:${e.file}`);
  });
  assert.deepEqual(order, ['removed:Zebra Run.gbc', 'verified:Yak Attack.gbc']);
  assertCardSafe();
});
