import { PNG } from 'pngjs';
import sharp from 'sharp';
import { newImage, type RGBImage } from './pillow.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 4).equals(PNG_MAGIC);
}

/**
 * Decode an image to 8 bit RGB, matching Pillow's Image.open(...).convert("RGB").
 *
 * PNG goes through pngjs, which like Pillow ignores color profiles and gamma,
 * and drops alpha without compositing. That keeps PNG art byte-exact with the
 * Python tool. Other formats (JPEG, WebP, GIF) go through sharp; JPEG decoders
 * can differ slightly, so those are close but not guaranteed to be identical.
 */
export async function decodeImage(buf: Buffer): Promise<RGBImage> {
  if (isPng(buf)) {
    const png = PNG.sync.read(buf);
    const im = newImage(png.width, png.height);
    const s = png.data;
    for (let i = 0, o = 0; i < s.length; i += 4, o += 3) {
      im.data[o] = s[i];
      im.data[o + 1] = s[i + 1];
      im.data[o + 2] = s[i + 2];
    }
    return im;
  }
  const { data, info } = await sharp(buf, { failOn: 'none' })
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Unexpected channel count ${info.channels}`);
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function encodePng(im: RGBImage): Buffer {
  const png = new PNG({ width: im.width, height: im.height });
  for (let i = 0, o = 0; i < im.data.length; i += 3, o += 4) {
    png.data[o] = im.data[i];
    png.data[o + 1] = im.data[i + 1];
    png.data[o + 2] = im.data[i + 2];
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Greedy word wrap using a rough average glyph width for bold sans text. */
function wrap(text: string, fontSize: number, maxWidth: number): string[] {
  const perLine = Math.max(4, Math.floor(maxWidth / (fontSize * 0.6)));
  const lines: string[] = [];
  for (const part of text.split(' - ')) {
    let line = '';
    for (const word of part.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [text];
}

/**
 * A 256x256 title card for games with no art, in the same colors as the Python
 * tool's placeholder(). The text is laid out by librsvg, so it is close to the
 * Python version but not byte-identical.
 */
export async function placeholderImage(title: string): Promise<RGBImage> {
  let fontSize = 34;
  let lines = wrap(title, fontSize, 230);
  while ((lines.length * fontSize * 1.15 > 230 || lines.some((l) => l.length * fontSize * 0.6 > 236)) && fontSize > 16) {
    fontSize -= 2;
    lines = wrap(title, fontSize, 230);
  }
  const lh = fontSize * 1.15;
  const top = 128 - ((lines.length - 1) * lh) / 2;
  const tspans = lines
    .map((l, i) => `<text x="128" y="${(top + i * lh).toFixed(1)}">${escapeXml(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
<rect width="256" height="256" fill="rgb(40,48,72)"/>
<g font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="${fontSize}" fill="rgb(235,235,245)" text-anchor="middle" dominant-baseline="central">${tspans}</g>
</svg>`;
  try {
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8Array(data) };
  } catch {
    const im = newImage(256, 256);
    for (let i = 0; i < im.data.length; i += 3) im.data.set([40, 48, 72], i);
    return im;
  }
}

/** Small JPEG thumbnail of any image, for the picker's candidate list. */
export async function smallJpeg(buf: Buffer, width: number): Promise<Buffer> {
  return sharp(buf, { failOn: 'none' })
    .resize({ width, withoutEnlargement: true })
    .flatten({ background: '#1c1d21' })
    .jpeg({ quality: 82 })
    .toBuffer();
}
