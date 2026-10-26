/**
 * A port of the Pillow 11.3 operations that tools/make_cover_pack.py uses to fit
 * cover art. The goal is byte-identical output, so each function follows the C
 * code in Pillow's libImaging (Resample.c, Reduce.c, BoxBlur.c, Filter.c,
 * Blend.c) step by step, including its integer and single precision float math.
 *
 * Images are 8 bit RGB, row-major, 3 bytes per pixel.
 */

export interface RGBImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const f32 = Math.fround;

export function newImage(width: number, height: number): RGBImage {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

function copyImage(im: RGBImage): RGBImage {
  return { width: im.width, height: im.height, data: new Uint8Array(im.data) };
}

/** Image.crop with integer coordinates inside the image. */
export function crop(im: RGBImage, x0: number, y0: number, x1: number, y1: number): RGBImage {
  const out = newImage(x1 - x0, y1 - y0);
  for (let y = 0; y < out.height; y++) {
    const src = ((y + y0) * im.width + x0) * 3;
    out.data.set(im.data.subarray(src, src + out.width * 3), y * out.width * 3);
  }
  return out;
}

/** Image.paste of a whole image at (dx, dy), clipped to the target. */
export function paste(dst: RGBImage, src: RGBImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 3;
      const d = (ty * dst.width + tx) * 3;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
    }
  }
}

// ---------------------------------------------------------------------------
// Resample.c (LANCZOS only)

const LANCZOS_SUPPORT = 3.0;
const PRECISION_BITS = 32 - 8 - 2;

function sinc(x: number): number {
  if (x === 0.0) return 1.0;
  x = x * Math.PI;
  return Math.sin(x) / x;
}

function lanczos(x: number): number {
  if (-3.0 <= x && x < 3.0) return sinc(x) * sinc(x / 3);
  return 0.0;
}

function clip8(v: number): number {
  const i = v >> PRECISION_BITS;
  return i < 0 ? 0 : i > 255 ? 255 : i;
}

interface Coeffs {
  ksize: number;
  bounds: Int32Array;
  kk: Int32Array;
}

