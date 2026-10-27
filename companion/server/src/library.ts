/**
 * Everything the UI needs: the games in the library folder (or on the card when
 * no folder is set), their names, art and choices, and what is on the card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CARD_ROM_REL, COVERS_REL, PACK_PLATFORM } from './config.js';
import { loadChoices, migrateChoices, type ArtRef } from './choices.js';
import { trackPaths } from './romPaths.js';
import { loadDats, type DatIndex } from './dat.js';
import { readManifest, type ManifestEntry } from './manifest.js';
import { autoMatchCached, cleanTitle, type MatchStatus } from './match.js';
import { PACK_HEAD_MAX, TITLE_MAX, asciiTitle, compareTitles, pathProblems, readPackSummary, type PlayHistory } from './pack.js';
import { choosePack } from './core.js';
import { codepointCompare, fileCrc, flushCrcCache, isRomName, scanLibrary, scanRoms, type LibraryFile } from './roms.js';
import { loadThumbs, REPOS, type ThumbIndex } from './thumbs.js';
import { folderSpace } from './volumes.js';

/** exact: CRC found in No-Intro and art found by that name. guessed: art found by a similar name. */
export type GameStatus = MatchStatus | 'chosen' | 'custom';

/**
 * Where a game stands on the card.
 *   placed     the app put it there (it is in the manifest)
 *   adopt      a ROM you copied by hand is this same game; sync adds it to the manifest under its current name
 *   new        not on the card yet; sync copies it
 *   cardKept   a ROM you copied by hand has this game's file name but is a different dump; the card's copy stays
 *   replace    as cardKept, but you chose the library's copy; sync replaces the card's copy
 *   cardOnly   on the card, not in the library; stays in the menu and is never removed
 *   none       no card chosen
 */
export type CardState = 'placed' | 'adopt' | 'new' | 'cardKept' | 'replace' | 'cardOnly' | 'none';

export interface Game {
  /** The CRC32. A game is its checksum. */
  id: string;
  crc: string;
  /** Where the game comes from: the library folder, or only the card. */
  origin: 'library' | 'card';
  cardState: CardState;
  /** For cardKept and replace: the card's own file with this game's name. */
  cardFile: string | null;
  /**
   * For a card copy kept instead of a library game (same name, different CRC): that
   * library game's CRC. The copy takes its star, art and title unless it has its own.
   */
  inheritsFrom: string | null;
  /** File name the ROM has (or will have) on the card. */
  file: string;
  platform: string;
  size: number;
  isGb: boolean;
  /** Every place this ROM is in the library, relative to the library folder. */
  paths: string[];
  /** Absolute path of the copy sync reads from. */
  sourcePath: string;
  /** The card name differs from the library name (kept from an earlier sync, or made unique). */
  renamed: boolean;
  /** Canonical No-Intro name when the CRC matched. */
  datName: string | null;
  defaultTitle: string;
  title: string;
  titleEdited: boolean;
  /** Bytes the title takes in the pack after ASCII conversion (max 39). */
  titleBytes: number;
  /** What would be used with no choices. */
  auto: { status: MatchStatus; art: ArtRef | null; label: string | null };
  /** What will be used. */
  art: ArtRef | null;
  artLabel: string | null;
  status: GameStatus;
  favorite: boolean;
  /** When it was last played on the Pocket (ms). Null until the core records play history. */
  lastPlayed: number | null;
  problems: string[];
}

export interface CardInfo {
  root: string;
  romFolder: string;
  missingRomFolder: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  covers: { exists: boolean; bytes: number; modifiedAt: string | null; count: number | null; titles: string[] };
  manifest: { exists: boolean; placed: number; error?: string };
}

