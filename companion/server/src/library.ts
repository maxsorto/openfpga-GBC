/**
 * Everything the UI needs: the games in the library folder (or on the card when
 * no folder is set), their names, art and choices, and what is on the card.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CARD_ROM_REL, COVERS_REL, PACK_PLATFORM } from './config.js';
import { loadChoices, type ArtRef } from './choices.js';
import { loadDats, type DatIndex } from './dat.js';
import { readManifest, type ManifestEntry } from './manifest.js';
import { autoMatchCached, cleanTitle, type MatchStatus } from './match.js';
import { CURRENT_PACK_VERSION, MAX_GAMES, TITLE_MAX, asciiTitle, compareTitles, pathProblems, readPackSummary, type PlayHistory } from './pack.js';
import { codepointCompare, fileCrc, isRomName, scanLibrary, scanRoms, type LibraryFile } from './roms.js';
import { loadThumbs, REPOS, type ThumbIndex } from './thumbs.js';
import { folderSpace } from './volumes.js';

/** exact: CRC found in No-Intro and art found by that name. guessed: art found by a similar name. */
export type GameStatus = MatchStatus | 'chosen' | 'custom';

export interface Game {
  /** The CRC32. A game is its checksum. */
  id: string;
  crc: string;
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
  maxGames: number;
  packVersion: number;
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
    const head = Buffer.alloc(Math.min(st.size, 528 + MAX_GAMES * 128));
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

/**
 * Pick the file name each game gets on the card.
 *
 * 1. A game the app placed before keeps the name in the manifest. Renaming or
 *    moving it in the library changes nothing on the card, and its save stays.
 * 2. Others use their library file name. Names must differ by more than case
 *    (exFAT ignores case), and so must the part before the extension, because
 *    that names the save. A clash gets " (GB)" or " (GBC)", then the CRC.
 * 3. Files you put on the card by hand are never overwritten. A clash with one
 *    gets a new name, unless it is the very same ROM.
 */
export function assignCardNames(
  games: Grouped[],
  manifest: ManifestEntry[],
  cardFiles: Map<string, string>,
  cardCrc: (file: string) => string | null,
): Map<string, string> {
  const names = new Map<string, string>();
  const stems = new Map<string, string>(); // lower stem -> crc that holds it
  const placedNames = new Set(manifest.map((e) => e.file.toLowerCase()));
  // Stems of files on the card that the app did not place.
  const handStems = new Map<string, string>();
  for (const [lower, actual] of cardFiles) if (!placedNames.has(lower)) handStems.set(stem(lower), actual);

  const byCrc = new Map(manifest.map((e) => [e.crc, e]));
  for (const g of games) {
    const e = byCrc.get(g.crc);
    if (!e) continue;
    const s = stem(e.file).toLowerCase();
    if (stems.has(s) || handStems.has(s)) continue;
    stems.set(s, g.crc);
    names.set(g.crc, e.file);
  }

  const free = (file: string, crc: string): boolean => {
    const s = stem(file).toLowerCase();
    if (stems.has(s)) return false;
    const hand = handStems.get(s);
    if (hand === undefined) return true;
    // The same ROM is already there under this exact name: share it.
    return hand.toLowerCase() === file.toLowerCase() && cardCrc(hand) === crc;
  };
  for (const g of games) {
    if (names.has(g.crc)) continue;
    const base = path.posix.basename(g.files[0].rel);
    const ext = extOf(base);
    const tries = [base, `${stem(base)} (${ext.slice(1).toUpperCase()})${ext}`, `${stem(base)} (${g.crc})${ext}`];
    const pick = tries.find((t) => free(t, g.crc)) ?? tries[tries.length - 1];
    stems.set(stem(pick).toLowerCase(), g.crc);
    names.set(g.crc, pick);
  }
  return names;
}

export interface LibraryOptions {
  /** Mac library folder. Null uses the card's own ROM folder. */
  library: string | null;
  /** The card, or a folder laid out like one. */
  card: string | null;
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
  const names = assignCardNames([...groups.values()], manifest?.manifest.placed ?? [], cardFiles, (f) => {
    if (!card) return null;
    try {
      const abs = path.join(cardRomDir(card), f);
      return fileCrc(abs, fs.statSync(abs));
    } catch {
      return null;
    }
  });

  const [dats, thumbs] = await Promise.all([loadDats(), loadThumbs()]);
  const choices = loadChoices().games;
  const played = playHistory(card);

  const games: Game[] = [...groups.values()].map(({ crc, files: fs_ }) => {
    const primary = fs_[0];
    const libName = path.posix.basename(primary.rel);
    const file = names.get(crc) ?? libName;
    const dat = dats.byCrc.get(crc);
    const system = file.toLowerCase().endsWith('.gb') ? 'gb' : 'gbc';
    const auto = autoMatchCached(thumbs, stem(libName), system, dat);
    const autoArt: ArtRef | null = auto.thumb ? { kind: 'thumb', repo: auto.thumb.repo, name: auto.thumb.name } : null;
    const choice = choices[crc] ?? {};
    const defaultTitle = cleanTitle(dat?.name ?? stem(libName));
    const title = choice.title ?? defaultTitle;
    const art = choice.art ?? autoArt;
    let status: GameStatus = auto.status;
    if (choice.art) status = choice.art.kind === 'custom' ? 'custom' : choice.art.kind === 'placeholder' ? 'none' : 'chosen';
    return {
      id: crc,
      crc,
      file,
      platform: PACK_PLATFORM,
      size: primary.size,
      isGb: system === 'gb',
      paths: fs_.map((f) => f.rel),
      sourcePath: primary.absPath,
      renamed: file !== libName,
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
  });
  games.sort(compareTitles);

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
    maxGames: MAX_GAMES,
    packVersion: CURRENT_PACK_VERSION,
    databases: { dats: dats.sources, thumbs: thumbs.sources },
  };
}

export { TITLE_MAX };
