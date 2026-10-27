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

/** What a pack entry needs to know about a game. */
export interface PackEntry {
  /** Shown in the picker. Non ASCII characters become "?", cut to 39 bytes. */
  title: string;
  /** ROM file name inside /Assets/<platform>/common. */
  romFile: string;
  /** Folder platform, "gbc" today. */
  platform: string;
  romSize: number;
  /** CRC32 of the whole ROM file, 8 hex digits. v6 does not store it; v7 does. */
  crc?: string;
  /** Starred. v7 sets entry flags bit 1 on every entry of a favorite game. */
  favorite?: boolean;
  /**
   * Which part of the menu this entry is in: the played section and the favorites
   * section at the top, then the A to Z list. v7 counts the top sections in its
   * letter index. Left out, an entry is in the A to Z list.
   */
  section?: MenuSection;
}

export type MenuSection = 'played' | 'favorite' | 'az';

/** A game with its art decoded, for building a pack in memory (tests, small packs). */
export interface PackGame extends PackEntry {
  art: RGBImage;
}

/** A game whose 45568 byte art blob is made only when the writer reaches it. */
export interface StreamGame extends PackEntry {
  blob: () => Promise<Buffer>;
}

export interface GamePaths {
  rom: string;
  sav: string;
  sus: string;
}

/**
 * Letter group for the Up/Down index: 0 for '#' (anything but A to Z), 1 to 26 for
 * A to Z. It uses the first character of the title as the pack writes it (ASCII,
 * other characters become '?'), ignoring case, so it matches what the Pocket shows.
 */
