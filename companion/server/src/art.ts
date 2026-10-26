/** Loading cover art from any source, and rendering fitted previews. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CUSTOM_ART_DIR } from './config.js';
import type { ArtRef } from './choices.js';
import { decodeImage, encodePng, placeholderImage } from './image.js';
import { fit, quantizePreview, type RGBImage } from './pillow.js';
import { getBoxart } from './thumbs.js';

export async function loadArt(ref: ArtRef | null, title: string): Promise<RGBImage> {
  if (!ref || ref.kind === 'placeholder') return placeholderImage(title);
  if (ref.kind === 'thumb') return decodeImage(await getBoxart(ref.repo, ref.name));
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

const previewCache = new Map<string, Buffer>();
const PREVIEW_CACHE_MAX = 400;

/** PNG of the art fitted to size x size, in the colors the Pocket will show. */
export async function fittedPreview(ref: ArtRef | null, title: string, size: number): Promise<Buffer> {
  const key = JSON.stringify([ref, !ref || ref.kind === 'placeholder' ? title : '', size]);
  const hit = previewCache.get(key);
  if (hit) return hit;
  const png = encodePng(quantizePreview(fit(await loadArt(ref, title), size)));
  previewCache.set(key, png);
  if (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!);
  return png;
}
