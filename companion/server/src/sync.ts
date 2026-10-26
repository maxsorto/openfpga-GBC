/**
 * Sync: carry out a plan on the card.
 *
 *   1. Check the plan still matches and the card has room. Nothing is written before this.
 *   2. Copy ROMs: write beside the final name, fsync, read back, check the CRC, rename.
 *   3. Remove ROMs that left the library, only if the manifest says the app placed them
 *      and the file is still the ROM the app put there.
 *   4. Build covers.bin and write it and the manifest, then read both back to verify.
 *
 * Only .gb and .gbc files in Assets/gbc/common, covers.bin and cover-picker.json are
 * ever written or removed. Saves (.sav, .sus and everything under Saves) are never touched.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, COVERS_REL, PACK_PLATFORM } from './config.js';
import { loadArt } from './art.js';
import { placeholderImage } from './image.js';
import { cardRomDir } from './library.js';
import { isSafeRomFile, manifestPath, readManifest, serializeManifest, syncDir, writeFileSynced, writeManifest, type ManifestEntry } from './manifest.js';
import { packWriter, readPackSummary, type PackGame } from './pack.js';
import { makePlan, type PlanOptions, type SyncPlan } from './plan.js';
import { crc32, fileCrc, flushCrcCache, rememberCrc } from './roms.js';

export type SyncPhase = 'check' | 'copy' | 'remove' | 'art' | 'pack' | 'write' | 'verify';

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

  // The pack.
  const writer = packWriter();
  emit({ type: 'phase', phase: 'art', message: `Preparing art for ${packGames.length} games` });
  const pack: PackGame[] = [];
  for (const g of packGames) {
    let art;
    try {
      art = await loadArt(g.art, g.title);
    } catch (e: any) {
      emit({ type: 'log', level: 'warn', message: `${g.title}: art not available (${e?.message ?? e}). Using a title card.` });
      art = await placeholderImage(g.title);
    }
    pack.push({ title: g.title, romFile: g.file, platform: g.platform, romSize: g.size, art, crc: g.crc, favorite: g.favorite });
    emit({ type: 'progress', done: pack.length, total: packGames.length * 2 });
  }

  const target = coversPath(card);
  let data: Buffer | null = null;
  let backup: string | null = null;
  if (pack.length) {
    emit({ type: 'phase', phase: 'pack', message: `Building covers.bin (v${writer.version})` });
    data = writer.build(pack, { logPlatform: PACK_PLATFORM, onProgress: (n) => emit({ type: 'progress', done: packGames.length + n, total: packGames.length * 2 }) });
    if (data.length !== writer.expectedSize(pack.length)) throw new Error('Built file has the wrong size');
  }

  emit({ type: 'phase', phase: 'write', message: 'Writing covers.bin and the manifest' });
  if (data) {
    if (fs.existsSync(target)) {
      const prev = fs.readFileSync(target);
      if (prev.equals(data)) emit({ type: 'log', level: 'info', message: 'covers.bin on the card was already up to date.' });
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = path.join(BACKUP_DIR, `covers-${stamp}.bin`);
      fs.writeFileSync(backup, prev);
      emit({ type: 'log', level: 'info', message: `Saved a copy of the old covers.bin on this Mac: ${backup}` });
    }
    writeFileSynced(target, data);
  }
  const manifest = { version: 1 as const, placed: [...placed.values()] };
  const manifestText = writeManifest(card, manifest);

  emit({ type: 'phase', phase: 'verify', message: 'Reading back to verify' });
  if (data) {
    const back = fs.readFileSync(target);
    if (!back.equals(data)) throw new Error('Verify failed: covers.bin on the card does not match. Try again, or use a card reader.');
    const summary = readPackSummary(back);
    emit({ type: 'log', level: 'info', message: `covers.bin verified: ${back.length.toLocaleString()} bytes, ${summary?.count ?? 0} games.` });
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
    bytes: data?.length ?? 0,
    count: pack.length,
    copied: plan.copy.length,
    removed: plan.remove.length,
    unchanged: plan.unchanged,
    backup,
  });
  return plan;
}
