/**
 * Which CRC was last seen at each ROM path. When the file at a path changes
 * contents (a new dump of the same game), the app moves the game's choices to the
 * new CRC. A path that disappears while another appears is a different file, so
 * nothing moves then.
 *
 * Kept with the choices (not in the cache), so clearing the cache never loses a move.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = () => path.join(DATA_DIR, 'rom-paths.json');

type PathMap = Record<string, string>;

function load(): PathMap {
  try {
    const m = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function save(m: PathMap): void {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const tmp = `${FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, FILE());
  } catch {
    // Only means a new dump is not recognized next time.
  }
}

export interface PathChange {
  abs: string;
  from: string;
  to: string;
}

/**
 * Record the CRC at each path under `scope` (a folder) and return the paths whose
 * CRC changed since last time. Paths under `scope` that are gone are forgotten.
 */
export function trackPaths(scope: string, entries: { abs: string; crc: string }[]): PathChange[] {
  const prefix = scope.endsWith(path.sep) ? scope : scope + path.sep;
  const m = load();
  const changes: PathChange[] = [];
  const seen = new Set<string>();
  let dirty = false;
  for (const e of entries) {
    seen.add(e.abs);
    const before = m[e.abs];
    if (before && before !== e.crc) changes.push({ abs: e.abs, from: before, to: e.crc });
    if (before !== e.crc) {
      m[e.abs] = e.crc;
      dirty = true;
    }
  }
  for (const k of Object.keys(m)) {
    if (k.startsWith(prefix) && !seen.has(k)) {
      delete m[k];
      dirty = true;
    }
  }
  if (dirty) save(m);
  return changes;
}