export interface Library {
  source: {
    kind: 'folder' | 'card';
    root: string;
    /** ROM files found, before duplicates are merged. */
    files: number;
    /** Files that were the same game as another file. */
    duplicates: number;
    unreadable: string[];
  };
  card: CardInfo | null;
  /** A to Z by title. */
  games: Game[];
  /** How many games the pack holds: 31 for v6, 2047 for v7. */
  maxGames: number;
  packVersion: number;
  /** Games whose choices moved to a new dump, not shown yet. */
  migrated: { id: string; title: string; kept: string[]; reason: 'library' | 'card'; where: string }[];
  /** Which pack the card gets and why. */
  pack: { version: number; limit: number; streaming: boolean; reason: string; coreVersion: string | null };
  databases: {
    dats: DatIndex['sources'];
    thumbs: ThumbIndex['sources'];
  };
}

function stem(file: string): string {
  return file.replace(/\.[^.]+$/, '');
}

function extOf(file: string): string {
  return path.extname(file);
}

function artLabel(ref: ArtRef | null): string | null {
  if (!ref) return null;
  if (ref.kind === 'thumb') return `${ref.name} (${REPOS.find((r) => r.repo === ref.repo)?.label ?? ref.repo})`;
  if (ref.kind === 'custom') return 'Your image';
  return 'Title card';
}

function coversInfo(root: string): CardInfo['covers'] {
  const file = path.join(root, COVERS_REL);
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(st.size, PACK_HEAD_MAX));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const s = readPackSummary(head);
    return { exists: true, bytes: st.size, modifiedAt: st.mtime.toISOString(), count: s?.count ?? null, titles: s?.titles ?? [] };
  } catch {
    return { exists: false, bytes: 0, modifiedAt: null, count: null, titles: [] };
  }
}

/**
 * Play history from the card. Always empty for now: the streaming core will
 * write Saves/gbc/common/launcher.cfg with, per CRC, the last time a game was
 * played. Parse it here and the Pocket view and the pack order pick it up.
 */
export function playHistory(_card: string | null): PlayHistory {
  return new Map();
}

export function cardRomDir(card: string): string {
  return path.join(path.resolve(card), CARD_ROM_REL);
}

/** ROM files in the card's ROM folder, by lower case name. */
export function listCardRoms(card: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const f of fs.readdirSync(cardRomDir(card))) if (isRomName(f)) out.set(f.toLowerCase(), f);
  } catch {
    // no folder yet
  }
  return out;
}

interface Grouped {
  crc: string;
  files: LibraryFile[];
}

export interface Placement {
  state: Exclude<CardState, 'cardOnly' | 'none'>;
  /** Name on the card. For cardKept, the card's own file, which this game does not use. */
  file: string;
}

export interface HandFile {
  file: string;
  crc: string;
}

export interface Placements {
  byCrc: Map<string, Placement>;
  /** ROMs on the card the app did not place and does not adopt or replace, by CRC. */
  cardOnly: Map<string, HandFile[]>;
  /** Every ROM on the card the app did not place, with its CRC. */
  hand: HandFile[];
}

/**
 * Decide where each library game goes on the card. In order:
 *
 * 1. A game the app placed before keeps the name in the manifest. Renaming or
 *    moving it in the library changes nothing on the card, and its save stays.
 * 2. A ROM you copied to the card by hand with the same CRC is adopted under its
 *    current name, never renamed, so its save keeps working.
 * 3. A ROM you copied by hand with the same name (before the extension) but a
 *    different CRC wins: the card's copy stays and the library's is not placed,
 *    because the save is tied to that name. You can choose the library's copy
 *    per game; it then replaces the card's copy under the card's name.
 * 4. Everything else uses its library file name. Names must differ by more than
 *    case (exFAT ignores case), and so must the part before the extension,
 *    because that names the save. A clash gets " (GB)" or " (GBC)", then the CRC.
 */
