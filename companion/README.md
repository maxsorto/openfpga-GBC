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
| `Assets/gbc/common/*.gb`, `*.gbc` | Copied from the library, or adopted if already there. Removed only if `cover-picker.json` lists them and the file is still the ROM the app put there. |
| `Assets/gbc/common/covers.bin` | Written. The old one is copied to the Mac first. |
| `Assets/gbc/common/cover-picker.json` | Written. The list of ROMs the app placed. |
| `Saves/` (`.sav`, `.sus`, everything else) | Never touched. |
| ROMs you copied by hand | Adopted when they are the same ROM as a library game. Otherwise never touched, unless you choose "Use the library's" for one. The plan lists them as "On the card, not from this app". |

The manifest looks like this:

```json
{ "version": 1, "placed": [ { "crc": "46DF91AD", "file": "Tetris.gb", "size": 32768 } ] }
```

Game Boy games go in the GBC folder too, because this core is the one that plays them.

### ROMs already on the card

Sync compares the library with what is on the card, game by game:

- **Placed before.** A game the app placed keeps its card name. Renaming or moving it in
  the library changes nothing on the card, so its save keeps working.
- **Adopted.** A ROM you copied to the card by hand with the same CRC as a library game is
  adopted: it joins the manifest under its current name and is never renamed. The
  library's copy is not placed. For example, `Pokemon - Yellow Version.gbc` on the card
  and `GB/Pokemon - Yellow Version.gb` in the library are the same ROM, so the card keeps
  `.gbc` and `Pokemon - Yellow Version.sav` still matches. From then on the app treats it
  like any ROM it placed.
- **Kept the card's version.** A ROM you copied by hand with the same name (before the
  extension) as a library game, but a different CRC, stays as it is, because its save is
  tied to that name. The library's copy is not placed, so the Pocket does not show two
  entries. The plan lists these, and each one has "Use the library's": sync then replaces
  the card's copy under the same name, after saving it to the Mac
  (`covers-backups/replaced-roms/`).
- **Card only.** ROMs on the card that are not in the library, such as ROM hacks, stay in
  the Pocket view and the menu order like any game (after favorites, A to Z, unless
  starred). Sync never removes them.
- **New.** Everything else is copied under its library file name. Two games can not share
  a name before the extension, because that names the save: `Wario Land II.gb` and
  `Wario Land II.gbc` become `Wario Land II.gb` and `Wario Land II (GBC).gbc`. Case does
  not count, as on exFAT.

### Saves

The plan lists every `.sav` in `Saves/gbc/common` and the ROM it belongs to after sync
(same name before the extension). It warns when a save would lose its ROM, for example
when a game leaves the library. Saves are only read, never moved, renamed or removed. A
save without a ROM works again if the game comes back under the same name.

If the library folder has no ROMs at all, sync stops before it removes anything.

### Pack v6 or v7: it depends on the core

Sync reads `Cores/maxsorto.GBC/core.json` on the card and looks at
`core.metadata.version`.

| Core on the card | covers.bin | Games in the menu |
| --- | --- | --- |
| Version ends in `-cover2` or higher (`-coverN`, N of 2 or more): the streaming core | Pack v7 | All of them, up to 2047 |
| Any other version, or no core found | Pack v6 | The first 31 |

Either way, sync copies every game, and the menu order is the same: games you played,
then favorites A to Z, then everything else A to Z. The plan says which format it chose
and why, for example "Streaming core found (1.4.0-cover2): all 702 games" or "This
core (1.4.0-cover1) shows 31 games. Install build 17 to see all." With v6 the Pocket
view marks where the 31 end. With v7 there is no such line.

A v7 pack is about 66 KB per game: 46.6 MB for 702 games. Sync streams it to a file
next to `covers.bin`, one game's art at a time, flushes it, reads it back to check it,
then renames it into place, so the old pack stays intact until the new one is proven.
The space check in the plan counts the whole new pack. Each game's packed art is
cached on the Mac, so a resync of 702 games rebuilds the pack in under a second.

### No library folder

Without a library folder, the app uses the ROMs already on the card, as before. Sync
then copies, adopts and removes nothing, and only writes `covers.bin` and the manifest.

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

Both formats are defined by `tools/make_cover_pack.py` (v6 by default, v7 with `--v7`).

