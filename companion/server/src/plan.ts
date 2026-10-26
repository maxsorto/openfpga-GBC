/**
 * The sync plan: what a sync would copy, remove and write, worked out before
 * anything on the card changes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { COVERS_REL } from './config.js';
import { buildLibrary, cardRomDir, listCardRoms, playHistory, type Game, type Library } from './library.js';
import { readManifest, type ManifestEntry } from './manifest.js';
import { menuOrder, packWriter } from './pack.js';
import { fileCrc } from './roms.js';
import { folderSpace } from './volumes.js';

export interface PlanCopy {
  crc: string;
  file: string;
  size: number;
  title: string;
  /**
   * new: not on the card. changed: the app's file at that name is a different ROM.
   * missing: the manifest lists it but the file is gone. replace: you chose the
   * library's copy over a different ROM you put on the card under this name.
   */
  reason: 'new' | 'changed' | 'missing' | 'replace';
  from: string;
  /** For replace: the CRC of the card's copy that is replaced. */
  replacesCrc?: string;
}

/** A ROM you put on the card by hand that is the same game as a library ROM. It joins the manifest under its current name. */
export interface PlanAdopt {
  crc: string;
  file: string;
  size: number;
  title: string;
}

/** A library game not placed because a different ROM with its name is on the card. */
export interface PlanKept {
  crc: string;
  title: string;
  /** The library file that is not copied. */
  libraryFile: string;
  /** The card's own file, which stays. */
  cardFile: string;
  cardCrc: string | null;
}

export interface PlanSave {
  /** File name in Saves/gbc/common. */
  file: string;
  /** The ROM on the card it belongs to after sync (same name before the extension), or null. */
  rom: string | null;
  /** ok: it has a ROM. loses: this sync removes its ROM. orphan: it had no ROM before either. */
  state: 'ok' | 'loses' | 'orphan';
}

export interface PlanRemove {
  crc: string;
  file: string;
  size: number;
}

export interface SyncPlan {
  card: string;
  romFolder: string;
  source: Library['source'];
  manifest: { exists: boolean; placed: number; error?: string; ignored: number };
  copy: PlanCopy[];
  remove: PlanRemove[];
  adopt: PlanAdopt[];
  keptCard: PlanKept[];
  /** Games already on the card as they should be. */
  unchanged: number;
  /** Battery saves in Saves/gbc/common and the ROM each belongs to after sync. Read only. */
  saves: PlanSave[];
  /** ROM files on the card the app did not place, adopt or replace. Never touched. */
  cardOnly: string[];
  /** Games in the Pocket menu, library and card only. */
  menuGames: number;
  /** Manifest entries whose file is already gone. They are dropped from the manifest. */
  stale: number;
  copyBytes: number;
  removeBytes: number;
  totalGames: number;
  totalRomBytes: number;
  pack: {
    version: number;
    file: string;
    bytes: number;
    count: number;
    /** Most games this pack holds: 31 for v6, 2047 for v7. */
    limit: number;
    /** The core on the card streams covers (v7). */
    streaming: boolean;
    /** Why this format: what core was found. */
    reason: string;
    titles: string[];
    crcs: string[];
    /** Left out of the pack because their path is too long for the core. */
    skipped: string[];
  };
  space: {
    freeBytes: number | null;
    /** What the card needs free before sync starts. */
    neededBytes: number;
    enough: boolean;
    /** Removing first frees enough room, so sync removes before it copies. */
    removeFirst: boolean;
  };
  /** Changes when anything in the plan changes. Sync refuses a plan that no longer matches. */
  signature: string;
}

export interface PlanOptions {
  library: string | null;
  card: string;
  /** Tests use this to pretend the card is nearly full. */
  freeBytesOverride?: number | null;
}

function roundUp(n: number, block: number): number {
  return Math.ceil(n / block) * block;
}

