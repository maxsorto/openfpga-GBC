import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ArtStatus, type CartsInfo, type Game, type Library } from './api';
import { CartsView, cartAsGame } from './CartsView';
import { GameCard } from './GameCard';
import { IconCard, IconCheck, IconFolder, IconRefresh, IconSearch, IconStar, IconWarn } from './Icons';
import { LibraryMenu } from './LibraryMenu';
import { PickerModal } from './PickerModal';
import { SourceMenu } from './SourceMenu';
import { SyncModal } from './SyncModal';
import { ThemeControl } from './ThemeControl';
import { Board } from './Board';
import { useVolumes } from './useVolumes';
import { VirtualGrid, type Block } from './VirtualGrid';
import { fmtBytes, fmtDate, isVolumePath, packBytes as packSize, words } from './util';

type View = 'library' | 'pocket' | 'cartridges';

/** One card in the grid. In the Pocket view a favorite can be in two places. */
interface Item {
  game: Game;
  key: string;
  /** Place in the Pocket menu, from 1. */
  pos: number | null;
  /** This is the game's second place: under its letter, after the favorites at the top. */
  again: boolean;
}
type Filter = 'all' | 'fav' | 'exact' | 'guessed' | 'none' | 'yours';

const FILTERS: { key: Filter; label: string; test: (g: Game) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'fav', label: 'Favorites', test: (g) => g.favorite },
  { key: 'exact', label: 'Exact', test: (g) => g.status === 'exact' },
  { key: 'guessed', label: 'Guessed', test: (g) => g.status === 'guessed' },
  { key: 'none', label: 'No art', test: (g) => g.status === 'none' },
  { key: 'yours', label: 'Yours', test: (g) => g.status === 'chosen' || g.status === 'custom' },
];

// Card height plus the gap below it. Matches .card in styles.css.
const ROW_H = 284;
const HEAD_H = 58;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode; not important
  }
}

function initialCard(): string | null {
  const q = new URLSearchParams(window.location.search);
  return q.get('card') ?? q.get('root') ?? stored('card') ?? stored('root');
}

function initialView(): View {
  const q = new URLSearchParams(window.location.search).get('view');
  const v = q ?? stored('view');
  return v === 'pocket' || v === 'cartridges' ? v : 'library';
}

function SectionHead({ title, count, note, icon }: { title: string; count?: number; note?: string; icon?: React.ReactNode }) {
  return (
    <div className="section-head">
      {icon}
      <h3>{title}</h3>
      {count != null && <span className="count">{count}</span>}
      {note && <span className="section-note">{note}</span>}
      <span className="section-rule" />
    </div>
  );
}