| | v6 | v7 |
| --- | --- | --- |
| Games | up to 31 | up to 2047 |
| Entry (128 B) | title[40], flags u8, pad[3], size u32, path[80] | title[40], flags u8, pad[3], size u32, CRC32 u32, path[76] |
| Art per game | 45568 B, packed back to back | the same 45568 B, padded with zeros to 65536 B |

Both start with a 16 byte header (`GBCV`, version, count, 128, 80) and 512 reserved
bytes, and end with three 256 byte path structs per game (ROM, `.sav`, `.sus`) and one
for `picker.log`. The CRC32 in v7 is of the whole ROM file, so the core can key play
history by game. The fixed 64 KB stride lets the core read any cover by its index.

`server/src/pack-common.ts` has the shared layout and both ways to write it (in memory,
or streamed one game at a time). `server/src/pack-v6.ts` and `server/src/pack-v7.ts`
describe each entry and stride. `server/src/pack.ts` has the writers and the menu order,
and `server/src/core.ts` picks the format from the card. The art step (`fit()`: Lanczos resize, Gaussian blur, darken, sharpen,
RGB565) is a direct port of the Pillow 11.3 C code in `server/src/pillow.ts`, including
its fixed point and single precision math, so packs come out byte-identical to the
Python tool.

Tests (`npm test`) check this against the real Python tool and Pillow:

- `pack-compat.test.ts`: three fake ROMs with generated PNG art. The TypeScript pack
  and the Python pack are identical, byte for byte, in v6 and in v7. A 40 game v7 pack
  matches too, both built in memory and streamed.
- The same test with a ROM that has no art: everything but that game's title card
  image is identical. The title card text is drawn by a different text engine
  (librsvg instead of FreeType), so roughly 15% of its pixels differ.
- `pillow-stages.test.ts`: each step of `fit()` on six image shapes and both sizes,
  compared with Pillow step by step.
- `sync.test.ts`: a fake library of 40 ROMs (random bytes, a few duplicates, an
  AppleDouble file, a hidden folder) and a fake card with saves and a ROM copied by
  hand. It runs a full sync, then removes, adds and changes ROMs and syncs again, and
  tries "Use the library's" on a ROM copied by hand. It
  checks that only manifest files are removed, saves and the hand placed ROM stay
  byte for byte, unchanged ROMs are not rewritten, a short card writes nothing, and a
  stale plan is refused. It runs offline.
- `adopt.test.ts`: a card that already has ROMs, like a real one: the same Pokemon Yellow
  under `.gbc` is adopted and keeps its name, a different Pokemon Silver dump on the card
  is kept, a ROM hack only on the card stays in the menu, saves are matched to ROMs (and
  flagged when a game leaves), and an empty library folder removes nothing.
- `format.test.ts`: the format follows the core (`-cover1` gives v6, `-cover2` and up
  give v7, no core or an unreadable `core.json` gives v6). A 40 game library syncs as v7
  with every game, favorites first, each entry carrying its ROM's CRC32; switching the
  core back gives v6 with 31.
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
  - `pack-art/`: each game's art as it goes in the pack, so a resync is quick.
  - `rom-crc.json`: CRC32 per file path, size and date, so ROMs are hashed once. A
    rescan of 700 ROMs reads no ROM data.
  - `covers-backups/`: the previous `covers.bin` from the card, saved before each sync.
    The last 5 are kept.

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
      core.ts         which pack format the card's core reads
      pack.ts         the pack writers, and the menu order
      pack-common.ts  the layout every pack version shares, in memory or streamed
      pack-v6.ts      pack v6: 31 games, for today's core
      pack-v7.ts      pack v7: up to 2047 games, for the streaming core
    test/             sync tests and compatibility tests against the Python tool
  web/      Vite + React UI. The grid only draws the rows near the screen.
```

## Limits in this version

- One library folder. Sync copies into `Assets/gbc/common`, because that is where the
  core looks.
- Today's core shows the first 31 games. All of them are on the card, and the streaming
  core (`-cover2`) shows them all.
- Play history is not read yet. `playHistory()` in `server/src/library.ts` is where
  `launcher.cfg` will be parsed.
- macOS only.
- Box art comes from libretro-thumbnails, a community collection.
