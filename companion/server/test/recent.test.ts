/**
 * Build 26 of the core: Recent mode, the Settings stop and what goes with them.
 *   - the pack: CRT1 flags bit 4, REC1 at file offset 128, recent.cfg and settings.cfg after
 *     carts.cfg, the Settings tile at the end of the default art
 *   - recent.cfg (launches the Pocket noted) and the app's play history
 *   - settings.cfg (the Pocket's own settings), read only
 *   - a sync: launches saved, REC1 written, recent.cfg emptied, settings.cfg untouched
 * Fake ROMs and flat art; CRCs come from the bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'recent');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');
const SAVES = path.join(CARD, 'Saves', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';

const { ensureDirs, DATA_DIR } = await import('../src/config.js');
ensureDirs();
const { crc32 } = await import('../src/roms.js');
const { newImage } = await import('../src/pillow.js');
const { settingsTileBlob } = await import('../src/tile.js');
const { emptySlotBlob, overrideEmptySlotForTests } = await import('../src/cartart.js');
const { packWriter, readPackSummary, fingerprintTableOffset, defaultArtOffset, defaultImageCount, CRT_HAS_V26, REC_MAX, STRIDE_V7, BLOB_BYTES } = await import('../src/pack.js');
const { parseRecent, recentCfgFile, emptyRecentCfg, applyLaunches, loadHistory, historyWithCard, HISTORY_KEPT, RECENT_FILE_BYTES } = await import('../src/history.js');
const { parsePocketSettings, pocketSettingsFile, readPocketSettings, DEFAULT_POCKET_SETTINGS } = await import('../src/pocketsettings.js');
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { buildLibrary } = await import('../src/library.js');
const { updateChoices } = await import('../src/choices.js');

type Sec = 'favorite' | 'az' | 'cart';
const flat = (v: number) => {
  const im = newImage(24, 24);
  im.data.fill(v);
  return im;
};
const entry = (title: string, crc: string, section: Sec = 'az', o: { favorite?: boolean; cartOnly?: boolean } = {}) => ({
  title,
  romFile: `${title}.gb`,
  platform: 'gbc',
  romSize: 1024,
  crc,
  section,
  favorite: o.favorite,
  cartOnly: o.cartOnly,
  hasArt: true,
  fingerprint: Buffer.alloc(8),
  art: flat(40 + title.length * 9),
});
const hex = (i: number) => (0x10000000 + i).toString(16).toUpperCase();
const K = hex(1);
const A = hex(2);
const T = hex(3);
const Z = hex(4);
const C = hex(5);

/** Kirby is a favorite (entry 0 and again at 2), then A to Z, then one cart-only entry. */
const menu = (fav = true) => [
  ...(fav ? [entry('Kirby', K, 'favorite', { favorite: true })] : []),
  entry('Alleyway', A),
  entry('Kirby', K, 'az', { favorite: fav }),
  entry('Tetris', T),
  entry('Zelda', Z),
  entry('Pokemon', C, 'cart', { cartOnly: true }),
];

test('REC1: az index per recent game, newest first; unknown, cart-only and repeated games skipped', () => {
  // Newest first: Kirby (a favorite: its A to Z entry, not the copy at the top), a game not
  // in the pack, the cart-only entry, Tetris, Kirby again, Alleyway.
  const buf = packWriter(7).build(menu(), { recent: [K, 'DEADBEEF', C, T, K.toLowerCase(), A] });
  assert.equal(buf.toString('ascii', 128, 132), 'REC1');
  assert.equal(buf.readUInt16LE(132), 3);
  assert.equal(buf.readUInt16LE(134), 0);
  assert.deepEqual([0, 1, 2].map((i) => buf.readUInt16LE(136 + i * 2)), [2, 3, 1]);
  assert.ok(buf.subarray(142, 528).every((b) => b === 0), 'zeros after the list');
  const s = readPackSummary(buf)!;
  assert.deepEqual(s.recent, [2, 3, 1]);
  // The same value as each game's az_pos.
  assert.deepEqual(s.recent!.map((i) => s.azPos[i]), [2, 3, 1]);
  assert.equal(s.carts!.flags & CRT_HAS_V26, CRT_HAS_V26);
  assert.equal(s.index!.playedCount, 0);

  // Nothing played: REC1 with n = 0.
  const none = packWriter(7).build(menu());
  assert.equal(none.toString('ascii', 128, 132), 'REC1');
  assert.ok(none.subarray(132, 528).every((b) => b === 0));
  assert.deepEqual(readPackSummary(none)!.recent, []);
});

