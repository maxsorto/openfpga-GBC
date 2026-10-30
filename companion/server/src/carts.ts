/**
 * Cartridges the Pocket did not recognize.
 *
 * When a cart does not match the pack, the core shows the default cartridge art with
 * the cart's header title and appends its header to /Saves/gbc/common/carts.cfg, a
 * 4096 byte file, little-endian:
 *
 *   0   "CRL1"
 *   4   u16 version = 1
 *   6   u16 n, records used (up to 127)
 *   8   8 zero bytes
 *   16  n records of 32 bytes: the cart's ROM header bytes 0x134 to 0x14F (28 bytes), 4 zero bytes
 *
 * The same cart can be there more than once (once per session it was seen in). Sync
 * saves the carts in the app (carts.json in the data folder), identifies each one, and
 * puts the identified ones in the pack as cartridge-only entries, so next time the cart
 * shows its real cover. Then it writes carts.cfg back empty.
 *
 * A cart's id is the CRC32 of its 28 header bytes. Its chosen cover and title are kept
 * in the choices store under that id, so the cover picker works for carts as for games.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PACK_PLATFORM } from './config.js';
import type { DatGame, DatIndex } from './dat.js';
import { cleanTitle, nameKey } from './match.js';
import { crc32 } from './roms.js';

export const CARTS_FILE_BYTES = 4096;
const HEAD = 16;
const RECORD = 32;
export const CART_HEADER_BYTES = 28; // 0x134 to 0x14F
export const CARTS_MAX_RECORDS = 127;

/* ---------- carts.cfg ---------- */

export function cartsPath(card: string): string {
  return path.join(path.resolve(card), 'Saves', PACK_PLATFORM, 'common', 'carts.cfg');
}

/**
 * A header read through bad contacts, not a real cart: a byte of the title area
 * (0x134 to 0x142) has bit 7 set. Real titles are plain ASCII. With shorted D6 and D7
 * lines, bit 7 copies bit 6, and the header checksum can still come out right.
 */
export function isMisread(header: Buffer): boolean {
  for (let i = 0; i < 0x143 - 0x134; i++) if (header[i] & 0x80) return true;
  return false;
}

/**
 * The records in a carts.cfg, deduped on the 28 header bytes (first seen first), with
 * misreads left out (counted in `misreads`). Null if malformed.
 */
