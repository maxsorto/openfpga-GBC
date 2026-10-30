/**
 * covers.bin format v7, for the streaming core: up to 2047 games, every cover
 * at a fixed stride so the core can read any one by index. The reference is
 * tools/make_cover_pack.py --v7.
 *
 *   entry 128 B: title char[40] | flags u8 | pad u8 | accent u16 | size u32 | crc32 u32 | path char[76] (cut to 75)
 *                flags bit 0 = original Game Boy, bit 1 = favorite (on every entry of a favorite game),
 *                bit 2 = cartridge only (no ROM on the card: zero path structs, CRC is the cart's id)
 *                accent = RGB565 color of the cover for the core's glow (0 = none), see accent.ts
 *   blobs: the same 45568 B of art, padded with zeros to 65536 B each
 *
 * The 512 B reserved area starts with a letter index, so Up/Down on the Pocket
 * can jump between letters:
 *   16  "IDX1"   20  fav_count u16   22  played_count u16
 *   24  27 x u16 section starts: '#', then A to Z. Each is the menu index of the
 *       first game in the A to Z part (after played and favorites) whose title,
 *       as written in the entry, starts with that letter, ignoring case. 0xFFFF if none.
 *
 * The app lists favorites twice: once in the favorites section at the top, and again
 * under their letter in the A to Z list, which holds every game. Both entries are full
 * copies (title, flags, size, CRC, art, path structs).
 * After the picker.log path struct come two more: /Saves/<platform>/common/favorites.cfg,
 * then /Saves/<platform>/common/carts.cfg.
 *
 * Unrecognized cartridges, at file offset 96 (after FPR2): "CRT1" | u32 file offset of
 * the default cartridge art | u16 list_count | u16 flags | 3 x u16 accent of each default
 * art | u16 0. Entries 0 to list_count - 1 are the browsable menu (the letter index covers
 * only these); the rest are cartridge-only entries for carts seen on the Pocket. flags bit
 * 0: the carts.cfg path struct is there. The default art is 3 blobs (gray DMG, black dual,
 * clear GBC-only cart; 45568 B each at a 65536 stride) at a 4096 aligned offset after the
 * FPR2 table, and ends the file. In those three, RGB565 0x0000 is transparent. flags bit
 * 1: a fourth image follows at the same stride, the All games tile Favorites mode shows
 * after your favorites (opaque, see tile.ts). It is there whenever the pack has favorites.
 *
 * Cartridge fingerprints, for Play Cartridge: at file offset 80 (in the reserved area,
 * after the letter index) "FPR2" | u32 file offset of the table | u16 entry count | u16 0.
 * The table follows the last path struct (carts.cfg), on a 4 byte boundary, before the
 * default cartridge art: one 8 byte record per entry, in entry order, duplicates included: ROM bytes
 * 0x14E, 0x14F (global checksum), 0x14D (header checksum), 0x143 (CGB flag), then the
 * u32 LE CRC32 of the 11 byte title area 0x134 to 0x13E. The core matches the exact
 * revision on the first four bytes, then falls back to the title CRC.
 * The rest of the layout is in pack-common.ts.
 */
import {
  ENTRY_BYTES,
  RESERVED_BYTES,
  asciiTitle,
  fixed,
  gamePaths,
  letterGroup,
  makeWriter,
  tailStart,
  hasFavorites,
  type PackEntry,
  type PackFormat,
} from './pack-common.js';
import { CART_ACCENTS, CART_KINDS, defaultCartBlobs } from './cartart.js';

/** File offset of "CRT1" in the reserved area. */
export const CRT_OFFSET = 96;
/** CRT1 flags bit 0: the carts.cfg path struct follows the favorites.cfg one. */
export const CRT_HAS_CARTS_CFG = 1;
/** CRT1 flags bit 1: the default art block has a fourth image, the All games tile. */
export const CRT_HAS_ALL_GAMES_TILE = 2;
const align4096 = (n: number) => (n + 4095) & ~4095;

/** File offset of "FPR2" in the reserved area. */
export const FPR_OFFSET = 80;
export const FINGERPRINT_BYTES = 8;

const align4 = (n: number) => (n + 3) & ~3;

export const NO_SECTION = 0xffff;

/** How many entries lead the menu as played, then favorites; and where the cart-only entries start. */
function leadCounts(games: PackEntry[]): { played: number; fav: number; list: number } {
  let i = 0;
  while (i < games.length && games[i].section === 'played') i++;
  const played = i;
  while (i < games.length && games[i].section === 'favorite') i++;
  const fav = i - played;
  while (i < games.length && (games[i].section ?? 'az') === 'az') i++;
  const list = i;
  for (let j = i; j < games.length; j++) {
    if (games[j].section === 'cart') continue;
    if (games[j].section === 'played' || games[j].section === 'favorite') {
      throw new Error('Pack v7: the played and favorites sections must come before the A to Z list');
    }
    throw new Error('Pack v7: cartridge-only entries must come after the browsable list');
  }
  return { played, fav, list };
}

/** Entries that are the browsable menu, before the cartridge-only ones. */
export function listCount(games: PackEntry[]): number {
  return leadCounts(games).list;
}

/** The letter index for games in menu order. */
export function letterIndex(games: PackEntry[]): { favCount: number; playedCount: number; starts: number[] } {
  const { played, fav, list } = leadCounts(games);
  const starts = new Array<number>(27).fill(NO_SECTION);
  for (let i = played + fav; i < list; i++) {
    const g = letterGroup(games[i].title);
    if (starts[g] === NO_SECTION) starts[g] = i;
  }
  return { favCount: fav, playedCount: played, starts };
}

