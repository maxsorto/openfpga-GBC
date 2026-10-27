/**
 * cover-picker.json on the card: the ROMs this app placed there. Sync only ever
 * removes or replaces files listed here, so files you copied by hand are safe.
 *
 *   { "version": 1, "placed": [ { "crc": "1A2B3C4D", "file": "Tetris.gb", "size": 32768 } ] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_REL } from './config.js';
import { isRomName } from './roms.js';
import { removeAppleDouble } from './io.js';

export interface ManifestEntry {
  crc: string;
  /** File name inside Assets/gbc/common. Never a path. */
  file: string;
  size: number;
}

export interface Manifest {
  version: 1;
  placed: ManifestEntry[];
}

export interface ManifestRead {
  manifest: Manifest;
  exists: boolean;
  /** Set when the file is there but could not be read. Nothing in it is trusted then. */
  error?: string;
  /** Entries that were dropped because they did not look like a plain ROM file name. */
  ignored: number;
}

export function manifestPath(card: string): string {
  return path.join(path.resolve(card), MANIFEST_REL);
}

/** A plain .gb or .gbc file name: no folders, no "..", nothing hidden. */
export function isSafeRomFile(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    file.length <= 255 &&
    !/[/\\\0]/.test(file) &&
    file !== '.' &&
    file !== '..' &&
    isRomName(file)
  );
}

function validEntry(e: unknown): e is ManifestEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.crc === 'string' &&
    /^[0-9A-F]{8}$/.test(r.crc) &&
    isSafeRomFile(r.file) &&
    typeof r.size === 'number' &&
    Number.isInteger(r.size) &&
    r.size >= 0
  );
}

export function readManifest(card: string): ManifestRead {
  const file = manifestPath(card);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { manifest: { version: 1, placed: [] }, exists: false, ignored: 0 };
  }
  try {
    const j = JSON.parse(raw) as { version?: unknown; placed?: unknown };
    if (j?.version !== 1 || !Array.isArray(j.placed)) throw new Error('Unknown manifest format');
    const placed: ManifestEntry[] = [];
    const names = new Set<string>();
    let ignored = 0;
    for (const e of j.placed) {
      if (!validEntry(e) || names.has(e.file.toLowerCase())) {
        ignored++;
        continue;
      }
      names.add(e.file.toLowerCase());
      placed.push({ crc: e.crc, file: e.file, size: e.size });
    }
    return { manifest: { version: 1, placed }, exists: true, ignored };
  } catch (e) {
    return { manifest: { version: 1, placed: [] }, exists: true, ignored: 0, error: (e as Error).message };
  }
}

export function serializeManifest(m: Manifest): string {
  const placed = [...m.placed].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return `${JSON.stringify({ version: 1, placed }, null, 1)}\n`;
}

/** Write through a temporary file, flushed to the card, then renamed into place. */
export function writeManifest(card: string, m: Manifest): string {
  const file = manifestPath(card);
  const text = serializeManifest(m);
  writeFileSynced(file, Buffer.from(text, 'utf8'));
  return text;
}

/** Write a file next to its final name, fsync it, then rename it into place. */
export function writeFileSynced(file: string, data: Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.part`);
  const fd = fs.openSync(tmp, 'w');
  try {
    let off = 0;
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  removeAppleDouble(tmp);
  syncDir(path.dirname(file));
}

/** Flush a folder's entries (the rename). Not every file system allows it; that is fine. */
export function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // not supported here
  }
}