function clusterSize(card: string): number {
  try {
    const s = fs.statfsSync(card);
    return Math.max(512, s.bsize);
  } catch {
    return 32768;
  }
}

export interface PlanResult {
  plan: SyncPlan;
  library: Library;
  /** Games in pack order, cut to what the pack holds. */
  packGames: Game[];
  manifestPlaced: ManifestEntry[];
}

export async function makePlan(opts: PlanOptions): Promise<PlanResult> {
  const card = path.resolve(opts.card);
  const romDir = cardRomDir(card);
  if (!fs.existsSync(card)) throw new Error(`Card not found: ${card}`);
  const library = await buildLibrary({ library: opts.library, card });
  const m = readManifest(card);
  const placed = m.manifest.placed;
  const placedByName = new Map(placed.map((e) => [e.file.toLowerCase(), e]));
  const cardFiles = listCardRoms(card);
  const statOf = (f: string): fs.Stats | null => {
    try {
      return fs.statSync(path.join(romDir, f));
    } catch {
      return null;
    }
  };
  const sizeOf = (f: string) => statOf(f)?.size ?? null;
  const crcOf = (f: string): string | null => {
    const st = statOf(f);
    return st ? fileCrc(path.join(romDir, f), st) : null;
  };

  const fromFolder = library.source.kind === 'folder';
  const libraryGames = library.games.filter((g) => g.origin === 'library');
  if (fromFolder && libraryGames.length === 0 && placed.length > 0) {
    throw new Error('The library folder has no ROMs. Sync stops here so it does not remove every game it placed. Check the folder and try again.');
  }

  const copy: PlanCopy[] = [];
  const adopt: PlanAdopt[] = [];
  const keptCard: PlanKept[] = [];
  let unchanged = 0;
  const keepNames = new Set<string>();
  for (const g of libraryGames) {
    const item = { crc: g.crc, file: g.file, size: g.size, title: g.title, from: g.sourcePath };
    if (g.cardState === 'cardKept') {
      keptCard.push({ crc: g.crc, title: g.title, libraryFile: g.paths[0], cardFile: g.cardFile!, cardCrc: crcOf(g.cardFile!) });
      continue;
    }
    const lower = g.file.toLowerCase();
    keepNames.add(lower);
    if (g.cardState === 'adopt') {
      adopt.push({ crc: g.crc, file: g.file, size: sizeOf(g.file) ?? g.size, title: g.title });
      continue;
    }
    if (g.cardState === 'replace') {
      copy.push({ ...item, reason: 'replace', replacesCrc: crcOf(g.file) ?? undefined });
      continue;
    }
    const onCard = cardFiles.get(lower);
    const entry = placedByName.get(lower);
    if (!onCard) {
      copy.push({ ...item, reason: entry ? 'missing' : 'new' });
      continue;
    }
    const st = statOf(onCard);
    if (!st) {
      copy.push({ ...item, reason: 'new' });
    } else if (entry) {
      // Trust the manifest when the size matches. Rereading every ROM on the card would make a resync slow.
      if (entry.crc === g.crc && st.size === g.size) unchanged++;
      else copy.push({ ...item, reason: 'changed' });
    } else {
      // Card names are chosen so this can not happen; stop rather than overwrite a file the app did not place.
      throw new Error(`${onCard} on the card is a ROM the app did not place. It was left alone. Plan again.`);
    }
  }

  const remove: PlanRemove[] = [];
  let stale = 0;
  // Without a library folder nothing leaves the library, so nothing is removed.
  if (fromFolder) {
    for (const e of placed) {
      if (keepNames.has(e.file.toLowerCase())) continue;
      if (cardFiles.has(e.file.toLowerCase())) remove.push({ crc: e.crc, file: cardFiles.get(e.file.toLowerCase())!, size: e.size });
      else stale++;
    }
  }

  const cardOnly = [...cardFiles.values()]
    .filter((f) => !keepNames.has(f.toLowerCase()) && !(fromFolder && placedByName.has(f.toLowerCase())))
    .sort();

  // Saves: which ROM each one belongs to once sync is done. Nothing here is written.
  const stemOf = (f: string) => f.replace(/\.[^.]+$/, '').toLowerCase();
  const removed = new Set(remove.map((r) => r.file.toLowerCase()));
  const before = new Map<string, string>();
  for (const f of cardFiles.values()) before.set(stemOf(f), f);
  const after = new Map<string, string>();
  for (const f of cardFiles.values()) if (!removed.has(f.toLowerCase())) after.set(stemOf(f), f);
  for (const c of copy) after.set(stemOf(c.file), c.file);
  const saves: PlanSave[] = [];
  try {
    for (const f of fs.readdirSync(path.join(card, 'Saves', 'gbc', 'common')).sort()) {
      if (f.startsWith('.') || path.extname(f).toLowerCase() !== '.sav') continue;
      const rom = after.get(stemOf(f)) ?? null;
      saves.push({ file: f, rom, state: rom ? 'ok' : before.has(stemOf(f)) ? 'loses' : 'orphan' });
    }
  } catch {
    // no Saves folder yet
  }

  const writer = packWriter(library.pack.version);
  const menu = library.games.filter((g) => g.cardState !== 'cardKept');
  const ordered = menuOrder(menu, playHistory(card));
  const packable = ordered.filter((g) => !g.problems.length);
  const packGames = packable.slice(0, writer.maxGames);
  const packBytes = packGames.length ? writer.expectedSize(packGames.length) : 0;

  const block = clusterSize(card);
  const copyBytes = copy.reduce((n, c) => n + c.size, 0);
  const removeBytes = remove.reduce((n, r) => n + r.size, 0);
  // Every file is written beside its final name, then renamed, so the old copy
  // still takes room while the new one is written. Nothing is counted as freed.
  const neededBytes =
    copy.reduce((n, c) => n + roundUp(c.size, block), 0) + roundUp(packBytes, block) + 4 * block;
  const freeBytes = opts.freeBytesOverride !== undefined ? opts.freeBytesOverride : folderSpace(card).freeBytes;
  const freed = remove.reduce((n, r) => n + roundUp(r.size, block), 0);
  const enoughAsIs = freeBytes == null || neededBytes <= freeBytes;
  const removeFirst = !enoughAsIs && freeBytes != null && neededBytes <= freeBytes + freed;

  const plan: SyncPlan = {
    card,
    romFolder: path.relative(card, romDir).split(path.sep).join('/'),
    source: library.source,
    manifest: { exists: m.exists, placed: placed.length, error: m.error, ignored: m.ignored },
    copy,
    remove,
    adopt,
    keptCard,
    unchanged,
    saves,
    cardOnly,
    menuGames: menu.length,
    stale,
    copyBytes,
    removeBytes,
    totalGames: libraryGames.length,
    totalRomBytes: menu.reduce((n, g) => n + g.size, 0),
    pack: {
      version: writer.version,
      file: COVERS_REL.split(path.sep).join('/'),
      bytes: packBytes,
      count: packGames.length,
      limit: writer.maxGames,
      streaming: library.pack.streaming,
      reason: library.pack.reason,
      titles: packGames.map((g) => g.title),
      crcs: packGames.map((g) => g.crc),
      skipped: ordered.filter((g) => g.problems.length).map((g) => g.file),
    },
    space: { freeBytes, neededBytes, enough: enoughAsIs || removeFirst, removeFirst },
    signature: '',
  };
  plan.signature = crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        copy.map((c) => [c.crc, c.file, c.reason]),
        remove.map((r) => [r.crc, r.file]),
        adopt.map((a) => [a.crc, a.file]),
        keptCard.map((k) => [k.crc, k.cardFile]),
        writer.version,
        packGames.map((g) => [g.crc, g.title, g.file, g.art]),
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  return { plan, library, packGames, manifestPlaced: placed };
}