test('REC1 holds at most 32 games', () => {
  const games = Array.from({ length: 40 }, (_, i) => entry(`Game ${String(i).padStart(2, '0')}`, hex(100 + i)));
  const recent = games.map((g) => g.crc).reverse(); // newest first: Game 39, 38, ...
  const s = readPackSummary(packWriter(7).build(games, { recent }))!;
  assert.equal(s.recent!.length, REC_MAX);
  assert.deepEqual(s.recent, Array.from({ length: 32 }, (_, i) => 39 - i));
});

test('trailer: favorites.cfg, carts.cfg, recent.cfg, settings.cfg after the log; the table after them', () => {
  const buf = packWriter(7).build(menu());
  const n = 6;
  const paths0 = 528 + n * (128 + STRIDE_V7);
  const struct = (k: number) => buf.toString('utf8', paths0 + (n * 3 + k) * 256, paths0 + (n * 3 + k + 1) * 256).replace(/\0+$/, '');
  assert.deepEqual([0, 1, 2, 3, 4].map(struct), [
    '/Saves/gbc/common/picker.log',
    '/Saves/gbc/common/favorites.cfg',
    '/Saves/gbc/common/carts.cfg',
    '/Saves/gbc/common/recent.cfg',
    '/Saves/gbc/common/settings.cfg',
  ]);
  assert.equal(fingerprintTableOffset(n), paths0 + (n * 3 + 5) * 256);
  assert.equal(readPackSummary(buf)!.fingerprints!.offset, fingerprintTableOffset(n));
});

test('default art: the Settings tile comes last, after the empty slot and the All games tile when they are there', () => {
  const real = emptySlotBlob();
  assert.ok(real, 'the empty slot art ships with the app');
  try {
    for (const empty of [true, false]) {
      overrideEmptySlotForTests(empty ? undefined : null);
      for (const fav of [true, false]) {
        const games = menu(fav);
        const w = packWriter(7);
        const buf = w.build(games);
        const s = readPackSummary(buf)!;
        const images = 3 + (empty ? 1 : 0) + (fav ? 1 : 0) + 1;
        const label = `empty slot ${empty}, All games tile ${fav}`;
        assert.equal(defaultImageCount(fav), images, label);
        assert.equal(s.carts!.artOffset, defaultArtOffset(games.length), label);
        assert.equal(buf.length, s.carts!.artOffset + images * STRIDE_V7, label);
        assert.equal(buf.length, w.expectedSize(games.length, fav), label);
        assert.equal(s.carts!.flags, 1 | (fav ? 2 : 0) | (empty ? 4 : 0) | 8 | 16, label);
        const at = (i: number) => buf.subarray(s.carts!.artOffset + i * STRIDE_V7, s.carts!.artOffset + i * STRIDE_V7 + BLOB_BYTES);
        const settingsAt = 3 + (empty ? 1 : 0) + (fav ? 1 : 0);
        assert.ok(at(settingsAt).equals(settingsTileBlob()), label);
        if (empty) assert.ok(at(3).equals(real!), label);
        assert.ok(buf.subarray(s.carts!.artOffset + settingsAt * STRIDE_V7 + BLOB_BYTES).every((b) => b === 0), 'padded with zeros');
      }
    }
  } finally {
    overrideEmptySlotForTests(undefined);
  }
});

test('the Settings tile is opaque and the same every time', () => {
  const b = settingsTileBlob();
  assert.equal(b.length, BLOB_BYTES);
  for (let i = 0; i < b.length; i += 2) assert.notEqual(b.readUInt16LE(i), 0, `word ${i / 2}`);
  assert.ok(b.equals(settingsTileBlob()));
});

