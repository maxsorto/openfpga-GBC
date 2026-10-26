import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Game, type Library } from './api';
import { GameCard } from './GameCard';
import { IconCard, IconFolder, IconRefresh, IconSearch, IconWarn } from './Icons';
import { PickerModal } from './PickerModal';
import { SourceMenu } from './SourceMenu';
import { SyncModal } from './SyncModal';
import { ThemeControl } from './ThemeControl';
import { Board } from './Board';
import { useVolumes } from './useVolumes';
import { fmtDate, isVolumePath } from './util';

type Filter = 'all' | 'exact' | 'guessed' | 'none' | 'yours';

const FILTERS: { key: Filter; label: string; test: (g: Game) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'exact', label: 'Exact', test: (g) => g.status === 'exact' },
  { key: 'guessed', label: 'Guessed', test: (g) => g.status === 'guessed' },
  { key: 'none', label: 'No art', test: (g) => g.status === 'none' },
  { key: 'yours', label: 'Yours', test: (g) => g.status === 'chosen' || g.status === 'custom' },
];

function initialRoot(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('root');
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem('root');
  } catch {
    return null;
  }
}

export function App() {
  const { volumes, loaded: volumesLoaded } = useVolumes();
  const [root, setRoot] = useState<string | null>(initialRoot);
  const [lib, setLib] = useState<Library | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<Game | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const chooseRoot = useCallback((r: string) => {
    setRoot(r);
    setLib(null);
    try {
      localStorage.setItem('root', r);
    } catch {
      // private mode; not important
    }
  }, []);

  // With nothing chosen yet, pick the first Pocket card that shows up.
  useEffect(() => {
    if (root || !volumesLoaded) return;
    const pocket = volumes.find((v) => v.isPocket);
    if (pocket) chooseRoot(pocket.mountPath);
  }, [root, volumes, volumesLoaded, chooseRoot]);

  const load = useCallback(async (r: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const l = await api.library(r);
      setLib(l);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setLib(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (root) void load(root);
  }, [root, load]);

  // A card that was ejected or pulled out.
  const cardGone = !!root && isVolumePath(root) && volumesLoaded && !volumes.some((v) => v.mountPath === root.replace(/\/$/, ''));

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const games = lib?.games ?? [];
  const included = games.filter((g) => g.included);
  const slotsLeft = (lib?.maxGames ?? 31) - included.length;
  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const q = query.trim().toLowerCase();
    return games.filter((g) => f.test(g) && (!q || g.title.toLowerCase().includes(q) || g.file.toLowerCase().includes(q)));
  }, [games, filter, query]);

  const vol = volumes.find((v) => v.mountPath === root?.replace(/\/$/, ''));
  const problems = games.filter((g) => g.problems.length);
  const dbMissing = lib && [...lib.databases.dats, ...lib.databases.thumbs].some((s) => s.state === 'missing');
  const dbStale = lib && [...lib.databases.dats, ...lib.databases.thumbs].some((s) => s.state === 'stale');

  async function save(patches: Parameters<typeof api.saveChoices>[0]) {
    try {
      await api.saveChoices(patches);
      if (root) await load(root, true);
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  function toggle(g: Game, on: boolean) {
    if (on && slotsLeft <= 0) {
      setToast('The core holds 31 games. Uncheck one first.');
      return;
    }
    void save({ [g.crc]: { include: on } });
  }

  return (
    <div className="app">
      <Board />
      <div className="shell-tint" aria-hidden="true" />
      <header className="titlebar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={22} height={34} />
          <div>
            <div className="brand-name">Cover Picker</div>
            <div className="brand-sub">For Analogue Pocket · GBC core</div>
          </div>
        </div>
        <div className="grow" />
        <ThemeControl />
        <SourceMenu root={root} volumes={volumes} freeBytes={lib?.freeBytes ?? vol?.freeBytes ?? null} onPick={chooseRoot} />
        <button
          className="a-button"
          disabled={!lib || included.length === 0 || cardGone}
          onClick={() => setSyncing(true)}
          aria-label="Sync to Pocket"
          title="Sync to Pocket"
        >
          <span className="a-cap" />
          <span className="a-label">Sync</span>
        </button>
      </header>
      <div className="stripes" aria-hidden="true">
        <span />
        <span />
      </div>

      {!root && (
        <div className="empty">
          <div className="empty-panel">
          <div className="empty-icon">
            <IconCard size={34} />
          </div>
          <h2>Insert your Pocket's SD card</h2>
          <p>The app finds it on its own. You can also work with a folder that has the same layout.</p>
          <button
            onClick={async () => {
              const r = await api.chooseFolder();
              if (r.path) chooseRoot(r.path);
            }}
          >
            <IconFolder /> Choose a folder…
          </button>
          </div>
        </div>
      )}

      {root && (
        <>
          <div className="toolbar">
            <div className="search small">
              <IconSearch />
              <input type="search" placeholder="Filter games" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="segmented">
              {FILTERS.map((f) => {
                const n = games.filter(f.test).length;
                if (f.key !== 'all' && n === 0) return null;
                return (
                  <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
                    {f.label} <span className="count">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="grow" />
            <div className="slots" title="The core shows up to 31 games">
              <div className="slots-text">
                <strong>{included.length}</strong> of {lib?.maxGames ?? 31} slots
              </div>
              <div className="slots-bar" aria-hidden="true">
                {Array.from({ length: lib?.maxGames ?? 31 }, (_, i) => (
                  <i key={i} className={i < included.length ? 'on' : ''} />
                ))}
              </div>
            </div>
          </div>

          <main className="content">
            {cardGone && (
              <div className="banner">
                <IconWarn /> The card is no longer mounted. Insert it again, or pick another source.
              </div>
            )}
            {error && !cardGone && (
              <div className="banner error">
                <IconWarn /> {error}
              </div>
            )}
            {lib?.missingRomFolder && (
              <div className="banner">
                <IconWarn /> There is no Assets/gbc/common folder here. The core reads ROMs from that folder.
              </div>
            )}
            {games.length > (lib?.maxGames ?? 31) && (
              <div className="banner info">
                {games.length} ROMs found. The core holds {lib?.maxGames}. Use the checkboxes to choose which ones go on the Pocket.
              </div>
            )}
            {problems.length > 0 && (
              <div className="banner">
                <IconWarn /> {problems.length === 1 ? '1 ROM has' : `${problems.length} ROMs have`} a file name longer than the core allows
                (255 bytes for the full path). Rename {problems.length === 1 ? 'it' : 'them'} on the card to include {problems.length === 1 ? 'it' : 'them'}.
              </div>
            )}
            {(dbMissing || dbStale) && (
              <div className="banner">
                <IconWarn />
                {dbMissing
                  ? 'Could not download the game lists. Matching works again once you are online.'
                  : 'Using saved game lists. A refresh failed.'}
                <button className="link" onClick={async () => {
                  await api.refreshDatabases().catch(() => null);
                  if (root) void load(root);
                }}>
                  <IconRefresh size={13} /> Try again
                </button>
              </div>
            )}

            {loading && !lib && (
              <div className="loading">
                <span className="spinner" /> Reading ROMs and matching names. The first run downloads the game lists.
              </div>
            )}

            {lib && games.length === 0 && !lib.missingRomFolder && (
              <div className="empty inline">
                <h2>No ROMs here yet</h2>
                <p>Copy .gb or .gbc files into Assets/gbc/common on the card, then come back.</p>
              </div>
            )}

            <div className="grid">
              {visible.map((g) => (
                <GameCard
                  key={g.id}
                  game={g}
                  canInclude={slotsLeft > 0}
                  onOpen={() => setPicker(g)}
                  onToggle={(on) => toggle(g, on)}
                  onRename={(t) => void save({ [g.crc]: { title: t === g.defaultTitle ? null : t } })}
                />
              ))}
            </div>
            {lib && games.length > 0 && visible.length === 0 && <div className="loading">No games match this filter.</div>}
          </main>

          <footer className="statusbar">
            <span>
              {games.length} {games.length === 1 ? 'ROM' : 'ROMs'} in {lib?.romFolders.join(', ') ?? 'Assets/gbc/common'}
            </span>
            <span className="sep" />
            <span>
              {lib?.covers.exists
                ? `covers.bin on card: ${lib.covers.count ?? '?'} games, written ${fmtDate(lib.covers.modifiedAt)}`
                : 'No covers.bin on this card yet'}
            </span>
            <span className="grow" />
            {lib && (
              <span className="dim">
                No-Intro {lib.databases.dats.reduce((n, d) => n + d.games, 0).toLocaleString()} ROMs, box art{' '}
                {lib.databases.thumbs.reduce((n, d) => n + d.count, 0).toLocaleString()}
              </span>
            )}
          </footer>
        </>
      )}

      {picker && (
        <PickerModal
          game={picker}
          onClose={() => setPicker(null)}
          onSaved={() => {
            setPicker(null);
            if (root) void load(root, true);
          }}
        />
      )}
      {syncing && root && lib && (
        <SyncModal
          root={lib.root}
          isPocket={!!vol?.isPocket}
          games={included}
          onClose={(synced) => {
            setSyncing(false);
            if (synced) void load(root, true);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
