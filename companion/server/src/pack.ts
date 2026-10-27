/**
 * The cover pack: the writers and the order games go in.
 *
 * Today's core reads v6 (pack-v6.ts, 31 games). The streaming core reads v7
 * (pack-v7.ts, up to 2047 games). core.ts decides which one a card gets.
 */
import { packV6 } from './pack-v6.js';
import { packV7 } from './pack-v7.js';
import { letterGroup, type MenuSection, type PackWriter } from './pack-common.js';

export * from './pack-common.js';
export { MAX_GAMES, PACK_VERSION, buildPack, expectedPackSize } from './pack-v6.js';
export { FINGERPRINT_BYTES, FPR_OFFSET, MAX_GAMES_V7, NO_SECTION, PACK_V7, STRIDE_V7, letterIndex } from './pack-v7.js';

const WRITERS: Record<number, PackWriter> = { 6: packV6, 7: packV7 };

/** The version used when no card says otherwise. */
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

/**
 * A to Z by title, the way the Pocket's letter index groups games: first the
 * titles that start with anything but A to Z ('#'), then A, B, ... Z, by the
 * first character of the title as the pack writes it. Within a letter, by title
 * ignoring case, then by file name. Stable on every Mac.
 */
export function compareTitles(a: Orderable, b: Orderable): number {
  const ga = letterGroup(a.title);
  const gb = letterGroup(b.title);
  if (ga !== gb) return ga - gb;
  const ta = a.title.toLowerCase();
  const tb = b.title.toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export type MenuGroup = 'played' | 'favorite' | 'rest';

export interface MenuItem<T> {
  game: T;
  section: MenuSection;
}

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

/**
 * The menu as pack entries. v6 (favoritesTwice false) is menuOrder(): each game
 * once. v7 (favoritesTwice true) keeps the played and favorites sections at the
 * top, then lists every game A to Z, so a favorite also shows under its letter.
 */
export function menuList<T extends Orderable>(games: T[], played: PlayHistory, favoritesTwice: boolean): MenuItem<T>[] {
  const ordered = menuOrder(games, played);
  if (!favoritesTwice) return ordered.map((game) => ({ game, section: menuGroup(game, played) === 'rest' ? 'az' : (menuGroup(game, played) as MenuSection) }));
  const top = ordered.filter((g) => menuGroup(g, played) !== 'rest').map((game) => ({ game, section: menuGroup(game, played) as MenuSection }));
  const all = [...games].sort(compareTitles).map((game) => ({ game, section: 'az' as const }));
  return [...top, ...all];
}