export function placeOnCard(
  games: Grouped[],
  manifest: ManifestEntry[],
  cardFiles: Map<string, string>,
  cardCrc: (file: string) => string | null,
  useLibraryCopy: (crc: string) => boolean,
): Placements {
  const byCrc = new Map<string, Placement>();
  const stems = new Map<string, string>(); // lower stem -> crc that holds it
  const placedNames = new Set(manifest.map((e) => e.file.toLowerCase()));
  const hand: HandFile[] = [];
  for (const [lower, actual] of [...cardFiles].sort((a, b) => codepointCompare(a[1], b[1]))) {
    if (placedNames.has(lower)) continue;
    const crc = cardCrc(actual);
    if (crc) hand.push({ file: actual, crc });
  }
  const used = new Set<string>(); // hand files that a library game takes over
  const handByCrc = new Map<string, HandFile>();
  for (const h of hand) if (!handByCrc.has(h.crc)) handByCrc.set(h.crc, h);
  const handByStem = new Map<string, HandFile>();
  for (const h of hand) if (!handByStem.has(stem(h.file).toLowerCase())) handByStem.set(stem(h.file).toLowerCase(), h);

  // 1. Placed before.
  const manifestByCrc = new Map(manifest.map((e) => [e.crc, e]));
  for (const g of games) {
    const e = manifestByCrc.get(g.crc);
    if (!e) continue;
    const s = stem(e.file).toLowerCase();
    if (stems.has(s)) continue;
    stems.set(s, g.crc);
    byCrc.set(g.crc, { state: 'placed', file: e.file });
  }
  // 2. Adopt the same ROM copied by hand.
  for (const g of games) {
    if (byCrc.has(g.crc)) continue;
    const h = handByCrc.get(g.crc);
    if (!h) continue;
    const s = stem(h.file).toLowerCase();
    if (stems.has(s)) continue;
    stems.set(s, g.crc);
    used.add(h.file);
    byCrc.set(g.crc, { state: 'adopt', file: h.file });
  }
  // 3. A different ROM copied by hand under this game's name.
  for (const g of games) {
    if (byCrc.has(g.crc)) continue;
    const s = stem(path.posix.basename(g.files[0].rel)).toLowerCase();
    const h = handByStem.get(s);
    if (!h || used.has(h.file) || stems.has(s)) continue;
    if (useLibraryCopy(g.crc)) {
      stems.set(s, g.crc);
      used.add(h.file);
      byCrc.set(g.crc, { state: 'replace', file: h.file });
    } else {
      byCrc.set(g.crc, { state: 'cardKept', file: h.file });
    }
  }
  // 4. New. Stems of hand files that stay on the card are taken too.
  for (const h of hand) if (!used.has(h.file)) stems.set(stem(h.file).toLowerCase(), stems.get(stem(h.file).toLowerCase()) ?? `hand:${h.crc}`);
  for (const g of games) {
    if (byCrc.has(g.crc)) continue;
    const base = path.posix.basename(g.files[0].rel);
    const ext = extOf(base);
    const tries = [base, `${stem(base)} (${ext.slice(1).toUpperCase()})${ext}`, `${stem(base)} (${g.crc})${ext}`];
    const pick = tries.find((t) => !stems.has(stem(t).toLowerCase())) ?? tries[tries.length - 1];
    stems.set(stem(pick).toLowerCase(), g.crc);
    byCrc.set(g.crc, { state: 'new', file: pick });
  }

  const libraryCrcs = new Set(games.map((g) => g.crc));
  const cardOnly = new Map<string, HandFile[]>();
  for (const h of hand) {
    if (used.has(h.file)) continue;
    // A second copy of a library game under another name. It stays on the card, but it is not another game.
    if (libraryCrcs.has(h.crc)) continue;
    const list = cardOnly.get(h.crc);
    if (list) list.push(h);
    else cardOnly.set(h.crc, [h]);
  }
  return { byCrc, cardOnly, hand };
}

export interface LibraryOptions {
  /** Mac library folder. Null uses the card's own ROM folder. */
  library: string | null;
  /** The card, or a folder laid out like one. */
  card: string | null;
  /** Favorite states that win over the saved ones, by CRC (from favorites.cfg on the card, before sync saves them). */
  favoriteOverrides?: Map<string, boolean>;
}

