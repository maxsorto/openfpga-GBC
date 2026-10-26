/**
 * Pieces every pack version shares: paths the core opens, title bytes and the
 * art geometry. The version specific writers live in pack-v6.ts (and later
 * pack-v7.ts); pack.ts picks one.
 */
import { fit, toRgb565, type RGBImage } from './pillow.js';

export const CEN = 128;
export const TH = 80;
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
  /** CRC32 of the ROM. v6 does not store it; v7 will. */
  crc?: string;
  /** Starred. v6 does not store it; v7 will. */
  favorite?: boolean;
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

export function fixed(buf: Buffer, len: number): Buffer {
  const out = Buffer.alloc(len);
  buf.copy(out, 0, 0, Math.min(len, buf.length));
  return out;
}

/** The two RGB565 images for one game: 128x128 center, then 80x80 preview. */
export function artBlob(art: RGBImage): Buffer {
  return Buffer.concat([toRgb565(fit(art, CEN)), toRgb565(fit(art, TH))]);
}

export interface PackBuildOptions {
  /** Platform folder for the picker.log path. */
  logPlatform?: string;
  onProgress?: (done: number) => void;
}

/** One pack format. A v7 writer will implement the same shape. */
export interface PackWriter {
  version: number;
  /** Most games the format holds, or null for no limit. */
  maxGames: number | null;
  build(games: PackGame[], opts?: PackBuildOptions): Buffer;
  expectedSize(count: number): number;
}
