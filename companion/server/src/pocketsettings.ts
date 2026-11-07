/**
 * The Pocket's own settings, from its Settings stop (build 26 and later). The core keeps
 * them in /Saves/gbc/common/settings.cfg, 16 bytes:
 *
 *   0   "SET1"
 *   4   u16 version = 1
 *   6   2 zero bytes
 *   8   start_in   0 cover flow, 1 grid, 2 last used
 *   9   opens_on   0 favorites, 1 recent, 2 all games
 *   10  legend     0 off, 1 on
 *   11  sounds     0 off, 1 on
 *   12  last_view  0 flow, 1 grid
 *   13  3 zero bytes
 *
 * A missing file means the defaults: cover flow, favorites, legend on, sounds on. So does
 * an all-zero one, in case the core makes the file before it first writes to it.
 * The app only reads it, to show it. It never writes or removes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACK_PLATFORM } from './config.js';

export const SETTINGS_FILE_BYTES = 16;

export type StartIn = 'flow' | 'grid' | 'last';
export type OpensOn = 'favorites' | 'recent' | 'all';
export type View = 'flow' | 'grid';

export interface PocketSettings {
  startIn: StartIn;
  opensOn: OpensOn;
  legend: boolean;
  sounds: boolean;
  /** The view the Pocket was last in, for "last used". */
  lastView: View;
}

export const DEFAULT_POCKET_SETTINGS: PocketSettings = { startIn: 'flow', opensOn: 'favorites', legend: true, sounds: true, lastView: 'flow' };

export interface PocketSettingsInfo {
  /** Path relative to the card root. */
  file: string;
  /** file: read from the card. defaults: no file (or an all-zero one), so the defaults. unreadable: a file the app does not understand. */
  state: 'file' | 'defaults' | 'unreadable';
  /** What the Pocket uses: the file's values, or the defaults. Null when unreadable. */
  settings: PocketSettings | null;
}

const START_IN: StartIn[] = ['flow', 'grid', 'last'];
const OPENS_ON: OpensOn[] = ['favorites', 'recent', 'all'];
const VIEWS: View[] = ['flow', 'grid'];

export function settingsPath(card: string): string {
  return path.join(path.resolve(card), 'Saves', PACK_PLATFORM, 'common', 'settings.cfg');
}

/** The settings in a settings.cfg, or null if it is malformed or has values the app does not know. */
export function parsePocketSettings(buf: Buffer): PocketSettings | null {
  if (buf.length < SETTINGS_FILE_BYTES || buf.toString('latin1', 0, 4) !== 'SET1') return null;
  if (buf.readUInt16LE(4) !== 1) return null;
  const startIn = START_IN[buf[8]];
  const opensOn = OPENS_ON[buf[9]];
  const lastView = VIEWS[buf[12]];
  if (!startIn || !opensOn || !lastView || buf[10] > 1 || buf[11] > 1) return null;
  return { startIn, opensOn, legend: buf[10] === 1, sounds: buf[11] === 1, lastView };
}

export function readPocketSettings(card: string): PocketSettingsInfo {
  const file = settingsPath(card);
  const rel = path.relative(path.resolve(card), file).split(path.sep).join('/');
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { file: rel, state: 'defaults', settings: { ...DEFAULT_POCKET_SETTINGS } };
    return { file: rel, state: 'unreadable', settings: null };
  }
  if (buf.length > 0 && buf.length <= 4096 && buf.every((b) => b === 0)) return { file: rel, state: 'defaults', settings: { ...DEFAULT_POCKET_SETTINGS } };
  const settings = buf.length <= 4096 ? parsePocketSettings(buf) : null;
  return settings ? { file: rel, state: 'file', settings } : { file: rel, state: 'unreadable', settings: null };
}

/** Build a file, for tests. */
export function pocketSettingsFile(s: PocketSettings): Buffer {
  const b = Buffer.alloc(SETTINGS_FILE_BYTES);
  b.write('SET1', 0, 'latin1');
  b.writeUInt16LE(1, 4);
  b[8] = START_IN.indexOf(s.startIn);
  b[9] = OPENS_ON.indexOf(s.opensOn);
  b[10] = s.legend ? 1 : 0;
  b[11] = s.sounds ? 1 : 0;
  b[12] = VIEWS.indexOf(s.lastView);
  return b;
}
