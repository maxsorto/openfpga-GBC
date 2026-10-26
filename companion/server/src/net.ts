import fs from 'node:fs';
import path from 'node:path';

/** fetch with a timeout. Throws on network errors and non-2xx responses. */
export async function fetchBuffer(url: string, headers: Record<string, string> = {}, timeoutMs = 30000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'gbc-cover-companion', ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export interface CachedFile {
  data: Buffer | null;
  /** 'fresh' cache, 'downloaded' now, 'stale' cache after a failed refresh, or 'missing'. */
  state: 'fresh' | 'downloaded' | 'stale' | 'missing';
  fetchedAt: number | null;
  error?: string;
}

/** Return a cached download, refreshing it when it is older than maxAgeMs. */
export async function cachedDownload(
  file: string,
  maxAgeMs: number,
  download: () => Promise<Buffer>,
  force = false,
): Promise<CachedFile> {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  if (stat && !force && Date.now() - stat.mtimeMs < maxAgeMs) {
    return { data: fs.readFileSync(file), state: 'fresh', fetchedAt: stat.mtimeMs };
  }
  try {
    const data = await download();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return { data, state: 'downloaded', fetchedAt: Date.now() };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    if (stat) return { data: fs.readFileSync(file), state: 'stale', fetchedAt: stat.mtimeMs, error };
    return { data: null, state: 'missing', fetchedAt: null, error };
  }
}
