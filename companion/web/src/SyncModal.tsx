import { useState } from 'react';
import { api, subscribeSync, type Game, type SyncEvent } from './api';
import { IconCheck, IconClose, IconEject, IconWarn } from './Icons';
import { fmtBytes, isVolumePath } from './util';

type Stage = 'confirm' | 'running' | 'done' | 'error';

const STEPS: { phase: string; label: string }[] = [
  { phase: 'prepare', label: 'Read the ROM folder' },
  { phase: 'art', label: 'Prepare art' },
  { phase: 'build', label: 'Build covers.bin' },
  { phase: 'write', label: 'Write to the card' },
  { phase: 'verify', label: 'Read back and verify' },
];

interface Props {
  root: string;
  isPocket: boolean;
  games: Game[];
  onClose: (synced: boolean) => void;
}

export function SyncModal({ root, isPocket, games, onClose }: Props) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [phase, setPhase] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<{ level: string; message: string }[]>([]);
  const [result, setResult] = useState<Extract<SyncEvent, { type: 'done' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eject, setEject] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; steps: string[] }>({ state: 'idle', steps: [] });

  const canEject = isVolumePath(root);
  const noArt = games.filter((g) => !g.art).length;

  async function start() {
    setStage('running');
    try {
      const jobId = await api.startSync(
        root,
        games.map((g) => g.id),
      );
      await subscribeSync(jobId, (e) => {
        if (e.type === 'phase') setPhase(e.phase);
        else if (e.type === 'progress') setProgress(e.done / Math.max(1, e.total));
        else if (e.type === 'log') setLogs((l) => [...l, { level: e.level, message: e.message }]);
        else if (e.type === 'done') {
          setResult(e);
          setPhase('finished');
          setStage('done');
        } else if (e.type === 'error') {
          setError(e.message);
          setStage('error');
        }
      });
    } catch (e) {
      setError((e as Error).message);
      setStage('error');
    }
  }

  async function doEject() {
    setEject({ state: 'busy', steps: [] });
    try {
      const r = await api.eject(root);
      setEject({ state: r.ok ? 'ok' : 'fail', steps: r.steps });
    } catch (e) {
      setEject({ state: 'fail', steps: [(e as Error).message] });
    }
  }

  const phaseIndex = phase === 'finished' ? STEPS.length : STEPS.findIndex((s) => s.phase === phase);

  return (
    <div className="backdrop">
      <div className="modal sync">
        <header>
          <div>
            <div className="modal-title">Sync to Pocket</div>
            <div className="modal-sub">{root}</div>
          </div>
          {stage !== 'running' && (
            <button className="icon-btn" onClick={() => onClose(stage === 'done')} aria-label="Close">
              <IconClose />
            </button>
          )}
        </header>

        <div className="sync-body">
          {stage === 'confirm' && (
            <>
              <p>
                This writes one file, <code>Assets/gbc/common/covers.bin</code>, with {games.length} {games.length === 1 ? 'game' : 'games'}.
                ROMs, saves and every other file stay as they are.
              </p>
              {!isPocket && (
                <div className="notice">
                  <IconWarn /> This is a folder, not a detected Pocket card. That is fine for testing.
                </div>
              )}
              {noArt > 0 && (
                <div className="notice muted">
                  {noArt} {noArt === 1 ? 'game has' : 'games have'} no art and will show a title card.
                </div>
              )}
              <ol className="sync-list">
                {games.map((g) => (
                  <li key={g.id}>{g.title}</li>
                ))}
              </ol>
            </>
          )}

          {stage !== 'confirm' && (
            <>
              <ul className="steps">
                {STEPS.map((s, i) => {
                  const state = stage === 'error' && i === phaseIndex ? 'fail' : i < phaseIndex ? 'done' : i === phaseIndex ? 'active' : 'todo';
                  return (
                    <li key={s.phase} className={state}>
                      <span className="step-mark">{state === 'done' ? <IconCheck size={12} /> : state === 'fail' ? <IconClose size={12} /> : null}</span>
                      {s.label}
                      {s.phase === 'art' && state === 'active' && <span className="dim"> {Math.round(progress * 100)}%</span>}
                    </li>
                  );
                })}
              </ul>
              {stage === 'running' && (
                <div className="bar">
                  <div style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              {stage === 'done' && result && (
                <div className="success">
                  <IconCheck size={18} />
                  <div>
                    <div className="success-title">Verified</div>
                    <div className="dim">
                      {result.count} games, {fmtBytes(result.bytes)}. The file on the card matches byte for byte.
                    </div>
                  </div>
                </div>
              )}
              {stage === 'error' && <div className="notice error">{error}</div>}
              {logs.length > 0 && (
                <div className="log">
                  {logs.map((l, i) => (
                    <div key={i} className={l.level}>
                      {l.message}
                    </div>
                  ))}
                </div>
              )}
              {eject.state !== 'idle' && (
                <div className={`notice ${eject.state === 'fail' ? 'error' : eject.state === 'ok' ? 'ok' : 'muted'}`}>
                  {eject.state === 'busy' && 'Ejecting…'}
                  {eject.state === 'ok' && 'Ejected. You can remove the card.'}
                  {eject.state === 'fail' && (
                    <div>
                      <div>Could not eject. Close any Finder windows on the card and try again.</div>
                      <pre>{eject.steps.join('\n')}</pre>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer>
          <span className="grow" />
          {stage === 'confirm' && (
            <>
              <button onClick={() => onClose(false)}>Cancel</button>
              <button className="primary" onClick={start}>
                Write covers.bin
              </button>
            </>
          )}
          {stage === 'running' && <span className="dim">Do not remove the card.</span>}
          {(stage === 'done' || stage === 'error') && (
            <>
              {stage === 'done' && canEject && eject.state !== 'ok' && (
                <button onClick={doEject} disabled={eject.state === 'busy'}>
                  <IconEject /> Eject
                </button>
              )}
              <button className="primary" onClick={() => onClose(stage === 'done')}>
                Done
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
