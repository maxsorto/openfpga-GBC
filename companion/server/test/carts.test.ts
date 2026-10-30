/**
 * Carts the Pocket did not recognize: carts.cfg, identification, and the pack v7
 * pieces for them (CRT1, cartridge-only entries, the carts.cfg path, the default art).
 * The game lists are small fixtures written to the test cache; nothing is downloaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { writeFakeRom } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.out', 'carts');
fs.rmSync(OUT, { recursive: true, force: true });
const LIB = path.join(OUT, 'library');
const CARD = path.join(OUT, 'card');
const ROMDIR = path.join(CARD, 'Assets', 'gbc', 'common');
const SAVES = path.join(CARD, 'Saves', 'gbc', 'common');

process.env.COMPANION_DATA_DIR = path.join(OUT, 'data');
process.env.COMPANION_CACHE_DIR = path.join(OUT, 'cache');
process.env.COMPANION_OFFLINE = '1';

// Small No-Intro lists: one GBC game with a serial, others without.
const DAT_GBC = `clrmamepro (
	name "Nintendo - Game Boy Color"
)

game (
	name "Pokemon - Crystal Version (USA)"
	region "USA"
	serial "BYTE"
	rom ( name "Pokemon - Crystal Version (USA).gbc" size 2097152 crc EE6F5188 serial "BYTE" )
)

game (
	name "Pokemon - Crystal Version (Europe)"
	region "Europe"
	rom ( name "Pokemon - Crystal Version (Europe).gbc" size 2097152 crc 878B2AA7 )
)

game (
	name "Pokemon - Silver Version (USA, Europe)"
	region "USA"
	rom ( name "Pokemon - Silver Version (USA, Europe).gbc" size 2097152 crc 8AD48636 )
)

game (
	name "Pokemon - Gold Version (USA, Europe)"
	region "USA"
	rom ( name "Pokemon - Gold Version (USA, Europe).gbc" size 2097152 crc 6BDE3C3E )
)

game (
	name "Rugrats Movie, The (USA)"
	region "USA"
	rom ( name "Rugrats Movie, The (USA).gbc" size 1048576 crc 0F7C0EE2 )
)

game (
	name "Pokemon Pinball (USA)"
	region "USA"
	rom ( name "Pokemon Pinball (USA).gbc" size 1048576 crc 03CA3A39 )
)
`;
const DAT_GB = `clrmamepro (
	name "Nintendo - Game Boy"
)

game (
	name "Klax (USA)"
	region "USA"
	rom ( name "Klax (USA).gb" size 65536 crc 8DB0D6C5 )
)

game (
	name "Tetris (World) (Rev 1)"
	region "World"
	rom ( name "Tetris (World) (Rev 1).gb" size 32768 crc 46DF91AD )
)

game (
	name "Pokemon - Blue Version (USA, Europe)"
	region "USA"
	rom ( name "Pokemon - Blue Version (USA, Europe).gb" size 1048576 crc D6DA8A1A )
)
`;
fs.mkdirSync(path.join(OUT, 'cache', 'dats'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'cache', 'dats', 'Nintendo - Game Boy Color.dat'), DAT_GBC);
fs.writeFileSync(path.join(OUT, 'cache', 'dats', 'Nintendo - Game Boy.dat'), DAT_GB);
fs.mkdirSync(path.join(OUT, 'cache', 'thumbnail-lists'), { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'cache', 'thumbnail-lists', 'Nintendo_-_Game_Boy_Color.json'),
  JSON.stringify(['Pokemon - Crystal Version (USA)', 'Pokemon - Silver Version (USA, Europe)', 'Pokemon - Gold Version (USA, Europe)']),
);
fs.writeFileSync(path.join(OUT, 'cache', 'thumbnail-lists', 'Nintendo_-_Game_Boy.json'), JSON.stringify(['Klax (USA)', 'Tetris (World) (Rev 1)']));

const { ensureDirs } = await import('../src/config.js');
ensureDirs();
const carts = await import('../src/carts.js');
const { loadDats } = await import('../src/dat.js');
const { makePlan } = await import('../src/plan.js');
const { runSync } = await import('../src/sync.js');
const { readPackSummary, packWriter, defaultArtOffset, fingerprintTableOffset } = await import('../src/pack.js');
const { placeholderCart, encodeKeyed, CART_ACCENTS, hasCartArtFiles } = await import('../src/cartart.js');
const { accentOf } = await import('../src/accent.js');
const { crc32 } = await import('../src/roms.js');

/** A cart header, ROM bytes 0x134 to 0x14F. */
function header(title: string, opts: { code?: string; cgb?: number; hc?: number; gc?: number } = {}): Buffer {
  const h = Buffer.alloc(28);
  Buffer.from(title, 'latin1').copy(h, 0, 0, opts.code ? 11 : 15);
  if (opts.code) Buffer.from(opts.code, 'latin1').copy(h, 0x13f - 0x134);
  h[0x143 - 0x134] = opts.cgb ?? 0;
  h[0x14d - 0x134] = opts.hc ?? 0x5a;
  const gc = opts.gc ?? 0x1234;
  h[0x14e - 0x134] = gc >> 8;
  h[0x14f - 0x134] = gc & 0xff;
  return h;
}

