import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.js';

export interface Volume {
  name: string;
  mountPath: string;
  fsType: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  /** Cores/ and Assets/ at the root, and exFAT or Analogue_Pocket.json. */
  isPocket: boolean;
  hasCoreStructure: boolean;
}

interface DiskInfo {
  fsType: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  wholeDisk: string | null;
}

/** `diskutil info -plist`, parsed with a few regexes to avoid a plist dependency. */
async function diskutilInfo(target: string): Promise<DiskInfo> {
  const empty = { fsType: null, totalBytes: null, freeBytes: null, wholeDisk: null };
  try {
    const res = await run('diskutil', ['info', '-plist', target], { timeoutMs: 8000 });
    if (res.code !== 0) return empty;
    const xml = res.stdout;
    const str = (k: string) => xml.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;
    const int = (k: string) => {
      const m = xml.match(new RegExp(`<key>${k}</key>\\s*<integer>(\\d+)</integer>`));
      return m ? Number(m[1]) : null;
    };
    return {
      fsType: str('FilesystemName') ?? str('FilesystemType') ?? str('FilesystemUserVisibleName'),
      totalBytes: int('TotalSize') ?? int('Size'),
      freeBytes: int('FreeSpace') ?? int('APFSContainerFree'),
      wholeDisk: str('ParentWholeDisk'),
    };
  } catch {
    return empty;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Mounted volumes under /Volumes, Pocket cards first. */
export async function listVolumes(): Promise<Volume[]> {
  let names: string[] = [];
  try {
    names = fs.readdirSync('/Volumes');
  } catch {
    return [];
  }
  const out: Volume[] = [];
  for (const name of names) {
    const mountPath = path.join('/Volumes', name);
    try {
      // "Macintosh HD" is a link to /; skip it.
      if (fs.lstatSync(mountPath).isSymbolicLink() && fs.realpathSync(mountPath) === '/') continue;
      if (!isDir(mountPath)) continue;
    } catch {
      continue;
    }
    const hasCoreStructure = isDir(path.join(mountPath, 'Cores')) && isDir(path.join(mountPath, 'Assets'));
    const hasPocketJson = fs.existsSync(path.join(mountPath, 'Analogue_Pocket.json'));
    const info = await diskutilInfo(mountPath);
    const isExfat = (info.fsType ?? '').toLowerCase().includes('exfat');
    out.push({
      name,
      mountPath,
      fsType: info.fsType,
      totalBytes: info.totalBytes,
      freeBytes: info.freeBytes,
      hasCoreStructure,
      isPocket: hasCoreStructure && (isExfat || hasPocketJson),
    });
  }
  out.sort((a, b) => (a.isPocket !== b.isPocket ? (a.isPocket ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}

/** Free and total bytes for any folder. */
export function folderSpace(p: string): { freeBytes: number | null; totalBytes: number | null } {
  try {
    const s = fs.statfsSync(p);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

export interface EjectResult {
  ok: boolean;
  steps: string[];
}

/**
 * Eject a card. If macOS refuses because something holds it open (often
 * loginwindow), flush with `sync`, force unmount the whole disk, then eject it.
 */
export async function ejectVolume(mountPath: string): Promise<EjectResult> {
  const steps: string[] = [];
  const resolved = path.resolve(mountPath);
  if (!resolved.startsWith('/Volumes/') || resolved.split('/').length !== 3) {
    return { ok: false, steps: ['Only volumes under /Volumes can be ejected.'] };
  }
  const info = await diskutilInfo(resolved);
  const first = await run('diskutil', ['eject', resolved], { timeoutMs: 60000 });
  steps.push(`diskutil eject: ${(first.stdout + first.stderr).trim()}`);
  if (first.code === 0) return { ok: true, steps };

  if (!info.wholeDisk) {
    steps.push('Could not find the disk for this volume, so a forced unmount was not tried.');
    return { ok: false, steps };
  }
  const dev = `/dev/${info.wholeDisk}`;
  await run('sync', [], { timeoutMs: 60000 });
  steps.push('sync: done');
  const unmount = await run('diskutil', ['unmountDisk', 'force', dev], { timeoutMs: 60000 });
  steps.push(`diskutil unmountDisk force: ${(unmount.stdout + unmount.stderr).trim()}`);
  if (unmount.code !== 0) return { ok: false, steps };
  const second = await run('diskutil', ['eject', dev], { timeoutMs: 60000 });
  steps.push(`diskutil eject ${dev}: ${(second.stdout + second.stderr).trim()}`);
  return { ok: second.code === 0, steps };
}
