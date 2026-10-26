/**
 * covers.bin format v7, for the streaming core: up to 2047 games, every cover
 * at a fixed stride so the core can read any one by index. The reference is
 * tools/make_cover_pack.py --v7.
 *
 *   entry 128 B: title char[40] | flags u8 | pad[3] | size u32 | crc32 u32 | path char[76] (cut to 75)
 *   blobs: the same 45568 B of art, padded with zeros to 65536 B each
 * The rest of the layout is in pack-common.ts.
 */
import { ENTRY_BYTES, asciiTitle, fixed, gamePaths, makeWriter, type PackFormat } from './pack-common.js';

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
};

export const packV7 = makeWriter(formatV7);