test('recent.cfg: records oldest first; n = 0, all zeros, truncated, bad magic and bad version', () => {
  const f = recentCfgFile([
    { crc: T, azPos: 3 },
    { crc: Z, azPos: 4 },
  ]);
  assert.equal(f.length, RECENT_FILE_BYTES);
  assert.deepEqual(parseRecent(f), { n: 2, launches: [{ crc: T, azPos: 3 }, { crc: Z, azPos: 4 }] });
  assert.deepEqual(parseRecent(emptyRecentCfg()), { n: 0, launches: [] });
  assert.deepEqual(parseRecent(Buffer.alloc(RECENT_FILE_BYTES)), { n: 0, launches: [] });
  // Bytes 0 to 15 of an empty file the way the core writes it.
  assert.deepEqual([...emptyRecentCfg().subarray(0, 16)], [0x52, 0x43, 0x4e, 0x31, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(parseRecent(f.subarray(0, 16 + 8)), null, 'n says 2, one record there');
  assert.equal(parseRecent(f.subarray(0, 10)), null);
  const magic = Buffer.from(f);
  magic.write('RCN2', 0, 'latin1');
  assert.equal(parseRecent(magic), null);
  const version = Buffer.from(f);
  version.writeUInt16LE(2, 4);
  assert.equal(parseRecent(version), null);
  const many = Buffer.from(f);
  many.writeUInt16LE(33, 6);
  assert.equal(parseRecent(many), null);
  // A record with CRC 0 is not a launch.
  const hole = recentCfgFile([{ crc: '00000000' }, { crc: A }]);
  assert.deepEqual(parseRecent(hole)!.launches.map((l) => l.crc), [A]);
});

test('play history: each launch moves its game to the front; applying twice changes nothing; capped', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const h1 = applyLaunches([], [{ crc: T, azPos: 0 }, { crc: Z, azPos: 0 }, { crc: T, azPos: 0 }, { crc: A, azPos: 0 }], t0);
  assert.deepEqual(h1.map((h) => h.crc), [A, T, Z]);
  const h2 = applyLaunches(h1, [{ crc: Z, azPos: 0 }], t0);
  assert.deepEqual(h2.map((h) => h.crc), [Z, A, T]);
  // A sync that saved the history but stopped before emptying recent.cfg reads it again: same order.
  const again = applyLaunches(h2, [{ crc: Z, azPos: 0 }], t0);
  assert.deepEqual(again.map((h) => h.crc), h2.map((h) => h.crc));
  const lots = applyLaunches([], Array.from({ length: HISTORY_KEPT + 50 }, (_, i) => ({ crc: hex(1000 + i), azPos: 0 })), t0);
  assert.equal(lots.length, HISTORY_KEPT);
  assert.ok(HISTORY_KEPT >= 100);
  assert.equal(lots[0].crc, hex(1000 + HISTORY_KEPT + 49), 'newest first');
});

test('settings.cfg: values, defaults when missing or all zero, unknown values unreadable', () => {
  const s = { startIn: 'last', opensOn: 'recent', legend: false, sounds: true, lastView: 'grid' } as const;
  const f = pocketSettingsFile(s);
  assert.equal(f.length, 16);
  assert.deepEqual([...f], [0x53, 0x45, 0x54, 0x31, 1, 0, 0, 0, 2, 1, 0, 1, 1, 0, 0, 0]);
  assert.deepEqual(parsePocketSettings(f), s);
  assert.equal(parsePocketSettings(f.subarray(0, 12)), null);
  const bad = Buffer.from(f);
  bad[9] = 3;
  assert.equal(parsePocketSettings(bad), null);
  const magic = Buffer.from(f);
  magic.write('SET2', 0, 'latin1');
  assert.equal(parsePocketSettings(magic), null);

  const card = path.join(OUT, 'settings-card');
  const dir = path.join(card, 'Saves', 'gbc', 'common');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(readPocketSettings(card), { file: 'Saves/gbc/common/settings.cfg', state: 'defaults', settings: DEFAULT_POCKET_SETTINGS });
  assert.deepEqual(DEFAULT_POCKET_SETTINGS, { startIn: 'flow', opensOn: 'favorites', legend: true, sounds: true, lastView: 'flow' });
  fs.writeFileSync(path.join(dir, 'settings.cfg'), Buffer.alloc(16));
  assert.equal(readPocketSettings(card).state, 'defaults');
  fs.writeFileSync(path.join(dir, 'settings.cfg'), f);
  assert.deepEqual(readPocketSettings(card), { file: 'Saves/gbc/common/settings.cfg', state: 'file', settings: s });
  fs.writeFileSync(path.join(dir, 'settings.cfg'), 'junk');
  assert.deepEqual(readPocketSettings(card).state, 'unreadable');
});

/* ---------- A sync ---------- */

function setCore(card: string, version: string): void {
  const dir = path.join(card, 'Cores', 'maxsorto.GBC');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'core.json'), JSON.stringify({ core: { magic: 'APF_VER_1', metadata: { shortname: 'GBC', version } } }));
}

