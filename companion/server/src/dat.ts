/**
 * No-Intro DATs from libretro-database, used to name ROMs by CRC32.
 * Format: clrmamepro text, one `game ( name "..." rom ( ... crc XXXXXXXX ... ) )` per entry.
 */
import path from 'node:path';
import { DAT_DIR, DAT_MAX_AGE_MS } from './config.js';
import { cachedDownload, fetchBuffer, type CachedFile } from './net.js';

export interface DatGame {
  name: string;
  system: 'gb' | 'gbc';
  size: number;
  crc: string;
}

const DATS: { system: 'gb' | 'gbc'; file: string }[] = [
  { system: 'gb', file: 'Nintendo - Game Boy.dat' },
  { system: 'gbc', file: 'Nintendo - Game Boy Color.dat' },
];

const BASE = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/';

export function parseDat(text: string, system: 'gb' | 'gbc'): DatGame[] {
  const out: DatGame[] = [];
  const gameRe = /^game \(\s*$([\s\S]*?)^\)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = gameRe.exec(text))) {
    const body = m[1];
    const name = body.match(/^\s*name "((?:[^"\\]|\\.)*)"/m)?.[1];
    if (!name) continue;
    const romRe = /rom \((.*?)\)\s*$/gm;
    let r: RegExpExecArray | null;
    while ((r = romRe.exec(body))) {
      const crc = r[1].match(/\bcrc ([0-9A-Fa-f]{8})\b/)?.[1];
      const size = Number(r[1].match(/\bsize (\d+)/)?.[1] ?? 0);
      if (crc) out.push({ name, system, size, crc: crc.toUpperCase() });
    }
  }
  return out;
}

export interface DatIndex {
  byCrc: Map<string, DatGame>;
  sources: { file: string; state: CachedFile['state']; games: number; fetchedAt: number | null; error?: string }[];
}

let memo: { at: number; index: DatIndex } | null = null;

export async function loadDats(force = false): Promise<DatIndex> {
  if (memo && !force && Date.now() - memo.at < 10 * 60 * 1000) return memo.index;
  const byCrc = new Map<string, DatGame>();
  const sources: DatIndex['sources'] = [];
  for (const d of DATS) {
    const res = await cachedDownload(
      path.join(DAT_DIR, d.file),
      DAT_MAX_AGE_MS,
      () => fetchBuffer(BASE + encodeURIComponent(d.file)),
      force,
    );
    const games = res.data ? parseDat(res.data.toString('utf8'), d.system) : [];
    for (const g of games) if (!byCrc.has(g.crc)) byCrc.set(g.crc, g);
    sources.push({ file: d.file, state: res.state, games: games.length, fetchedAt: res.fetchedAt, error: res.error });
  }
  const index = { byCrc, sources };
  // Do not memoize a failed load, so the next request tries the network again.
  if (sources.every((s) => s.games > 0)) memo = { at: Date.now(), index };
  return index;
}
