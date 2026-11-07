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
export { CRT_HAS_EMPTY_SLOT, CRT_HAS_V26, REC_MAX, REC_OFFSET, recentIndexes, NO_PLACE, ROM_PATH_MAX_V7, defaultImageCount, CRT_OFFSET, FINGERPRINT_BYTES, FPR_OFFSET, MAX_GAMES_V7, NO_SECTION, PACK_V7, STRIDE_V7, defaultArtOffset, fingerprintTableOffset, letterIndex, listCount } from './pack-v7.js';

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

export interface MenuItem<T> {
  game: T;
  section: MenuSection;
}

/**
 * Menu order on the Pocket: favorites A to Z, then everything else A to Z. Play
 * history does not change it: v7 carries it in its REC1 block, for Recent mode.
 */
export function menuOrder<T extends Orderable>(games: T[]): T[] {
  const favorite = games.filter((g) => g.favorite).sort(compareTitles);
  const rest = games.filter((g) => !g.favorite).sort(compareTitles);
  return [...favorite, ...rest];
}

/**
 * The menu as pack entries. v6 (favoritesTwice false) is menuOrder(): each game
 * once. v7 (favoritesTwice true) keeps the favorites section at the top, then lists
 * every game A to Z, so a favorite also shows under its letter.
 */
export function menuList<T extends Orderable>(games: T[], favoritesTwice: boolean): MenuItem<T>[] {
  const ordered = menuOrder(games);
  if (!favoritesTwice) return ordered.map((game) => ({ game, section: game.favorite ? 'favorite' : 'az' }));
  const top = ordered.filter((g) => g.favorite).map((game) => ({ game, section: 'favorite' as const }));
  const all = [...games].sort(compareTitles).map((game) => ({ game, section: 'az' as const }));
  return [...top, ...all];
}
