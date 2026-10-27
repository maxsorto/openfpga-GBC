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

/** Size of a covers.bin with this many games. Same rule as the server's packSize(). */
export function packBytes(version: number, count: number): number {
  if (count <= 0) return 0;
  const stride = version >= 7 ? 65536 : (128 * 128 + 80 * 80) * 2;
  const base = 16 + 512 + count * (128 + stride + 3 * 256) + 256;
  // v7 adds the favorites.cfg path struct and a 4 byte cartridge fingerprint per entry.
  return version >= 7 ? base + 256 + count * 4 : base;
}

/** "star, cover and title" */
export function words(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
