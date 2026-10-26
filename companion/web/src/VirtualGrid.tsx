import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

/** A full width row (a section header or a note), or a run of cards that wraps into rows. */
export type Block<T> = { kind: 'row'; key: string; height: number; node: ReactNode } | { kind: 'items'; key: string; items: T[] };

interface Props<T> {
  blocks: Block<T>[];
  /** The element that scrolls. */
  scroller: RefObject<HTMLElement>;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  minColumn?: number;
  gapX?: number;
  /** Card height plus the gap below it. Cards have a fixed height so rows never shift. */
  rowHeight?: number;
}

type Row<T> = { key: string; top: number; height: number } & ({ kind: 'row'; node: ReactNode } | { kind: 'items'; items: T[] });

/**
 * Only the rows near the screen are in the page, so 700 games scroll as
 * smoothly as 30. Rows have fixed heights; their positions are worked out
 * from the column count.
 */
export function VirtualGrid<T>({ blocks, scroller, itemKey, renderItem, minColumn = 176, gapX = 18, rowHeight = 280 }: Props<T>) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: 900 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const offset = box.current ? box.current.offsetTop : 0;
      setView({ top: s.scrollTop - offset, height: s.clientHeight });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    s.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      s.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller]);

  const columns = Math.max(1, Math.floor((width + gapX) / (minColumn + gapX)));

  const { rows, total } = useMemo(() => {
    const out: Row<T>[] = [];
    let y = 0;
    for (const b of blocks) {
      if (b.kind === 'row') {
        out.push({ kind: 'row', key: b.key, top: y, height: b.height, node: b.node });
        y += b.height;
        continue;
      }
      for (let i = 0; i < b.items.length; i += columns) {
        out.push({ kind: 'items', key: `${b.key}:${i}`, top: y, height: rowHeight, items: b.items.slice(i, i + columns) });
        y += rowHeight;
      }
    }
    return { rows: out, total: y };
  }, [blocks, columns, rowHeight]);

  const margin = rowHeight * 2;
  const from = view.top - margin;
  const to = view.top + view.height + margin;
  const visible = rows.filter((r) => r.top + r.height >= from && r.top <= to);

  return (
    <div ref={box} className="vgrid" style={{ height: total }}>
      {visible.map((r) =>
        r.kind === 'row' ? (
          <div key={r.key} className="vgrid-row" style={{ top: r.top, height: r.height }}>
            {r.node}
          </div>
        ) : (
          <div
            key={r.key}
            className="vgrid-cards"
            style={{ top: r.top, height: r.height, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gapX }}
          >
            {r.items.map((it) => (
              <div key={itemKey(it)} className="vgrid-cell">
                {renderItem(it)}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
