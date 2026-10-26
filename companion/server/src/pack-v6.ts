/**
 * covers.bin format v6, for today's core: up to 31 games. The layout and every
 * byte rule follow tools/make_cover_pack.py, which is the reference.
 *
 *   entry 128 B: title char[40] | flags u8 | pad[3] | size u32 | path char[80] (cut to 79)
 *   blobs are packed back to back: stride 45568 B
 * The rest of the layout is in pack-common.ts.
 */
import {
  BLOB_BYTES,
  ENTRY_BYTES,
  ROM_PATH_MAX,
  asciiTitle,
  buildPackWith,
  fixed,
  gamePaths,
  makeWriter,
  packSize,
  type PackFormat,
  type PackGame,
} from './pack-common.js';

export const PACK_VERSION = 6;
export const MAX_GAMES = 31;

export const formatV6: PackFormat = {
  version: PACK_VERSION,
  maxGames: MAX_GAMES,
  stride: BLOB_BYTES,
  entry(g) {
    const p = gamePaths(g.platform, g.romFile);
    const e = Buffer.alloc(ENTRY_BYTES);
    fixed(asciiTitle(g.title), 40).copy(e, 0);
    e.writeUInt8(/\.gb$/i.test(g.romFile) ? 1 : 0, 40);
    e.writeUInt32LE(g.romSize >>> 0, 44);
    fixed(Buffer.from(p.rom, 'utf8').subarray(0, ROM_PATH_MAX), 80).copy(e, 48);
    return e;
  },
};

export function buildPack(games: PackGame[], logPlatform = 'gbc', onProgress?: (done: number) => void): Buffer {
  return buildPackWith(formatV6, games, { logPlatform, onProgress });
}

export function expectedPackSize(count: number): number {
  return packSize(formatV6, count);
}

export const packV6 = makeWriter(formatV6);
