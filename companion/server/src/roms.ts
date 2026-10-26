import fs from 'node:fs';
import path from 'node:path';
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

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): string {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

type CrcCache = Record<string, string>;

function loadCrcCache(): CrcCache {
  try {
    return JSON.parse(fs.readFileSync(CRC_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCrcCache(c: CrcCache): void {
  try {
    fs.mkdirSync(path.dirname(CRC_CACHE_FILE), { recursive: true });
    fs.writeFileSync(CRC_CACHE_FILE, JSON.stringify(c));
  } catch {
    // The cache only saves time; ignore write errors.
  }
}

/** Same order as Python's sorted() on file names: by code point. */
export function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * List .gb and .gbc files in each ROM folder. Hidden files are skipped,
 * including the "._" files macOS leaves on exFAT cards.
 */
export function scanRoms(root: string): RomFile[] {
  const cache = loadCrcCache();
  let dirty = false;
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
      if (file.startsWith('.')) continue;
      if (!ROM_EXTENSIONS.includes(path.extname(file).toLowerCase())) continue;
      const absPath = path.join(dir, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const key = `${absPath}|${st.size}|${Math.round(st.mtimeMs)}`;
      let crc = cache[key];
      if (!crc) {
        crc = crc32(fs.readFileSync(absPath));
        cache[key] = crc;
        dirty = true;
      }
      out.push({ id: `${folder.platform}/${file}`, file, platform: folder.platform, absPath, size: st.size, mtimeMs: st.mtimeMs, crc });
    }
  }
  if (dirty) saveCrcCache(cache);
  return out;
}
