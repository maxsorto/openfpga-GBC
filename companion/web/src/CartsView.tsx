import { fittedUrl, type Cart, type CartsInfo, type Game } from './api';
import { IconCard } from './Icons';
import { STATUS_HINT } from './GameCard';
import { fmtDate } from './util';

const CHIP: Record<string, string> = {
  exact: 'Exact',
  guessed: 'Guessed',
  chosen: 'Picked',
  custom: 'Your image',
  none: 'No match',
};

/** A cart as the cover picker sees it: a game whose id is the cart's id. */
export function cartAsGame(c: Cart): Game {
  return {
    id: c.id,
    crc: c.id,
    origin: 'card',
    cardState: 'cardOnly',
    cardFile: null,
    inheritsFrom: null,
    file: c.headerTitle,
    platform: 'gbc',
    size: 0,
    isGb: !(c.cgb & 0x80),
    paths: [],
    sourcePath: '',
    renamed: false,
    datName: c.identified?.name ?? null,
    defaultTitle: c.defaultTitle,
    title: c.title,
    titleEdited: c.titleEdited,
    titleBytes: c.title.length,
    auto: { status: c.identified?.status ?? 'none', art: c.autoArt, label: null },
    art: c.art,
    artLabel: null,
    status: c.status,
    favorite: false,
    lastPlayed: null,
    problems: [],
  };
}

function system(cgb: number): string {
  return cgb === 0xc0 ? 'GBC' : cgb === 0x80 ? 'GB + GBC' : 'GB';
}

interface Props {
  info: CartsInfo | null;
  loading: boolean;
  query: string;
  onChangeCover: (c: Cart) => void;
  onForget: (c: Cart) => void;
}

/** Carts the Pocket did not recognize, and what the next sync does with them. */
export function CartsView({ info, loading, query, onChangeCover, onForget }: Props) {
  if (!info) {
    return loading ? (
      <div className="loading">
        <span className="spinner" /> Looking for carts.
      </div>
    ) : null;
  }
  const q = query.trim().toLowerCase();
  const carts = info.carts.filter((c) => !q || c.title.toLowerCase().includes(q) || c.headerTitle.toLowerCase().includes(q));
  if (!info.carts.length) {
    return (
      <div className="empty inline">
        <div className="empty-icon">
          <IconCard size={34} />
        </div>
        <h2>No cartridges yet</h2>
        <p>
          When you insert a cart the Pocket does not recognize, it shows a plain cartridge with the cart's title and notes it. After the next sync it
          shows up here, and the Pocket shows its real cover from then on.
        </p>
      </div>
    );
  }
  const pending = info.carts.filter((c) => c.pending).length;
  return (
    <>
      <div className="banner info">
        <IconCard />
        <span>
          Carts the Pocket did not recognize. The ones with a cover go in covers.bin, so Play Cartridge shows them.
          {pending > 0 && ` ${pending} new on the card, saved when you sync.`}
        </span>
      </div>
      <div className="grid carts-grid">
        {carts.map((c) => (
          <div key={c.id} className="card cart-card">
            <div className="cover-wrap">
              <button className="cover" onClick={() => onChangeCover(c)} title="Change cover">
                <img
                  src={fittedUrl(c.art, c.title)}
                  alt=""
                  width={128}
                  height={128}
                  draggable={false}
                  onLoad={(e) => e.currentTarget.classList.add('loaded')}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (!img.dataset.fallback) {
                      img.dataset.fallback = '1';
                      img.src = fittedUrl(null, c.title);
                    }
                  }}
                />
                <span className="cover-hover">Change cover</span>
              </button>
            </div>
            <div className="card-body">
              <div className="title cart-title">
                <span className="title-text">{c.inLibrary ?? c.title}</span>
              </div>
              <div className="meta">
                {c.inLibrary ? (
                  <span className="chip exact" title="A game in your library. Play Cartridge already shows its cover.">
                    In library
                  </span>
                ) : (
                  <span className={`chip ${c.status}`} title={c.status === 'none' ? 'Nothing fits. The Pocket shows a plain cartridge with its title. Pick a cover to fix it.' : STATUS_HINT[c.status]}>
                    {CHIP[c.status]}
                  </span>
                )}
                <span className="sys">{system(c.cgb)}</span>
                {c.pending && <span className="sys warn">New</span>}
              </div>
              <div className="file" title={`Header title ${c.headerTitle}${c.code ? `, game code ${c.code}` : ''}${c.lastSeen ? `. Last seen ${fmtDate(c.lastSeen)}` : ''}`}>
                {c.headerTitle}
                {c.code ? ` · ${c.code}` : ''}
              </div>
              <div className="cart-actions">
                <button className="link small" onClick={() => onChangeCover(c)}>
                  Change cover
                </button>
                {!c.pending && (
                  <button className="link small" onClick={() => onForget(c)}>
                    Forget
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {carts.length === 0 && <div className="loading">No carts match this filter.</div>}
    </>
  );
}