const CRYSTAL = header('PM_CRYSTAL', { code: 'BYTE', cgb: 0xc0, hc: 0x41, gc: 0x8e3f });
const SILVER = header('POKEMON_SLV', { code: 'AAXE', cgb: 0x80, hc: 0x22, gc: 0x7e9d });
const KLAX = header('KLAX', { cgb: 0x00, hc: 0x10, gc: 0x0b2c });
const UNKNOWN = header('ZQXWV TEST', { cgb: 0x00, hc: 0x99, gc: 0x4444 });

test('carts.cfg: records, duplicates dropped, empty and broken files', () => {
  const f = carts.cartsCfgFile([CRYSTAL, KLAX, CRYSTAL, UNKNOWN, KLAX]);
  assert.equal(f.length, 4096);
  assert.equal(f.toString('latin1', 0, 4), 'CRL1');
  // Records start at 16, 32 bytes each: 28 header bytes then 4 zeros.
  assert.ok(f.subarray(16, 44).equals(CRYSTAL));
  assert.ok(f.subarray(44, 48).every((b) => b === 0));
  const p = carts.parseCartsCfg(f)!;
  assert.equal(p.n, 5);
  assert.deepEqual(p.records.map((r) => r.toString('hex')), [CRYSTAL, KLAX, UNKNOWN].map((r) => r.toString('hex')));
  assert.deepEqual(carts.parseCartsCfg(Buffer.alloc(4096)), { records: [], n: 0, misreads: 0 });
  assert.deepEqual(carts.parseCartsCfg(carts.emptyCartsCfg()), { records: [], n: 0, misreads: 0 });
  const bad = (fn: (b: Buffer) => void) => {
    const b = Buffer.from(f);
    fn(b);
    return carts.parseCartsCfg(b);
  };
  assert.equal(bad((b) => b.write('CRL2', 0)), null);
  assert.equal(bad((b) => b.writeUInt16LE(2, 4)), null);
  assert.equal(bad((b) => b.writeUInt16LE(128, 6)), null);
  const empty = carts.emptyCartsCfg();
  assert.equal(empty.readUInt16LE(4), 1);
  assert.equal(empty.readUInt16LE(6), 0);
  assert.ok(empty.subarray(8).every((b) => b === 0));
});

test('carts.cfg written the way the core writes it: the record first, then the header with n + 1', () => {
  // Stopped after the record but before the header: the record past n is not counted.
  const f = carts.cartsCfgFile([CRYSTAL]);
  KLAX.copy(f, 16 + 32);
  assert.deepEqual(carts.parseCartsCfg(f)!.records.map((r) => r.toString('hex')), [CRYSTAL.toString('hex')]);
  // A file the core just made (4096 zeros) with the first record written but no header yet:
  // not readable, so it is left alone (never emptied) until the core writes its header.
  const fresh = Buffer.alloc(4096);
  CRYSTAL.copy(fresh, 16);
  assert.equal(carts.parseCartsCfg(fresh), null);
  // Then the header: n = 1.
  fresh.write('CRL1', 0, 'latin1');
  fresh.writeUInt16LE(1, 4);
  fresh.writeUInt16LE(1, 6);
  assert.equal(carts.parseCartsCfg(fresh)!.records.length, 1);
});

