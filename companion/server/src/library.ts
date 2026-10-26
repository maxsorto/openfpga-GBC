/** Everything the UI needs about one card or folder: ROMs, names, art and choices. */
import fs from 'node:fs';
import path from 'node:path';
import { COVERS_REL, ROM_FOLDERS } from './config.js';
import { loadChoices, type ArtRef } from './choices.js';
import { loadDats, type DatIndex } from './dat.js';
import { autoMatch, cleanTitle, type MatchStatus } from './match.js';
import { MAX_GAMES, TITLE_MAX, asciiTitle, pathProblems, readPackSummary } from './pack.js';
import { scanRoms } from './roms.js';
import { loadThumbs, REPOS, type ThumbIndex } from './thumbs.js';
import { folderSpace } from './volumes.js';

/** exact: CRC found in No-Intro and art found by that name. guessed: art found by a similar name. */
export type GameStatus = MatchStatus | 'chosen' | 'custom';

export interface Game {
  id: string;
  file: string;
  platform: string;
  size: number;
  crc: string;
  isGb: boolean;
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
  included: boolean;
  includeExplicit: boolean;
  problems: string[];
}

export interface Library {
  root: string;
  romFolders: string[];
  missingRomFolder: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  covers: { exists: boolean; bytes: number; modifiedAt: string | null; count: number | null; titles: string[] };
  games: Game[];
  maxGames: number;
  databases: {
    dats: DatIndex['sources'];
    thumbs: ThumbIndex['sources'];
  };
}

function stem(file: string): string {
  return file.replace(/\.[^.]+$/, '');
}

function artLabel(ref: ArtRef | null): string | null {
  if (!ref) return null;
  if (ref.kind === 'thumb') return `${ref.name} (${REPOS.find((r) => r.repo === ref.repo)?.label ?? ref.repo})`;
  if (ref.kind === 'custom') return 'Your image';
  return 'Title card';
}

function coversInfo(root: string): Library['covers'] {
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

export async function buildLibrary(rootIn: string): Promise<Library> {
  const root = path.resolve(rootIn);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`);

  const roms = scanRoms(root);
  const [dats, thumbs] = await Promise.all([loadDats(), loadThumbs()]);
  const choices = loadChoices().games;

  const games: Game[] = roms.map((rom) => {
    const dat = dats.byCrc.get(rom.crc);
    const system = rom.file.toLowerCase().endsWith('.gb') ? 'gb' : 'gbc';
    const auto = autoMatch(thumbs, stem(rom.file), system, dat);
    const autoArt: ArtRef | null = auto.thumb ? { kind: 'thumb', repo: auto.thumb.repo, name: auto.thumb.name } : null;
    const choice = choices[rom.crc] ?? {};
    const defaultTitle = cleanTitle(dat?.name ?? stem(rom.file));
    const title = choice.title ?? defaultTitle;
    const art = choice.art ?? autoArt;
    let status: GameStatus = auto.status;
    if (choice.art) status = choice.art.kind === 'custom' ? 'custom' : choice.art.kind === 'placeholder' ? 'none' : 'chosen';
    return {
      id: rom.id,
      file: rom.file,
      platform: rom.platform,
      size: rom.size,
      crc: rom.crc,
      isGb: system === 'gb',
      datName: dat?.name ?? null,
      defaultTitle,
      title,
      titleEdited: choice.title !== undefined,
      titleBytes: asciiTitle(title, 1000).length,
      auto: { status: auto.status, art: autoArt, label: artLabel(autoArt) },
      art,
      artLabel: artLabel(art),
      status,
      included: false,
      includeExplicit: choice.include !== undefined,
      problems: pathProblems(rom.platform, rom.file),
    };
  });

  // The core holds 31 games. Explicit choices count first, then the rest fill
  // the free slots in alphabetical order.
  let slots = MAX_GAMES;
  for (const g of games) {
    const c = choices[g.crc]?.include;
    if (c === true && !g.problems.length && slots > 0) {
      g.included = true;
      slots--;
    }
  }
  for (const g of games) {
    const c = choices[g.crc]?.include;
    if (c === undefined && !g.problems.length && slots > 0) {
      g.included = true;
      slots--;
    }
  }

  const space = folderSpace(root);
  const romFolders = ROM_FOLDERS.map((f) => f.rel);
  return {
    root,
    romFolders,
    missingRomFolder: ROM_FOLDERS.every((f) => !fs.existsSync(path.join(root, f.rel))),
    ...space,
    covers: coversInfo(root),
    games,
    maxGames: MAX_GAMES,
    databases: { dats: dats.sources, thumbs: thumbs.sources },
  };
}

export { TITLE_MAX };