const crcOf = (p: string) => crc32(fs.readFileSync(p));
const RECENT = path.join(SAVES, 'recent.cfg');
const SETTINGS = path.join(SAVES, 'settings.cfg');
const COVERS = path.join(ROMDIR, 'covers.bin');

writeFakeRom(path.join(LIB, 'Alleyway.gb'), 8192, 11);
writeFakeRom(path.join(LIB, 'Tetris.gb'), 8192, 12);
writeFakeRom(path.join(LIB, 'Wario Land.gb'), 8192, 13);
writeFakeRom(path.join(LIB, 'Zelda.gbc'), 8192, 14);
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(SAVES, { recursive: true });
setCore(CARD, '1.4.0-cover2');
const G = {
  alleyway: crcOf(path.join(LIB, 'Alleyway.gb')),
  tetris: crcOf(path.join(LIB, 'Tetris.gb')),
  wario: crcOf(path.join(LIB, 'Wario Land.gb')),
  zelda: crcOf(path.join(LIB, 'Zelda.gbc')),
};
const NOT_HERE = 'C0FFEE00';
const sync = async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  return plan;
};

test('sync: the Pocket\'s launches go in the history and in REC1, then recent.cfg is emptied; settings.cfg is only read', async () => {
  updateChoices({ [G.zelda]: { favorite: true } });
  let plan = await sync();
  assert.equal(plan.recent.cfg, null, 'no recent.cfg yet');
  assert.deepEqual(plan.recent.games, []);
  assert.equal(plan.pocketSettings.state, 'defaults');
  assert.ok(!fs.existsSync(RECENT), 'sync never makes recent.cfg');
  assert.ok(!fs.existsSync(SETTINGS), 'sync never makes settings.cfg');

  // On the Pocket: Tetris, then Zelda, then Tetris again, then a game the library does not have.
  fs.writeFileSync(RECENT, recentCfgFile([{ crc: G.tetris, azPos: 3 }, { crc: G.zelda, azPos: 5 }, { crc: G.tetris, azPos: 3 }, { crc: NOT_HERE, azPos: 9 }]));
  const settings = pocketSettingsFile({ startIn: 'grid', opensOn: 'recent', legend: false, sounds: false, lastView: 'grid' });
  fs.writeFileSync(SETTINGS, settings);

  const lib = await buildLibrary({ library: LIB, card: CARD });
  assert.deepEqual(lib.recent, [G.tetris, G.zelda], 'newest first, only games in the menu');
  assert.equal(lib.recentPending, 4);
  assert.deepEqual(lib.card!.pocketSettings.settings, { startIn: 'grid', opensOn: 'recent', legend: false, sounds: false, lastView: 'grid' });

  ({ plan } = await makePlan({ library: LIB, card: CARD }));
  assert.deepEqual(plan.recent.cfg && [plan.recent.cfg.n, plan.recent.cfg.launches], [4, 4]);
  assert.deepEqual(plan.recent.games.map((g) => g.title), ['Tetris', 'Zelda']);
  assert.equal(plan.pocketSettings.state, 'file');
  assert.deepEqual(loadHistory(), [], 'planning saves nothing');
  await runSync({ library: LIB, card: CARD, signature: plan.signature });

  assert.deepEqual(loadHistory().map((h) => h.crc), [NOT_HERE, G.tetris, G.zelda]);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'history.json')));
  assert.ok(fs.readFileSync(RECENT).equals(emptyRecentCfg()), 'recent.cfg is empty again');
  assert.ok(fs.readFileSync(SETTINGS).equals(settings), 'settings.cfg is untouched');
  // REC1: Tetris and Zelda by their A to Z entries (Zelda is a favorite: not its copy at the top).
  const s = readPackSummary(fs.readFileSync(COVERS))!;
  assert.deepEqual(s.recent!.map((i) => s.titles[i]), ['Tetris', 'Zelda']);
  assert.equal(s.titles[0], 'Zelda');
  assert.deepEqual(s.recent!.map((i) => s.azPos[i]), s.recent);
  assert.ok(!s.recent!.includes(0));

  // Next time there is nothing new: recent.cfg is not rewritten, and REC1 stays.
  const mtime = fs.statSync(RECENT).mtimeMs;
  plan = await sync();
  assert.deepEqual(plan.recent.cfg && [plan.recent.cfg.n, plan.recent.cfg.launches], [0, 0]);
  assert.equal(fs.statSync(RECENT).mtimeMs, mtime);
  assert.deepEqual(readPackSummary(fs.readFileSync(COVERS))!.recent!.map((i) => s.titles[i]), ['Tetris', 'Zelda']);
  assert.ok(fs.readFileSync(SETTINGS).equals(settings));
});

