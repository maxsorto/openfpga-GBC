import { useEffect, useRef, useState } from 'react';
import { fittedUrl, type Game } from './api';
import { IconCheck, IconPencil, IconWarn } from './Icons';

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
  canInclude: boolean;
  onOpen: () => void;
  onToggle: (include: boolean) => void;
  onRename: (title: string) => void;
}

export function GameCard({ game, canInclude, onOpen, onToggle, onRename }: Props) {
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
    if (t && t !== game.title) onRename(t);
  };

  const blocked = game.problems.length > 0;
  const toggleDisabled = blocked || (!game.included && !canInclude);

  return (
    <div className={`card ${game.included ? '' : 'excluded'}`}>
      <div className="cover-wrap">
        <button className="cover" onClick={onOpen} title="Change cover">
          <img src={fittedUrl(game.art, game.title)} alt="" width={128} height={128} draggable={false} />
          <span className="cover-hover">Change cover</span>
        </button>
        <label
          className={`include ${game.included ? 'on' : ''} ${toggleDisabled ? 'disabled' : ''}`}
          title={blocked ? game.problems.join(' ') : !game.included && !canInclude ? 'All 31 slots are in use' : game.included ? 'On the Pocket' : 'Not on the Pocket'}
        >
          <input type="checkbox" checked={game.included} disabled={toggleDisabled} onChange={(e) => onToggle(e.target.checked)} />
          <span className="box">{game.included && <IconCheck size={12} />}</span>
        </label>
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
          {game.titleBytes > 39 && <span className="sys warn" title="Titles are cut to 39 characters on the Pocket">39+</span>}
        </div>
        <div className="file" title={game.file}>
          {game.file}
        </div>
      </div>
    </div>
  );
}