export function parseCartsCfg(buf: Buffer): { records: Buffer[]; n: number; misreads: number } | null {
  // The core makes the file as zeros before it first writes to it: no carts yet.
  if (buf.length > 0 && buf.every((b) => b === 0)) return { records: [], n: 0, misreads: 0 };
  if (buf.length < HEAD || buf.toString('latin1', 0, 4) !== 'CRL1') return null;
  if (buf.readUInt16LE(4) !== 1) return null;
  const n = buf.readUInt16LE(6);
  if (n > CARTS_MAX_RECORDS || HEAD + n * RECORD > buf.length) return null;
  const seen = new Set<string>();
  const records: Buffer[] = [];
  let misreads = 0;
  for (let i = 0; i < n; i++) {
    const h = Buffer.from(buf.subarray(HEAD + i * RECORD, HEAD + i * RECORD + CART_HEADER_BYTES));
    const key = h.toString('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    if (isMisread(h)) misreads++;
    else records.push(h);
  }
  return { records, n, misreads };
}

export interface CartsCfg {
  /** Path relative to the card root. */
  file: string;
  records: Buffer[];
  /** Records in the file, before duplicates and misreads are dropped. */
  n: number;
  /** Different records that were misreads (see isMisread), left out. */
  misreads: number;
  /** Hash of the file as read, so sync only empties it if it did not change since the plan. */
  sha: string;
}

export function readCartsCfg(card: string): CartsCfg | null {
  const file = cartsPath(card);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length > 64 * 1024) return null;
  const parsed = parseCartsCfg(buf);
  if (!parsed) return null;
  return {
    ...parsed,
    file: path.relative(path.resolve(card), file).split(path.sep).join('/'),
    sha: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/** The file as the core expects it with nothing in it: magic, version 1, n = 0, zeros. */
export function emptyCartsCfg(): Buffer {
  const b = Buffer.alloc(CARTS_FILE_BYTES);
  b.write('CRL1', 0, 'latin1');
  b.writeUInt16LE(1, 4);
  return b;
}

/** Build a file from headers, for tests. */
export function cartsCfgFile(headers: Buffer[]): Buffer {
  const b = emptyCartsCfg();
  b.writeUInt16LE(headers.length, 6);
  headers.forEach((h, i) => h.copy(b, HEAD + i * RECORD, 0, CART_HEADER_BYTES));
  return b;
}

/* ---------- One cart's header ---------- */

export interface CartHeader {
  id: string;
  /** The title as the cart stores it, for example "PM_CRYSTAL". 11 bytes when the cart seems to have a game code. */
  title: string;
  /**
   * The title read as if there were no game code (15 bytes on color carts, 16 on old
   * ones). A 15 letter title like "THERUGRATSMOVIE" ends in 4 letters that look like a
   * code; when the DAT does not know that code, this is the real title.
   */
  longTitle: string;
  /** The 4 letter game code (0x13F to 0x142), when the cart has one. */
  code: string | null;
  /** Byte 0x143: 0xC0 GBC only, 0x80 works on both, anything else original Game Boy. */
  cgb: number;
  /** The FPR2 record Play Cartridge matches on (8 bytes). */
  fingerprint: Buffer;
}

export function cartId(header: Buffer): string {
  return crc32(header.subarray(0, CART_HEADER_BYTES));
}

/** Offsets in the 28 header bytes, which start at ROM byte 0x134. */
const at = (romOffset: number) => romOffset - 0x134;

export function decodeHeader(h: Buffer): CartHeader {
  if (h.length < CART_HEADER_BYTES) throw new Error('A cart header is 28 bytes');
  const cgb = h[at(0x143)];
  const codeBytes = h.subarray(at(0x13f), at(0x143)).toString('latin1');
  const code = cgb & 0x80 && /^[A-Z0-9]{4}$/.test(codeBytes) ? codeBytes : null;
  // The title is 11 bytes with a game code, 15 on other color carts, 16 on old carts.
  const read = (end: number) => {
    let t = '';
    for (const b of h.subarray(0, end)) {
      if (b === 0) break;
      t += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
    }
    return t.trim();
  };
  const longEnd = cgb & 0x80 ? at(0x143) : at(0x144);
  const title = read(code ? at(0x13f) : longEnd);
  const longTitle = read(longEnd);
  const fingerprint = Buffer.alloc(8);
  fingerprint[0] = h[at(0x14e)];
  fingerprint[1] = h[at(0x14f)];
  fingerprint[2] = h[at(0x14d)];
  fingerprint[3] = cgb;
  fingerprint.writeUInt32LE(parseInt(crc32(h.subarray(0, 11)), 16) >>> 0, 4);
  return { id: cartId(h), title, longTitle, code, cgb, fingerprint };
}

/* ---------- Identification ---------- */

export interface Identification {
  /** exact: the game code matched the DAT. guessed: the title matched a No-Intro name. */
  status: 'exact' | 'guessed';
  /** The No-Intro name. */
  name: string;
  system: 'gb' | 'gbc';
  /** The DAT's ROM CRC for that name, to find its art. */
  crc: string;
  score: number;
}

/** Which DAT a cart belongs to, from byte 0x143. */
export function cartSystems(cgb: number): ('gb' | 'gbc')[] {
  if (cgb === 0xc0) return ['gbc'];
  if (cgb === 0x80) return ['gbc', 'gb'];
  return ['gb'];
}

/** Header titles shorten words. These expand the common ones before matching. */
const ALIASES: Record<string, string> = { pm: 'pokemon', pkmn: 'pokemon' };

function headerTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => ALIASES[t] ?? t);
}