export async function buildLibrary(opts: LibraryOptions): Promise<Library> {
  const card = opts.card ? path.resolve(opts.card) : null;
  if (card && (!fs.existsSync(card) || !fs.statSync(card).isDirectory())) throw new Error(`Folder not found: ${card}`);
  let files: LibraryFile[];
  let source: Library['source'];
  if (opts.library) {
    const root = path.resolve(opts.library);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Library folder not found: ${root}`);
    const scan = scanLibrary(root);
    files = scan.files;
    source = { kind: 'folder', root, files: files.length, duplicates: 0, unreadable: scan.unreadable };
  } else if (card) {
    files = scanRoms(card).map((r) => ({ rel: r.file, absPath: r.absPath, size: r.size, mtimeMs: r.mtimeMs, crc: r.crc }));
    source = { kind: 'card', root: cardRomDir(card), files: files.length, duplicates: 0, unreadable: [] };
  } else {
    throw new Error('Choose a library folder or a card');
  }

  // One game per checksum. The copy we use is the least nested, then the shortest
  // name ("Tetris.gb" over "Tetris (copy).gb"), then code point order.
  const depth = (rel: string) => rel.split('/').length;
  const rank = (a: LibraryFile, b: LibraryFile) =>
    depth(a.rel) - depth(b.rel) ||
    path.posix.basename(a.rel).length - path.posix.basename(b.rel).length ||
    codepointCompare(a.rel, b.rel);
  const groups = new Map<string, Grouped>();
  for (const f of [...files].sort(rank)) {
    const g = groups.get(f.crc);
    if (g) g.files.push(f);
    else groups.set(f.crc, { crc: f.crc, files: [f] });
  }
  source.duplicates = files.length - groups.size;

  const manifest = card ? readManifest(card) : null;
  const cardFiles = card ? listCardRoms(card) : new Map<string, string>();
  const crcOnCard = (f: string): string | null => {
    if (!card) return null;
    try {
      const abs = path.join(cardRomDir(card), f);
      return fileCrc(abs, fs.statSync(abs));
    } catch {
      return null;
    }
  };
  // A new dump at the same path keeps the game's choices (rule: same path, new CRC).
  // A file that moved and changed at once is a different file: nothing moves.
  const scope = source.kind === 'folder' ? source.root : cardRomDir(card!);
  for (const ch of trackPaths(scope, files.map((f) => ({ abs: f.absPath, crc: f.crc })))) {
    if (groups.has(ch.to)) migrateChoices(ch.from, ch.to, source.kind === 'folder' ? 'library' : 'card', path.relative(scope, ch.abs).split(path.sep).join('/'));
  }
  let choices = loadChoices().games;
  // With no library folder, every ROM on the card is a card only game.
  const libraryGroups = source.kind === 'folder' ? [...groups.values()] : [];
  // Without a card this still picks unique names, so saves never mix.
  const placements = placeOnCard(
    libraryGroups,
    source.kind === 'folder' ? (manifest?.manifest.placed ?? []) : [],
    cardFiles,
    crcOnCard,
    (crc) => choices[crc]?.useLibraryCopy === true,
  );
  flushCrcCache();
  // ROMs you put on the card yourself: a new dump under the same name keeps its choices too.
  if (card && source.kind === 'folder') {
    const romDir = cardRomDir(card);
    let moved = false;
    for (const ch of trackPaths(romDir, placements.hand.map((h) => ({ abs: path.join(romDir, h.file), crc: h.crc })))) {
      if (migrateChoices(ch.from, ch.to, 'card', path.basename(ch.abs))) moved = true;
    }
    if (moved) choices = loadChoices().games;
  }

  const [dats, thumbs] = await Promise.all([loadDats(), loadThumbs()]);
  const played = playHistory(card);

  // Card copies kept instead of a library game take that game's choices.
  const parentOf = new Map<string, string>();
  for (const [libCrc, p] of placements.byCrc) {
    if (p.state !== 'cardKept') continue;
    const h = placements.hand.find((x) => x.file === p.file);
    if (h) parentOf.set(h.crc, libCrc);
  }

  const makeGame = (crc: string, origin: Game['origin'], name: string, file: string, size: number, paths: string[], sourcePath: string): Game => {
    const placement = placements.byCrc.get(crc);
    const cardState: CardState = origin === 'card' ? 'cardOnly' : !card ? 'none' : (placement?.state ?? 'none');
    const dat = dats.byCrc.get(crc);
    const system = file.toLowerCase().endsWith('.gb') ? 'gb' : 'gbc';
    const auto = autoMatchCached(thumbs, stem(name), system, dat);
    const autoArt: ArtRef | null = auto.thumb ? { kind: 'thumb', repo: auto.thumb.repo, name: auto.thumb.name } : null;
    const own = choices[crc] ?? {};
    const parentCrc = origin === 'card' ? (parentOf.get(crc) ?? null) : null;
    const parent = parentCrc ? (choices[parentCrc] ?? {}) : {};
    // Its own choices first, then the library game it stands in for.
    const choice = {
      title: own.title ?? parent.title,
      art: own.art ?? parent.art,
      favorite: opts.favoriteOverrides?.get(crc) ?? own.favorite ?? parent.favorite,
    };
    const defaultTitle = cleanTitle(dat?.name ?? stem(name));
    const title = choice.title ?? defaultTitle;
    const art = choice.art ?? autoArt;
    let status: GameStatus = auto.status;
    if (choice.art) status = choice.art.kind === 'custom' ? 'custom' : choice.art.kind === 'placeholder' ? 'none' : 'chosen';
    return {
      id: crc,
      crc,
      origin,
      cardState,
      cardFile: cardState === 'cardKept' || cardState === 'replace' ? placement!.file : null,
      inheritsFrom: parentCrc,
      file,
      platform: PACK_PLATFORM,
      size,
      isGb: system === 'gb',
      paths,
      sourcePath,
      renamed: file !== name,
      datName: dat?.name ?? null,
      defaultTitle,
      title,
      titleEdited: choice.title !== undefined,
      titleBytes: asciiTitle(title, 1000).length,
      auto: { status: auto.status, art: autoArt, label: artLabel(autoArt) },
      art,
      artLabel: artLabel(art),
      status,
      favorite: choice.favorite === true,
      lastPlayed: played.get(crc) ?? null,
      problems: pathProblems(PACK_PLATFORM, file),
    };
  };

  const games: Game[] = libraryGroups.map(({ crc, files: fs_ }) => {
    const primary = fs_[0];
    const libName = path.posix.basename(primary.rel);
    const p = placements.byCrc.get(crc);
    // A game whose card copy is kept is shown under its library name; it is not placed.
    const file = p && p.state !== 'cardKept' ? p.file : libName;
    return makeGame(crc, 'library', libName, file, primary.size, fs_.map((f) => f.rel), primary.absPath);
  });
  if (card) {
    for (const [crc, hs] of placements.cardOnly) {
      const abs = path.join(cardRomDir(card), hs[0].file);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      games.push(makeGame(crc, 'card', hs[0].file, hs[0].file, size, [], abs));
    }
  }
  games.sort(compareTitles);

  const pack = choosePack(card, games.filter((g) => g.cardState !== 'cardKept' && !g.problems.length).length);

  let cardInfo: CardInfo | null = null;
  if (card) {
    const romFolder = CARD_ROM_REL.split(path.sep).join('/');
    cardInfo = {
      root: card,
      romFolder,
      missingRomFolder: !fs.existsSync(cardRomDir(card)),
      ...folderSpace(card),
      covers: coversInfo(card),
      manifest: { exists: !!manifest?.exists, placed: manifest?.manifest.placed.length ?? 0, error: manifest?.error },
    };
  }

  return {
    source,
    card: cardInfo,
    games,
    migrated: loadChoices()
      .migrations.filter((m) => !m.seen)
      .map((m) => ({ id: m.id, title: games.find((g) => g.crc === m.to)?.title ?? m.where, kept: m.kept, reason: m.reason, where: m.where })),
    maxGames: pack.limit,
    packVersion: pack.version,
    pack: { version: pack.version, limit: pack.limit, streaming: pack.streaming, reason: pack.reason, coreVersion: pack.core.version },
    databases: { dats: dats.sources, thumbs: thumbs.sources },
  };
}

export { TITLE_MAX };
