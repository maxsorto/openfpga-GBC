/**
 * Sync: carry out a plan on the card.
 *
 *   1. Check the plan still matches and the card has room. Nothing is written before this.
 *   2. Copy ROMs: write beside the final name, fsync, read back, check the CRC, rename.
 *   3. Remove ROMs that left the library, only if the manifest says the app placed them
 *      and the file is still the ROM the app put there.
 *   4. Stream covers.bin (v6 or v7, by the core on the card) to a file beside it,
 *      check it, then rename it into place. Write the manifest. Read both back.
 *
 * Only .gb and .gbc files in Assets/gbc/common, covers.bin and cover-picker.json are
 * ever written or removed. Saves (.sav, .sus and everything under Saves) are never touched.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUPS_KEPT, BACKUP_DIR, COVERS_REL, PACK_PLATFORM } from './config.js';
import { packBlob } from './art.js';
import { cardRomDir } from './library.js';
import { isSafeRomFile, manifestPath, readManifest, serializeManifest, syncDir, writeManifest, type ManifestEntry } from './manifest.js';
import { PACK_HEAD_MAX, packWriter, readPackSummary, type StreamGame } from './pack.js';
import { makePlan, type PlanOptions, type SyncPlan } from './plan.js';
import { crc32, fileCrc, flushCrcCache, rememberCrc } from './roms.js';

export type SyncPhase = 'check' | 'copy' | 'remove' | 'pack' | 'write' | 'verify';

export type SyncEvent =
  | { type: 'phase'; phase: SyncPhase; message: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'file'; index: number; total: number; file: string; size: number; state: 'copying' | 'verified' | 'removed' | 'kept' | 'adopted'; bytesDone: number; bytesTotal: number }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  | { type: 'done'; target: string; bytes: number; count: number; copied: number; removed: number; unchanged: number; backup: string | null }
  | { type: 'error'; message: string };

export interface SyncJob {
  id: string;
  emitter: EventEmitter;
  events: SyncEvent[];
  status: 'running' | 'done' | 'error';
}

const jobs = new Map<string, SyncJob>();
let running: SyncJob | null = null;

export function getJob(id: string): SyncJob | undefined {
  return jobs.get(id);
}

export function coversPath(root: string): string {
  return path.join(path.resolve(root), COVERS_REL);
}

export interface SyncRequest extends PlanOptions {
  /** The plan the user confirmed. Sync stops if the fresh plan differs. */
  signature?: string;
}

/** Start a sync in the background. Progress comes as events. */
export function startSync(req: SyncRequest): SyncJob {
  if (running?.status === 'running') throw new Error('A sync is already running');
  const job: SyncJob = { id: Math.random().toString(36).slice(2, 10), emitter: new EventEmitter(), events: [], status: 'running' };
  jobs.set(job.id, job);
  running = job;
  const emit = (e: SyncEvent) => {
    job.events.push(e);
    job.emitter.emit('event', e);
  };
  void runSync(req, emit).then(
    () => {
      job.status = 'done';
    },
    (e: any) => {
      job.status = 'error';
      emit({ type: 'error', message: e?.message ?? String(e) });
    },
  );
  return job;
}

/** SHA-256 and size of a file, read 1 MB at a time. */
export function hashFile(file: string): { sha: string; bytes: number } {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  const fd = fs.openSync(file, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha: hash.digest('hex'), bytes };
}

function readHead(file: string, max: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** Copy the card's covers.bin to the Mac, keeping the last few. */
function backupCovers(target: string): string {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `covers-${stamp}.bin`);
  fs.copyFileSync(target, backup);
  const old = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^covers-.*\.bin$/.test(f))
    .sort();
  for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  return backup;
}

