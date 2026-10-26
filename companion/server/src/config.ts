import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 4390 sits next to PocketTunes Sync (4380) so both can run at once.
export const PORT = Number(process.env.PORT ?? 4390);
export const HOME = os.homedir();

// Choices and your own cover images live here. Override with COMPANION_DATA_DIR.
export const DATA_DIR =
  process.env.COMPANION_DATA_DIR ?? path.join(HOME, 'Library', 'Application Support', 'GBC Cover Companion');
export const CUSTOM_ART_DIR = path.join(DATA_DIR, 'custom-art');
export const CHOICES_FILE = path.join(DATA_DIR, 'choices.json');

// Downloads that can be fetched again. Override with COMPANION_CACHE_DIR.
export const CACHE_DIR = process.env.COMPANION_CACHE_DIR ?? path.join(HOME, 'Library', 'Caches', 'GBC Cover Companion');
export const DAT_DIR = path.join(CACHE_DIR, 'dats');
export const TREE_DIR = path.join(CACHE_DIR, 'thumbnail-lists');
export const BOXART_DIR = path.join(CACHE_DIR, 'boxart');
export const CRC_CACHE_FILE = path.join(CACHE_DIR, 'rom-crc.json');
// Copies of covers.bin as it was on the card before each sync.
export const BACKUP_DIR = path.join(CACHE_DIR, 'covers-backups');

// How long downloaded lists stay fresh before we try to refresh them.
export const DAT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const TREE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Optional, raises the GitHub API rate limit for the thumbnail lists.
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

export const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/sbin', '/sbin'];
export const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [...EXTRA_PATH, process.env.PATH ?? ''].join(':'),
};

/**
 * ROM folders on the card. The core only looks in /Assets/gbc/common today.
 * Adding { platform: 'gb', rel: 'Assets/gb/common' } here is the hook for
 * original Game Boy folders later.
 */
export const ROM_FOLDERS: { platform: string; rel: string }[] = [{ platform: 'gbc', rel: 'Assets/gbc/common' }];
export const ROM_EXTENSIONS = ['.gb', '.gbc'];

// Where the core reads the pack, relative to the card root.
export const COVERS_REL = path.join('Assets', 'gbc', 'common', 'covers.bin');
export const PACK_PLATFORM = 'gbc';

export function ensureDirs(): void {
  for (const d of [DATA_DIR, CUSTOM_ART_DIR, CACHE_DIR, DAT_DIR, TREE_DIR, BOXART_DIR, BACKUP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
