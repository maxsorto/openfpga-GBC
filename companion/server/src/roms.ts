import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CRC_CACHE_FILE, ROM_EXTENSIONS, ROM_FOLDERS } from './config.js';

export interface RomFile {
  /** Stable id: "<platform>/<file>". */
  id: string;
  file: string;
  platform: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  /** CRC32, 8 upper case hex digits. */
  crc: string;
}

/** One ROM file found in the Mac library folder. */
export interface LibraryFile {
  /** Path relative to the library folder, with "/" separators. */
  rel: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  crc: string;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function hex(n: number): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function crc32(buf: Uint8Array): string {
  // zlib.crc32 is native and much faster. It exists from Node 22.2.
  const native = (zlib as unknown as { crc32?: (b: Uint8Array) => number }).crc32;
  if (native) return hex(native(buf));
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return hex(c ^ 0xffffffff);
}

type CrcCache = Record<string, string>;

let cacheMemo: CrcCache | null = null;
let cacheDirty = false;

function crcCache(): CrcCache {
  if (cacheMemo) return cacheMemo;
  try {
    cacheMemo = JSON.parse(fs.readFileSync(CRC_CACHE_FILE, 'utf8')) as CrcCache;
  } catch {
    cacheMemo = {};
  }
  return cacheMemo;
}

/** Write the CRC cache if anything changed. */
export function flushCrcCache(): void {
  if (!cacheDirty || !cacheMemo) return;
  try {
    fs.mkdirSync(path.dirname(CRC_CACHE_FILE), { recursive: true });
    const tmp = `${CRC_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cacheMemo));
    fs.renameSync(tmp, CRC_CACHE_FILE);
    cacheDirty = false;
  } catch {
    // The cache only saves time; ignore write errors.
  }
}

function cacheKey(absPath: string, st: { size: number; mtimeMs: number }): string {
  return `${absPath}|${st.size}|${Math.round(st.mtimeMs)}`;
}

/** CRC32 of a file, from the cache when path, size and date are unchanged. */
export function fileCrc(absPath: string, st: { size: number; mtimeMs: number }): string {
  const cache = crcCache();
  const key = cacheKey(absPath, st);
  let crc = cache[key];
  if (!crc) {
    crc = crc32(fs.readFileSync(absPath));
    cache[key] = crc;
    cacheDirty = true;
  }
  return crc;
}

/** Remember a CRC we already know, for example right after copying a file. */
export function rememberCrc(absPath: string, crc: string): void {
  try {
    const st = fs.statSync(absPath);
    crcCache()[cacheKey(absPath, st)] = crc;
    cacheDirty = true;
  } catch {
    // not important
  }
}

/** Drop cache entries under a folder whose files no longer exist as they were. */
function pruneCrcCache(dir: string, seen: Set<string>): void {
  const cache = crcCache();
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(prefix) && !seen.has(key)) {
      delete cache[key];
      cacheDirty = true;
    }
  }
}

/** Same order as Python's sorted() on file names: by code point. */
export function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isRomName(file: string): boolean {
  return !file.startsWith('.') && ROM_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/**
 * List .gb and .gbc files in each ROM folder of a card. Hidden files are
 * skipped, including the "._" files macOS leaves on exFAT cards.
 */
export function scanRoms(root: string): RomFile[] {
  const out: RomFile[] = [];
  for (const folder of ROM_FOLDERS) {
    const dir = path.join(root, folder.rel);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of names.sort(codepointCompare)) {
      if (!isRomName(file)) continue;
      const absPath = path.join(dir, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const crc = fileCrc(absPath, st);
      out.push({ id: `${folder.platform}/${file}`, file, platform: folder.platform, absPath, size: st.size, mtimeMs: st.mtimeMs, crc });
    }
  }
  flushCrcCache();
  return out;
}

export interface LibraryScan {
  root: string;
  files: LibraryFile[];
  /** Files we could not read. */
  unreadable: string[];
}

/** Largest ROM we accept. The biggest Game Boy Color carts are 8 MB. */
const MAX_ROM_BYTES = 16 * 1024 * 1024;

/**
 * Walk a library folder for .gb and .gbc files. Hidden files and folders are
 * skipped, which covers AppleDouble "._" files, .Trash and the like.
 * Symbolic links are not followed.
 */
export function scanLibrary(rootIn: string): LibraryScan {
  const root = path.resolve(rootIn);
  const files: LibraryFile[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(relDir || '.');
      return;
    }
    entries.sort((a, b) => codepointCompare(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!e.isFile() || !isRomName(e.name)) continue;
      try {
        const st = fs.statSync(abs);
        if (st.size === 0 || st.size > MAX_ROM_BYTES) {
          unreadable.push(rel);
          continue;
        }
        const crc = fileCrc(abs, st);
        seen.add(cacheKey(abs, st));
        files.push({ rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, crc });
      } catch {
        unreadable.push(rel);
      }
    }
  };
  walk(root, '');
  pruneCrcCache(root, seen);
  flushCrcCache();
  return { root, files, unreadable };
}

/**
 * Cartridge fingerprint of a ROM file, as Play Cartridge reads it from a cart:
 * bytes 0x14E, 0x14F (global checksum), 0x14D (header checksum) and 0x143 (CGB
 * flag), then the u32 LE CRC32 of the title area 0x134 to 0x13E (11 bytes, raw).
 * The title CRC lets another revision of the same game still find its cover.
 * Eight zeros for a file shorter than 0x150 bytes or one that can not be read.
 */
export function romFingerprint(file: string): Buffer {
  const head = Buffer.alloc(0x150);
  let n = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      n = fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    n = 0;
  }
  if (n < 0x150) return Buffer.alloc(8);
  const out = Buffer.from([head[0x14e], head[0x14f], head[0x14d], head[0x143], 0, 0, 0, 0]);
  out.writeUInt32LE(parseInt(crc32(head.subarray(0x134, 0x13f)), 16) >>> 0, 4);
  return out;
}
