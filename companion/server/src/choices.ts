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
  /** Starred. Favorites come first on the Pocket, after recently played games. */
  favorite?: boolean;
  /** From the 31 slot version. Kept in the file but no longer used. */
  include?: boolean;
  updatedAt?: string;
}

interface ChoicesFile {
  version: 1;
  games: Record<string, Choice>;
}

const CRC_RE = /^[0-9A-F]{8}$/;

export function loadChoices(): ChoicesFile {
  try {
    const f = JSON.parse(fs.readFileSync(CHOICES_FILE, 'utf8'));
    if (f && typeof f.games === 'object') return { version: 1, games: f.games };
  } catch {
    // first run or unreadable file
  }
  return { version: 1, games: {} };
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
    // Only a star is stored; false clears it.
    if (patch.favorite === null || patch.favorite === false) delete c.favorite;
    else if (patch.favorite === true) c.favorite = true;
    c.updatedAt = new Date().toISOString();
    const keys = Object.keys(c).filter((k) => k !== 'updatedAt');
    if (keys.length) f.games[crc] = c;
    else delete f.games[crc];
  }
  save(f);
}
