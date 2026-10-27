import { useEffect, useState } from 'react';
import { api, subscribeSync, type SyncEvent, type SyncPhase, type SyncPlan } from './api';
import { IconCheck, IconClose, IconEject, IconStar, IconWarn } from './Icons';
import { fmtBytes, isVolumePath, words } from './util';

type Stage = 'planning' | 'plan' | 'running' | 'done' | 'error';

// In the order sync runs them. (With a nearly full card, removing comes before copying.)
const STEPS: { phase: SyncPhase; label: string }[] = [
  { phase: 'check', label: 'Check the card' },
  { phase: 'copy', label: 'Copy ROMs and verify each one' },
  { phase: 'remove', label: 'Remove ROMs that left the library' },
  { phase: 'pack', label: 'Build and write covers.bin' },
  { phase: 'verify', label: 'Read covers.bin back and verify it' },
  { phase: 'write', label: 'Put covers.bin in place and write the manifest' },
];

type FileEvent = Extract<SyncEvent, { type: 'file' }>;
type BytesEvent = Extract<SyncEvent, { type: 'bytes' }>;

/** Bytes progress for the current phase, with when it started, for a time estimate. */
interface Bytes extends BytesEvent {
  startedAt: number;
  startDone: number;
  flushSince: number | null;
}

function fmtSecs(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}

/** "12.0 MB of 44.5 MB, about 40 s left", or the flush timer. */
function bytesLine(b: Bytes, now: number): string {
  if (b.flushing && b.flushSince != null) return `${b.label ?? 'Flushing to the card'}, ${fmtSecs((now - b.flushSince) / 1000)}`;
  const amount = `${fmtBytes(b.done)} of ${fmtBytes(b.total)}`;
  const secs = (now - b.startedAt) / 1000;
  const moved = b.done - b.startDone;
  if (secs < 1.5 || moved <= 0 || b.done >= b.total) return amount;
  const left = (b.total - b.done) / (moved / secs);
  return `${amount}, about ${fmtSecs(left)} left`;
}

