// Typed client for the local backend. In dev, Vite proxies /api to :4390.

export type ArtRef =
  | { kind: 'thumb'; repo: string; name: string }
  | { kind: 'custom'; file: string }
  | { kind: 'placeholder' };

export type MatchStatus = 'exact' | 'guessed' | 'none';
export type GameStatus = MatchStatus | 'chosen' | 'custom';

export interface Game {
  id: string;
  file: string;
  platform: string;
  size: number;
  crc: string;
  isGb: boolean;
  datName: string | null;
  defaultTitle: string;
  title: string;
  titleEdited: boolean;
  titleBytes: number;
  auto: { status: MatchStatus; art: ArtRef | null; label: string | null };
  art: ArtRef | null;
  artLabel: string | null;
  status: GameStatus;
  included: boolean;
  includeExplicit: boolean;
  problems: string[];
}

export interface SourceState {
  state: 'fresh' | 'downloaded' | 'stale' | 'missing';
  error?: string;
}

export interface Library {
  root: string;
  romFolders: string[];
  missingRomFolder: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  covers: { exists: boolean; bytes: number; modifiedAt: string | null; count: number | null; titles: string[] };
  games: Game[];
  maxGames: number;
  databases: {
    dats: (SourceState & { file: string; games: number })[];
    thumbs: (SourceState & { repo: string; count: number })[];
  };
}

export interface Volume {
  name: string;
  mountPath: string;
  fsType: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  isPocket: boolean;
  hasCoreStructure: boolean;
}

export interface Candidate {
  repo: string;
  name: string;
  label: string;
  score: number;
}

export interface ChoicePatch {
  title?: string | null;
  art?: ArtRef | null;
  include?: boolean | null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `${res.status} ${res.statusText}`);
  return body as T;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  volumes: async () => (await json<{ volumes: Volume[] }>(await fetch('/api/volumes'))).volumes,
  library: async (root: string) => json<Library>(await fetch(`/api/library?root=${encodeURIComponent(root)}`)),
  saveChoices: async (patches: Record<string, ChoicePatch>) => json<{ ok: true }>(await post('/api/choices', { patches })),
  candidates: async (q: string, system: 'gb' | 'gbc') =>
    (await json<{ results: Candidate[] }>(await fetch(`/api/candidates?q=${encodeURIComponent(q)}&system=${system}`))).results,
  uploadArt: async (crc: string, file: File) =>
    (
      await json<{ ref: ArtRef }>(
        await fetch(`/api/custom-art?crc=${crc}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }),
      )
    ).ref,
  chooseFolder: async () => json<{ path?: string; cancelled?: boolean }>(await post('/api/choose-folder', {})),
  refreshDatabases: async () => json<unknown>(await post('/api/refresh-databases', {})),
  startSync: async (root: string, ids: string[]) => (await json<{ jobId: string }>(await post('/api/sync', { root, ids }))).jobId,
  eject: async (mountPath: string) => json<{ ok: boolean; steps: string[] }>(await post('/api/eject', { mountPath })),
};

export function fittedUrl(art: ArtRef | null, title: string, size: 128 | 80 = 128): string {
  const q = new URLSearchParams({ size: String(size) });
  if (art && art.kind !== 'placeholder') q.set('ref', JSON.stringify(art));
  else q.set('title', title);
  return `/api/fitted?${q.toString()}`;
}

export function boxartUrl(repo: string, name: string, w = 200): string {
  return `/api/boxart?${new URLSearchParams({ repo, name, w: String(w) }).toString()}`;
}

export type SyncEvent =
  | { type: 'phase'; phase: string; message: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  | { type: 'done'; target: string; bytes: number; count: number; backup: string | null }
  | { type: 'error'; message: string };

export function subscribeSync(jobId: string, onEvent: (e: SyncEvent) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/sync/${jobId}/stream`);
    es.addEventListener('msg', (e) => onEvent(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('end', () => {
      es.close();
      resolve();
    });
    es.onerror = () => {
      es.close();
      reject(new Error('Lost connection to the app'));
    };
  });
}
