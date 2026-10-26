/** App settings that are not about one game: today only the library folder. */
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_FILE } from './config.js';

export interface Settings {
  /** The Mac folder with your ROMs. Null means the card's own ROM folder is the library. */
  libraryRoot: string | null;
}

export function loadSettings(): Settings {
  try {
    const f = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { libraryRoot: typeof f.libraryRoot === 'string' && f.libraryRoot ? f.libraryRoot : null };
  } catch {
    return { libraryRoot: null };
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch };
  if (next.libraryRoot) {
    const abs = path.resolve(next.libraryRoot);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Folder not found: ${abs}`);
    next.libraryRoot = abs;
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}