/** Copy one ROM to the card and prove it arrived intact. */
function copyRom(from: string, to: string, crc: string): void {
  const data = fs.readFileSync(from);
  if (crc32(data) !== crc) throw new Error(`${path.basename(from)} changed in the library since the plan. Plan again.`);
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.part`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      let off = 0;
      while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const back = fs.readFileSync(tmp);
    if (back.length !== data.length || crc32(back) !== crc) throw new Error(`Verify failed for ${path.basename(to)}: the copy on the card does not match`);
    fs.renameSync(tmp, to);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Run a sync and wait for it. Used by startSync and by the tests. */
export async function runSync(req: SyncRequest, emit: (e: SyncEvent) => void = () => {}): Promise<SyncPlan> {
  emit({ type: 'phase', phase: 'check', message: 'Checking the card and the library' });
  const { plan, packGames, manifestPlaced } = await makePlan(req);
  if (req.signature && req.signature !== plan.signature) {
    throw new Error('The library or the card changed since this plan was made. Close this and sync again to see the new plan.');
  }
  if (!plan.space.enough) {
    throw new Error(
      `Not enough space on the card. It needs ${plan.space.neededBytes.toLocaleString()} bytes free and has ${(plan.space.freeBytes ?? 0).toLocaleString()}. Nothing was written.`,
    );
  }
  if (plan.manifest.error) {
    throw new Error(`cover-picker.json on the card could not be read (${plan.manifest.error}). Nothing was written. Move it aside and sync again.`);
  }
  const card = plan.card;
  const romDir = cardRomDir(card);
  fs.mkdirSync(romDir, { recursive: true });

  // The manifest as it will be after this sync, kept up to date as files land.
  const placed = new Map<string, ManifestEntry>(manifestPlaced.map((e) => [e.file.toLowerCase(), { ...e }]));
  let sinceFlush = 0;
  const flush = (force = false) => {
    if (!force && sinceFlush < 20) return;
    writeManifest(card, { version: 1, placed: [...placed.values()] });
    sinceFlush = 0;
  };

  const doRemove = () => {
    if (!plan.remove.length) return;
    emit({ type: 'phase', phase: 'remove', message: `Removing ${plan.remove.length} ROMs that left the library` });
    plan.remove.forEach((r, i) => {
      const key = r.file.toLowerCase();
      const entry = placed.get(key);
      // Only files the manifest lists, with a plain ROM name, in the ROM folder.
      if (!entry || !isSafeRomFile(r.file)) return;
      const abs = path.join(romDir, r.file);
      if (path.dirname(abs) !== romDir) return;
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(abs);
      } catch {
        st = null;
      }
      if (st?.isFile()) {
        if (fileCrc(abs, st) === entry.crc) {
          fs.unlinkSync(abs);
          emit({ type: 'file', index: i + 1, total: plan.remove.length, file: r.file, size: r.size, state: 'removed', bytesDone: 0, bytesTotal: 0 });
        } else {
          emit({ type: 'log', level: 'warn', message: `${r.file} is no longer the ROM the app placed, so it was kept.` });
          emit({ type: 'file', index: i + 1, total: plan.remove.length, file: r.file, size: r.size, state: 'kept', bytesDone: 0, bytesTotal: 0 });
        }
      }
      placed.delete(key);
      sinceFlush++;
      flush();
    });
    syncDir(romDir);
  };

  // Drop manifest entries whose file is already gone.
  for (const [key, e] of placed) {
    if (!fs.existsSync(path.join(romDir, e.file)) && !plan.copy.some((c) => c.file.toLowerCase() === key)) placed.delete(key);
  }

  // Adopt ROMs you put on the card by hand that are library games: same CRC, name kept.
  if (plan.adopt.length) {
    plan.adopt.forEach((a, i) => {
      if (!isSafeRomFile(a.file)) throw new Error(`Refusing to adopt ${a.file}`);
      const abs = path.join(romDir, a.file);
      const st = fs.statSync(abs);
      if (fileCrc(abs, st) !== a.crc) throw new Error(`${a.file} on the card changed since the plan. Nothing else was written. Plan again.`);
      placed.set(a.file.toLowerCase(), { crc: a.crc, file: a.file, size: st.size });
      emit({ type: 'file', index: i + 1, total: plan.adopt.length, file: a.file, size: st.size, state: 'adopted', bytesDone: 0, bytesTotal: 0 });
    });
    flush(true);
    emit({ type: 'log', level: 'info', message: `Adopted ${plan.adopt.length} ROMs already on the card. They keep their names, so their saves still match.` });
  }

  if (plan.space.removeFirst) {
    emit({ type: 'log', level: 'info', message: 'Removing first to make room.' });
    doRemove();
  }

  if (plan.copy.length) {
    emit({ type: 'phase', phase: 'copy', message: `Copying ${plan.copy.length} ROMs` });
    const bytesTotal = plan.copyBytes;
    let bytesDone = 0;
    for (let i = 0; i < plan.copy.length; i++) {
      const c = plan.copy[i];
      if (!isSafeRomFile(c.file)) throw new Error(`Refusing to write ${c.file}`);
      const to = path.join(romDir, c.file);
      emit({ type: 'file', index: i + 1, total: plan.copy.length, file: c.file, size: c.size, state: 'copying', bytesDone, bytesTotal });
      if (c.reason === 'replace') {
        // You chose the library's copy over one you put there by hand. Keep the card's copy on the Mac first.
        const st = fs.statSync(to);
        if (fileCrc(to, st) !== c.replacesCrc) throw new Error(`${c.file} on the card changed since the plan. Plan again.`);
        const dir = path.join(BACKUP_DIR, 'replaced-roms');
        fs.mkdirSync(dir, { recursive: true });
        const keep = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')} ${c.file}`);
        fs.copyFileSync(to, keep);
        emit({ type: 'log', level: 'info', message: `Saved the card's copy of ${c.file} on this Mac: ${keep}` });
      }
      copyRom(c.from, to, c.crc);
      rememberCrc(to, c.crc);
      placed.set(c.file.toLowerCase(), { crc: c.crc, file: c.file, size: c.size });
      bytesDone += c.size;
      emit({ type: 'file', index: i + 1, total: plan.copy.length, file: c.file, size: c.size, state: 'verified', bytesDone, bytesTotal });
      emit({ type: 'progress', done: bytesDone, total: bytesTotal });
      sinceFlush++;
      flush();
      // Let the progress stream out between files.
      await new Promise((r) => setImmediate(r));
    }
    syncDir(romDir);
    flush(true);
  }

  if (!plan.space.removeFirst) doRemove();

  // The pack, streamed to a file beside covers.bin: one game's art in memory at a time.
  const writer = packWriter(plan.pack.version);
  const target = coversPath(card);
  let packBytes = 0;
  let packSha: string | null = null;
  let backup: string | null = null;
  if (packGames.length) {
    emit({ type: 'phase', phase: 'pack', message: `Building covers.bin (v${writer.version}, ${packGames.length} games)` });
    const tmp = path.join(path.dirname(target), '.covers.bin.part');
    try {
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(tmp, 'w');
      try {
        const games: StreamGame[] = packGames.map((g) => ({
          title: g.title,
          romFile: g.file,
          platform: g.platform,
          romSize: g.size,
          crc: g.crc,
          favorite: g.favorite,
          blob: async () => {
            try {
              return await packBlob(g.art, g.title);
            } catch (e: any) {
              emit({ type: 'log', level: 'warn', message: `${g.title}: art not available (${e?.message ?? e}). Using a title card.` });
              return packBlob(null, g.title);
            }
          },
        }));
        packBytes = await writer.write(
          games,
          (chunk) => {
            let off = 0;
            while (off < chunk.length) off += fs.writeSync(fd, chunk, off, chunk.length - off);
            hash.update(chunk);
          },
          { logPlatform: PACK_PLATFORM, onProgress: (n) => emit({ type: 'progress', done: n, total: packGames.length }) },
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      packSha = hash.digest('hex');
      if (packBytes !== writer.expectedSize(packGames.length)) throw new Error('Built file has the wrong size');
      // Check the new file before it replaces the old one.
      const back = hashFile(tmp);
      if (back.bytes !== packBytes || back.sha !== packSha) throw new Error('Verify failed: covers.bin did not write correctly. Try again, or use a card reader.');

      emit({ type: 'phase', phase: 'write', message: 'Writing covers.bin and the manifest' });
      if (fs.existsSync(target)) {
        if (hashFile(target).sha === packSha) emit({ type: 'log', level: 'info', message: 'covers.bin on the card was already up to date.' });
        backup = backupCovers(target);
        emit({ type: 'log', level: 'info', message: `Saved a copy of the old covers.bin on this Mac: ${backup}` });
      }
      fs.renameSync(tmp, target);
      syncDir(path.dirname(target));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } else {
    emit({ type: 'phase', phase: 'write', message: 'Writing the manifest' });
  }
  const manifest = { version: 1 as const, placed: [...placed.values()] };
  const manifestText = writeManifest(card, manifest);

  emit({ type: 'phase', phase: 'verify', message: 'Reading back to verify' });
  if (packSha) {
    const back = hashFile(target);
    if (back.bytes !== packBytes || back.sha !== packSha) throw new Error('Verify failed: covers.bin on the card does not match. Try again, or use a card reader.');
    const summary = readPackSummary(readHead(target, PACK_HEAD_MAX));
    if (!summary || summary.version !== writer.version || summary.count !== packGames.length) throw new Error('Verify failed: covers.bin header does not match.');
    emit({ type: 'log', level: 'info', message: `covers.bin verified: v${summary.version}, ${packBytes.toLocaleString()} bytes, ${summary.count} games.` });
  }
  const mBack = fs.readFileSync(manifestPath(card), 'utf8');
  if (mBack !== manifestText || serializeManifest(readManifest(card).manifest) !== manifestText) {
    throw new Error('Verify failed: cover-picker.json on the card does not match.');
  }
  for (const e of manifest.placed) {
    const st = fs.statSync(path.join(romDir, e.file));
    if (st.size !== e.size) throw new Error(`Verify failed: ${e.file} has the wrong size.`);
  }
  emit({ type: 'log', level: 'info', message: `Manifest verified: ${manifest.placed.length} ROMs placed by the app.` });
  flushCrcCache();

  emit({
    type: 'done',
    target,
    bytes: packBytes,
    count: packGames.length,
    copied: plan.copy.length,
    removed: plan.remove.length,
    unchanged: plan.unchanged,
    backup,
  });
  return plan;
}
