/**
 * Sync: build covers.bin, write it to <root>/Assets/gbc/common/covers.bin, read
 * it back to verify. Nothing else on the card is created, changed or removed.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, COVERS_REL, PACK_PLATFORM } from './config.js';
import { loadArt } from './art.js';
import { placeholderImage } from './image.js';
import { buildLibrary } from './library.js';
import { buildPack, expectedPackSize, MAX_GAMES, readPackSummary, type PackGame } from './pack.js';

export type SyncEvent =
  | { type: 'phase'; phase: string; message: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  | { type: 'done'; target: string; bytes: number; count: number; backup: string | null }
  | { type: 'error'; message: string };

export interface SyncJob {
  id: string;
  emitter: EventEmitter;
  events: SyncEvent[];
  status: 'running' | 'done' | 'error';
}

const jobs = new Map<string, SyncJob>();

export function getJob(id: string): SyncJob | undefined {
  return jobs.get(id);
}

export function coversPath(root: string): string {
  return path.join(path.resolve(root), COVERS_REL);
}

function writeAndFlush(file: string, data: Buffer): void {
  const fd = fs.openSync(file, 'w');
  try {
    let off = 0;
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function startSync(root: string, ids: string[]): SyncJob {
  const job: SyncJob = { id: Math.random().toString(36).slice(2, 10), emitter: new EventEmitter(), events: [], status: 'running' };
  jobs.set(job.id, job);
  const emit = (e: SyncEvent) => {
    job.events.push(e);
    job.emitter.emit('event', e);
  };

  void (async () => {
    try {
      emit({ type: 'phase', phase: 'prepare', message: 'Reading the ROM folder' });
      const lib = await buildLibrary(root);
      const target = coversPath(lib.root);
      if (!fs.existsSync(path.dirname(target))) throw new Error(`Folder not found: ${path.dirname(target)}`);
      const wanted = new Set(ids);
      const games = lib.games.filter((g) => wanted.has(g.id));
      if (!games.length) throw new Error('No games selected');
      if (games.length > MAX_GAMES) throw new Error(`Select at most ${MAX_GAMES} games`);
      const bad = games.find((g) => g.problems.length);
      if (bad) throw new Error(`${bad.file}: ${bad.problems.join(' ')}`);

      emit({ type: 'phase', phase: 'art', message: `Preparing art for ${games.length} games` });
      const pack: PackGame[] = [];
      for (const g of games) {
        let art;
        try {
          art = await loadArt(g.art, g.title);
        } catch (e: any) {
          emit({ type: 'log', level: 'warn', message: `${g.title}: art not available (${e?.message ?? e}). Using a title card.` });
          art = await placeholderImage(g.title);
        }
        pack.push({ title: g.title, romFile: g.file, platform: g.platform, romSize: g.size, art });
        emit({ type: 'progress', done: pack.length, total: games.length * 2 });
      }

      emit({ type: 'phase', phase: 'build', message: 'Building covers.bin' });
      const data = buildPack(pack, PACK_PLATFORM, (n) => emit({ type: 'progress', done: games.length + n, total: games.length * 2 }));
      if (data.length !== expectedPackSize(games.length)) throw new Error('Built file has the wrong size');

      let backup: string | null = null;
      if (fs.existsSync(target)) {
        const prev = fs.readFileSync(target);
        if (prev.equals(data)) {
          emit({ type: 'log', level: 'info', message: 'covers.bin on the card is already up to date.' });
        }
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backup = path.join(BACKUP_DIR, `covers-${stamp}.bin`);
        fs.writeFileSync(backup, prev);
        emit({ type: 'log', level: 'info', message: `Saved a copy of the old covers.bin on this Mac: ${backup}` });
      }

      emit({ type: 'phase', phase: 'write', message: `Writing ${target}` });
      writeAndFlush(target, data);

      emit({ type: 'phase', phase: 'verify', message: 'Reading it back to verify' });
      const back = fs.readFileSync(target);
      if (!back.equals(data)) throw new Error('Verify failed: the file on the card does not match. Try again, or use a card reader.');
      const summary = readPackSummary(back);
      emit({ type: 'log', level: 'info', message: `Verified ${back.length.toLocaleString()} bytes, ${summary?.count ?? 0} games.` });

      job.status = 'done';
      emit({ type: 'done', target, bytes: back.length, count: games.length, backup });
    } catch (e: any) {
      job.status = 'error';
      emit({ type: 'error', message: e?.message ?? String(e) });
    }
  })();
  return job;
}
