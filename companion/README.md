# GBC Cover Companion

A Mac app that puts your Game Boy library on the Analogue Pocket with box art, for the
GBC cover picker core. You point it at the folder with your ROMs. It names each one,
finds its box art, lets you star favorites and fix anything it got wrong, then syncs
every game to the SD card and writes `covers.bin`.

It is a local web app, built like PocketTunes Sync. A Hono (Node) backend on
`127.0.0.1` does the disk and image work. A Vite + React + TypeScript UI talks to it.
There is no Python dependency.

## What it does

1. **Library.** You pick one folder on your Mac (native folder dialog, or type a path).
   The app remembers it. Every `.gb` and `.gbc` file in it and its subfolders is read.
   Hidden files and folders are skipped, including the `._` files macOS leaves on exFAT.
2. **One game per checksum.** Each ROM is identified by its CRC32. The same ROM twice
   (another name, another folder) shows once, and the app remembers every path. Hacks
   and translations have their own checksums, so they are separate games.
3. **Names and art.** Each ROM is named by CRC32 against the No-Intro DATs, and box art
   is found in libretro-thumbnails (see "How matching works"). The whole library is
   matched at once. Art downloads in the background, a few at a time, and fills in as
   it arrives. The toolbar shows how many are Exact, Guessed or have No art, with a
   filter for each.
4. **Two views.** *Library* shows everything in the folder. *Pocket* shows what the card
   will hold, in the order the Pocket shows it.
5. **Favorites.** Star any game. On the Pocket, games you played come first (most
   recent first), then favorites A to Z, then everything else A to Z. Play history
   does not exist yet; the streaming core will record it, and the app will read it.
6. **Fix a cover.** Click a cover to search the libretro box art, use a title card, or
   drop in your own PNG or JPEG. The preview shows the 128 by 128 center image and the
   80 by 80 list image, in the Pocket's 16 bit color. Click a title to rename it.
7. **Sync plan.** Sync to Pocket first shows a plan: ROMs to copy (new, or a different
   ROM at that file name), ROMs to remove, ROMs that are unchanged, how much space it
   needs against the card's free space, and the pack. Nothing is written until you
   confirm. If the card is short on space, the plan says so and sync does not start.
8. **Sync.** Each ROM is written next to its final name, flushed to the card, read back
   and checked by CRC32, then renamed into place. Unchanged ROMs are skipped, so a
   resync takes seconds. ROMs that left the library are removed, but only ones the app
   placed. Then `covers.bin` and the manifest are written, read back and verified, and
   the app offers Eject. Progress shows file by file.

### What sync touches on the card

| Path | What happens |
| --- | --- |
| `Assets/gbc/common/*.gb`, `*.gbc` | Copied from the library. Removed only if `cover-picker.json` lists them and the file is still the ROM the app put there. |
| `Assets/gbc/common/covers.bin` | Written. The old one is copied to the Mac first. |
| `Assets/gbc/common/cover-picker.json` | Written. The list of ROMs the app placed. |
| `Saves/` (`.sav`, `.sus`, everything else) | Never touched. |
| ROMs you copied by hand | Never touched. The plan lists them as "On the card, not from this app". |

The manifest looks like this:

```json
{ "version": 1, "placed": [ { "crc": "46DF91AD", "file": "Tetris.gb", "size": 32768 } ] }
```

Game Boy games go in the GBC folder too, because this core is the one that plays them.

### File names on the card

A ROM keeps its library file name on the card, with a few rules so saves never mix:

- Once placed, a game keeps its card name. Renaming or moving it in the library changes
  nothing on the card, so its save keeps working.
- Two games can not share a name before the extension, because that names the save.
  `Wario Land II.gb` and `Wario Land II.gbc` become `Wario Land II.gb` and
  `Wario Land II (GBC).gbc`. Case does not count, as on exFAT.
- A ROM you put on the card by hand is never overwritten. If the library has a
  different ROM with that name, the app gives its copy another name.

### Today's core and 31 games

Today's core reads pack v6 and shows at most 31 games. Sync still copies every game.
The pack holds the first 31 in Pocket order, so favorites come first. The Pocket view
marks where the 31 end. The streaming core will read pack v7 and show them all; its
writer will sit next to the v6 one in `server/src/pack.ts`.

### No library folder

Without a library folder, the app uses the ROMs already on the card, as before. Sync
then copies nothing and only writes `covers.bin` and the manifest.

## Prerequisites

- macOS. Card detection and eject use `diskutil`.
- Node 18 or newer, with npm (`brew install node`).
- An internet connection the first time, to download the game lists and box art.
  After that, everything already downloaded works offline.

## Quick start

```bash
cd companion
npm install
npm start          # builds the UI, starts the app, opens http://localhost:4390
```

For development with hot reload:

```bash
npm run dev        # backend on :4390, Vite UI on http://localhost:5174
```

Other commands:

```bash
npm test           # sync, order and pack compatibility tests (the last need the Pillow venv)
npm run typecheck  # server and web
```

Set `PORT` to use another port, `NO_OPEN=1` to stop `npm start` from opening a browser,
and `GITHUB_TOKEN` if you hit GitHub's rate limit for the box art lists.

## How matching works

1. **CRC32.** Each ROM is hashed and looked up in the No-Intro DATs from
   libretro-database (`Nintendo - Game Boy.dat` and `Nintendo - Game Boy Color.dat`).
   A hit gives the canonical name, for example
   `Pokemon - Crystal Version (USA, Europe) (Rev 1)`.
