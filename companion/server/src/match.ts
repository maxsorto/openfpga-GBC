/** Title cleanup and fuzzy name matching against the thumbnail list. */
import type { DatGame } from './dat.js';
import { REPOS, thumbName, type Thumb, type ThumbIndex } from './thumbs.js';

export type MatchStatus = 'exact' | 'guessed' | 'none';

export interface AutoMatch {
  status: MatchStatus;
  thumb: Thumb | null;
  score: number;
}

/** Strip accents: "Pokémon" becomes "Pokemon". */
export function foldAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * A display title from a No-Intro style name: tags like "(USA, Europe)" and
 * "[!]" removed, and "Legend of Zelda, The - ..." turned into "The Legend of Zelda - ...".
 */
export function cleanTitle(name: string): string {
  let t = foldAccents(name)
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = t.split(' - ');
  const m = parts[0].match(/^(.*), (The|A|An)$/i);
  if (m) parts[0] = `${m[2]} ${m[1]}`;
  t = parts.join(' - ');
  return t || name;
}

/** A comparison key: lower case words only, tags and leading "the" removed. */
export function nameKey(name: string): string {
  return cleanTitle(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

interface Prepared {
  key: string;
  tokens: Set<string>;
  /** Sum of token lengths. */
  len: number;
}

function prepare(key: string): Prepared {
  const tokens = new Set(key.split(' '));
  let len = 0;
  for (const t of tokens) len += t.length;
  return { key, tokens, len };
}

function similarityPrepared(pa: Prepared, pb: Prepared): number {
  const a = pa.key;
  const b = pb.key;
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Overlap of words, weighted by word length so "2" or "dx" count for little.
  let common = 0;
  for (const t of pa.tokens) if (pb.tokens.has(t)) common += t.length;
  const overlap = (2 * common) / (pa.len + pb.len);
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  const ratio = short.length / long.length;
  const prefix = long.startsWith(short + ' ') ? 0.6 + 0.4 * ratio : 0;
  const contains = ` ${long} `.includes(` ${short} `) ? 0.45 + 0.4 * ratio : 0;
  return Math.max(overlap, prefix, contains);
}

export function similarity(a: string, b: string): number {
  return similarityPrepared(prepare(a), prepare(b));
}

/** Small tie breakers between thumbnails of the same game. */
function preference(t: Thumb, system: 'gb' | 'gbc'): number {
  const n = t.name;
  let p = 0;
  if (/\(USA/.test(n)) p += 0.03;
  else if (/\(World/.test(n)) p += 0.025;
  else if (/Europe/.test(n)) p += 0.015;
  if (/\((Beta|Proto|Demo|Sample|Kiosk|Pirate|Unl)\b/i.test(n)) p -= 0.04;
  if (t.system === system) p += 0.01;
  return p;
}

interface Keyed {
  t: Thumb;
  p: Prepared;
}

let keyCache: { src: Thumb[]; keyed: Keyed[] } | null = null;

function keyed(index: ThumbIndex): Keyed[] {
  if (keyCache?.src !== index.thumbs) {
    keyCache = { src: index.thumbs, keyed: index.thumbs.map((t) => ({ t, p: prepare(nameKey(t.name)) })) };
  }
  return keyCache.keyed;
}

export function search(index: ThumbIndex, query: string, system: 'gb' | 'gbc', limit = 60): { thumb: Thumb; score: number }[] {
  const q = nameKey(query);
  if (!q) return [];
  const pq = prepare(q);
  const out: { thumb: Thumb; score: number }[] = [];
  for (const k of keyed(index)) {
    const s = similarityPrepared(pq, k.p);
    if (s >= 0.3) out.push({ thumb: k.t, score: s + preference(k.t, system) });
  }
  out.sort((a, b) => b.score - a.score || a.thumb.name.localeCompare(b.thumb.name));
  return out.slice(0, limit);
}

/** Auto threshold: below this a name match is not trusted. */
export const GUESS_THRESHOLD = 0.75;

let matchMemo: { src: ThumbIndex['thumbs']; map: Map<string, AutoMatch> } | null = null;

/** autoMatch, remembered per thumbnail list, so rescanning a big library is quick. */
export function autoMatchCached(index: ThumbIndex, romStem: string, system: 'gb' | 'gbc', dat: DatGame | undefined): AutoMatch {
  if (matchMemo?.src !== index.thumbs) matchMemo = { src: index.thumbs, map: new Map() };
  const key = `${system}|${dat?.name ?? ''}|${dat?.system ?? ''}|${romStem}`;
  let m = matchMemo.map.get(key);
  if (!m) {
    m = autoMatch(index, romStem, system, dat);
    matchMemo.map.set(key, m);
  }
  return m;
}

export function autoMatch(index: ThumbIndex, romStem: string, system: 'gb' | 'gbc', dat: DatGame | undefined): AutoMatch {
  if (dat) {
    const name = thumbName(dat.name);
    const repos = [...REPOS].sort((a, b) => (a.system === dat.system ? -1 : b.system === dat.system ? 1 : 0));
    for (const r of repos) {
      if (index.byRepo.get(r.repo)?.has(name)) return { status: 'exact', thumb: { repo: r.repo, system: r.system, name }, score: 1 };
    }
  }
  const query = dat ? dat.name : romStem;
  const best = search(index, query, dat?.system ?? system, 1)[0];
  if (best && best.score >= GUESS_THRESHOLD) return { status: 'guessed', thumb: best.thumb, score: best.score };
  return { status: 'none', thumb: null, score: best?.score ?? 0 };
}