// Two records from Max's card: a Super Mario Bros. Deluxe cart read through shorted D6 and
// D7 contacts (bit 7 copies bit 6 in every letter; the header checksum still comes out
// right), and a good The Rugrats Movie cart.
const MISREAD_SMBDX = Buffer.from('cdc1d2c9cf20c4c5ccd5d8c1c8d9c5c03031001b05020133022d3cca', 'hex');
const RUGRATS = Buffer.from('544845525547524154534d4f56494580373803190500013300 1a5d4f'.replace(/ /g, ''), 'hex');

test('misread carts: a title byte with bit 7 set is not a real cart', () => {
  assert.equal(MISREAD_SMBDX.length, 28);
  assert.equal(RUGRATS.length, 28);
  assert.equal(carts.isMisread(MISREAD_SMBDX), true);
  assert.equal(carts.isMisread(RUGRATS), false);
  assert.equal(carts.isMisread(CRYSTAL), false);
  // Only the title area (0x134 to 0x142) counts: 0x143 is 0x80 or 0xC0 on color carts.
  assert.equal(carts.decodeHeader(RUGRATS).cgb, 0x80);
  const p = carts.parseCartsCfg(carts.cartsCfgFile([MISREAD_SMBDX, RUGRATS, MISREAD_SMBDX]))!;
  assert.equal(p.n, 3);
  assert.equal(p.misreads, 1);
  assert.deepEqual(p.records.map((r) => r.toString('hex')), [RUGRATS.toString('hex')]);
});

test('header: title, game code, CGB flag, and the FPR2 record', () => {
  const c = carts.decodeHeader(CRYSTAL);
  assert.equal(c.title, 'PM_CRYSTAL');
  assert.equal(c.code, 'BYTE');
  assert.equal(c.cgb, 0xc0);
  // 0x14E, 0x14F, 0x14D, 0x143, then the CRC32 of 0x134..0x13E (here b"PM_CRYSTAL\0").
  assert.deepEqual([...c.fingerprint.subarray(0, 4)], [0x8e, 0x3f, 0x41, 0xc0]);
  assert.equal(c.fingerprint.readUInt32LE(4), zlib.crc32(Buffer.from('PM_CRYSTAL\0', 'latin1')));
  assert.equal(c.fingerprint.readUInt32LE(4), 0xfb07c0c0);
  const k = carts.decodeHeader(KLAX);
  assert.equal(k.title, 'KLAX');
  assert.equal(k.code, null);
  assert.equal(c.id, crc32(CRYSTAL));
});

test('identification: game code first, then the header title, filtered by platform', async () => {
  const dats = await loadDats();
  const id = (h: Buffer) => carts.identifyCart(carts.decodeHeader(h), dats);
  assert.deepEqual(id(CRYSTAL) && [id(CRYSTAL)!.status, id(CRYSTAL)!.name], ['exact', 'Pokemon - Crystal Version (USA)']);
  // Silver's code is not in the list, so its title is matched: "SLV" abbreviates "Silver".
  assert.deepEqual(id(SILVER) && [id(SILVER)!.status, id(SILVER)!.name], ['guessed', 'Pokemon - Silver Version (USA, Europe)']);
  assert.deepEqual(id(KLAX) && [id(KLAX)!.status, id(KLAX)!.name, id(KLAX)!.system], ['guessed', 'Klax (USA)', 'gb']);
  // "PM_CRYSTAL" with no game code still finds Crystal by title.
  const noCode = header('PM_CRYSTAL', { cgb: 0xc0 });
  assert.equal(id(noCode)!.name, 'Pokemon - Crystal Version (USA)');
  assert.equal(id(UNKNOWN), null);
  // A title with no spaces ("THERUGRATSMOVIE") still finds its game.
  assert.deepEqual(id(RUGRATS) && [id(RUGRATS)!.status, id(RUGRATS)!.name], ['guessed', 'Rugrats Movie, The (USA)']);
  // Its last 4 letters look like a game code, but the DAT has no such code: the full title is used.
  const r = carts.decodeHeader(RUGRATS);
  assert.equal(r.code, 'OVIE');
  assert.equal(carts.headerTitle(r, id(RUGRATS)), 'THERUGRATSMOVIE');
  assert.equal(carts.codeConfirmed(r, id(RUGRATS)), false);
  assert.equal(carts.headerTitle(carts.decodeHeader(CRYSTAL), id(CRYSTAL)), 'PM_CRYSTAL');
  // A cart for the original Game Boy never matches a Game Boy Color game.
  assert.equal(id(header('PM_CRYSTAL', { cgb: 0x00 })), null);
  assert.deepEqual(carts.cartSystems(0xc0), ['gbc']);
  assert.deepEqual(carts.cartSystems(0x80), ['gbc', 'gb']);
  assert.deepEqual(carts.cartSystems(0x00), ['gb']);
});

