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
  /** new: not on the card. changed: the app's file at that name is a different ROM. missing: the manifest lists it but the file is gone. */
  reason: 'new' | 'changed' | 'missing';
  from: string;
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
  /** Games already on the card as they should be. */
  unchanged: number;
  /** Games whose ROM was already on the card, put there by hand. Left alone and not claimed. */
  shared: string[];
  /** ROM files on the card the app did not place and the library does not have. Never touched. */
  cardOnly: string[];
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
    /** The core shows only this many for now. */
    limit: number | null;
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

  const copy: PlanCopy[] = [];
  const shared: string[] = [];
  let unchanged = 0;
  const keepNames = new Set<string>();
  for (const g of library.games) {
    const lower = g.file.toLowerCase();
    keepNames.add(lower);
    const onCard = cardFiles.get(lower);
    const entry = placedByName.get(lower);
    const item = { crc: g.crc, file: g.file, size: g.size, title: g.title, from: g.sourcePath };
    if (!onCard) {
      copy.push({ ...item, reason: entry ? 'missing' : 'new' });
      continue;
    }
    const abs = path.join(romDir, onCard);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      copy.push({ ...item, reason: 'new' });
      continue;
    }
    if (entry) {
      // Trust the manifest when the size matches. Rereading every ROM on the card would make a resync slow.
      if (entry.crc === g.crc && st.size === g.size) unchanged++;
      else copy.push({ ...item, reason: 'changed' });
    } else {
      // Put there by hand. Card names are chosen so this is the same ROM; check anyway.
      if (fileCrc(abs, st) === g.crc) {
        unchanged++;
        shared.push(onCard);
      } else {
        throw new Error(`${onCard} on the card is a different ROM that the app did not place. It was left alone. Rename it or remove it, then plan again.`);
      }
    }
  }

  const remove: PlanRemove[] = [];
  let stale = 0;
  for (const e of placed) {
    if (keepNames.has(e.file.toLowerCase())) continue;
    if (cardFiles.has(e.file.toLowerCase())) remove.push({ crc: e.crc, file: cardFiles.get(e.file.toLowerCase())!, size: e.size });
    else stale++;
  }

  const cardOnly = [...cardFiles.values()].filter((f) => !keepNames.has(f.toLowerCase()) && !placedByName.has(f.toLowerCase())).sort();

  const writer = packWriter();
  const ordered = menuOrder(library.games, playHistory(card));
  const packable = ordered.filter((g) => !g.problems.length);
  const packGames = writer.maxGames == null ? packable : packable.slice(0, writer.maxGames);
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
    unchanged,
    shared,
    cardOnly,
    stale,
    copyBytes,
    removeBytes,
    totalGames: library.games.length,
    totalRomBytes: library.games.reduce((n, g) => n + g.size, 0),
    pack: {
      version: writer.version,
      file: COVERS_REL.split(path.sep).join('/'),
      bytes: packBytes,
      count: packGames.length,
      limit: writer.maxGames,
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
        packGames.map((g) => [g.crc, g.title, g.file, g.art]),
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  return { plan, library, packGames, manifestPlaced: placed };
}
