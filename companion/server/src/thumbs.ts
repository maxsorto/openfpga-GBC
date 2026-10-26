/**
 * Box art from libretro-thumbnails. The file list for each repo comes from the
 * GitHub tree API and is cached; images are downloaded on demand and cached.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ART_CONCURRENCY, BOXART_DIR, GITHUB_TOKEN, TREE_DIR, TREE_MAX_AGE_MS } from './config.js';
import { Limiter, type Lane } from './limit.js';
import { cachedDownload, fetchBuffer, type CachedFile } from './net.js';
import { isPng } from './image.js';

export interface ThumbRepo {
  repo: string;
  system: 'gb' | 'gbc';
  label: string;
}

export const REPOS: ThumbRepo[] = [
  { repo: 'Nintendo_-_Game_Boy_Color', system: 'gbc', label: 'GBC' },
  { repo: 'Nintendo_-_Game_Boy', system: 'gb', label: 'GB' },
];

export interface Thumb {
  repo: string;
  system: 'gb' | 'gbc';
  /** File name without .png, already in libretro's character rules. */
  name: string;
}

/** libretro thumbnail names replace &*\/:`<>?\| with "_". */
export function thumbName(gameName: string): string {
  return gameName.replace(/[&*/:`<>?\\|]/g, '_');
}

export interface ThumbIndex {
  thumbs: Thumb[];
  byRepo: Map<string, Set<string>>;
  sources: { repo: string; state: CachedFile['state']; count: number; fetchedAt: number | null; error?: string }[];
}

let memo: { at: number; index: ThumbIndex } | null = null;

async function downloadTree(repo: string): Promise<Buffer> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (GITHUB_TOKEN) headers.authorization = `Bearer ${GITHUB_TOKEN}`;
  const raw = await fetchBuffer(`https://api.github.com/repos/libretro-thumbnails/${repo}/git/trees/master?recursive=1`, headers, 60000);
  const tree = JSON.parse(raw.toString('utf8')) as { tree?: { path: string }[] };
  if (!Array.isArray(tree.tree)) throw new Error('Unexpected response from GitHub');
  const names = tree.tree
    .map((e) => e.path)
    .filter((p) => p.startsWith('Named_Boxarts/') && p.endsWith('.png'))
    .map((p) => p.slice('Named_Boxarts/'.length, -4));
  if (!names.length) throw new Error('No box art in the GitHub listing');
  return Buffer.from(JSON.stringify(names));
}

export async function loadThumbs(force = false): Promise<ThumbIndex> {
  if (memo && !force && Date.now() - memo.at < 10 * 60 * 1000) return memo.index;
  const thumbs: Thumb[] = [];
  const byRepo = new Map<string, Set<string>>();
  const sources: ThumbIndex['sources'] = [];
  for (const r of REPOS) {
    const res = await cachedDownload(path.join(TREE_DIR, `${r.repo}.json`), TREE_MAX_AGE_MS, () => downloadTree(r.repo), force);
    let names: string[] = [];
    try {
      names = res.data ? JSON.parse(res.data.toString('utf8')) : [];
    } catch {
      names = [];
    }
    byRepo.set(r.repo, new Set(names));
    for (const name of names) thumbs.push({ repo: r.repo, system: r.system, name });
    sources.push({ repo: r.repo, state: res.state, count: names.length, fetchedAt: res.fetchedAt, error: res.error });
  }
  const index = { thumbs, byRepo, sources };
  if (sources.every((s) => s.count > 0)) memo = { at: Date.now(), index };
  return index;
}

function boxartFile(repo: string, name: string): string {
  return path.join(BOXART_DIR, repo, `${name}.png`);
}

function rawUrl(repo: string, relPath: string): string {
  return `https://raw.githubusercontent.com/libretro-thumbnails/${repo}/master/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

const inflight = new Map<string, Promise<Buffer>>();
const downloads = new Limiter(ART_CONCURRENCY);

/** True when this box art is already on disk. */
export function boxartCached(repo: string, name: string): boolean {
  return fs.existsSync(boxartFile(repo, name));
}

/**
 * The PNG for one thumbnail, from the cache or GitHub. Some entries in the
 * repos are git symlinks; the raw URL then returns the link target as text,
 * which we follow. Downloads share one queue: at most ART_CONCURRENCY run at
 * once, and "high" requests (covers on screen) go before "low" ones (the
 * background fetch of the whole library).
 */
export function getBoxart(repo: string, name: string, lane: Lane = 'high'): Promise<Buffer> {
  if (!REPOS.some((r) => r.repo === repo)) return Promise.reject(new Error('Unknown thumbnail repo'));
  if (name.includes('/') || name.includes('\0')) return Promise.reject(new Error('Bad thumbnail name'));
  const file = boxartFile(repo, name);
  if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
  const key = `${repo}/${name}`;
  const running = inflight.get(key);
  if (running) {
    if (lane === 'high') downloads.promote(key);
    return running;
  }
  const p = downloads
    .run(key, lane, async () => {
      let rel = `Named_Boxarts/${name}.png`;
      for (let hop = 0; hop < 4; hop++) {
        const buf = await fetchBuffer(rawUrl(repo, rel));
        if (isPng(buf)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, file);
          return buf;
        }
        const target = buf.toString('utf8').trim();
        if (buf.length > 512 || !target.endsWith('.png')) throw new Error(`Not an image: ${key}`);
        rel = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
        if (rel.startsWith('..')) throw new Error(`Bad link in ${key}`);
      }
      throw new Error(`Too many links for ${key}`);
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