export function App() {
  const { volumes, loaded: volumesLoaded } = useVolumes();
  const [card, setCard] = useState<string | null>(initialCard);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [lib, setLib] = useState<Library | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(initialView);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<Game | null>(null);
  // Carts the Pocket did not recognize.
  const [cartsInfo, setCartsInfo] = useState<CartsInfo | null>(null);
  const [cartsLoading, setCartsLoading] = useState(false);
  const [pickingCart, setPickingCart] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [art, setArt] = useState<ArtStatus | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const warmKey = useRef('');

  const setView = (v: View) => {
    setViewState(v);
    store('view', v);
    scroller.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    api
      .settings()
      .then((s) => setLibraryRoot(s.libraryRoot))
      .catch(() => null)
      .finally(() => setSettingsLoaded(true));
  }, []);

  const chooseCard = useCallback((r: string) => {
    setCard(r);
    store('card', r);
  }, []);

  const chooseLibrary = useCallback(async (r: string | null) => {
    try {
      const s = await api.saveSettings({ libraryRoot: r });
      setLibraryRoot(s.libraryRoot);
      setLib(null);
    } catch (e) {
      setToast((e as Error).message);
    }
  }, []);

  // With no card chosen yet, pick the first Pocket card that shows up.
  useEffect(() => {
    if (card || !volumesLoaded) return;
    const pocket = volumes.find((v) => v.isPocket);
    if (pocket) chooseCard(pocket.mountPath);
  }, [card, volumes, volumesLoaded, chooseCard]);

  // A card that was ejected or pulled out.
  const cardGone = !!card && isVolumePath(card) && volumesLoaded && !volumes.some((v) => v.mountPath === card.replace(/\/$/, ''));
  const activeCard = cardGone ? null : card;

  const load = useCallback(
    async (quiet = false) => {
      if (!libraryRoot && !activeCard) {
        setLib(null);
        return;
      }
      if (!quiet) setLoading(true);
      try {
        setLib(await api.library(activeCard));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        if (!quiet) setLib(null);
      } finally {
        setLoading(false);
      }
    },
    [libraryRoot, activeCard],
  );

  const loadCarts = useCallback(async () => {
    setCartsLoading(true);
    try {
      setCartsInfo(await api.carts(activeCard));
    } catch {
      // The cartridges view shows nothing new; the rest of the app works.
    } finally {
      setCartsLoading(false);
    }
  }, [activeCard]);

  // Carts load with the library, and again after a sync (which saves new ones).
  useEffect(() => {
    if (settingsLoaded && (libraryRoot || activeCard)) void loadCarts();
  }, [settingsLoaded, libraryRoot, activeCard, loadCarts, lib?.card?.covers.modifiedAt]);

  useEffect(() => {
    if (settingsLoaded) void load();
  }, [settingsLoaded, load]);

  // Fetch art for the whole library in the background, and show progress.
  useEffect(() => {
    if (!lib) return;
    const items = lib.games.map((g) => ({ ref: g.art && g.art.kind !== 'placeholder' ? g.art : null, title: g.title }));
    const key = JSON.stringify(items);
    if (key === warmKey.current) return;
    warmKey.current = key;
    api.warmArt(items).then(setArt).catch(() => null);
  }, [lib]);

  useEffect(() => {
    if (!art?.running) return;
    const t = window.setInterval(() => {
      api.artStatus().then(setArt).catch(() => null);
    }, 700);
    return () => window.clearInterval(t);
  }, [art?.running]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const all = lib?.games ?? [];
  // Library: what is in the folder. Pocket: what the card will hold, including ROMs only on the card.
  // With no library folder the card's ROMs are the library.
  const cardIsLibrary = lib?.source.kind === 'card';
  const libraryGames = useMemo(() => (cardIsLibrary ? all : all.filter((g) => g.origin === 'library')), [all, cardIsLibrary]);
  const pocketGames = useMemo(() => all.filter((g) => g.cardState !== 'cardKept'), [all]);
  const games = view === 'library' ? libraryGames : pocketGames;
  const maxGames = lib?.maxGames ?? 31;
  const streaming = !!lib?.pack.streaming;
  const packVersion = lib?.pack.version ?? 6;
  const vol = volumes.find((v) => v.mountPath === activeCard?.replace(/\/$/, ''));

  const matches = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const q = query.trim().toLowerCase();
    return (g: Game) => f.test(g) && (!q || g.title.toLowerCase().includes(q) || g.file.toLowerCase().includes(q));
  }, [filter, query]);

  // Pocket order: played (most recent first), then favorites A to Z, then the A to Z list.
  // With the streaming core (v7) the A to Z list has every game, so a favorite shows
  // twice: at the top and under its letter. With v6 each game shows once.
  const pocket = useMemo(() => {
    const games = pocketGames;
    const played = games.filter((g) => g.lastPlayed != null).sort((a, b) => b.lastPlayed! - a.lastPlayed!);
    const favs = games.filter((g) => g.lastPlayed == null && g.favorite);
    const rest = streaming ? games : games.filter((g) => g.lastPlayed == null && !g.favorite);
    let n = 0;
    const items = (list: Game[], tag: string, again: boolean): Item[] =>
      list.map((game) => ({
        game,
        key: `${tag}:${game.crc}`,
        pos: game.problems.length ? null : ++n,
        again: again && (game.favorite || game.lastPlayed != null),
      }));
    const p = items(played, 'p', false);
    const f = items(favs, 'f', false);
    const r = items(rest, 'a', streaming);
    return { played: p, favs: f, rest: r, entries: n };
  }, [pocketGames, streaming]);

  const unfiltered = filter === 'all' && !query.trim();

  const blocks = useMemo((): Block<Item>[] => {
    if (view === 'library') return [{ kind: 'items', key: 'all', items: games.filter(matches).map((game) => ({ game, key: game.crc, pos: null, again: false })) }];
    const out: Block<Item>[] = [];
    // A run of games, with the "today's core stops here" line where it falls.
    const run = (key: string, items: Item[]) => {
      const shown = items.filter((it) => matches(it.game));
      if (!unfiltered) {
        if (shown.length) out.push({ kind: 'items', key, items: shown });
        return;
      }
      const cut = shown.findIndex((it) => (it.pos ?? 0) > maxGames);
      const firstPos = shown.length ? (shown[0].pos ?? 0) : 0;
      if (cut <= 0 || firstPos > maxGames) {
        if (cut === 0 && firstPos === maxGames + 1) out.push(cutoffRow());
        if (shown.length) out.push({ kind: 'items', key, items: shown });
        return;
      }
      out.push({ kind: 'items', key: `${key}-a`, items: shown.slice(0, cut) });
      out.push(cutoffRow());
      out.push({ kind: 'items', key: `${key}-b`, items: shown.slice(cut) });
    };
    const cutoffRow = (): Block<Item> => ({
      kind: 'row',
      key: 'cutoff',
      height: 70,
      node: (
        <div className="cutoff">
          <span className="cutoff-line" />
          <span className="cutoff-text">
            {streaming
              ? `Pack v${packVersion} holds ${maxGames} games. The games below are copied to the card but are not in the menu.`
              : `Today's core shows the ${maxGames} above. Every game below is copied to the card too, ready for the streaming core.`}
          </span>
          <span className="cutoff-line" />
        </div>
      ),
    });
    out.push({
      kind: 'row',
      key: 'h-played',
      height: HEAD_H,
      node: (
        <SectionHead
          title="Recently played"
          count={pocket.played.length}
          note={
            pocket.played.length
              ? 'Most recent first'
              : streaming
                ? 'None yet. Play history from the Pocket shows here in a later version of the app.'
                : 'None yet. The Pocket will record play history once the streaming core is in.'
          }
        />
      ),
    });
    run('played', pocket.played);
    out.push({
      kind: 'row',
      key: 'h-fav',
      height: HEAD_H,
      node: (
        <SectionHead
          icon={<IconStar on size={14} className="section-star" />}
          title="Favorites"
          count={pocket.favs.length}
          note={
            pocket.favs.length
              ? streaming
                ? 'Favorites mode on the Pocket shows these A to Z, then an All games cover.'
                : 'A to Z'
              : streaming
                ? 'Star a game to see it in Favorites mode on the Pocket.'
                : 'Star a game to put it first.'
          }
        />
      ),
    });
    run('fav', pocket.favs);
    out.push({
      kind: 'row',
      key: 'h-rest',
      height: HEAD_H,
      node: streaming ? (
        <SectionHead title="All games" count={pocket.rest.length} note="Every game once, A to Z. Up and Down on the Pocket jump by letter." />
      ) : (
        <SectionHead title="Everything else" count={pocket.rest.length} note="A to Z" />
      ),
    });
    run('rest', pocket.rest);
    return out;
  }, [view, games, matches, pocket, unfiltered, maxGames, streaming, packVersion]);

  const shownCount = useMemo(() => blocks.reduce((n, b) => n + (b.kind === 'items' ? b.items.length : 0), 0), [blocks]);

  const problems = games.filter((g) => g.problems.length);
  const dbMissing = lib && [...lib.databases.dats, ...lib.databases.thumbs].some((s) => s.state === 'missing');
  const dbStale = lib && [...lib.databases.dats, ...lib.databases.thumbs].some((s) => s.state === 'stale');
  const romBytes = games.reduce((n, g) => n + g.size, 0);
  const packBytes = packSize(packVersion, Math.min(maxGames, pocket.entries));
  const freeBytes = lib?.card?.freeBytes ?? vol?.freeBytes ?? null;

  const loadRef = useRef(load);
  loadRef.current = load;

  const onFavorite = useCallback(async (g: Game, on: boolean) => {
    setLib((l) => (l ? { ...l, games: l.games.map((x) => (x.crc === g.crc ? { ...x, favorite: on } : x)) } : l));
    try {
      await api.saveChoices({ [g.crc]: { favorite: on } });
      // A library game whose card copy is kept passes its star on: refresh to show it there too.
      if (g.cardState === 'cardKept') await loadRef.current(true);
    } catch (e) {
      setToast((e as Error).message);
      setLib((l) => (l ? { ...l, games: l.games.map((x) => (x.crc === g.crc ? { ...x, favorite: !on } : x)) } : l));
    }
  }, []);

  const onRename = useCallback(
    async (g: Game, t: string) => {
      try {
        await api.saveChoices({ [g.crc]: { title: t === g.defaultTitle ? null : t } });
        await load(true);
      } catch (e) {
        setToast((e as Error).message);
      }
    },
    [load],
  );

  const onOpen = useCallback((g: Game) => setPicker(g), []);

  const renderItem = useCallback(
    (it: Item) => (
      <GameCard
        game={it.game}
        position={view === 'pocket' ? it.pos : null}
        again={it.again}
        beyondLimit={it.pos != null && it.pos > maxGames}
        onOpen={onOpen}
        onFavorite={onFavorite}
        onRename={onRename}
      />
    ),
    [view, maxGames, onOpen, onFavorite, onRename],
  );

  const nothingChosen = settingsLoaded && !libraryRoot && !card;
  const artPct = art && art.total ? Math.round((art.done / art.total) * 100) : 0;
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, games.filter(f.test).length])) as Record<Filter, number>, [games]);

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
        <nav className="views" role="tablist" aria-label="View">
          {(
            [
              ['library', 'Library', 'Everything in your library folder'],
              ['pocket', 'Pocket', 'What the card will hold, in menu order'],
              ['cartridges', 'Cartridges', 'Carts the Pocket did not recognize'],
            ] as const
          ).map(([key, label, hint]) => (
            <button key={key} role="tab" aria-selected={view === key} className={view === key ? 'on' : ''} title={hint} onClick={() => setView(key)}>
              {label}
              {key === 'cartridges'
                ? cartsInfo && cartsInfo.carts.length > 0 && <span className="count">{cartsInfo.carts.length}</span>
                : lib && <span className="count">{key === 'library' ? libraryGames.length : pocketGames.length}</span>}
            </button>
          ))}
        </nav>
        <div className="grow" />
        <ThemeControl />
        <LibraryMenu libraryRoot={libraryRoot} games={lib ? libraryGames.length : null} hasCard={!!activeCard} onPick={chooseLibrary} />
        <SourceMenu root={card} volumes={volumes} freeBytes={freeBytes} onPick={chooseCard} />
        <button
          className="a-button"
          disabled={!lib || !activeCard || all.length === 0}
          onClick={() => setSyncing(true)}
          aria-label="Sync to Pocket"
          title={activeCard ? 'Sync to Pocket' : 'Insert the Pocket card to sync'}
        >
          <span className="a-cap" />
          <span className="a-label">Sync</span>
        </button>
      </header>
      <div className="stripes" aria-hidden="true">
        <span />
        <span />
      </div>

      {nothingChosen && (
        <div className="empty">
          <div className="empty-panel">
            <div className="empty-icon">
              <IconFolder size={34} />
            </div>
            <h2>Choose your ROM library</h2>
            <p>Pick the folder on your Mac that holds your .gb and .gbc files. Subfolders are included. Then insert your Pocket's SD card to sync.</p>
            <button
              className="primary"
              onClick={async () => {
                const r = await api.chooseFolder('library');
                if (r.path) void chooseLibrary(r.path);
              }}
            >
              <IconFolder /> Choose library folder…
            </button>
            <p className="empty-alt">
              <IconCard size={13} /> No library yet? Insert the card and the app works with the ROMs already on it.
            </p>
          </div>
        </div>
      )}

      {!nothingChosen && (
        <>
          <div className="toolbar">
            <div className="search small">
              <IconSearch />
              <input type="search" placeholder="Filter games" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="segmented" hidden={view === 'cartridges'}>
              {FILTERS.map((f) => {
                const n = counts[f.key];
                if (f.key !== 'all' && f.key !== 'fav' && f.key !== 'none' && n === 0) return null;
                return (
                  <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
                    {f.key === 'fav' && <IconStar on={filter === 'fav'} size={12} />}
                    {f.label} <span className="count">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="grow" />
            {art && art.total > 0 && view !== 'cartridges' && (
              <div className="meter-box" title={art.failed ? `${art.failed} could not be downloaded. They show a title card.` : 'Box art downloaded and fitted'}>
                <div className="meter-text">
                  {art.running ? (
                    <>
                      Art <strong>{art.done}</strong> of {art.total}
                    </>
                  ) : (
                    <>
                      Art ready <strong>{art.done}</strong>
                      {art.failed > 0 && <span className="warn-text"> · {art.failed} failed</span>}
                    </>
                  )}
                </div>
                <div className={`mini-bar ${art.running ? 'busy' : ''}`} aria-hidden="true">
                  <i style={{ width: `${art.running ? artPct : 100}%` }} />
                </div>
              </div>
            )}
            {view === 'pocket' && lib && (
              <div className="meter-box" title="All ROMs plus the pack, against free space on the card">
                <div className="meter-text">
                  ROMs <strong>{fmtBytes(romBytes)}</strong> + pack {fmtBytes(packBytes)}
                  {freeBytes != null && <> / {fmtBytes(freeBytes)} free</>}
                </div>
                <div className={`mini-bar ${freeBytes != null && romBytes + packBytes > freeBytes ? 'over' : ''}`} aria-hidden="true">
                  <i style={{ width: `${freeBytes ? Math.min(100, Math.max(2, ((romBytes + packBytes) / freeBytes) * 100)) : 0}%` }} />
                </div>
              </div>
            )}
          </div>

          <main className="content" ref={scroller}>
            {cardGone && (
              <div className="banner">
                <IconWarn /> The card is no longer mounted. Insert it again, or pick another card.
              </div>
            )}
            {error && (
              <div className="banner error">
                <IconWarn /> {error}
              </div>
            )}
            {lib && lib.migrated.length > 0 && (
              <div className="banner info">
                <IconCheck />
                <span className="grow">
                  {lib.migrated
                    .slice(0, 3)
                    .map((m) => `${m.title}: new dump, kept your ${words(m.kept)}.`)
                    .join(' ')}
                  {lib.migrated.length > 3 && ` And ${lib.migrated.length - 3} more.`}
                </span>
                <button
                  className="link"
                  onClick={async () => {
                    const ids = lib.migrated.map((m) => m.id);
                    setLib((l) => (l ? { ...l, migrated: [] } : l));
                    await api.migrationsSeen(ids).catch(() => null);
                  }}
                >
                  OK
                </button>
              </div>
            )}
            {lib?.source.kind === 'card' && (
              <div className="banner info">
                <IconFolder /> Showing the ROMs already on the card. Choose a library folder to copy games from your Mac.
              </div>
            )}
            {lib && !activeCard && !cardGone && view === 'pocket' && (
              <div className="banner info">
                <IconCard /> Insert your Pocket's SD card to see the sync plan.
              </div>
            )}
            {lib?.card?.manifest.error && (
              <div className="banner error">
                <IconWarn /> cover-picker.json on the card could not be read. Sync is paused until it is moved aside.
              </div>
            )}
            {view === 'pocket' && lib?.card && (streaming || games.length > maxGames) && (
              <div className="banner info">
                {streaming ? (
                  <>
                    <IconCard /> {lib.pack.reason} Favorites mode shows your favorites, then All games. All games has every game once, A to Z.
                  </>
                ) : (
                  <>
                    {lib.pack.reason} All {games.length} games still go on the card, and the first {maxGames} are in the menu: favorites first, then A to Z.
                  </>
                )}
              </div>
            )}
            {problems.length > 0 && (
              <div className="banner">
                <IconWarn /> {problems.length === 1 ? '1 ROM has' : `${problems.length} ROMs have`} a file name longer than the core allows (255 bytes for the
                full path). {problems.length === 1 ? 'It is' : 'They are'} copied but left out of the menu until renamed.
              </div>
            )}
            {lib && lib.source.unreadable.length > 0 && (
              <div className="banner" title={lib.source.unreadable.join('\n')}>
                <IconWarn /> {lib.source.unreadable.length} {lib.source.unreadable.length === 1 ? 'file' : 'files'} in the library could not be read, or are
                not ROM sized, and were skipped.
              </div>
            )}
            {(dbMissing || dbStale) && (
              <div className="banner">
                <IconWarn />
                {dbMissing ? 'Could not download the game lists. Matching works again once you are online.' : 'Using saved game lists. A refresh failed.'}
                <button
                  className="link"
                  onClick={async () => {
                    await api.refreshDatabases().catch(() => null);
                    void load();
                  }}
                >
                  <IconRefresh size={13} /> Try again
                </button>
              </div>
            )}

            {loading && !lib && (
              <div className="loading">
                <span className="spinner" /> Reading ROMs and matching names. The first run downloads the game lists.
              </div>
            )}

            {lib && games.length === 0 && view === 'library' && (
              <div className="empty inline">
                <h2>No ROMs here yet</h2>
                <p>
                  {lib.source.kind === 'folder'
                    ? 'No .gb or .gbc files in this folder or its subfolders.'
                    : 'Choose a library folder on your Mac, or copy .gb or .gbc files into Assets/gbc/common on the card.'}
                </p>
              </div>
            )}

            {view === 'cartridges' ? (
              <CartsView
                info={cartsInfo}
                loading={cartsLoading}
                query={query}
                onChangeCover={(c) => {
                  setPickingCart(true);
                  setPicker(cartAsGame(c));
                }}
                onForget={async (c) => {
                  await api.forgetCart(c.id).catch((e) => setToast((e as Error).message));
                  void loadCarts();
                }}
              />
            ) : (
              <>
                {lib && games.length > 0 && (
                  <VirtualGrid blocks={blocks} scroller={scroller} itemKey={(it) => it.key} renderItem={renderItem} rowHeight={ROW_H} />
                )}
                {lib && games.length > 0 && shownCount === 0 && <div className="loading">No games match this filter.</div>}
              </>
            )}
          </main>

          <footer className="statusbar">
            <span title={lib?.source.root}>
              {lib
                ? `${libraryGames.length} ${libraryGames.length === 1 ? 'game' : 'games'} from ${lib.source.files} ${lib.source.files === 1 ? 'file' : 'files'}${
                    lib.source.duplicates ? `, ${lib.source.duplicates} duplicate${lib.source.duplicates === 1 ? '' : 's'} merged` : ''
                  }${all.length > libraryGames.length ? `, ${all.length - libraryGames.length} only on the card` : ''}`
                : ''}
            </span>
            {lib?.card && (
              <>
                <span className="sep" />
                <span>
                  {lib.card.covers.exists
                    ? `covers.bin on card: ${lib.card.covers.count ?? '?'} games, written ${fmtDate(lib.card.covers.modifiedAt)}`
                    : 'No covers.bin on this card yet'}
                  {lib.card.manifest.exists ? `, ${lib.card.manifest.placed} ROMs placed by the app` : ''}
                </span>
              </>
            )}
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
          onClose={() => {
            setPicker(null);
            setPickingCart(false);
          }}
          onSaved={() => {
            setPicker(null);
            if (pickingCart) {
              setPickingCart(false);
              void loadCarts();
            } else void load(true);
          }}
        />
      )}
      {syncing && activeCard && lib && (
        <SyncModal
          card={lib.card?.root ?? activeCard}
          isPocket={!!vol?.isPocket}
          onClose={(synced) => {
            setSyncing(false);
            if (synced) void load(true);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
