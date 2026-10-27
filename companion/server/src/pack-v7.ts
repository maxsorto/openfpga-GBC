/**
 * covers.bin format v7, for the streaming core: up to 2047 games, every cover
 * at a fixed stride so the core can read any one by index. The reference is
 * tools/make_cover_pack.py --v7.
 *
 *   entry 128 B: title char[40] | flags u8 | pad[3] | size u32 | crc32 u32 | path char[76] (cut to 75)
 *   blobs: the same 45568 B of art, padded with zeros to 65536 B each
 *
 * The 512 B reserved area starts with a letter index, so Up/Down on the Pocket
 * can jump between letters:
 *   16  "IDX1"   20  fav_count u16   22  played_count u16
 *   24  27 x u16 section starts: '#', then A to Z. Each is the menu index of the
 *       first game in the A to Z part (after played and favorites) whose title,
 *       as written in the entry, starts with that letter, ignoring case. 0xFFFF if none.
 * The rest of the layout is in pack-common.ts.
 */
import { ENTRY_BYTES, RESERVED_BYTES, asciiTitle, fixed, gamePaths, letterGroup, makeWriter, type PackEntry, type PackFormat } from './pack-common.js';

export const NO_SECTION = 0xffff;

/** How many games lead the menu as played, then as favorites. They must come first, in that order. */
function leadCounts(games: PackEntry[]): { played: number; fav: number } {
  let i = 0;
  while (i < games.length && games[i].played) i++;
  const played = i;
  while (i < games.length && games[i].favorite && !games[i].played) i++;
  const fav = i - played;
  for (let j = i; j < games.length; j++) {
    if (games[j].played || games[j].favorite) throw new Error('Pack v7: played games and favorites must come before the A to Z part');
  }
  return { played, fav };
}

/** The letter index for games in menu order. */
export function letterIndex(games: PackEntry[]): { favCount: number; playedCount: number; starts: number[] } {
  const { played, fav } = leadCounts(games);
  const starts = new Array<number>(27).fill(NO_SECTION);
  for (let i = played + fav; i < games.length; i++) {
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
    const p = gamePaths(g.platform, g.romFile);
    const e = Buffer.alloc(ENTRY_BYTES);
    fixed(asciiTitle(g.title), 40).copy(e, 0);
    e.writeUInt8(/\.gb$/i.test(g.romFile) ? 1 : 0, 40);
    e.writeUInt32LE(g.romSize >>> 0, 44);
    e.writeUInt32LE(parseInt(g.crc, 16) >>> 0, 48);
    fixed(Buffer.from(p.rom, 'utf8').subarray(0, ROM_PATH_MAX_V7), 76).copy(e, 52);
    return e;
  },
  arrange(games) {
    if (ascending(letterIndex(games).starts)) return games;
    // menuOrder() sorts by the same letter rule, so this does not happen. If it does,
    // keep each letter's games in their order but put the letters in order.
    const { played, fav } = leadCounts(games);
    const head = games.slice(0, played + fav);
    const rest = games
      .slice(played + fav)
      .map((g, i) => ({ g, i, k: letterGroup(g.title) }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.g);
    return [...head, ...rest];
  },
  reserved(games) {
    const idx = letterIndex(games);
    if (!ascending(idx.starts)) throw new Error('Pack v7: letter sections are out of order');
    const r = Buffer.alloc(RESERVED_BYTES);
    r.write('IDX1', 0, 'ascii');
    r.writeUInt16LE(idx.favCount, 4);
    r.writeUInt16LE(idx.playedCount, 6);
    idx.starts.forEach((s, i) => r.writeUInt16LE(s, 8 + i * 2));
    return r;
  },
};

export const packV7 = makeWriter(formatV7);