function precomputeCoeffs(inSize: number, in0: number, in1: number, outSize: number): Coeffs {
  const scale = f32(in1 - in0) / outSize;
  let filterscale = scale;
  if (filterscale < 1.0) filterscale = 1.0;
  const support = LANCZOS_SUPPORT * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const pre = new Float64Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale;
    let ww = 0.0;
    const ss = 1.0 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const base = xx * ksize;
    for (let x = 0; x < xmax; x++) {
      const w = lanczos((x + xmin - center + 0.5) * ss);
      pre[base + x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      if (ww !== 0.0) pre[base + x] /= ww;
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  // normalize_coeffs_8bpc
  const kk = new Int32Array(outSize * ksize);
  for (let i = 0; i < kk.length; i++) {
    const v = pre[i];
    kk[i] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
  }
  return { ksize, bounds, kk };
}

function resampleHorizontal(im: RGBImage, outW: number, offset: number, outH: number, c: Coeffs): RGBImage {
  const out = newImage(outW, outH);
  const src = im.data;
  const dst = out.data;
  for (let yy = 0; yy < outH; yy++) {
    const row = (yy + offset) * im.width * 3;
    for (let xx = 0; xx < outW; xx++) {
      const xmin = c.bounds[xx * 2];
      const xmax = c.bounds[xx * 2 + 1];
      const kb = xx * c.ksize;
      let s0 = 1 << (PRECISION_BITS - 1);
      let s1 = s0;
      let s2 = s0;
      for (let x = 0; x < xmax; x++) {
        const k = c.kk[kb + x];
        const p = row + (x + xmin) * 3;
        s0 += src[p] * k;
        s1 += src[p + 1] * k;
        s2 += src[p + 2] * k;
      }
      const d = (yy * outW + xx) * 3;
      dst[d] = clip8(s0);
      dst[d + 1] = clip8(s1);
      dst[d + 2] = clip8(s2);
    }
  }
  return out;
}

function resampleVertical(im: RGBImage, outH: number, c: Coeffs): RGBImage {
  const w = im.width;
  const out = newImage(w, outH);
  const src = im.data;
  const dst = out.data;
  for (let yy = 0; yy < outH; yy++) {
    const ymin = c.bounds[yy * 2];
    const ymax = c.bounds[yy * 2 + 1];
    const kb = yy * c.ksize;
    for (let xx = 0; xx < w; xx++) {
      let s0 = 1 << (PRECISION_BITS - 1);
      let s1 = s0;
      let s2 = s0;
      for (let y = 0; y < ymax; y++) {
        const k = c.kk[kb + y];
        const p = ((y + ymin) * w + xx) * 3;
        s0 += src[p] * k;
        s1 += src[p + 1] * k;
        s2 += src[p + 2] * k;
      }
      const d = (yy * w + xx) * 3;
      dst[d] = clip8(s0);
      dst[d + 1] = clip8(s1);
      dst[d + 2] = clip8(s2);
    }
  }
  return out;
}

/** ImagingResampleInner with the LANCZOS filter. `box` holds C floats. */
function resampleInner(im: RGBImage, xsize: number, ysize: number, box: number[]): RGBImage {
  const needH = xsize !== im.width || box[0] !== 0 || box[2] !== xsize;
  const needV = ysize !== im.height || box[1] !== 0 || box[3] !== ysize;
  const ch = precomputeCoeffs(im.width, box[0], box[2], xsize);
  const cv = precomputeCoeffs(im.height, box[1], box[3], ysize);
  const yFirst = cv.bounds[0];
  const yLast = cv.bounds[ysize * 2 - 2] + cv.bounds[ysize * 2 - 1];
  let cur = im;
  let out: RGBImage | null = null;
  if (needH) {
    for (let i = 0; i < ysize; i++) cv.bounds[i * 2] -= yFirst;
    cur = out = resampleHorizontal(im, xsize, yFirst, yLast - yFirst, ch);
  }
  if (needV) out = resampleVertical(cur, ysize, cv);
  return out ?? copyImage(cur);
}

/** The C entry point `_resize` for a non NEAREST filter. */
function coreResize(im: RGBImage, xsize: number, ysize: number, boxIn: number[]): RGBImage {
  const box = boxIn.map(f32);
  if (
    box[0] - Math.trunc(box[0]) === 0 &&
    box[2] - box[0] === xsize &&
    box[1] - Math.trunc(box[1]) === 0 &&
    box[3] - box[1] === ysize
  ) {
    return crop(im, Math.trunc(box[0]), Math.trunc(box[1]), Math.trunc(box[2]), Math.trunc(box[3]));
  }
  return resampleInner(im, xsize, ysize, box);
}

// ---------------------------------------------------------------------------
// Reduce.c

function divisionUint32(divider: number, resultBits: number): number {
  const maxDividend = (1 << resultBits) * divider;
  const maxInt = f32(2 ** 32);
  return Math.trunc(f32(maxInt / f32(maxDividend)));
}

/** Image.reduce(factor, box) for an RGB image. box is (x0, y0, x1, y1) ints. */
export function reduce(im: RGBImage, xscale: number, yscale: number, b: number[]): RGBImage {
  if (xscale === 1 && yscale === 1) return crop(im, b[0], b[1], b[2], b[3]);
  const box = [b[0], b[1], b[2] - b[0], b[3] - b[1]];
  const outW = Math.trunc((box[2] + xscale - 1) / xscale);
  const outH = Math.trunc((box[3] + yscale - 1) / yscale);
  const out = newImage(outW, outH);
  const src = im.data;
  const W = im.width;

  // Pillow has shift based fast paths for these factors; the rest use a
  // fixed point multiplier, which can round differently.
  const key = `${xscale}x${yscale}`;
  const shift = key === '1x2' || key === '2x1' ? 1 : key === '2x2' ? 2 : key === '4x4' ? 4 : 0;
  const n = xscale * yscale;
  const amend = Math.trunc(n / 2);
  const mult = divisionUint32(n, 8);

  const fullW = Math.trunc(box[2] / xscale);
  const fullH = Math.trunc(box[3] / yscale);
  const sum = [0, 0, 0];
  for (let y = 0; y < fullH; y++) {
    const yy0 = box[1] + y * yscale;
    for (let x = 0; x < fullW; x++) {
      const xx0 = box[0] + x * xscale;
      sum[0] = sum[1] = sum[2] = 0;
      for (let yy = yy0; yy < yy0 + yscale; yy++) {
        let p = (yy * W + xx0) * 3;
        for (let xx = 0; xx < xscale; xx++, p += 3) {
          sum[0] += src[p];
          sum[1] += src[p + 1];
          sum[2] += src[p + 2];
        }
      }
      const d = (y * outW + x) * 3;
      for (let c = 0; c < 3; c++) {
        out.data[d + c] = shift ? (sum[c] + amend) >>> shift : (((sum[c] + amend) * mult) / 16777216) & 0xff;
      }
    }
  }

  // ImagingReduceCorners: the last column and row cover a partial block.
  const corner = (x: number, y: number, xs0: number, xs1: number, ys0: number, ys1: number) => {
    const scale = (xs1 - xs0) * (ys1 - ys0);
    const m = divisionUint32(scale, 8);
    const a = Math.trunc(scale / 2);
    const s = [a, a, a];
    for (let yy = ys0; yy < ys1; yy++) {
      for (let xx = xs0; xx < xs1; xx++) {
        const p = (yy * W + xx) * 3;
        s[0] += src[p];
        s[1] += src[p + 1];
        s[2] += src[p + 2];
      }
    }
    const d = (y * outW + x) * 3;
    for (let c = 0; c < 3; c++) out.data[d + c] = Math.floor((s[c] * m) / 16777216) & 0xff;
  };
  if (box[2] % xscale) {
    const x = fullW;
    for (let y = 0; y < fullH; y++) {
      const yy0 = box[1] + y * yscale;
      corner(x, y, box[0] + x * xscale, box[0] + box[2], yy0, yy0 + yscale);
    }
  }
  if (box[3] % yscale) {
    const y = fullH;
    for (let x = 0; x < fullW; x++) {
      const xx0 = box[0] + x * xscale;
      corner(x, y, xx0, xx0 + xscale, box[1] + y * yscale, box[1] + box[3]);
    }
  }
  if (box[2] % xscale && box[3] % yscale) {
    corner(fullW, fullH, box[0] + fullW * xscale, box[0] + box[2], box[1] + fullH * yscale, box[1] + box[3]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image.resize / Image.thumbnail (Python side)

function pyInt(v: number): number {
  return Math.trunc(v);
}

function getSafeBox(im: RGBImage, size: [number, number], box: number[]): number[] {
  const filterSupport = LANCZOS_SUPPORT - 0.5;
  const scaleX = (box[2] - box[0]) / size[0];
  const scaleY = (box[3] - box[1]) / size[1];
  const supportX = filterSupport * scaleX;
  const supportY = filterSupport * scaleY;
  return [
    Math.max(0, pyInt(box[0] - supportX)),
    Math.max(0, pyInt(box[1] - supportY)),
    Math.min(im.width, Math.ceil(box[2] + supportX)),
    Math.min(im.height, Math.ceil(box[3] + supportY)),
  ];
}

/** Image.resize(size, LANCZOS, box=None, reducing_gap) for an RGB image. */
export function resize(im: RGBImage, size: [number, number], reducingGap: number | null = null): RGBImage {
  let box = [0, 0, im.width, im.height];
  if (im.width === size[0] && im.height === size[1]) return copyImage(im);
  let self = im;
  if (reducingGap !== null) {
    const fx = pyInt((box[2] - box[0]) / size[0] / reducingGap) || 1;
    const fy = pyInt((box[3] - box[1]) / size[1] / reducingGap) || 1;
    if (fx > 1 || fy > 1) {
      const rb = getSafeBox(self, size, box);
      self = reduce(self, fx, fy, rb);
      box = [(box[0] - rb[0]) / fx, (box[1] - rb[1]) / fy, (box[2] - rb[0]) / fx, (box[3] - rb[1]) / fy];
    }
  }
  return coreResize(self, size[0], size[1], box);
}

/** Image.thumbnail((size, size), LANCZOS) with the default reducing_gap of 2.0. */
export function thumbnail(im: RGBImage, w: number, h: number): RGBImage {
  let x = Math.floor(w);
  let y = Math.floor(h);
  if (x >= im.width && y >= im.height) return im;
  const aspect = im.width / im.height;
  const roundAspect = (num: number, key: (n: number) => number) => {
    const a = Math.floor(num);
    const b = Math.ceil(num);
    return Math.max(key(b) < key(a) ? b : a, 1);
  };
  if (x / y >= aspect) {
    x = roundAspect(y * aspect, (n) => Math.abs(aspect - n / y));
  } else {
    y = roundAspect(x / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - x / n)));
  }
  if (im.width === x && im.height === y) return im;
  return resize(im, [x, y], 2.0);
}

// ---------------------------------------------------------------------------
// BoxBlur.c (GaussianBlur)

function gaussianBlurRadius(radius: number, passes: number): number {
  const sigma2 = f32(f32(radius * radius) / passes);
  const L = f32(Math.sqrt(12.0 * sigma2 + 1.0));
  const l = f32(Math.floor((L - 1.0) / 2.0));
  let a = f32(f32(f32(2 * l) + 1) * f32(f32(l * f32(l + 1)) - f32(3 * sigma2)));
  const lp1 = f32(l + 1);
  a = f32(a / f32(6 * f32(sigma2 - f32(lp1 * lp1))));
  return f32(l + a);
}

/** One ImagingLineBoxBlur32 pass over `n` pixels read with a stride. */
function lineBoxBlur(
  buf: Uint8Array,
  start: number,
  stride: number,
  n: number,
  tmpIn: Uint8Array,
  radius: number,
  edgeA: number,
  edgeB: number,
  ww: number,
  fw: number,
): void {
  // Copy the line out first; the blur writes back in place.
  for (let i = 0, p = start; i < n; i++, p += stride) {
    tmpIn[i * 3] = buf[p];
    tmpIn[i * 3 + 1] = buf[p + 1];
    tmpIn[i * 3 + 2] = buf[p + 2];
  }
  const lastx = n - 1;
  const L = tmpIn;
  for (let c = 0; c < 3; c++) {
    const px = (i: number) => L[i * 3 + c];
    let acc = px(0) * (radius + 1);
    for (let x = 0; x < edgeA - 1; x++) acc += px(x);
    acc += px(lastx) * (radius - edgeA + 1);
    const save = (x: number, bulk: number) => {
      buf[start + x * stride + c] = Math.floor((bulk + 8388608) / 16777216) & 0xff;
    };
    if (edgeA <= edgeB) {
      for (let x = 0; x < edgeA; x++) {
        acc += px(x + radius) - px(0);
        save(x, acc * ww + (px(0) + px(x + radius + 1)) * fw);
      }
      for (let x = edgeA; x < edgeB; x++) {
        acc += px(x + radius) - px(x - radius - 1);
        save(x, acc * ww + (px(x - radius - 1) + px(x + radius + 1)) * fw);
      }
      for (let x = edgeB; x <= lastx; x++) {
        acc += px(lastx) - px(x - radius - 1);
        save(x, acc * ww + (px(x - radius - 1) + px(lastx)) * fw);
      }
    } else {
      for (let x = 0; x < edgeB; x++) {
        acc += px(x + radius) - px(0);
        save(x, acc * ww + (px(0) + px(x + radius + 1)) * fw);
      }
      for (let x = edgeB; x < edgeA; x++) {
        acc += px(lastx) - px(0);
        save(x, acc * ww + (px(0) + px(lastx)) * fw);
      }
      for (let x = edgeA; x <= lastx; x++) {
        acc += px(lastx) - px(x - radius - 1);
        save(x, acc * ww + (px(x - radius - 1) + px(lastx)) * fw);
      }
    }
  }
}

function boxBlurParams(floatRadius: number, size: number) {
  const radius = Math.trunc(floatRadius);
  const ww = Math.trunc(f32(16777216 / f32(f32(floatRadius * 2) + 1)));
  const fw = Math.floor((16777216 - (radius * 2 + 1) * ww) / 2);
  const edgeA = Math.min(radius + 1, size);
  const edgeB = Math.max(size - radius - 1, 0);
  return { radius, ww, fw, edgeA, edgeB };
}

/** ImageFilter.GaussianBlur(radius): three extended box blur passes per axis. */
export function gaussianBlur(im: RGBImage, radiusIn: number): RGBImage {
  const r = f32(radiusIn);
  const out = copyImage(im);
  if (r === 0) return out;
  const br = gaussianBlurRadius(r, 3);
  const { width: W, height: H } = out;
  const tmp = new Uint8Array(Math.max(W, H) * 3);
  if (br !== 0) {
    const p = boxBlurParams(br, W);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < H; y++) lineBoxBlur(out.data, y * W * 3, 3, W, tmp, p.radius, p.edgeA, p.edgeB, p.ww, p.fw);
    }
    const q = boxBlurParams(br, H);
    for (let pass = 0; pass < 3; pass++) {
      for (let x = 0; x < W; x++) lineBoxBlur(out.data, x * 3, W * 3, H, tmp, q.radius, q.edgeA, q.edgeB, q.ww, q.fw);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filter.c (ImageFilter.SMOOTH) and Blend.c (ImageEnhance)

const SMOOTH_KERNEL = [1, 1, 1, 1, 5, 1, 1, 1, 1].map((v) => f32(f32(v) / f32(13)));

/** im.filter(ImageFilter.SMOOTH): 3x3 kernel, border pixels copied. */
export function smooth(im: RGBImage): RGBImage {
  const { width: W, height: H } = im;
  if (W < 3 || H < 3) return copyImage(im);
  const out = copyImage(im);
  const s = im.data;
  const k = SMOOTH_KERNEL;
  const offset = f32(0 + 0.5);
  const k1x3 = (row: number, x: number, c: number, k0: number) => {
    const a = f32(s[(row * W + x - 1) * 3 + c] * k[k0]);
    const b = f32(s[(row * W + x) * 3 + c] * k[k0 + 1]);
    const d = f32(s[(row * W + x + 1) * 3 + c] * k[k0 + 2]);
    return f32(f32(a + b) + d);
  };
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let ss = offset;
        ss = f32(ss + k1x3(y + 1, x, c, 0));
        ss = f32(ss + k1x3(y, x, c, 3));
        ss = f32(ss + k1x3(y - 1, x, c, 6));
        out.data[(y * W + x) * 3 + c] = ss <= 0 ? 0 : ss >= 255 ? 255 : Math.trunc(ss);
      }
    }
  }
  return out;
}

/** Image.blend(a, b, alpha), which ImageEnhance uses. */
export function blend(a: RGBImage, b: RGBImage, alphaIn: number): RGBImage {
  const alpha = f32(alphaIn);
  if (alpha === 0) return copyImage(a);
  if (alpha === 1) return copyImage(b);
  const out = newImage(a.width, a.height);
  const A = a.data;
  const B = b.data;
  const O = out.data;
  if (alpha >= 0 && alpha <= 1) {
    for (let i = 0; i < O.length; i++) O[i] = Math.trunc(f32(A[i] + f32(alpha * (B[i] - A[i]))));
  } else {
    for (let i = 0; i < O.length; i++) {
      const t = f32(A[i] + f32(alpha * (B[i] - A[i])));
      O[i] = t <= 0 ? 0 : t >= 255 ? 255 : Math.trunc(t);
    }
  }
  return out;
}

/** ImageEnhance.Brightness(im).enhance(factor). */
export function brightness(im: RGBImage, factor: number): RGBImage {
  return blend(newImage(im.width, im.height), im, factor);
}

/** ImageEnhance.Sharpness(im).enhance(factor). */
export function sharpness(im: RGBImage, factor: number): RGBImage {
  return blend(smooth(im), im, factor);
}

/** Python's round(): halves go to the even neighbour. */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * fit() from make_cover_pack.py: contain the art in a size x size square, on a
 * blurred and darkened "cover" fill of itself.
 */
export function fit(img: RGBImage, size: number): RGBImage {
  const s = Math.max(size / img.width, size / img.height);
  let bg = resize(img, [Math.max(1, pyRound(img.width * s)), Math.max(1, pyRound(img.height * s))]);
  const cx = Math.floor((bg.width - size) / 2);
  const cy = Math.floor((bg.height - size) / 2);
  bg = crop(bg, cx, cy, cx + size, cy + size);
  bg = brightness(gaussianBlur(bg, size / 10), 0.45);
  let fg = thumbnail(img, size, size);
  fg = sharpness(fg, 1.4);
  paste(bg, fg, Math.floor((size - fg.width) / 2), Math.floor((size - fg.height) / 2));
  return bg;
}

/** RGB888 to RGB565 words, little-endian, row-major. */
export function toRgb565(im: RGBImage): Buffer {
  const out = Buffer.alloc(im.width * im.height * 2);
  const d = im.data;
  for (let i = 0, o = 0; i < d.length; i += 3, o += 2) {
    out.writeUInt16LE(((d[i] >> 3) << 11) | ((d[i + 1] >> 2) << 5) | (d[i + 2] >> 3), o);
  }
  return out;
}

/** What the Pocket shows: RGB565 expanded back to RGB888 for a preview. */
export function quantizePreview(im: RGBImage): RGBImage {
  const out = newImage(im.width, im.height);
  const d = im.data;
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i] >> 3;
    const g = d[i + 1] >> 2;
    const b = d[i + 2] >> 3;
    out.data[i] = (r << 3) | (r >> 2);
    out.data[i + 1] = (g << 2) | (g >> 4);
    out.data[i + 2] = (b << 3) | (b >> 2);
  }
  return out;
}
