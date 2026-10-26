import { memo, useEffect, useRef, useState } from 'react';
import { fittedUrl, type Game } from './api';
import { IconPencil, IconStar, IconWarn } from './Icons';

export const STATUS_LABEL: Record<Game['status'], string> = {
  exact: 'Exact',
  guessed: 'Guessed',
  none: 'No art',
  chosen: 'Picked',
  custom: 'Your image',
};

export const STATUS_HINT: Record<Game['status'], string> = {
  exact: 'The ROM matched No-Intro by CRC32, and art exists under that exact name.',
  guessed: 'Art was found by a similar name. Check that it is the right game.',
  none: 'No art found. The Pocket will show a title card.',
  chosen: 'You picked this art.',
  custom: 'You added this image.',
};

interface Props {
  game: Game;
  /** Place in the Pocket menu, counting from 1. Shown in the Pocket view only. */
  position?: number | null;
  /** Past what today's core shows. */
  beyondLimit?: boolean;
  onOpen: (g: Game) => void;
  onFavorite: (g: Game, on: boolean) => void;
  onRename: (g: Game, title: string) => void;
}

/** The cover image. Shows a quiet well while it loads, and a title card if the art fails. */
function Cover({ game }: { game: Game }) {
  const src = fittedUrl(game.art, game.title);
  const [state, setState] = useState<{ src: string; loaded: boolean; failed: boolean }>({ src, loaded: false, failed: false });
  const current = state.src === src ? state : { src, loaded: false, failed: false };
  const shown = current.failed ? fittedUrl(null, game.title) : src;
  return (
    <img
      key={shown}
      className={current.loaded ? 'loaded' : ''}
      src={shown}
      alt=""
      width={128}
      height={128}
      draggable={false}
      decoding="async"
      onLoad={() => setState({ ...current, loaded: true })}
      onError={() => !current.failed && setState({ src, loaded: false, failed: true })}
    />
  );
}

function GameCardImpl({ game, position, beyondLimit, onOpen, onFavorite, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(game.title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(game.title);
  }, [game.title, editing]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== game.title) onRename(game, t);
  };

  const blocked = game.problems.length > 0;
  const fileTitle = game.renamed ? `${game.file} on the card. In the library: ${game.paths.join(', ')}` : game.paths.join('\n');

  return (
    <div className={`card ${game.favorite ? 'fav' : ''} ${beyondLimit ? 'beyond' : ''}`}>
      <div className="cover-wrap">
        <button className="cover" onClick={() => onOpen(game)} title="Change cover">
          <Cover game={game} />
          <span className="cover-hover">Change cover</span>
        </button>
        <button
          className={`star ${game.favorite ? 'on' : ''}`}
          aria-pressed={game.favorite}
          aria-label={game.favorite ? `Unfavorite ${game.title}` : `Favorite ${game.title}`}
          title={game.favorite ? 'Unfavorite' : 'Favorite'}
          onClick={() => onFavorite(game, !game.favorite)}
        >
          <IconStar on={game.favorite} size={13} />
        </button>
        {position != null && (
          <span className="slot-no" title={beyondLimit ? 'On the card. Today\'s core shows the first 31.' : 'Shown on the Pocket today'}>
            {String(position).padStart(2, '0')}
          </span>
        )}
      </div>
      <div className="card-body">
        {editing ? (
          <input
            ref={input}
            className="title-input"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(game.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button className="title" onClick={() => setEditing(true)} title="Rename">
            <span className="title-text">{game.title}</span>
            <IconPencil size={12} className="pencil" />
          </button>
        )}
        <div className="meta">
          {blocked ? (
            <span className="chip problem" title={game.problems.join(' ')}>
              <IconWarn size={11} /> Path too long
            </span>
          ) : (
            <span className={`chip ${game.status}`} title={STATUS_HINT[game.status]}>
              {STATUS_LABEL[game.status]}
            </span>
          )}
          <span className="sys">{game.isGb ? 'GB' : 'GBC'}</span>
          {game.paths.length > 1 && (
            <span className="sys" title={`Same ROM ${game.paths.length} times in the library:\n${game.paths.join('\n')}`}>
              x{game.paths.length}
            </span>
          )}
          {game.titleBytes > 39 && <span className="sys warn" title="Titles are cut to 39 characters on the Pocket">39+</span>}
        </div>
        <div className="file" title={fileTitle}>
          {game.file}
        </div>
      </div>
    </div>
  );
}

export const GameCard = memo(GameCardImpl);