2. **Exact art.** libretro-thumbnails names its files after those same No-Intro names,
   with the characters ``&*/:`<>?\|`` replaced by `_`. If a file with that exact name is
   in `Named_Boxarts` of `Nintendo_-_Game_Boy_Color` or `Nintendo_-_Game_Boy`, the
   status is **Exact**.
3. **Name match.** Otherwise (ROM hacks, bad dumps, renamed files) the file name is
   compared with every box art name. Region and other tags in brackets are ignored,
   and words are compared with longer words counting for more. A close enough match
   is used and marked **Guessed**. Check those. Nothing close means **No art**, and the
   Pocket shows a title card.
4. **Your choices win.** Anything you pick, a title you type, and favorites are saved
   per ROM CRC32, so they follow the ROM even if you rename or move the file.

The default title is the No-Intro name (or the file name) without tags, with
"Legend of Zelda, The" turned into "The Legend of Zelda" and accents removed. The core
shows 39 ASCII characters. Longer titles are cut, and other characters show as `?`.

The ROM, `.sav` and `.sus` paths in the pack always come from the card file name, as the
core expects. The full path must fit in 255 bytes. ROMs with longer names are flagged.
They are still copied, but left out of the menu until you rename them.

## The cover pack

The format is defined by `tools/make_cover_pack.py` (v6), and `server/src/pack-v6.ts`
follows it. `server/src/pack.ts` picks the writer and the menu order;
`server/src/pack-common.ts` has what every version shares (paths, titles, art). The art step (`fit()`: Lanczos resize, Gaussian blur, darken, sharpen,
RGB565) is a direct port of the Pillow 11.3 C code in `server/src/pillow.ts`, including
its fixed point and single precision math, so packs come out byte-identical to the
Python tool.

Tests (`npm test`) check this against the real Python tool and Pillow:

- `pack-compat.test.ts`: three fake ROMs with generated PNG art. The TypeScript pack
  and the Python pack are identical, byte for byte.
- The same test with a ROM that has no art: everything but that game's title card
  image is identical. The title card text is drawn by a different text engine
  (librsvg instead of FreeType), so roughly 15% of its pixels differ.
- `pillow-stages.test.ts`: each step of `fit()` on six image shapes and both sizes,
  compared with Pillow step by step.
- `sync.test.ts`: a fake library of 40 ROMs (random bytes, a few duplicates, an
  AppleDouble file, a hidden folder) and a fake card with saves and a ROM copied by
  hand. It runs a full sync, then removes, adds and changes ROMs and syncs again. It
  checks that only manifest files are removed, saves and the hand placed ROM stay
  byte for byte, unchanged ROMs are not rewritten, a short card writes nothing, and a
  stale plan is refused. It runs offline.
- `order.test.ts`: played, then favorites, then the rest, as the Pocket shows them.

The tests use the venv at `cover-picker/.venv` (Pillow 11.3). Set
`COVER_PICKER_PYTHON` to use another Python with Pillow.

PNG art is decoded with pngjs, which matches Pillow exactly. JPEG and other formats you
drop in are decoded by sharp; those may differ from Pillow by a few values per pixel,
which does not matter on the device.

## Where data lives

- `~/Library/Application Support/GBC Cover Companion/`
  - `settings.json`: the library folder.
  - `choices.json`: titles, art picks and favorites, keyed by ROM CRC32.
  - `custom-art/`: images you dropped in.
- `~/Library/Caches/GBC Cover Companion/`
  - `dats/`: No-Intro DATs. Refreshed after 30 days.
  - `thumbnail-lists/`: box art file lists from GitHub. Refreshed after 7 days.
  - `boxart/`: downloaded box art.
  - `previews/`: the fitted covers the grid shows, so each is built once.
  - `rom-crc.json`: CRC32 per file path, size and date, so ROMs are hashed once. A
    rescan of 700 ROMs reads no ROM data.
  - `covers-backups/`: the previous `covers.bin` from the card, saved before each sync.

The cache can be deleted at any time. `COMPANION_DATA_DIR` and `COMPANION_CACHE_DIR`
override both locations. `COMPANION_OFFLINE=1` turns off all downloads.

## Eject

Eject runs `diskutil eject`. If macOS refuses (often because loginwindow holds the
volume), the app runs `sync`, then `diskutil unmountDisk force` on the whole disk, then
ejects it.

## Project layout

```
companion/
  server/   Hono backend (TypeScript, run with tsx)
    src/
      index.ts        routes, sync progress stream, static files
      config.ts       port, data folders, card paths
      settings.ts     the library folder
      volumes.ts      /Volumes listing, Pocket detection, eject
      roms.ts         library and card scans, CRC32 and its cache
      library.ts      games: dedupe, names, art, favorites, card file names
      plan.ts         the sync plan
      sync.ts         carrying out a plan, with progress events
      manifest.ts     cover-picker.json
      dat.ts          No-Intro DAT download and parsing
      thumbs.ts       libretro-thumbnails lists and box art download
      limit.ts        download queue: at most 6 at once, covers on screen first
      match.ts        title cleanup and name matching
      choices.ts      saved choices
      art.ts          loading art, fitted previews and their disk cache
      pillow.ts       port of the Pillow steps used by make_cover_pack.py
      image.ts        decoding, PNG encoding, title cards
      pack.ts         which pack writer, and the menu order
      pack-common.ts  what every pack version shares
      pack-v6.ts      covers.bin writer for today's core
    test/             sync tests and compatibility tests against the Python tool
  web/      Vite + React UI. The grid only draws the rows near the screen.
```

## Limits in this version

- One library folder. Sync copies into `Assets/gbc/common`, because that is where the
  core looks.
- Today's core shows the first 31 games. All of them are on the card for the streaming
  core.
- Play history is not read yet. `playHistory()` in `server/src/library.ts` is where
  `launcher.cfg` will be parsed.
- macOS only.
- Box art comes from libretro-thumbnails, a community collection.
