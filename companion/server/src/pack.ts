/**
 * The cover pack: which writer to use and in what order games go in.
 *
 * Today's core reads v6 (pack-v6.ts), which holds 31 games. The streaming core
 * will read v7; its writer goes in pack-v7.ts and into WRITERS below. Nothing
 * outside this file needs to know which version is current.
 */
import { packV6 } from './pack-v6.js';
import type { PackWriter } from './pack-common.js';

export * from './pack-common.js';
export { BLOB_BYTES, ENTRY_BYTES, MAX_GAMES, PACK_VERSION, buildPack, expectedPackSize, readPackSummary } from './pack-v6.js';

const WRITERS: Record<number, PackWriter> = { 6: packV6 };

/** The version sync writes. */
export const CURRENT_PACK_VERSION = 6;

export function packWriter(version = CURRENT_PACK_VERSION): PackWriter {
  const w = WRITERS[version];
  if (!w) throw new Error(`No writer for pack v${version}`);
  return w;
}

export interface Orderable {
  crc: string;
  title: string;
  file: string;
  favorite: boolean;
}

/**
 * Play history by CRC: when each game was last played (ms since 1970).
 * Empty today. The core will write it to launcher.cfg, and the app will read
 * it on sync (see playHistory() in library.ts).
 */
export type PlayHistory = Map<string, number>;

/** Alphabetical by title, ignoring case, then by file name. Stable on every Mac. */
export function compareTitles(a: Orderable, b: Orderable): number {
  const ta = a.title.toLowerCase();
  const tb = b.title.toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export type MenuGroup = 'played' | 'favorite' | 'rest';

export function menuGroup(g: Orderable, played: PlayHistory): MenuGroup {
  return played.has(g.crc) ? 'played' : g.favorite ? 'favorite' : 'rest';
}

/**
 * Menu order on the Pocket: played games, most recent first; then favorites
 * A to Z; then everything else A to Z.
 */
export function menuOrder<T extends Orderable>(games: T[], played: PlayHistory = new Map()): T[] {
  const groups: Record<MenuGroup, T[]> = { played: [], favorite: [], rest: [] };
  for (const g of games) groups[menuGroup(g, played)].push(g);
  groups.played.sort((a, b) => played.get(b.crc)! - played.get(a.crc)! || compareTitles(a, b));
  groups.favorite.sort(compareTitles);
  groups.rest.sort(compareTitles);
  return [...groups.played, ...groups.favorite, ...groups.rest];
}