test('recent.cfg changed after the plan: refused; unreadable or all-zero files are left alone', async () => {
  fs.writeFileSync(RECENT, recentCfgFile([{ crc: G.wario }]));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.recent.games.map((g) => g.title), ['Wario Land', 'Tetris', 'Zelda']);
  fs.writeFileSync(RECENT, recentCfgFile([{ crc: G.wario }, { crc: G.alleyway }]));
  await assert.rejects(runSync({ library: LIB, card: CARD, signature: plan.signature }), /changed since this plan/);
  assert.deepEqual(loadHistory().map((h) => h.crc), [NOT_HERE, G.tetris, G.zelda], 'nothing saved');

  // Now it goes through: Alleyway newest.
  await sync();
  assert.deepEqual(loadHistory().map((h) => h.crc).slice(0, 3), [G.alleyway, G.wario, NOT_HERE]);
  assert.deepEqual(historyWithCard(null).slice(0, 2), [G.alleyway, G.wario]);

  const junk = Buffer.from('not a recent file');
  fs.writeFileSync(RECENT, junk);
  const p1 = await sync();
  assert.equal(p1.recent.cfg, null);
  assert.ok(fs.readFileSync(RECENT).equals(junk), 'an unreadable file is never written');

  fs.writeFileSync(RECENT, Buffer.alloc(RECENT_FILE_BYTES));
  const p2 = await sync();
  assert.deepEqual(p2.recent.cfg && p2.recent.cfg.n, 0);
  assert.ok(fs.readFileSync(RECENT).equals(Buffer.alloc(RECENT_FILE_BYTES)), 'an all-zero file is left as it is');
  const s = readPackSummary(fs.readFileSync(COVERS))!;
  assert.deepEqual(s.recent!.map((i) => s.titles[i]), ['Alleyway', 'Wario Land', 'Tetris', 'Zelda']);
});

test('v6 cores get no REC1, and the history waits for the streaming core', async () => {
  setCore(CARD, '1.4.0-cover1');
  fs.writeFileSync(RECENT, recentCfgFile([{ crc: G.zelda }]));
  const plan = await sync();
  assert.equal(plan.pack.version, 6);
  assert.deepEqual(plan.recent.games, []);
  const buf = fs.readFileSync(COVERS);
  assert.ok(buf.subarray(16, 528).every((b) => b === 0));
  // The launches are still saved, and the file emptied.
  assert.equal(loadHistory()[0].crc, G.zelda);
  assert.ok(fs.readFileSync(RECENT).equals(emptyRecentCfg()));
  setCore(CARD, '1.4.0-cover2');
});
