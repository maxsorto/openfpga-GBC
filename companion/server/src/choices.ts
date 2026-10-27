/** Your choices per ROM, keyed by CRC32, saved as JSON in the data folder. */
import fs from 'node:fs';
import path from 'node:path';
import { CHOICES_FILE } from './config.js';

export type ArtRef =
  | { kind: 'thumb'; repo: string; name: string }
  | { kind: 'custom'; file: string }
  | { kind: 'placeholder' };

export interface Choice {
  title?: string;
  art?: ArtRef;
  /**
   * Starred. Favorites come first on the Pocket, after recently played games.
   * false is kept too: a card copy that inherits a star can be unstarred on its own.
   */
  favorite?: boolean;
  /**
   * When a ROM you put on the card by hand has this game's file name but is a
   * different dump, sync keeps the card's copy. True replaces it with the
   * library's copy instead (the card copy is backed up to the Mac first).
   */
  useLibraryCopy?: boolean;
  /** From the 31 slot version. Kept in the file but no longer used. */
  include?: boolean;
  updatedAt?: string;
}

/**
 * Choices that moved to a new CRC because the ROM at the same place changed
 * (a new dump of the same game). Kept so a move happens once, and so the app can
 * say what it did.
 */
export interface Migration {
  id: string;
  from: string;
  to: string;
  /** library: same path in the library folder. card: replaced under the same card file name. */
  reason: 'library' | 'card';
  /** Where it happened: the library path, or the card file name. */
  where: string;
  /** What moved, in words: "star", "cover", "title", "choice of copy". */
  kept: string[];
  at: string;
  /** The app has shown it. */
  seen: boolean;
}

interface ChoicesFile {
  version: 1;
  games: Record<string, Choice>;
  migrations: Migration[];
}

const CRC_RE = /^[0-9A-F]{8}$/;

export function loadChoices(): ChoicesFile {
  try {
    const f = JSON.parse(fs.readFileSync(CHOICES_FILE, 'utf8'));
    if (f && typeof f.games === 'object') return { version: 1, games: f.games, migrations: Array.isArray(f.migrations) ? f.migrations : [] };
  } catch {
    // first run or unreadable file
  }
  return { version: 1, games: {}, migrations: [] };
}

function save(f: ChoicesFile): void {
  fs.mkdirSync(path.dirname(CHOICES_FILE), { recursive: true });
  const tmp = `${CHOICES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2));
  fs.renameSync(tmp, CHOICES_FILE);
}

export function isArtRef(v: unknown): v is ArtRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'placeholder') return true;
  if (r.kind === 'thumb') return typeof r.repo === 'string' && typeof r.name === 'string';
  if (r.kind === 'custom') return typeof r.file === 'string' && !r.file.includes('/') && !r.file.includes('..');
  return false;
}

/** Fields set to null are cleared; fields left out are kept. */
export interface ChoicePatch {
  title?: string | null;
  art?: ArtRef | null;
  include?: boolean | null;
  favorite?: boolean | null;
  useLibraryCopy?: boolean | null;
}

export function updateChoices(patches: Record<string, ChoicePatch>): void {
  const f = loadChoices();
  for (const [crc, patch] of Object.entries(patches)) {
    if (!CRC_RE.test(crc)) throw new Error(`Bad CRC: ${crc}`);
    const c: Choice = { ...(f.games[crc] ?? {}) };
    if (patch.title === null) delete c.title;
    else if (typeof patch.title === 'string') c.title = patch.title.slice(0, 200);
    if (patch.art === null) delete c.art;
    else if (patch.art !== undefined) {
      if (!isArtRef(patch.art)) throw new Error('Bad art reference');
      c.art = patch.art;
    }
    if (patch.include === null) delete c.include;
    else if (typeof patch.include === 'boolean') c.include = patch.include;
    if (patch.favorite === null) delete c.favorite;
    else if (typeof patch.favorite === 'boolean') c.favorite = patch.favorite;
    if (patch.useLibraryCopy === null || patch.useLibraryCopy === false) delete c.useLibraryCopy;
    else if (patch.useLibraryCopy === true) c.useLibraryCopy = true;
    c.updatedAt = new Date().toISOString();
    const keys = Object.keys(c).filter((k) => k !== 'updatedAt');
    if (keys.length) f.games[crc] = c;
    else delete f.games[crc];
  }
  save(f);
}

/** The per-game choices that follow a game to a new dump, and how to say each one. */
const MOVABLE: { key: 'favorite' | 'art' | 'title' | 'useLibraryCopy'; word: (c: Choice) => string | null }[] = [
  { key: 'favorite', word: (c) => (c.favorite ? 'star' : null) },
  { key: 'art', word: () => 'cover' },
  { key: 'title', word: () => 'title' },
  { key: 'useLibraryCopy', word: () => null },
];

/** What a move from one CRC to another would carry: the old choices the new CRC does not have yet. */
export function pendingMove(from: string, to: string): { fields: Partial<Choice>; kept: string[] } {
  const f = loadChoices();
  const old = f.games[from] ?? {};
  const now = f.games[to] ?? {};
  const fields: Partial<Choice> = {};
  const kept: string[] = [];
  if (f.migrations.some((m) => m.from === from && m.to === to)) return { fields, kept };
  for (const m of MOVABLE) {
    if (old[m.key] === undefined || now[m.key] !== undefined) continue;
    (fields as Record<string, unknown>)[m.key] = old[m.key];
    const w = m.word(old);
    if (w) kept.push(w);
  }
  return { fields, kept };
}

/**
 * Give a game's new dump the choices of the old one: each choice the new CRC does
 * not have yet is copied. The old CRC keeps its choices too, so nothing is lost.
 * Runs once per pair. Returns the record, or null when there was nothing to move.
 */
export function migrateChoices(from: string, to: string, reason: Migration['reason'], where: string, seen = false): Migration | null {
  if (!CRC_RE.test(from) || !CRC_RE.test(to) || from === to) return null;
  const { fields, kept } = pendingMove(from, to);
  if (!Object.keys(fields).length) return null;
  const f = loadChoices();
  f.games[to] = { ...(f.games[to] ?? {}), ...fields, updatedAt: new Date().toISOString() };
  const m: Migration = { id: `${from}-${to}`, from, to, reason, where, kept, at: new Date().toISOString(), seen };
  f.migrations.push(m);
  save(f);
  return m;
}

export function markMigrationsSeen(ids: string[]): void {
  const f = loadChoices();
  let changed = false;
  for (const m of f.migrations) {
    if (ids.includes(m.id) && !m.seen) {
      m.seen = true;
      changed = true;
    }
  }
  if (changed) save(f);
}
