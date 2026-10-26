// Typed client for the local backend. In dev, Vite proxies /api to :4390.

export type ArtRef =
  | { kind: 'thumb'; repo: string; name: string }
  | { kind: 'custom'; file: string }
  | { kind: 'placeholder' };

export type MatchStatus = 'exact' | 'guessed' | 'none';
export type GameStatus = MatchStatus | 'chosen' | 'custom';

export interface Game {
  /** The CRC32: a game is its checksum. */
  id: string;
  crc: string;
  /** File name on the card. */
  file: string;
  platform: string;
  size: number;
  isGb: boolean;
  /** Where it is in the library, relative to the library folder. More than one for duplicates. */
  paths: string[];
  sourcePath: string;
  renamed: boolean;
  datName: string | null;
  defaultTitle: string;
  title: string;
  titleEdited: boolean;
  titleBytes: number;
  auto: { status: MatchStatus; art: ArtRef | null; label: string | null };
  art: ArtRef | null;
  artLabel: string | null;
  status: GameStatus;
  favorite: boolean;
  /** Null until the core records play history. */
  lastPlayed: number | null;
  problems: string[];
}

export interface SourceState {
  state: 'fresh' | 'downloaded' | 'stale' | 'missing';
  error?: string;
}

export interface CardInfo {
  root: string;
  romFolder: string;
  missingRomFolder: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  covers: { exists: boolean; bytes: number; modifiedAt: string | null; count: number | null; titles: string[] };
  manifest: { exists: boolean; placed: number; error?: string };
}

export interface Library {
  source: { kind: 'folder' | 'card'; root: string; files: number; duplicates: number; unreadable: string[] };
  card: CardInfo | null;
  games: Game[];
  maxGames: number;
  packVersion: number;
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
  favorite?: boolean | null;
}

export interface Settings {
  libraryRoot: string | null;
}

export interface ArtStatus {
  running: boolean;
  total: number;
  done: number;
  failed: number;
}

export interface SyncPlan {
  card: string;
  romFolder: string;
  source: Library['source'];
  manifest: { exists: boolean; placed: number; error?: string; ignored: number };
  copy: { crc: string; file: string; size: number; title: string; reason: 'new' | 'changed' | 'missing'; from: string }[];
  remove: { crc: string; file: string; size: number }[];
  unchanged: number;
  shared: string[];
  cardOnly: string[];
  stale: number;
  copyBytes: number;
  removeBytes: number;
  totalGames: number;
  totalRomBytes: number;
  pack: { version: number; file: string; bytes: number; count: number; limit: number | null; titles: string[]; crcs: string[]; skipped: string[] };
  space: { freeBytes: number | null; neededBytes: number; enough: boolean; removeFirst: boolean };
  signature: string;
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
  settings: async () => json<Settings>(await fetch('/api/settings')),
  saveSettings: async (s: Partial<Settings>) => json<Settings>(await post('/api/settings', s)),
  library: async (card: string | null) => json<Library>(await fetch(`/api/library${card ? `?card=${encodeURIComponent(card)}` : ''}`)),
  saveChoices: async (patches: Record<string, ChoicePatch>) => json<{ ok: true }>(await post('/api/choices', { patches })),
  candidates: async (q: string, system: 'gb' | 'gbc') =>
    (await json<{ results: Candidate[] }>(await fetch(`/api/candidates?q=${encodeURIComponent(q)}&system=${system}`))).results,
  uploadArt: async (crc: string, file: File) =>
    (
      await json<{ ref: ArtRef }>(
        await fetch(`/api/custom-art?crc=${crc}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file }),
      )
    ).ref,
  chooseFolder: async (purpose: 'library' | 'card' = 'card') => json<{ path?: string; cancelled?: boolean }>(await post('/api/choose-folder', { purpose })),
  refreshDatabases: async () => json<unknown>(await post('/api/refresh-databases', {})),
  warmArt: async (items: { ref: ArtRef | null; title: string }[]) => json<ArtStatus>(await post('/api/art/warm', { items })),
  artStatus: async () => json<ArtStatus>(await fetch('/api/art/status')),
  plan: async (card: string) => json<SyncPlan>(await fetch(`/api/plan?card=${encodeURIComponent(card)}`)),
  startSync: async (card: string, signature: string) => (await json<{ jobId: string }>(await post('/api/sync', { card, signature }))).jobId,
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

export type SyncPhase = 'check' | 'copy' | 'remove' | 'art' | 'pack' | 'write' | 'verify';

export type SyncEvent =
  | { type: 'phase'; phase: SyncPhase; message: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'file'; index: number; total: number; file: string; size: number; state: 'copying' | 'verified' | 'removed' | 'kept'; bytesDone: number; bytesTotal: number }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  | { type: 'done'; target: string; bytes: number; count: number; copied: number; removed: number; unchanged: number; backup: string | null }
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