test('accent: weighted mean color, more saturated, full value; gray covers get the cool white', () => {
  const solid = (r: number, g: number, b: number) => ({ width: 4, height: 4, data: new Uint8Array(48).map((_, i) => [r, g, b][i % 3]) });
  assert.equal(accentOf(solid(200, 0, 0)), 0xf800);
  assert.equal(accentOf(solid(0, 0, 120)), 0x001f);
  // No color at all: the neutral #C8D4FF, made a little more saturated.
  const gray = accentOf(solid(128, 128, 128));
  assert.equal(gray, accentOf(solid(20, 20, 20)));
  // Python: colorsys on #C8D4FF with s * 1.3 and v = 1 gives (184, 199, 255), RGB565 0xBE3F.
  assert.equal(gray, 0xbe3f);
});

test('default cart art: alpha 0 is 0x0000, an opaque pixel is never 0x0000', () => {
  const img = placeholderCart('dual', 80);
  const enc = encodeKeyed(img);
  let transparent = 0;
  for (let i = 0; i < 80 * 80; i++) {
    const v = enc.readUInt16LE(i * 2);
    if (img.data[i * 4 + 3] === 0) {
      assert.equal(v, 0);
      transparent++;
    } else assert.notEqual(v, 0);
  }
  assert.ok(transparent > 0 && transparent < 80 * 80);
  // A black opaque pixel becomes 0x0001.
  const black = { size: 1, data: new Uint8Array([0, 0, 0, 255]) };
  assert.equal(encodeKeyed(black).readUInt16LE(0), 1);
});

// The card: a streaming core, three library games. One of them is the same game as a logged cart.
const BLUE = header('POKEMON BLUE', { cgb: 0x00, hc: 0xd3, gc: 0x9d0a });
for (const [name, seed] of [['Tetris.gb', 1], ['Zelda.gb', 2]] as const) writeFakeRom(path.join(LIB, name), 8192, seed);
{
  const rom = Buffer.alloc(32768, 7);
  BLUE.copy(rom, 0x134);
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(path.join(LIB, 'Pokemon - Blue Version.gb'), rom);
}
fs.mkdirSync(ROMDIR, { recursive: true });
fs.mkdirSync(SAVES, { recursive: true });
fs.mkdirSync(path.join(CARD, 'Cores', 'maxsorto.GBC'), { recursive: true });
fs.writeFileSync(path.join(CARD, 'Cores', 'maxsorto.GBC', 'core.json'), JSON.stringify({ core: { metadata: { version: '1.5.0-cover2' } } }));
const CFG = path.join(SAVES, 'carts.cfg');

