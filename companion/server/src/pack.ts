/**
 * covers.bin writer, format v6. The layout and every byte rule here follow
 * tools/make_cover_pack.py, which is the reference.
 *
 *   0      header 16 B: "GBCV" | ver u16 = 6 | count u16 | 128 u16 | 80 u16 | 4 pad
 *   16     reserved 512 B
 *   528    entries, count x 128 B: title char[40] | flags u8 | pad[3] | size u32 | path char[80]
 *   then   blobs, count x 45568 B: 128x128 RGB565 | 80x80 RGB565, row-major, little-endian
 *   then   path structs, count x 3 x 256 B: ROM path, .sav path, .sus path, NUL padded
 *   then   one 256 B path struct: /Saves/<platform>/common/picker.log
 */
import { fit, toRgb565, type RGBImage } from './pillow.js';

export const PACK_VERSION = 6;
export const CEN = 128;
export const TH = 80;
export const MAX_GAMES = 31;
export const ENTRY_BYTES = 128;
export const BLOB_BYTES = (CEN * CEN + TH * TH) * 2;
export const PATH_STRUCT_BYTES = 256;
/** The entry's 80 byte path field is informational (the core opens ROMs through the 256 byte path structs), so it is cut to fit. */
export const ROM_PATH_MAX = 79;
/** Longest path the core can open: a 256 byte path struct with its NUL. */
export const PATH_MAX = PATH_STRUCT_BYTES - 1;
export const TITLE_MAX = 39;

export interface PackGame {
  /** Shown in the picker. Non ASCII characters become "?", cut to 39 bytes. */
  title: string;
  /** ROM file name inside /Assets/<platform>/common. */
  romFile: string;
  /** Folder platform, "gbc" today. */
  platform: string;
  romSize: number;
  art: RGBImage;
}

export interface GamePaths {
  rom: string;
  sav: string;
  sus: string;
}

function stemOf(file: string): string {
  const i = file.lastIndexOf('.');
  return i > 0 ? file.slice(0, i) : file;
}

export function gamePaths(platform: string, romFile: string): GamePaths {
  const base = `/Saves/${platform}/common/${stemOf(romFile)}`;
  return { rom: `/Assets/${platform}/common/${romFile}`, sav: `${base}.sav`, sus: `${base}.sus` };
}

/** Problems that stop a ROM from going into the pack, or [] when it is fine. */
export function pathProblems(platform: string, romFile: string): string[] {
  const p = gamePaths(platform, romFile);
  const out: string[] = [];
  const romBytes = Buffer.byteLength(p.rom);
  if (romBytes > PATH_MAX) out.push(`ROM path is ${romBytes} bytes; the core allows ${PATH_MAX}. Rename the file.`);
  for (const q of [p.sav, p.sus]) {
    if (Buffer.byteLength(q) > 255) out.push(`Save path is too long: ${q}`);
  }
  return out;
}

/** Python's str.encode("ascii", "replace"), then cut to `max` bytes. */
export function asciiTitle(title: string, max = TITLE_MAX): Buffer {
  const bytes: number[] = [];
  for (const ch of title) {
    const cp = ch.codePointAt(0)!;
    bytes.push(cp < 128 ? cp : 0x3f);
  }
  return Buffer.from(bytes.slice(0, max));
}

function fixed(buf: Buffer, len: number): Buffer {
  const out = Buffer.alloc(len);
  buf.copy(out, 0, 0, Math.min(len, buf.length));
  return out;
}

/** The two RGB565 images for one game. */
export function artBlob(art: RGBImage): Buffer {
  return Buffer.concat([toRgb565(fit(art, CEN)), toRgb565(fit(art, TH))]);
}

export function buildPack(games: PackGame[], logPlatform = 'gbc', onProgress?: (done: number) => void): Buffer {
  if (games.length === 0) throw new Error('No games to pack');
  if (games.length > MAX_GAMES) throw new Error(`The core holds at most ${MAX_GAMES} games`);

  const header = Buffer.alloc(16);
  header.write('GBCV', 0, 'ascii');
  header.writeUInt16LE(PACK_VERSION, 4);
  header.writeUInt16LE(games.length, 6);
  header.writeUInt16LE(CEN, 8);
  header.writeUInt16LE(TH, 10);

  const entries: Buffer[] = [];
  const blobs: Buffer[] = [];
  const paths: Buffer[] = [];
  games.forEach((g, i) => {
    const problems = pathProblems(g.platform, g.romFile);
    if (problems.length) throw new Error(`${g.romFile}: ${problems.join(' ')}`);
    const p = gamePaths(g.platform, g.romFile);
    const e = Buffer.alloc(ENTRY_BYTES);
    fixed(asciiTitle(g.title), 40).copy(e, 0);
    e.writeUInt8(/\.gb$/i.test(g.romFile) ? 1 : 0, 40);
    e.writeUInt32LE(g.romSize >>> 0, 44);
    fixed(Buffer.from(p.rom, 'utf8').subarray(0, ROM_PATH_MAX), 80).copy(e, 48);
    entries.push(e);
    for (const q of [p.rom, p.sav, p.sus]) paths.push(fixed(Buffer.from(q, 'utf8'), PATH_STRUCT_BYTES));
    blobs.push(artBlob(g.art));
    onProgress?.(i + 1);
  });
  const log = fixed(Buffer.from(`/Saves/${logPlatform}/common/picker.log`, 'utf8'), PATH_STRUCT_BYTES);
  return Buffer.concat([header, Buffer.alloc(512), ...entries, ...blobs, ...paths, log]);
}

export function expectedPackSize(count: number): number {
  return 16 + 512 + count * (ENTRY_BYTES + BLOB_BYTES + 3 * PATH_STRUCT_BYTES) + PATH_STRUCT_BYTES;
}

/** Read the header and titles back from a pack, for display and checks. */
export function readPackSummary(buf: Buffer): { version: number; count: number; titles: string[]; roms: string[] } | null {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'GBCV') return null;
  const version = buf.readUInt16LE(4);
  const count = buf.readUInt16LE(6);
  const titles: string[] = [];
  const roms: string[] = [];
  for (let i = 0; i < count; i++) {
    const o = 528 + i * ENTRY_BYTES;
    if (o + ENTRY_BYTES > buf.length) break;
    titles.push(buf.toString('latin1', o, o + 40).replace(/\0.*$/s, ''));
    roms.push(buf.toString('utf8', o + 48, o + 128).replace(/\0.*$/s, ''));
  }
  return { version, count, titles, roms };
}
