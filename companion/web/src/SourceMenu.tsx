import { useEffect, useRef, useState } from 'react';
import { api, type Volume } from './api';
import { IconCard, IconChevron, IconFolder } from './Icons';
import { basename, fmtBytes } from './util';

interface Props {
  root: string | null;
  volumes: Volume[];
  freeBytes: number | null;
  onPick: (root: string) => void;
}

/** The pill in the title bar: which card or folder we are working on. */
export function SourceMenu({ root, volumes, freeBytes, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const vol = volumes.find((v) => v.mountPath === root);
  const pockets = volumes.filter((v) => v.isPocket);
  const others = volumes.filter((v) => !v.isPocket);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (p: string) => {
    setOpen(false);
    onPick(p);
  };

  const label = root ? (vol ? vol.name : basename(root)) : 'No card';
  const dot = root ? (vol?.isPocket ? 'ok' : 'folder') : 'off';

  return (
    <div className="source" ref={ref}>
      <button className="source-pill" onClick={() => setOpen((o) => !o)} title={root ?? ''}>
        <span className={`dot ${dot}`} />
        {vol ? <IconCard /> : root ? <IconFolder /> : <IconCard />}
        <span className="source-name">{label}</span>
        {root && freeBytes != null && <span className="source-free">{fmtBytes(freeBytes)} free</span>}
        <IconChevron className="chev" />
      </button>
      {open && (
        <div className="menu">
          <div className="menu-label">Pocket cards</div>
          {pockets.length === 0 && <div className="menu-empty">No Pocket card found. Insert one, or pick a folder.</div>}
          {pockets.map((v) => (
            <button key={v.mountPath} className={`menu-item ${v.mountPath === root ? 'active' : ''}`} onClick={() => pick(v.mountPath)}>
              <IconCard />
              <span className="grow">{v.name}</span>
              <span className="dim">{fmtBytes(v.freeBytes)} free</span>
            </button>
          ))}
          {others.length > 0 && <div className="menu-label">Other volumes</div>}
          {others.map((v) => (
            <button key={v.mountPath} className={`menu-item ${v.mountPath === root ? 'active' : ''}`} onClick={() => pick(v.mountPath)}>
              <IconCard />
              <span className="grow">{v.name}</span>
              <span className="dim">{fmtBytes(v.freeBytes)} free</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={async () => {
              setOpen(false);
              const r = await api.chooseFolder();
              if (r.path) onPick(r.path);
            }}
          >
            <IconFolder />
            <span className="grow">Choose a folder…</span>
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
          <div className="menu-hint">A folder works like a card if it has Assets/gbc/common inside.</div>
        </div>
      )}
    </div>
  );
}
