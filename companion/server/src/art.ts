/** Loading cover art from any source, fitted previews, and fetching art for a whole library. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BLOB_DIR, CUSTOM_ART_DIR, PREVIEW_DIR } from './config.js';
import type { ArtRef } from './choices.js';
import { decodeImage, encodePng, placeholderImage } from './image.js';
import type { Lane } from './limit.js';
import { fit, quantizePreview, type RGBImage } from './pillow.js';
import { BLOB_BYTES, artBlobAndAccent } from './pack-common.js';
import { getBoxart } from './thumbs.js';

export async function loadArt(ref: ArtRef | null, title: string, lane: Lane = 'high'): Promise<RGBImage> {
  if (!ref || ref.kind === 'placeholder') return placeholderImage(title);
  if (ref.kind === 'thumb') return decodeImage(await getBoxart(ref.repo, ref.name, lane));
  return decodeImage(fs.readFileSync(path.join(CUSTOM_ART_DIR, path.basename(ref.file))));
}

/** Store an image you dropped in. Returns its reference, or throws if it does not decode. */
export async function saveCustomArt(crc: string, buf: Buffer, contentType: string): Promise<ArtRef> {
  const img = await decodeImage(buf);
  if (img.width < 8 || img.height < 8) throw new Error('Image is too small');
  const ext = /png/.test(contentType) ? 'png' : /jpe?g/.test(contentType) ? 'jpg' : /webp/.test(contentType) ? 'webp' : /gif/.test(contentType) ? 'gif' : 'img';
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const file = `${crc}-${hash}.${ext}`;
  fs.mkdirSync(CUSTOM_ART_DIR, { recursive: true });
  fs.writeFileSync(path.join(CUSTOM_ART_DIR, file), buf);
  return { kind: 'custom', file };
}

// Bump when fit() or the title card changes, so old previews are not reused.
const PREVIEW_VERSION = 1;

function previewKey(ref: ArtRef | null, title: string, size: number): string {
  const card = !ref || ref.kind === 'placeholder';
  return JSON.stringify([PREVIEW_VERSION, card ? null : ref, card ? title : '', size]);
}

function previewFile(key: string): string {
  const h = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(PREVIEW_DIR, h.slice(0, 2), `${h}.png`);
}

export function previewCached(ref: ArtRef | null, title: string, size: number): boolean {
  return fs.existsSync(previewFile(previewKey(ref, title, size)));
}

const memory = new Map<string, Buffer>();
const MEMORY_MAX = 300;
const building = new Map<string, Promise<Buffer>>();

/**
 * PNG of the art fitted to size x size, in the colors the Pocket will show.
 * Kept in memory and on disk, so each one is built once.
 */
export async function fittedPreview(ref: ArtRef | null, title: string, size: number, lane: Lane = 'high'): Promise<Buffer> {
  const key = previewKey(ref, title, size);
  const hit = memory.get(key);
  if (hit) return hit;
  const file = previewFile(key);
  try {
    const png = fs.readFileSync(file);
    remember(key, png);
    return png;
  } catch {
    // not built yet
  }
  const running = building.get(key);
  if (running) return running;
  const p = (async () => {
    const png = encodePng(quantizePreview(fit(await loadArt(ref, title, lane), size)));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, file);
    } catch {
      // The disk cache only saves time.
    }
    remember(key, png);
    return png;
  })().finally(() => building.delete(key));
  building.set(key, p);
  return p;
}

function remember(key: string, png: Buffer): void {
  memory.set(key, png);
  if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value!);
}

/**
 * The art blob a pack stores for one game (128x128 then 80x80, RGB565), cached
 * on disk. Same key rules as the previews: art by reference, title cards by title.
 */
export async function packBlob(ref: ArtRef | null, title: string): Promise<Buffer> {
  return (await packArt(ref, title)).blob;
}

/**
 * The art blob and the cover's accent color (RGB565), cached together: the blob, then
 * the accent as 2 bytes. Older cache files (blob only) are built again.
 */
export async function packArt(ref: ArtRef | null, title: string): Promise<{ blob: Buffer; accent: number }> {
  const h = crypto.createHash('sha1').update(previewKey(ref, title, 0)).digest('hex');
  const file = path.join(BLOB_DIR, h.slice(0, 2), `${h}.bin`);
  try {
    const b = fs.readFileSync(file);
    if (b.length === BLOB_BYTES + 2) return { blob: b.subarray(0, BLOB_BYTES), accent: b.readUInt16LE(BLOB_BYTES) };
  } catch {
    // not built yet
  }
  const { blob, accent } = artBlobAndAccent(await loadArt(ref, title));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const tail = Buffer.alloc(2);
    tail.writeUInt16LE(accent, 0);
    fs.writeFileSync(tmp, Buffer.concat([blob, tail]));
    fs.renameSync(tmp, file);
  } catch {
    // The cache only saves time.
  }
  return { blob, accent };
}

/* ---------- Fetching art for the whole library in the background ---------- */

export interface ArtWarmItem {
  ref: ArtRef | null;
  title: string;
}

export interface ArtStatus {
  running: boolean;
  total: number;
  done: number;
  failed: number;
}

let status: ArtStatus = { running: false, total: 0, done: 0, failed: 0 };
let generation = 0;

export function artStatus(): ArtStatus {
  return { ...status };
}

/**
 * Download and fit the grid preview for every game, a few at a time. A new
 * call replaces the previous run. Work already on disk counts as done at once.
 */
export function warmArt(items: ArtWarmItem[], workers = 6): ArtStatus {
  const gen = ++generation;
  // Games that share art count once each in the progress, but are built once.
  const games = new Map<string, number>();
  const todo: ArtWarmItem[] = [];
  for (const it of items) {
    const key = previewKey(it.ref, it.title, 128);
    const n = games.get(key);
    if (n !== undefined) {
      games.set(key, n + 1);
      continue;
    }
    games.set(key, 1);
    if (!memory.has(key) && !previewCached(it.ref, it.title, 128)) todo.push(it);
  }
  // Items already built: count every game that uses them.
  let done = 0;
  const pending = new Set(todo.map((it) => previewKey(it.ref, it.title, 128)));
  for (const [key, n] of games) if (!pending.has(key)) done += n;
  status = { running: todo.length > 0, total: items.length, done, failed: 0 };
  if (!todo.length) return artStatus();
  let next = 0;
  const worker = async () => {
    while (gen === generation && next < todo.length) {
      const it = todo[next++];
      const n = games.get(previewKey(it.ref, it.title, 128)) ?? 1;
      try {
        await fittedPreview(it.ref, it.title, 128, 'low');
        if (gen === generation) status.done += n;
      } catch {
        if (gen === generation) status.failed += n;
      }
      // Let requests for covers on screen through between images.
      await new Promise((r) => setImmediate(r));
    }
  };
  void Promise.all(Array.from({ length: workers }, worker)).then(() => {
    if (gen === generation) status.running = false;
  });
  return artStatus();
}