test('sync: identified carts become cartridge-only entries after the list, then carts.cfg is emptied', async () => {
  fs.writeFileSync(CFG, carts.cartsCfgFile([CRYSTAL, KLAX, CRYSTAL, UNKNOWN, BLUE]));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.carts.cfg && [plan.carts.cfg.n, plan.carts.cfg.records, plan.carts.cfg.newCarts], [5, 4, 4]);
  assert.deepEqual(plan.carts.entries.map((e) => [e.title, e.status]), [['Pokemon - Crystal Version', 'exact'], ['Klax', 'guessed']]);
  assert.deepEqual(plan.carts.inLibrary.map((e) => [e.headerTitle, e.game]), [['POKEMON BLUE', 'Pokemon - Blue Version']]);
  assert.deepEqual(plan.carts.unidentified.map((e) => e.headerTitle), ['ZQXWV TEST']);
  assert.equal(plan.pack.listCount, 3);
  assert.equal(plan.pack.count, 5);

  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  // Saved in the app, all four (identified or not).
  const saved = carts.loadCarts();
  assert.deepEqual(saved.map((c) => c.title).sort(), ['KLAX', 'PM_CRYSTAL', 'POKEMON BLUE', 'ZQXWV TEST']);
  // carts.cfg is empty again.
  assert.ok(fs.readFileSync(CFG).equals(carts.emptyCartsCfg()));

  const buf = fs.readFileSync(path.join(ROMDIR, 'covers.bin'));
  const s = readPackSummary(buf)!;
  assert.equal(s.count, 5);
  assert.equal(buf.length, packWriter(7).expectedSize(5));
  // CRT1 at 96: default art offset, list count, flags (carts.cfg path present), accents, 0.
  assert.equal(buf.toString('ascii', 96, 100), 'CRT1');
  assert.deepEqual(s.carts, { artOffset: defaultArtOffset(5), listCount: 3, flags: 1, accents: [CART_ACCENTS.dmg, CART_ACCENTS.dual, CART_ACCENTS.cgb] });
  assert.equal(buf.readUInt16LE(114), 0);
  assert.equal(s.carts!.artOffset % 4096, 0);
  // The letter index covers only the browsable list.
  assert.ok(s.index!.starts.every((x) => x === 0xffff || x < 3));
  // Entries 3 and 4 are the carts: flags bit 2, the cart's id as the CRC, no path, no ROM size.
  assert.deepEqual(s.titles.slice(3), ['Pokemon - Crystal Version', 'Klax']);
  assert.deepEqual(s.flags.slice(0, 3).map((f) => f & 4), [0, 0, 0]);
  assert.deepEqual(s.flags.slice(3).map((f) => f & 4), [4, 4]);
  assert.equal(s.flags[4] & 1, 1, 'Klax is an original Game Boy cart');
  assert.deepEqual(s.crcs.slice(3), [carts.cartId(CRYSTAL), carts.cartId(KLAX)]);
  assert.deepEqual(s.roms.slice(3), ['', '']);
  for (const i of [3, 4]) assert.equal(buf.readUInt32LE(528 + i * 128 + 44), 0);
  // Every entry has an accent.
  assert.ok(s.accents.every((a) => a !== 0), `accents ${s.accents.map((a) => a.toString(16))}`);
  // Path structs: zeros for the carts; then the log, favorites.cfg and carts.cfg paths.
  const paths0 = 528 + 5 * (128 + 65536);
  const struct = (k: number) => buf.subarray(paths0 + k * 256, paths0 + (k + 1) * 256);
  for (let k = 9; k < 15; k++) assert.ok(struct(k).every((b) => b === 0), `path struct ${k}`);
  assert.equal(struct(15).toString('utf8').replace(/\0+$/, ''), '/Saves/gbc/common/picker.log');
  assert.equal(struct(16).toString('utf8').replace(/\0+$/, ''), '/Saves/gbc/common/favorites.cfg');
  assert.equal(struct(17).toString('utf8').replace(/\0+$/, ''), '/Saves/gbc/common/carts.cfg');
  // FPR2, shifted by the carts.cfg path; the carts' records come from their logged headers.
  assert.equal(s.fingerprints!.offset, paths0 + 18 * 256);
  assert.equal(s.fingerprints!.offset, fingerprintTableOffset(5));
  const rec = (i: number) => buf.subarray(s.fingerprints!.offset + i * 8, s.fingerprints!.offset + i * 8 + 8);
  assert.ok(rec(3).equals(carts.decodeHeader(CRYSTAL).fingerprint));
  assert.ok(rec(4).equals(carts.decodeHeader(KLAX).fingerprint));
  // The default art: 3 images at a 65536 stride, ending the file. The first is the DMG cart.
  const art0 = buf.subarray(s.carts!.artOffset, s.carts!.artOffset + 45568);
  if (!hasCartArtFiles()) assert.ok(art0.subarray(0, 128 * 128 * 2).equals(encodeKeyed(placeholderCart('dmg', 128))));
  assert.equal(art0.readUInt16LE(0), 0, 'the corner of the cart image is transparent');
  assert.equal(buf.length, s.carts!.artOffset + 3 * 65536);
});

test('next sync: carts saved in the app stay in the pack, and nothing is applied twice', async () => {
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.carts.cfg && [plan.carts.cfg.n, plan.carts.cfg.records], [0, 0]);
  assert.equal(plan.carts.entries.length, 2);
  const before = fs.statSync(CFG).mtimeMs;
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal(fs.statSync(CFG).mtimeMs, before, 'an empty carts.cfg is not rewritten');
  assert.equal(carts.loadCarts().length, 4);
});

