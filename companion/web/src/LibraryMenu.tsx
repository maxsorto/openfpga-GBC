import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { IconChevron, IconFolder, IconGrid } from './Icons';
import { basename } from './util';

interface Props {
  libraryRoot: string | null;
  games: number | null;
  hasCard: boolean;
  onPick: (root: string | null) => void;
}

/** The pill in the title bar for the Mac library folder. */
export function LibraryMenu({ libraryRoot, games, hasCard, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (p: string | null) => {
    setOpen(false);
    onPick(p);
  };

  return (
    <div className="source" ref={ref}>
      <button className="source-pill" onClick={() => setOpen((o) => !o)} title={libraryRoot ?? 'No library folder'}>
        <span className={`dot ${libraryRoot ? 'folder' : 'off'}`} />
        {libraryRoot ? <IconFolder /> : <IconGrid />}
        <span className="source-name">{libraryRoot ? basename(libraryRoot) : hasCard ? 'Card ROMs' : 'No library'}</span>
        {games != null && <span className="source-free">{games} games</span>}
        <IconChevron className="chev" />
      </button>
      {open && (
        <div className="menu">
          <div className="menu-label">Library folder</div>
          {libraryRoot ? (
            <div className="menu-path-now">{libraryRoot}</div>
          ) : (
            <div className="menu-empty">
              None yet. {hasCard ? 'The ROMs on the card are used as the library.' : 'Pick the folder that holds your ROMs.'}
            </div>
          )}
          <button
            className="menu-item"
            onClick={async () => {
              setOpen(false);
              const r = await api.chooseFolder('library');
              if (r.path) onPick(r.path);
            }}
          >
            <IconFolder />
            <span className="grow">{libraryRoot ? 'Choose another folder…' : 'Choose a folder…'}</span>
          </button>
          <form
            className="menu-path"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) pick(typed.trim());
            }}
          >
            <input type="text" placeholder="Or type a path, then Return" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </form>
          {libraryRoot && hasCard && (
            <>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => pick(null)}>
                <IconGrid />
                <span className="grow">Use the ROMs on the card instead</span>
              </button>
            </>
          )}
          <div className="menu-hint">
            Every .gb and .gbc file in this folder and its subfolders. Hidden files are skipped. The same ROM twice counts once.
          </div>
        </div>
      )}
    </div>
  );
}
