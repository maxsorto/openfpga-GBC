export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return 'unknown';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p;
}

export function isVolumePath(p: string): boolean {
  return /^\/Volumes\/[^/]+\/?$/.test(p);
}

/** Bytes the title takes in the pack: one per character, non ASCII becomes "?". */
export function titleBytes(t: string): number {
  return [...t].length;
}

export function hasNonAscii(t: string): boolean {
  return /[^\x00-\x7f]/.test(t);
}
