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
/** App settings, such as the library folder. */
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Downloads that can be fetched again. Override with COMPANION_CACHE_DIR.
export const CACHE_DIR = process.env.COMPANION_CACHE_DIR ?? path.join(HOME, 'Library', 'Caches', 'GBC Cover Companion');
export const DAT_DIR = path.join(CACHE_DIR, 'dats');
export const TREE_DIR = path.join(CACHE_DIR, 'thumbnail-lists');
export const BOXART_DIR = path.join(CACHE_DIR, 'boxart');
export const CRC_CACHE_FILE = path.join(CACHE_DIR, 'rom-crc.json');
// Copies of covers.bin as it was on the card before each sync.
export const BACKUP_DIR = path.join(CACHE_DIR, 'covers-backups');
// Fitted 128 and 80 pixel previews, so the grid does not redo the art work.
export const PREVIEW_DIR = path.join(CACHE_DIR, 'previews');
// Each game's art as it goes in the pack (45568 bytes), so a resync does not redo the image work.
export const BLOB_DIR = path.join(CACHE_DIR, 'pack-art');
// How many old covers.bin copies to keep. A v7 pack for 700 games is about 46 MB.
export const BACKUPS_KEPT = 5;

// How long downloaded lists stay fresh before we try to refresh them.
export const DAT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const TREE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Set COMPANION_OFFLINE=1 to never download (tests use this). Cached files still work.
export const OFFLINE = process.env.COMPANION_OFFLINE === '1';

// Box art downloads at once. Kept low to be kind to GitHub.
export const ART_CONCURRENCY = 6;

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
// The folder sync copies ROMs into. Game Boy games go here too: this core plays them.
export const CARD_ROM_REL = path.join('Assets', 'gbc', 'common');
// What the app placed on the card, so it only ever removes its own files.
export const MANIFEST_REL = path.join(CARD_ROM_REL, 'cover-picker.json');

export function ensureDirs(): void {
  for (const d of [DATA_DIR, CUSTOM_ART_DIR, CACHE_DIR, DAT_DIR, TREE_DIR, BOXART_DIR, BACKUP_DIR, PREVIEW_DIR, BLOB_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