test('forget a cart: it leaves the pack; it comes back if the Pocket logs it again', async () => {
  assert.equal(carts.forgetCart(carts.cartId(KLAX)), true);
  let { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.carts.entries.map((e) => e.title), ['Pokemon - Crystal Version']);
  fs.writeFileSync(CFG, carts.cartsCfgFile([KLAX]));
  ({ plan } = await makePlan({ library: LIB, card: CARD }));
  assert.deepEqual(plan.carts.entries.map((e) => e.title).sort(), ['Klax', 'Pokemon - Crystal Version']);
});

test('a cart logged before its ROM was added is skipped once the ROM is in the library', async () => {
  // A Tetris cart was logged; then its ROM (same title) shows up in the library.
  const tetrisCart = header('TETRIS', { cgb: 0x00, hc: 0x0a, gc: 0x16bf });
  fs.writeFileSync(CFG, carts.cartsCfgFile([tetrisCart]));
  let { plan } = await makePlan({ library: LIB, card: CARD });
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  // A different revision: same title, other checksums.
  const rom = Buffer.alloc(32768, 3);
  header('TETRIS', { cgb: 0x00, hc: 0x0b, gc: 0x1111 }).copy(rom, 0x134);
  fs.writeFileSync(path.join(LIB, 'Tetris DX.gb'), rom);
  ({ plan } = await makePlan({ library: LIB, card: CARD }));
  assert.ok(plan.carts.inLibrary.some((c) => c.headerTitle === 'TETRIS' && c.game === 'Tetris DX'));
  assert.ok(!plan.carts.entries.some((e) => e.title.startsWith('Tetris')));
});

test('sync skips misread carts: not saved, not counted, and carts.cfg is still emptied', async () => {
  const before = carts.loadCarts().length;
  fs.writeFileSync(CFG, carts.cartsCfgFile([MISREAD_SMBDX]));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.deepEqual(plan.carts.cfg && [plan.carts.cfg.n, plan.carts.cfg.records, plan.carts.cfg.newCarts, plan.carts.cfg.misreads], [1, 0, 0, 1]);
  assert.ok(!plan.carts.unidentified.some((c) => c.id === carts.cartId(MISREAD_SMBDX)));
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.equal(carts.loadCarts().length, before);
  assert.ok(!carts.loadCarts().some((c) => c.id === carts.cartId(MISREAD_SMBDX)));
  assert.ok(fs.readFileSync(CFG).equals(carts.emptyCartsCfg()));
});

test('a misread already saved in carts.json is dropped when it loads', () => {
  const file = path.join(OUT, 'data', 'carts.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = carts.decodeHeader(MISREAD_SMBDX);
  j.carts.push({ id: d.id, header: MISREAD_SMBDX.toString('hex'), title: d.title, code: d.code, cgb: d.cgb, firstSeen: 'x', lastSeen: 'x', timesSeen: 1, identified: null });
  fs.writeFileSync(file, JSON.stringify(j));
  assert.ok(!carts.loadCarts().some((c) => c.id === d.id));
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).carts.some((c: { id: string }) => c.id === d.id), 'and the file no longer has it');
});

test('a carts.cfg the core has not finished writing is left untouched by sync', async () => {
  const half = Buffer.alloc(4096);
  KLAX.copy(half, 16); // the record is there, the header is not yet
  fs.writeFileSync(CFG, half);
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.carts.cfg, null);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  assert.ok(fs.readFileSync(CFG).equals(half));
});

test('v6 cores get no cart entries and no CRT1', async () => {
  fs.writeFileSync(path.join(CARD, 'Cores', 'maxsorto.GBC', 'core.json'), JSON.stringify({ core: { metadata: { version: '1.4.0-cover1' } } }));
  const { plan } = await makePlan({ library: LIB, card: CARD });
  assert.equal(plan.pack.version, 6);
  assert.equal(plan.carts.entries.length, 0);
  await runSync({ library: LIB, card: CARD, signature: plan.signature });
  const buf = fs.readFileSync(path.join(ROMDIR, 'covers.bin'));
  assert.ok(buf.subarray(16, 528).every((b) => b === 0));
});
