import { useEffect, useMemo, useRef, useState } from 'react';
import { api, boxartUrl, fittedUrl, type ArtRef, type Candidate, type Game } from './api';
import { IconClose, IconImage, IconSearch } from './Icons';
import { STATUS_LABEL } from './GameCard';
import { hasNonAscii, titleBytes } from './util';

type Pick = { mode: 'auto' } | { mode: 'ref'; ref: ArtRef };

function sameRef(a: ArtRef | null, b: ArtRef | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function initialPick(g: Game): Pick {
  const explicit = g.status === 'chosen' || g.status === 'custom' || (g.status === 'none' && g.auto.status !== 'none');
  return explicit && g.art ? { mode: 'ref', ref: g.art } : explicit ? { mode: 'ref', ref: { kind: 'placeholder' } } : { mode: 'auto' };
}

interface Props {
  game: Game;
  onClose: () => void;
  onSaved: () => void;
}

export function PickerModal({ game, onClose, onSaved }: Props) {
  const [pick, setPick] = useState<Pick>(() => initialPick(game));
  const [title, setTitle] = useState(game.title);
  const [query, setQuery] = useState(game.datName ?? game.defaultTitle);
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        setResults(await api.candidates(q, game.isGb ? 'gb' : 'gbc'));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, game.isGb]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const effective: ArtRef | null = pick.mode === 'auto' ? game.auto.art : pick.ref;
  const bytes = titleBytes(title.trim());

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      setPick({ mode: 'ref', ref: await api.uploadArt(game.crc, file) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const t = title.trim() || game.defaultTitle;
    try {
      await api.saveChoices({
        [game.crc]: {
          art: pick.mode === 'auto' ? null : pick.ref,
          title: t === game.defaultTitle ? null : t,
        },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const autoLabel = useMemo(() => {
    if (!game.auto.art) return 'Nothing found. Shows a title card.';
    return `${STATUS_LABEL[game.auto.status]}: ${game.auto.label}`;
  }, [game]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal picker ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void upload(f);
        }}
      >
        <header>
          <div>
            <div className="modal-title">{game.title}</div>
            <div className="modal-sub">{game.file}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>

        <div className="picker-body">
          <aside className="picker-side">
            <div className="bezel">
              <div className="bezel-top">
                <span className="bezel-lines" />
                <span className="bezel-caption">On the Pocket</span>
                <span className="bezel-lines" />
              </div>
              <div className="screen">
                <img src={fittedUrl(effective, title.trim() || game.defaultTitle, 128)} alt="" width={256} height={256} />
              </div>
              <div className="screen-small-row">
                <div className="screen small">
                  <img src={fittedUrl(effective, title.trim() || game.defaultTitle, 80)} alt="" width={80} height={80} />
                </div>
                <div className="screen-caption">128 px center<br />80 px list<br />16 bit color</div>
              </div>
            </div>

            <label className="field">
              <span className="side-label">Title</span>
              <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="field-note">
              <span className={bytes > 39 ? 'warn-text' : ''}>{bytes} of 39 characters</span>
              {title.trim() !== game.defaultTitle && (
                <button className="link" onClick={() => setTitle(game.defaultTitle)}>
                  Reset
                </button>
              )}
            </div>
            {bytes > 39 && <div className="field-note warn-text">Only the first 39 characters will show.</div>}
            {hasNonAscii(title) && <div className="field-note warn-text">Accented letters show as "?" on the Pocket.</div>}
            {game.datName && <div className="field-note dim">No-Intro: {game.datName}</div>}
          </aside>

          <section className="picker-main">
            <div className="options">
              <button className={`option ${pick.mode === 'auto' ? 'selected' : ''}`} onClick={() => setPick({ mode: 'auto' })}>
                <span className="option-title">Automatic</span>
                <span className="option-sub">{autoLabel}</span>
              </button>
              <button
                className={`option ${pick.mode === 'ref' && pick.ref.kind === 'placeholder' ? 'selected' : ''}`}
                onClick={() => setPick({ mode: 'ref', ref: { kind: 'placeholder' } })}
              >
                <span className="option-title">Title card</span>
                <span className="option-sub">The game name on a plain background</span>
              </button>
              <button
                className={`option drop ${pick.mode === 'ref' && pick.ref.kind === 'custom' ? 'selected' : ''}`}
                onClick={() => fileInput.current?.click()}
              >
                <span className="option-title">
                  <IconImage size={14} /> {uploading ? 'Reading image…' : 'Your own image'}
                </span>
                <span className="option-sub">Drop a PNG or JPEG here, or click to choose</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = '';
                }}
              />
            </div>

            <div className="search">
              <IconSearch />
              <input type="search" placeholder="Search libretro box art" value={query} onChange={(e) => setQuery(e.target.value)} />
              {searching && <span className="spinner" />}
            </div>

            <div className="results">
              {results.length === 0 && !searching && <div className="results-empty">No box art matches that search.</div>}
              {results.map((r) => {
                const ref: ArtRef = { kind: 'thumb', repo: r.repo, name: r.name };
                const selected = pick.mode === 'ref' ? sameRef(pick.ref, ref) : sameRef(game.auto.art, ref);
                return (
                  <button key={`${r.repo}/${r.name}`} className={`result ${selected ? 'selected' : ''}`} onClick={() => setPick({ mode: 'ref', ref })} title={r.name}>
                    <span className="result-art">
                      <img src={boxartUrl(r.repo, r.name, 200)} alt="" loading="lazy" />
                    </span>
                    <span className="result-name">{r.name}</span>
                    <span className="result-sys">{r.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="credit">Box art from libretro-thumbnails.</div>
          </section>
        </div>

        <footer>
          {error && <span className="error-text">{error}</span>}
          <span className="grow" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={saving || uploading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
        {dragging && <div className="drop-overlay">Drop the image to use it as the cover</div>}
      </div>
    </div>
  );
}