function ascending(starts: number[]): boolean {
  const present = starts.filter((s) => s !== NO_SECTION);
  return present.every((s, i) => i === 0 || s > present[i - 1]);
}

export const PACK_V7 = 7;
export const MAX_GAMES_V7 = 2047;
export const STRIDE_V7 = 65536;
/** v7 keeps 75 bytes of the ROM path in the entry, plus a NUL. */
const ROM_PATH_MAX_V7 = 75;

export const formatV7: PackFormat = {
  version: PACK_V7,
  maxGames: MAX_GAMES_V7,
  stride: STRIDE_V7,
  entry(g) {
    if (!g.crc || !/^[0-9A-Fa-f]{8}$/.test(g.crc)) throw new Error(`${g.romFile}: pack v7 needs the ROM's CRC32`);
    const e = Buffer.alloc(ENTRY_BYTES);
    fixed(asciiTitle(g.title), 40).copy(e, 0);
    e.writeUInt8((/\.gb$/i.test(g.romFile) ? 1 : 0) | (g.favorite ? 2 : 0) | (g.cartOnly ? 4 : 0), 40);
    e.writeUInt16LE((g.accent ?? 0) & 0xffff, 42);
    e.writeUInt32LE(g.romSize >>> 0, 44);
    e.writeUInt32LE(parseInt(g.crc, 16) >>> 0, 48);
    if (!g.cartOnly) fixed(Buffer.from(gamePaths(g.platform, g.romFile).rom, 'utf8').subarray(0, ROM_PATH_MAX_V7), 76).copy(e, 52);
    return e;
  },
  // The core opens favorites.cfg and carts.cfg through these path structs, right after the log one.
  trailer: (platform) => [`/Saves/${platform}/common/favorites.cfg`, `/Saves/${platform}/common/carts.cfg`],
  allGamesTile: true,
  tailBytes(count, tile) {
    return defaultArtOffset(count) + (CART_KINDS.length + (tile ? 1 : 0)) * STRIDE_V7 - tailStart(formatV7, count);
  },
  tail(games, start, tile) {
    const table = align4(start);
    const art = defaultArtOffset(games.length);
    const out = Buffer.alloc(art + (CART_KINDS.length + (tile ? 1 : 0)) * STRIDE_V7 - start);
    games.forEach((g, i) => {
      const f = g.fingerprint;
      if (f && f.length !== FINGERPRINT_BYTES) throw new Error(`${g.romFile}: a fingerprint is ${FINGERPRINT_BYTES} bytes`);
      f?.copy(out, table - start + i * FINGERPRINT_BYTES);
    });
    defaultCartBlobs().forEach((b, i) => b.copy(out, art - start + i * STRIDE_V7));
    // Favorites mode's closing cover, after the three cartridges.
    if (tile) {
      if (tile.length !== 45568) throw new Error('The All games tile is one art blob');
      tile.copy(out, art - start + CART_KINDS.length * STRIDE_V7);
    }
    return out;
  },
  arrange(games) {
    if (ascending(letterIndex(games).starts)) return games;
    // menuOrder() sorts by the same letter rule, so this does not happen. If it does,
    // keep each letter's games in their order but put the letters in order.
    const { played, fav, list } = leadCounts(games);
    const head = games.slice(0, played + fav);
    const rest = games
      .slice(played + fav, list)
      .map((g, i) => ({ g, i, k: letterGroup(g.title) }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.g);
    return [...head, ...rest, ...games.slice(list)];
  },
  reserved(games) {
    const idx = letterIndex(games);
    if (!ascending(idx.starts)) throw new Error('Pack v7: letter sections are out of order');
    const r = Buffer.alloc(RESERVED_BYTES);
    r.write('IDX1', 0, 'ascii');
    r.writeUInt16LE(idx.favCount, 4);
    r.writeUInt16LE(idx.playedCount, 6);
    idx.starts.forEach((s, i) => r.writeUInt16LE(s, 8 + i * 2));
    // Where Play Cartridge finds the fingerprint table.
    const at = FPR_OFFSET - 16;
    r.write('FPR2', at, 'ascii');
    r.writeUInt32LE(fingerprintTableOffset(games.length), at + 4);
    r.writeUInt16LE(games.length, at + 8);
    r.writeUInt16LE(0, at + 10);
    // Unrecognized carts: where the default art is, and where the browsable list ends.
    const c = CRT_OFFSET - 16;
    r.write('CRT1', c, 'ascii');
    r.writeUInt32LE(defaultArtOffset(games.length), c + 4);
    r.writeUInt16LE(listCount(games), c + 8);
    r.writeUInt16LE(CRT_HAS_CARTS_CFG | (hasFavorites(games) ? CRT_HAS_ALL_GAMES_TILE : 0), c + 10);
    CART_KINDS.forEach((k, i) => r.writeUInt16LE(CART_ACCENTS[k], c + 12 + i * 2));
    r.writeUInt16LE(0, c + 18);
    return r;
  },
};

/** File offset of the FPR2 table. */
export function fingerprintTableOffset(count: number): number {
  return align4(tailStart(formatV7, count));
}

/** File offset of the default cartridge art: after the FPR2 table, 4096 aligned. */
export function defaultArtOffset(count: number): number {
  return align4096(fingerprintTableOffset(count) + count * FINGERPRINT_BYTES);
}

export const packV7 = makeWriter(formatV7);