export function letterGroup(title: string): number {
  const c = asciiTitle(title, 1)[0];
  if (c === undefined) return 0;
  const u = c >= 0x61 && c <= 0x7a ? c - 32 : c;
  return u >= 0x41 && u <= 0x5a ? u - 0x40 : 0;
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

export const HEADER_BYTES = 16;
export const RESERVED_BYTES = 512;
export const ENTRY_BYTES = 128;
/** One game's art: 128x128 then 80x80, RGB565. */
export const BLOB_BYTES = (CEN * CEN + TH * TH) * 2;

/**
 * One pack format. Every version shares the layout:
 *   header 16 B: "GBCV" | ver u16 | count u16 | 128 u16 | 80 u16 | 4 pad
 *   reserved 512 B
 *   entries, count x 128 B (layout per version)
 *   blobs, count x stride B (the art, then zeros up to the stride)
 *   path structs, count x 3 x 256 B: ROM, .sav, .sus
 *   one 256 B path struct: /Saves/<platform>/common/picker.log
 *   v7 only: one more, /Saves/<platform>/common/favorites.cfg (the core finds it at
 *   paths0 + (count * 3 + 1) * 256, so it must follow the log one)
 */
export interface PackFormat {
  version: number;
  maxGames: number;
  /** Bytes per art blob in the file. */
  stride: number;
  entry(g: PackEntry): Buffer;
  /** The 512 reserved bytes after the header. Zeros when not given. */
  reserved?(games: PackEntry[]): Buffer;
  /** Path structs after the picker.log one, for files the core opens by name. */
  trailer?(platform: string): string[];
  /** A last chance to fix the order, for formats that rely on it. Returns the games to write, in order. */
  arrange?<T extends PackEntry>(games: T[]): T[];
}

export interface PackBuildOptions {
  /** Platform folder for the picker.log path. */
  logPlatform?: string;
  onProgress?: (done: number) => void;
}

export function packSize(fmt: PackFormat, count: number): number {
  const trailer = fmt.trailer?.('gbc').length ?? 0;
  return HEADER_BYTES + RESERVED_BYTES + count * (ENTRY_BYTES + fmt.stride + 3 * PATH_STRUCT_BYTES) + (1 + trailer) * PATH_STRUCT_BYTES;
}

function checkGames(fmt: PackFormat, games: PackEntry[]): void {
  if (games.length === 0) throw new Error('No games to pack');
  if (games.length > fmt.maxGames) throw new Error(`Pack v${fmt.version} holds at most ${fmt.maxGames} games`);
  for (const g of games) {
    const problems = pathProblems(g.platform, g.romFile);
    if (problems.length) throw new Error(`${g.romFile}: ${problems.join(' ')}`);
  }
}

function header(fmt: PackFormat, games: PackEntry[]): Buffer {
  const h = Buffer.alloc(HEADER_BYTES + RESERVED_BYTES);
  h.write('GBCV', 0, 'ascii');
  h.writeUInt16LE(fmt.version, 4);
  h.writeUInt16LE(games.length, 6);
  h.writeUInt16LE(CEN, 8);
  h.writeUInt16LE(TH, 10);
  if (fmt.reserved) {
    const r = fmt.reserved(games);
    if (r.length !== RESERVED_BYTES) throw new Error('Reserved area must be 512 bytes');
    r.copy(h, HEADER_BYTES);
  }
  return h;
}

function pathStructs(fmt: PackFormat, games: PackEntry[], logPlatform: string): Buffer {
  const out: Buffer[] = [];
  for (const g of games) {
    const p = gamePaths(g.platform, g.romFile);
    for (const q of [p.rom, p.sav, p.sus]) out.push(fixed(Buffer.from(q, 'utf8'), PATH_STRUCT_BYTES));
  }
  out.push(fixed(Buffer.from(`/Saves/${logPlatform}/common/picker.log`, 'utf8'), PATH_STRUCT_BYTES));
  for (const q of fmt.trailer?.(logPlatform) ?? []) out.push(fixed(Buffer.from(q, 'utf8'), PATH_STRUCT_BYTES));
  return Buffer.concat(out);
}

function padBlob(fmt: PackFormat, blob: Buffer): Buffer {
  if (blob.length !== BLOB_BYTES) throw new Error(`Art blob is ${blob.length} bytes, expected ${BLOB_BYTES}`);
  if (fmt.stride === BLOB_BYTES) return blob;
  const out = Buffer.alloc(fmt.stride);
  blob.copy(out, 0);
  return out;
}

/** The whole pack in memory. Fine for 31 games and for tests. */
export function buildPackWith(fmt: PackFormat, gamesIn: PackGame[], opts: PackBuildOptions = {}): Buffer {
  checkGames(fmt, gamesIn);
  const games = fmt.arrange ? fmt.arrange(gamesIn) : gamesIn;
  const parts: Buffer[] = [header(fmt, games), ...games.map((g) => fmt.entry(g))];
  games.forEach((g, i) => {
    parts.push(padBlob(fmt, artBlob(g.art)));
    opts.onProgress?.(i + 1);
  });
  parts.push(pathStructs(fmt, games, opts.logPlatform ?? 'gbc'));
  return Buffer.concat(parts);
}

/**
 * Stream a pack to `sink`, one piece at a time. Only one game's art is in
 * memory at once, so a 2047 game v7 pack (130 MB) never sits in a buffer.
 */
export async function writePackWith(
  fmt: PackFormat,
  gamesIn: StreamGame[],
  sink: (chunk: Buffer) => void | Promise<void>,
  opts: PackBuildOptions = {},
): Promise<number> {
  checkGames(fmt, gamesIn);
  const games = fmt.arrange ? fmt.arrange(gamesIn) : gamesIn;
  let written = 0;
  const put = async (b: Buffer) => {
    await sink(b);
    written += b.length;
  };
  await put(header(fmt, games));
  await put(Buffer.concat(games.map((g) => fmt.entry(g))));
  for (let i = 0; i < games.length; i++) {
    await put(padBlob(fmt, await games[i].blob()));
    opts.onProgress?.(i + 1);
  }
  await put(pathStructs(fmt, games, opts.logPlatform ?? 'gbc'));
  if (written !== packSize(fmt, games.length)) throw new Error('Pack came out the wrong size');
  return written;
}

/** One pack format, ready to use: in memory or streamed. */
export interface PackWriter {
  version: number;
  /** Most games the format holds. */
  maxGames: number;
  build(games: PackGame[], opts?: PackBuildOptions): Buffer;
  write(games: StreamGame[], sink: (chunk: Buffer) => void | Promise<void>, opts?: PackBuildOptions): Promise<number>;
  expectedSize(count: number): number;
}

export function makeWriter(fmt: PackFormat): PackWriter {
  return {
    version: fmt.version,
    maxGames: fmt.maxGames,
    build: (games, opts) => buildPackWith(fmt, games, opts),
    write: (games, sink, opts) => writePackWith(fmt, games, sink, opts),
    expectedSize: (n) => packSize(fmt, n),
  };
}

export interface PackIndex {
  favCount: number;
  playedCount: number;
  /** 27 menu indexes: '#', then A to Z. 0xFFFF where no title starts with that letter. */
  starts: number[];
}

export interface PackSummary {
  version: number;
  count: number;
  titles: string[];
  roms: string[];
  /** v7 only. */
  crcs: string[];
  /** Entry flags: bit 0 original Game Boy, bit 1 favorite (v7). */
  flags: number[];
  /** v7 only, when the reserved area starts with "IDX1". */
  index: PackIndex | null;
}

/** Read the header and entries back from the start of a pack, for display and checks. */
export function readPackSummary(buf: Buffer): PackSummary | null {
  if (buf.length < HEADER_BYTES || buf.toString('ascii', 0, 4) !== 'GBCV') return null;
  const version = buf.readUInt16LE(4);
  const count = buf.readUInt16LE(6);
  const titles: string[] = [];
  const roms: string[] = [];
  const crcs: string[] = [];
  const flags: number[] = [];
  const pathAt = version >= 7 ? 52 : 48;
  for (let i = 0; i < count; i++) {
    const o = HEADER_BYTES + RESERVED_BYTES + i * ENTRY_BYTES;
    if (o + ENTRY_BYTES > buf.length) break;
    titles.push(buf.toString('latin1', o, o + 40).replace(/\0.*$/s, ''));
    flags.push(buf.readUInt8(o + 40));
    roms.push(buf.toString('utf8', o + pathAt, o + ENTRY_BYTES).replace(/\0.*$/s, ''));
    if (version >= 7) crcs.push(buf.readUInt32LE(o + 48).toString(16).toUpperCase().padStart(8, '0'));
  }
  let index: PackIndex | null = null;
  if (version >= 7 && buf.length >= 24 + 27 * 2 && buf.toString('ascii', 16, 20) === 'IDX1') {
    index = { favCount: buf.readUInt16LE(20), playedCount: buf.readUInt16LE(22), starts: Array.from({ length: 27 }, (_, i) => buf.readUInt16LE(24 + i * 2)) };
  }
  return { version, count, titles, roms, crcs, flags, index };
}

/** Bytes to read from the start of a pack to get every entry. */
export const PACK_HEAD_MAX = HEADER_BYTES + RESERVED_BYTES + 2047 * ENTRY_BYTES;