interface Props {
  card: string;
  isPocket: boolean;
  onClose: (synced: boolean) => void;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'dim' }) {
  return (
    <div className={`tile ${tone ?? ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function SyncModal({ card, isPocket, onClose }: Props) {
  const [stage, setStage] = useState<Stage>('planning');
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [seen, setSeen] = useState<SyncPhase[]>([]);
  const [file, setFile] = useState<FileEvent | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<{ level: string; message: string }[]>([]);
  const [result, setResult] = useState<Extract<SyncEvent, { type: 'done' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eject, setEject] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; steps: string[] }>({ state: 'idle', steps: [] });
  const [bytes, setBytes] = useState<Bytes | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [replan, setReplan] = useState(0);
  const [changed, setChanged] = useState(false);

  // Per game: keep the card's own copy, or use the library's. Plans again after.
  async function chooseCopy(crc: string, useLibrary: boolean) {
    try {
      await api.saveChoices({ [crc]: { useLibraryCopy: useLibrary ? true : null } });
      setChanged(true);
      setReplan((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
      setStage('error');
    }
  }

  useEffect(() => {
    let alive = true;
    api
      .plan(card)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        setStage('plan');
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setStage('error');
      });
    return () => {
      alive = false;
    };
  }, [card, replan]);

  const canEject = isVolumePath(card);

  // A clock for the time estimate and the flush timer.
  useEffect(() => {
    if (stage !== 'running') return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [stage]);

  async function start() {
    if (!plan) return;
    setStage('running');
    try {
      const jobId = await api.startSync(card, plan.signature);
      await subscribeSync(jobId, (e) => {
        if (e.type === 'phase') {
          setSeen((s) => (s.includes(e.phase) ? s : [...s, e.phase]));
          setProgress(0);
          setBytes(null);
        } else if (e.type === 'bytes') {
          const t = Date.now();
          setNow(t);
          setBytes((prev) => {
            const same = prev && prev.phase === e.phase && prev.total === e.total && prev.label === e.label;
            return {
              ...e,
              startedAt: same ? prev.startedAt : t,
              startDone: same ? prev.startDone : e.done,
              flushSince: e.flushing ? (same && prev.flushSince != null ? prev.flushSince : t) : null,
            };
          });
          setProgress(e.done / Math.max(1, e.total));
        } else if (e.type === 'file') {
          setFile(e);
          if (e.bytesTotal) setProgress(e.bytesDone / e.bytesTotal);
        } else if (e.type === 'progress') setProgress(e.done / Math.max(1, e.total));
        else if (e.type === 'log') setLogs((l) => [...l, { level: e.level, message: e.message }]);
        else if (e.type === 'done') {
          setResult(e);
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
      const r = await api.eject(card);
      setEject({ state: r.ok ? 'ok' : 'fail', steps: r.steps });
    } catch (e) {
      setEject({ state: 'fail', steps: [(e as Error).message] });
    }
  }

  const current = seen[seen.length - 1];
  const stepState = (p: SyncPhase) => {
    if (stage === 'error' && p === current) return 'fail';
    if (p === current && stage === 'running') return 'active';
    if (seen.includes(p)) return 'done';
    if (stage === 'done') return 'skip';
    // Steps with nothing to do show as skipped once sync is past them.
    if (plan && stage === 'running') {
      const nothing =
        (p === 'copy' && !plan.copy.length) || (p === 'remove' && !plan.remove.length) || ((p === 'pack' || p === 'verify') && !plan.pack.count);
      const passed = STEPS.findIndex((x) => x.phase === p) < STEPS.findIndex((x) => x.phase === current);
      if (nothing && passed) return 'skip';
    }
    return 'todo';
  };
  const stepNote = (p: SyncPhase) => {
    if (!plan) return null;
    if (p === 'copy') {
      if (!plan.copy.length) return stage === 'done' || seen.length > 1 ? 'nothing to copy' : null;
      if (file && current === 'copy') return `${file.index} of ${file.total}`;
      return `${plan.copy.length}`;
    }
    if (p === 'check' && plan.adopt.length) return `${plan.adopt.length} adopted`;
    if (p === 'remove') return plan.remove.length ? `${plan.remove.length}` : stage === 'done' ? 'nothing to remove' : null;
    if ((p === 'pack' || p === 'verify') && current === p && bytes?.phase === p) return `${Math.floor(progress * 100)}%`;
    if (p === 'pack' && !plan.pack.count) return stage === 'done' ? 'no games' : null;
    return null;
  };

  const space = plan?.space;
  const usedPct = space?.freeBytes ? Math.min(100, (space.neededBytes / space.freeBytes) * 100) : 0;

  return (
    <div className="backdrop">
      <div className="modal sync">
        <header>
          <div>
            <div className="modal-title">Sync to Pocket</div>
            <div className="modal-sub">{card}</div>
          </div>
          {stage !== 'running' && (
            <button className="icon-btn" onClick={() => onClose(stage === 'done' || changed)} aria-label="Close">
              <IconClose />
            </button>
          )}
        </header>

        <div className="sync-body">
          {stage === 'planning' && (
            <div className="loading">
              <span className="spinner" /> Comparing the library with the card…
            </div>
          )}

          {stage === 'plan' && plan && (
            <>
              <div className="tiles">
                <Tile label="Copy" value={`${plan.copy.length}`} sub={plan.copy.length ? fmtBytes(plan.copyBytes) : 'nothing new'} />
                <Tile label="Remove" value={`${plan.remove.length}`} sub={plan.remove.length ? fmtBytes(plan.removeBytes) : 'nothing'} tone={plan.remove.length ? 'warn' : undefined} />
                {plan.adopt.length > 0 ? (
                  <Tile label="Adopt" value={`${plan.adopt.length}`} sub={`${plan.unchanged} unchanged`} />
                ) : (
                  <Tile label="Unchanged" value={`${plan.unchanged}`} sub="skipped" tone="dim" />
                )}
                <Tile
                  label={`Pack v${plan.pack.version}`}
                  value={`${plan.pack.count}`}
                  sub={plan.pack.streaming && plan.pack.favCount ? `${fmtBytes(plan.pack.bytes)}, ${plan.pack.favCount} twice` : fmtBytes(plan.pack.bytes)}
                />
              </div>

              <div className={`space ${space?.enough ? '' : 'short'}`}>
                <div className="space-text">
                  <span>
                    Needs <strong>{fmtBytes(space?.neededBytes)}</strong> free
                  </span>
                  <span className="dim">{space?.freeBytes != null ? `${fmtBytes(space.freeBytes)} free on the card` : 'Free space unknown'}</span>
                </div>
                <div className="bar meter" aria-hidden="true">
                  <div style={{ width: `${Math.max(usedPct, 1)}%` }} />
                </div>
              </div>

              {!space?.enough && (
                <div className="notice error">
                  <IconWarn /> Not enough space on the card. Nothing will be written. Remove games from the library or free up the card.
                </div>
              )}
              {space?.removeFirst && (
                <div className="notice muted">Space is tight, so sync removes the old ROMs first, then copies.</div>
              )}
              {plan.manifest.error && (
                <div className="notice error">
                  <IconWarn /> cover-picker.json on the card could not be read: {plan.manifest.error}. Sync will not run until it is moved aside.
                </div>
              )}
              {plan.pack.streaming ? (
                <div className="notice ok">
                  <IconCheck />
                  <div>
                    {plan.pack.reason} covers.bin is pack v{plan.pack.version}, {fmtBytes(plan.pack.bytes)}. Favorites come first, then A to Z.
                  </div>
                </div>
              ) : plan.menuGames > plan.pack.limit ? (
                <div className="notice">
                  <IconWarn />
                  <div>
                    {plan.pack.reason} All {plan.menuGames} games still go on the card. covers.bin holds the first {plan.pack.limit}: favorites first,
                    then A to Z.
                  </div>
                </div>
              ) : (
                <div className="notice muted">{plan.pack.reason}</div>
              )}
              {plan.pocketFavorites && plan.pocketFavorites.changes.length > 0 && (
                <div className="notice ok">
                  <IconStar on />
                  <div>
                    {(() => {
                      const ch = plan.pocketFavorites.changes;
                      const on = ch.filter((c) => c.favorite).length;
                      return `${ch.length} favorite ${ch.length === 1 ? 'change' : 'changes'} from the Pocket: ${on} starred, ${ch.length - on} unstarred. Sync saves them here and puts them in covers.bin, then empties favorites.cfg.`;
                    })()}
                  </div>
                </div>
              )}
              {plan.carryOver.length > 0 && (
                <div className="notice ok">
                  <IconCheck />
                  <div>
                    {plan.carryOver.map((c) => (
                      <div key={c.file}>
                        {c.title}: new dump, keeps your {words(c.kept)}.
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {plan.suspends.length > 0 && (
                <div className="notice">
                  <IconWarn />
                  <div>
                    {plan.suspends.map((x) => (
                      <div key={x.file}>Suspend point for {x.title} was made with a different ROM and will be cleared.</div>
                    ))}
                    <div className="dim">Resuming it would crash the core. A copy is kept on this Mac. The battery save is not touched.</div>
                  </div>
                </div>
              )}
              {plan.saves.some((x) => x.state === 'loses') && (
                <div className="notice">
                  <IconWarn />
                  <div>
                    {(() => {
                      const n = plan.saves.filter((x) => x.state === 'loses').length;
                      return `${n} ${n === 1 ? 'save loses its' : 'saves lose their'} ROM in this sync. The ${n === 1 ? 'save stays' : 'saves stay'} on the card, and ${n === 1 ? 'works' : 'work'} again if the game comes back under the same name.`;
                    })()}
                  </div>
                </div>
              )}
              {!isPocket && <div className="notice muted">This is a folder, not a detected Pocket card. That is fine for testing.</div>}
              {!plan.manifest.exists && (
                <div className="notice muted">
                  First sync to this card. The app keeps a list of the ROMs it places in cover-picker.json, and only ever removes those.
                </div>
              )}

              <div className="plan-lists">
                {plan.copy.length > 0 && (
                  <details open={plan.copy.length <= 12}>
                    <summary>
                      To copy <span className="count">{plan.copy.length}</span>
                    </summary>
                    <ul className="plan-list">
                      {plan.copy.map((c) => (
                        <li key={c.file}>
                          <span className="grow ellipsis">{c.file}</span>
                          {c.reason !== 'new' && (
                            <span className="chip guessed">{c.reason === 'changed' ? 'Changed' : c.reason === 'missing' ? 'Missing' : 'Replaces card copy'}</span>
                          )}
                          {c.reason === 'replace' && (
                            <button className="link small" onClick={() => chooseCopy(c.crc, false)}>
                              Keep the card's
                            </button>
                          )}
                          <span className="dim mono">{fmtBytes(c.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.adopt.length > 0 && (
                  <details open={plan.adopt.length <= 6}>
                    <summary>
                      Adopted <span className="count">{plan.adopt.length}</span>
                    </summary>
                    <p className="plan-note">
                      You put these on the card, and they are the same ROMs as in your library. The app takes them over under their current names, so
                      their saves keep working. From now on they are removed if they leave the library.
                    </p>
                    <ul className="plan-list">
                      {plan.adopt.map((a) => (
                        <li key={a.file}>
                          <span className="grow ellipsis">{a.file}</span>
                          <span className="dim mono">{a.crc}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.keptCard.length > 0 && (
                  <details open>
                    <summary>
                      Kept the card's version <span className="count">{plan.keptCard.length}</span>
                    </summary>
                    <p className="plan-note">
                      A different ROM with the same name is already on the card, and its save is tied to that name. The card's copy stays and the
                      library's is not copied.
                    </p>
                    <ul className="plan-list">
                      {plan.keptCard.map((k) => (
                        <li key={k.crc}>
                          <span className="grow ellipsis" title={`Library: ${k.libraryFile} (${k.crc}). Card: ${k.cardFile} (${k.cardCrc ?? '?'})`}>
                            {k.cardFile}
                          </span>
                          <button className="link small" onClick={() => chooseCopy(k.crc, true)}>
                            Use the library's
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.remove.length > 0 && (
                  <details open>
                    <summary>
                      To remove <span className="count">{plan.remove.length}</span>
                    </summary>
                    <p className="plan-note">These left the library. Only ROMs this app placed are removed. Their saves stay.</p>
                    <ul className="plan-list">
                      {plan.remove.map((r) => (
                        <li key={r.file}>
                          <span className="grow ellipsis">{r.file}</span>
                          <span className="dim mono">{fmtBytes(r.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.cardOnly.length > 0 && (
                  <details>
                    <summary>
                      On the card, not from this app <span className="count">{plan.cardOnly.length}</span>
                    </summary>
                    <p className="plan-note">You put these there. Sync leaves them alone.</p>
                    <ul className="plan-list">
                      {plan.cardOnly.map((f) => (
                        <li key={f}>
                          <span className="grow ellipsis">{f}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.pocketFavorites && plan.pocketFavorites.changes.length > 0 && (
                  <details>
                    <summary>
                      Favorites from the Pocket <span className="count">{plan.pocketFavorites.changes.length}</span>
                    </summary>
                    <ul className="plan-list">
                      {plan.pocketFavorites.changes.map((c) => (
                        <li key={c.crc}>
                          <span className="grow ellipsis">{c.titles.join(', ') || `Not in the library or on the card (${c.crc})`}</span>
                          <span className={`chip ${c.favorite ? 'chosen' : 'none'}`}>{c.favorite ? 'Starred' : 'Unstarred'}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {plan.saves.length > 0 && (
                  <details open={plan.saves.some((x) => x.state === 'loses')}>
                    <summary>
                      Saves <span className="count">{plan.saves.length}</span>
                    </summary>
                    <p className="plan-note">Each save and the ROM it belongs to after sync. Saves are only read, never moved or renamed.</p>
                    <ul className="plan-list">
                      {plan.saves.map((x) => (
                        <li key={x.file}>
                          <span className="grow ellipsis">{x.file}</span>
                          {x.rom ? (
                            <span className="dim ellipsis save-rom">{x.rom}</span>
                          ) : (
                            <span className={`chip ${x.state === 'loses' ? 'problem' : 'none'}`}>{x.state === 'loses' ? 'Loses its ROM' : 'No ROM'}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <details>
                  <summary>
                    In covers.bin, in menu order <span className="count">{plan.pack.count}</span>
                  </summary>
                  <ol className="sync-list">
                    {plan.pack.titles.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ol>
                </details>
              </div>
              <p className="plan-foot dim">
                Battery saves (.sav) are never touched. Under Saves, sync only empties favorites.cfg after saving its changes, and a suspend point
                made with a different ROM, after keeping a copy.
              </p>
            </>
          )}

          {(stage === 'running' || stage === 'done' || (stage === 'error' && seen.length > 0)) && (
            <>
              <ul className="steps">
                {STEPS.map((s) => {
                  const state = stepState(s.phase);
                  const note = stepNote(s.phase);
                  return (
                    <li key={s.phase} className={state}>
                      <span className="step-mark">
                        {state === 'done' ? <IconCheck size={12} /> : state === 'fail' ? <IconClose size={12} /> : null}
                      </span>
                      {s.phase === 'pack' && plan ? `Build and write covers.bin (pack v${plan.pack.version})` : s.label}
                      {note && <span className="dim mono step-note">{note}</span>}
                    </li>
                  );
                })}
              </ul>
              {stage === 'running' && (
                <div className="now">
                  <div className="now-line">
                    {current === 'copy' && file ? (
                      <>
                        <span className="grow ellipsis">
                          {file.state === 'copying' ? 'Copying' : 'Verified'} <strong>{file.file}</strong>
                        </span>
                        <span className="dim mono">{bytes?.phase === 'copy' ? bytesLine(bytes, now) : `${fmtBytes(file.bytesDone)} of ${fmtBytes(file.bytesTotal)}`}</span>
                      </>
                    ) : bytes && bytes.phase === current ? (
                      <>
                        <span className="grow ellipsis">
                          {bytes.flushing ? (
                            <strong>Flushing to the card</strong>
                          ) : (
                            bytes.label ?? STEPS.find((s) => s.phase === current)?.label
                          )}
                        </span>
                        <span className="dim mono">{bytesLine(bytes, now)}</span>
                      </>
                    ) : (
                      <span className="dim">{current ? STEPS.find((s) => s.phase === current)?.label : 'Checking the card'}…</span>
                    )}
                  </div>
                  <div className={`bar ${bytes?.flushing ? 'flushing' : ''}`}>
                    <div style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                </div>
              )}
              {stage === 'done' && result && (
                <div className="success">
                  <IconCheck size={18} />
                  <div>
                    <div className="success-title">Synced and verified</div>
                    <div className="dim">
                      Copied {result.copied}, removed {result.removed}
                      {plan?.adopt.length ? `, adopted ${plan.adopt.length}` : ''}, {result.unchanged} unchanged. covers.bin has {result.count} games ({fmtBytes(result.bytes)}) and
                      matches byte for byte.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {stage === 'error' && <div className="notice error">{error}</div>}
          {logs.length > 0 && stage !== 'plan' && (
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
        </div>

        <footer>
          <span className="grow" />
          {(stage === 'planning' || stage === 'plan') && (
            <>
              <button onClick={() => onClose(changed)}>Cancel</button>
              <button className="primary" onClick={start} disabled={!plan || !plan.space.enough || !!plan.manifest.error}>
                {plan && plan.copy.length ? `Copy ${plan.copy.length} and write` : 'Write covers.bin'}
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
