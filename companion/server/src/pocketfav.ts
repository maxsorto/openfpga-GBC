/**
 * Favorites set on the Pocket. The core records them in
 * /Saves/gbc/common/favorites.cfg, a 4096 byte file, little-endian:
 *
 *   0   "FAV1"
 *   4   u16 version = 1
 *   6   u16 n, records used
 *   8   n records of 8 bytes: u32 CRC32 of the ROM | u8 state (1 favorite, 0 not) | 3 pad
 *   the rest is zero
 *
 * Later records win for the same CRC. Sync applies them to the app's choices and
 * then writes the file back empty. A missing or malformed file is ignored, and an
 * all-zero file (the core makes one before its first write) means no changes.
 * The core finds the file through a path struct at the end of a v7 pack.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PACK_PLATFORM } from './config.js';

export const FAV_FILE_BYTES = 4096;
const HEAD = 8;
const RECORD = 8;
export const FAV_MAX_RECORDS = (FAV_FILE_BYTES - HEAD) / RECORD;

export interface PocketFavorites {
  /** Path relative to the card root. */
  file: string;
  /** Final state per CRC, in the order first seen. */
  changes: { crc: string; favorite: boolean }[];
  /** Records in the file, before later ones override earlier ones. */
  records: number;
  /** Hash of the file as read, so sync only empties it if it did not change since the plan. */
  sha: string;
}

export function favoritesPath(card: string): string {
  return path.join(path.resolve(card), 'Saves', PACK_PLATFORM, 'common', 'favorites.cfg');
}

export function parseFavorites(buf: Buffer): Omit<PocketFavorites, 'file' | 'sha'> | null {
  // The core creates the file as zeros before it first writes to it: no changes yet.
  if (buf.length > 0 && buf.every((b) => b === 0)) return { changes: [], records: 0 };
  if (buf.length < HEAD || buf.toString('latin1', 0, 4) !== 'FAV1') return null;
  if (buf.readUInt16LE(4) !== 1) return null;
  const n = buf.readUInt16LE(6);
  if (n > FAV_MAX_RECORDS || HEAD + n * RECORD > buf.length) return null;
  const state = new Map<string, boolean>();
  for (let i = 0; i < n; i++) {
    const o = HEAD + i * RECORD;
    const crc = buf.readUInt32LE(o).toString(16).toUpperCase().padStart(8, '0');
    const s = buf.readUInt8(o + 4);
    if (s > 1) return null;
    state.delete(crc); // keep the order of the last record
    state.set(crc, s === 1);
  }
  return { changes: [...state].map(([crc, favorite]) => ({ crc, favorite })), records: n };
}

export function readPocketFavorites(card: string): PocketFavorites | null {
  const file = favoritesPath(card);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length > 64 * 1024) return null;
  const parsed = parseFavorites(buf);
  if (!parsed) return null;
  return {
    ...parsed,
    file: path.relative(path.resolve(card), file).split(path.sep).join('/'),
    sha: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/** The file as the core expects it with nothing in it: magic, version 1, n = 0, zeros. */
export function emptyFavorites(): Buffer {
  const b = Buffer.alloc(FAV_FILE_BYTES);
  b.write('FAV1', 0, 'latin1');
  b.writeUInt16LE(1, 4);
  b.writeUInt16LE(0, 6);
  return b;
}

/** Build a file from records, for tests. */
export function favoritesFile(records: { crc: string; favorite: boolean }[]): Buffer {
  const b = emptyFavorites();
  b.writeUInt16LE(records.length, 6);
  records.forEach((r, i) => {
    b.writeUInt32LE(parseInt(r.crc, 16) >>> 0, HEAD + i * RECORD);
    b.writeUInt8(r.favorite ? 1 : 0, HEAD + i * RECORD + 4);
  });
  return b;
}
