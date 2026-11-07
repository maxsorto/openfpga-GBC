/**
 * Play history: which games were played on the Pocket, newest first.
 *
 * The core (build 26 and later) notes each launch in /Saves/gbc/common/recent.cfg,
 * 272 bytes, little-endian:
 *
 *   0   "RCN1"
 *   4   u16 version = 1
 *   6   u16 n, records used (0 to 32)
 *   8   8 zero bytes
 *   16  n records of 8 bytes, oldest first (launch order):
 *       u32 CRC32 of the ROM | u16 az_pos (the pack index the core used, informational) | u16 0
 *   records past n are zero
 *
 * A missing file, an all-zero one or n = 0 means no new launches. The app keeps the
 * history itself, in history.json in its data folder, by CRC, newest first. Sync applies
 * the file's launches in order (each one moves its game to the front), saves the history,
 * writes the pack (its REC1 block is the 32 newest history games in the A to Z list), and
 * then writes recent.cfg back empty, if it did not change in the meantime.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PACK_PLATFORM } from './config.js';

export const RECENT_FILE_BYTES = 272;
const HEAD = 16;
const RECORD = 8;
export const RECENT_MAX_RECORDS = 32;
/** Games kept in history.json. More than the Pocket shows, so a game that leaves and comes back keeps its place. */
export const HISTORY_KEPT = 200;

export interface Launch {
  crc: string;
  /** The pack index the core used. Informational: the CRC is what counts. */
  azPos: number;
}

export interface RecentCfg {
  /** Path relative to the card root. */
  file: string;
  /** Records used in the file. */
  n: number;
  /** The launches, oldest first, as in the file. */
  launches: Launch[];
  /** Hash of the file as read, so sync only empties it if it did not change since the plan. */
  sha: string;
}

export function recentPath(card: string): string {
  return path.join(path.resolve(card), 'Saves', PACK_PLATFORM, 'common', 'recent.cfg');
}

/** The launches in a recent.cfg, oldest first, or null if the file is malformed. */
export function parseRecent(buf: Buffer): { n: number; launches: Launch[] } | null {
  // The core may make the file as zeros before it first writes to it: no launches yet.
  if (buf.length > 0 && buf.every((b) => b === 0)) return { n: 0, launches: [] };
  if (buf.length < HEAD || buf.toString('latin1', 0, 4) !== 'RCN1') return null;
  if (buf.readUInt16LE(4) !== 1) return null;
  const n = buf.readUInt16LE(6);
  if (n > RECENT_MAX_RECORDS || HEAD + n * RECORD > buf.length) return null;
  const launches: Launch[] = [];
  for (let i = 0; i < n; i++) {
    const o = HEAD + i * RECORD;
    const crc = buf.readUInt32LE(o);
    if (crc === 0) continue; // an empty record is not a launch
    launches.push({ crc: crc.toString(16).toUpperCase().padStart(8, '0'), azPos: buf.readUInt16LE(o + 4) });
  }
  return { n, launches };
}

export function readRecentCfg(card: string): RecentCfg | null {
  const file = recentPath(card);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length > 64 * 1024) return null;
  const parsed = parseRecent(buf);
  if (!parsed) return null;
  return {
    ...parsed,
    file: path.relative(path.resolve(card), file).split(path.sep).join('/'),
    sha: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/** The file as the core writes it with nothing in it: magic, version 1, n = 0, zeros. */
export function emptyRecentCfg(): Buffer {
  const b = Buffer.alloc(RECENT_FILE_BYTES);
  b.write('RCN1', 0, 'latin1');
  b.writeUInt16LE(1, 4);
  return b;
}

/** Build a file from launches, oldest first, for tests. */
export function recentCfgFile(launches: { crc: string; azPos?: number }[]): Buffer {
  const b = emptyRecentCfg();
  b.writeUInt16LE(launches.length, 6);
  launches.forEach((l, i) => {
    b.writeUInt32LE(parseInt(l.crc, 16) >>> 0, HEAD + i * RECORD);
    b.writeUInt16LE(l.azPos ?? 0, HEAD + i * RECORD + 4);
  });
  return b;
}

/* ---------- history.json ---------- */

export interface HistoryEntry {
  crc: string;
  /** When the app learned of the launch (the sync that read it), ISO time. */
  at: string;
}

interface HistoryFile {
  version: 1;
  /** Newest first. */
  games: HistoryEntry[];
}

const HISTORY_FILE = () => path.join(DATA_DIR, 'history.json');
const CRC_RE = /^[0-9A-F]{8}$/;

/** The saved history, newest first. Empty on first run or if the file is unreadable. */
export function loadHistory(): HistoryEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')) as HistoryFile;
    if (!Array.isArray(j.games)) return [];
    return j.games.filter((g) => g && typeof g.crc === 'string' && CRC_RE.test(g.crc) && typeof g.at === 'string');
  } catch {
    return [];
  }
}

function saveHistory(games: HistoryEntry[]): void {
  fs.mkdirSync(path.dirname(HISTORY_FILE()), { recursive: true });
  const tmp = `${HISTORY_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, games } satisfies HistoryFile, null, 2));
  fs.renameSync(tmp, HISTORY_FILE());
}

/**
 * The history after these launches, oldest first: each one moves its game to the front.
 * Applying the same launches twice gives the same order, so a sync that stops after
 * saving and before emptying recent.cfg does no harm when the next one reads it again.
 */
export function applyLaunches(history: HistoryEntry[], launches: Launch[], now = new Date()): HistoryEntry[] {
  const at = now.toISOString();
  let out = [...history];
  for (const l of launches) {
    const crc = l.crc.toUpperCase();
    out = [{ crc, at }, ...out.filter((h) => h.crc !== crc)];
  }
  return out.slice(0, HISTORY_KEPT);
}

/** Save launches from recent.cfg in history.json. Returns the new history. */
export function recordLaunches(launches: Launch[], now = new Date()): HistoryEntry[] {
  const next = applyLaunches(loadHistory(), launches, now);
  if (launches.length) saveHistory(next);
  return next;
}

/** History CRCs, newest first, with the card's launches that are not saved yet. */
export function historyWithCard(cfg: RecentCfg | null): string[] {
  return applyLaunches(loadHistory(), cfg?.launches ?? []).map((h) => h.crc);
}
