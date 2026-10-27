/**
 * Card I/O for sync. Everything here is async and works in chunks, so the app
 * keeps sending progress while a slow card writes, flushes and reads back.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config.js';

/**
 * Bytes per write before an fsync, and per read when checking. 2 MB gives an
 * update every 3 to 4 seconds on a 0.6 MB/s card. Tests make it smaller with
 * COMPANION_TEST_CHUNK_BYTES.
 */
export const CHUNK_BYTES = Number(process.env.COMPANION_TEST_CHUNK_BYTES ?? 0) || 2 * 1024 * 1024;

export type OnBytes = (done: number) => void;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write all of a buffer at the file handle's current position. */
export async function writeAll(fh: fsp.FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

/**
 * A file written in chunks: each CHUNK_BYTES is flushed to the card before
 * `onFlushed` reports it, so progress follows the card and not the Mac's cache.
 * `slowMs` adds a pause per flush (tests use it to act like a slow card).
 */
export class ChunkedWriter {
  private written = 0;
  private flushed = 0;
  private readonly hash = crypto.createHash('sha256');

  private constructor(
    private readonly fh: fsp.FileHandle,
    private readonly onFlushed: OnBytes,
    private readonly slowMs: number,
  ) {}

  static async open(file: string, onFlushed: OnBytes, slowMs = 0): Promise<ChunkedWriter> {
    return new ChunkedWriter(await fsp.open(file, 'w'), onFlushed, slowMs);
  }

  async write(chunk: Buffer): Promise<void> {
    await writeAll(this.fh, chunk);
    this.hash.update(chunk);
    this.written += chunk.length;
    if (this.written - this.flushed >= CHUNK_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    await this.fh.sync();
    if (this.slowMs) await sleep(this.slowMs);
    this.flushed = this.written;
    this.onFlushed(this.flushed);
  }

  /** Flush what is left, close, and return the size and SHA-256 of what was written. */
  async close(): Promise<{ bytes: number; sha: string }> {
    try {
      if (this.flushed !== this.written) await this.flush();
    } finally {
      await this.fh.close();
    }
    return { bytes: this.written, sha: this.hash.digest('hex') };
  }

  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }

  get bytesWritten(): number {
    return this.written;
  }
}

/** SHA-256 and size of a file, read in chunks, with progress. */
export async function hashFile(file: string, onBytes?: OnBytes, slowMs = 0): Promise<{ sha: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(CHUNK_BYTES);
  const fh = await fsp.open(file, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      bytes += bytesRead;
      if (slowMs) await sleep(slowMs);
      onBytes?.(bytes);
    }
  } finally {
    await fh.close();
  }
  return { sha: hash.digest('hex'), bytes };
}

/** Copy a file in chunks, with progress. Used to keep the old covers.bin on the Mac. */
export async function copyFileChunked(from: string, to: string, onBytes?: OnBytes): Promise<void> {
  const buf = Buffer.alloc(CHUNK_BYTES);
  const src = await fsp.open(from, 'r');
  try {
    const dst = await fsp.open(to, 'w');
    try {
      let done = 0;
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (bytesRead <= 0) break;
        await writeAll(dst, buf.subarray(0, bytesRead));
        done += bytesRead;
        onBytes?.(done);
      }
    } finally {
      await dst.close();
    }
  } finally {
    await src.close();
  }
}

/**
 * macOS keeps extended attributes of files on exFAT in a "._name" file next to
 * them. When the app renames or removes a file it made, that companion file
 * stays behind. Remove it, and only it: never any other "._" file.
 */
export function removeAppleDouble(file: string): void {
  const sidecar = path.join(path.dirname(file), `._${path.basename(file)}`);
  try {
    if (fs.lstatSync(sidecar).isFile()) fs.unlinkSync(sidecar);
  } catch {
    // none there
  }
}

/* ---------- What the app last wrote to each card ---------- */

const WRITTEN_FILE = path.join(CACHE_DIR, 'written-packs.json');

interface Written {
  bytes: number;
  mtimeMs: number;
  sha: string;
}

function loadWritten(): Record<string, Written> {
  try {
    return JSON.parse(fs.readFileSync(WRITTEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Remember the covers.bin the app just put on a card (size, date, hash). */
export function rememberWrittenPack(target: string, sha: string): void {
  try {
    const st = fs.statSync(target);
    const all = loadWritten();
    all[path.resolve(target)] = { bytes: st.size, mtimeMs: st.mtimeMs, sha };
    fs.mkdirSync(path.dirname(WRITTEN_FILE), { recursive: true });
    fs.writeFileSync(WRITTEN_FILE, JSON.stringify(all));
  } catch {
    // only saves time
  }
}

/**
 * True when the card's covers.bin is still the one the app wrote last time
 * (same size and date). Then there is no need to read it all back to keep a copy:
 * the app can build it again from the library.
 */
export function isOurPack(target: string): boolean {
  try {
    const st = fs.statSync(target);
    const w = loadWritten()[path.resolve(target)];
    return !!w && w.bytes === st.size && w.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Run `fn` on a file that is not the app's own (a save, favorites.cfg) and remove
 * the "._" sidecar macOS may make for it, unless that sidecar was already there.
 */
export async function withoutNewSidecar<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  const sidecar = path.join(path.dirname(file), `._${path.basename(file)}`);
  const had = fs.existsSync(sidecar);
  try {
    return await fn();
  } finally {
    if (!had) removeAppleDouble(file);
  }
}