/** True when the letters of `short` appear in order in `long`, starting with the same letter. */
function abbreviates(short: string, long: string): boolean {
  if (!short || short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

/**
 * How well a header title fits a name, 0 to 1. Each header word finds its best name
 * word: the same word 1, a prefix 0.9, an abbreviation ("slv" for "silver") 0.6 to
 * 0.9. Longer header words count more. Name words left over lower the score a little.
 */
export function titleScore(header: string[], name: string[]): number {
  if (!header.length || !name.length) return 0;
  const used = new Set<number>();
  let got = 0;
  let total = 0;
  for (const h of header) {
    total += h.length;
    let best = 0;
    let bestAt = -1;
    name.forEach((n, j) => {
      if (used.has(j)) return;
      const m = h === n ? 1 : h.length >= 2 && n.startsWith(h) ? 0.9 : h.length >= 2 && abbreviates(h, n) ? 0.6 + (0.3 * h.length) / n.length : 0;
      if (m > best) {
        best = m;
        bestAt = j;
      }
    });
    if (bestAt >= 0) used.add(bestAt);
    got += best * h.length;
  }
  const nameChars = name.reduce((s, n) => s + n.length, 0);
  const usedChars = [...used].reduce((s, j) => s + name[j].length, 0);
  const byWord = (got / total) * (0.7 + (0.3 * usedChars) / nameChars);
  return Math.max(byWord, compactScore(header, name));
}

/**
 * Many headers drop the spaces: "THERUGRATSMOVIE", "SUPERMARIOLAND". Compare the title
 * without spaces with the name's words run together, with or without a leading "the".
 */
function compactScore(header: string[], name: string[]): number {
  const h = header.join('');
  if (h.length < 6) return 0;
  const n = name.join('');
  for (const full of [n, `the${n}`]) {
    if (h === full) return 1;
    // A title cut short by the header's length, or a name with an extra word after it.
    const [short, long] = h.length < full.length ? [h, full] : [full, h];
    if (long.startsWith(short) && short.length >= 0.7 * long.length) return 0.9 * (short.length / long.length) + 0.05;
  }
  return 0;
}

/** Small tie breakers between names of the same game. */
function preference(name: string): number {
  let p = 0;
  if (/\(USA/.test(name)) p += 0.03;
  else if (/\(World/.test(name)) p += 0.025;
  else if (/Europe/.test(name)) p += 0.015;
  if (/\((Beta|Proto|Demo|Sample|Kiosk|Pirate|Unl)\b/i.test(name)) p -= 0.04;
  if (/\(Rev /.test(name)) p -= 0.005;
  return p;
}

/** Below this a title match is not trusted, and the cart is left unidentified. */
export const CART_GUESS_THRESHOLD = 0.6;

export function identifyCart(h: CartHeader, dats: DatIndex): Identification | null {
  const systems = cartSystems(h.cgb);
  const games = [...dats.byCrc.values()].filter((g) => systems.includes(g.system));
  // (a) The game code, when the DAT has it.
  if (h.code) {
    const hits = games.filter((g) => g.serial === h.code);
    if (hits.length) {
      const best = hits.sort((a, b) => preference(b.name) - preference(a.name) || (a.name < b.name ? -1 : 1))[0];
      return { status: 'exact', name: best.name, system: best.system, crc: best.crc, score: 1 };
    }
  }
  // (b) The header title against the No-Intro names. A code the DAT does not know may
  // really be the end of the title, so the long reading is tried too.
  const readings = [...new Set([h.title, h.longTitle])].map(headerTokens).filter((t) => t.length);
  if (!readings.length) return null;
  let best: { g: DatGame; score: number } | null = null;
  const seen = new Set<string>();
  for (const g of games) {
    if (seen.has(g.name)) continue;
    seen.add(g.name);
    const nameTokens = nameKey(g.name).split(' ').filter(Boolean);
    const s = Math.max(...readings.map((t) => titleScore(t, nameTokens)));
    if (s <= 0) continue;
    const score = s + preference(g.name) + (g.system === systems[0] ? 0.01 : 0);
    if (!best || score > best.score || (score === best.score && g.name < best.g.name)) best = { g, score };
  }
  if (!best || best.score < CART_GUESS_THRESHOLD) return null;
  return { status: 'guessed', name: best.g.name, system: best.g.system, crc: best.g.crc, score: Math.round(best.score * 1000) / 1000 };
}

/* ---------- Saved carts ---------- */

export interface SavedCart {
  id: string;
  /** The 28 header bytes, hex. */
  header: string;
  title: string;
  code: string | null;
  cgb: number;
  firstSeen: string;
  lastSeen: string;
  /** Syncs that found it in carts.cfg. */
  timesSeen: number;
  /** What the app found it to be, or null if nothing fit. Worked out again while it is null. */
  identified: Identification | null;
}

interface CartsState {
  version: 1;
  carts: SavedCart[];
}

const STATE_FILE = () => path.join(DATA_DIR, 'carts.json');

export function loadCarts(): SavedCart[] {
  let carts: SavedCart[];
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) as CartsState;
    carts = Array.isArray(j.carts) ? j.carts : [];
  } catch {
    return [];
  }
  // Misreads saved before they were recognized are dropped.
  const good = carts.filter((c) => !isMisread(Buffer.from(c.header, 'hex')));
  if (good.length !== carts.length) saveCarts(good);
  return good;
}

function saveCarts(carts: SavedCart[]): void {
  fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
  const tmp = `${STATE_FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, carts } satisfies CartsState, null, 2));
  fs.renameSync(tmp, STATE_FILE());
}

/** Save headers from carts.cfg in the app. Returns how many were new. */
export function mergeCarts(headers: Buffer[], dats: DatIndex, now = new Date()): { added: number; updated: number } {
  const carts = loadCarts();
  const byId = new Map(carts.map((c) => [c.id, c]));
  let added = 0;
  let updated = 0;
  const stamp = now.toISOString();
  for (const h of headers) {
    if (isMisread(h)) continue;
    const d = decodeHeader(h);
    const old = byId.get(d.id);
    if (old) {
      old.lastSeen = stamp;
      old.timesSeen += 1;
      if (!old.identified) old.identified = identifyCart(d, dats);
      updated++;
      continue;
    }
    const identified = identifyCart(d, dats);
    const c: SavedCart = {
      id: d.id,
      header: h.subarray(0, CART_HEADER_BYTES).toString('hex'),
      title: headerTitle(d, identified),
      code: codeConfirmed(d, identified) ? d.code : null,
      cgb: d.cgb,
      firstSeen: stamp,
      lastSeen: stamp,
      timesSeen: 1,
      identified,
    };
    carts.push(c);
    byId.set(c.id, c);
    added++;
  }
  saveCarts(carts);
  return { added, updated };
}

/** Saved carts, with carts not identified yet tried again (the game lists may be there now). */
export function savedCarts(dats: DatIndex): SavedCart[] {
  const carts = loadCarts();
  let changed = false;
  for (const c of carts) {
    if (c.identified) continue;
    const id = identifyCart(decodeHeader(Buffer.from(c.header, 'hex')), dats);
    if (id) {
      c.identified = id;
      changed = true;
    }
  }
  if (changed) saveCarts(carts);
  return carts;
}

/** Forget a cart. If the Pocket logs it again, it comes back. */
export function forgetCart(id: string): boolean {
  const carts = loadCarts();
  const left = carts.filter((c) => c.id !== id);
  if (left.length === carts.length) return false;
  saveCarts(left);
  return true;
}

/** The game code counts only when the DAT knew it; otherwise those 4 bytes are the end of the title. */
export function codeConfirmed(d: CartHeader, id: Identification | null): boolean {
  return !!d.code && id?.status === 'exact';
}

/** The header title to show: 11 bytes with a confirmed game code, the long reading otherwise. */
export function headerTitle(d: CartHeader, id: Identification | null): string {
  return codeConfirmed(d, id) ? d.title : d.longTitle;
}

/** The display title for an identified cart. */
export function cartDisplayTitle(c: { identified: Identification | null; title: string }): string {
  return c.identified ? cleanTitle(c.identified.name) : c.title;
}
