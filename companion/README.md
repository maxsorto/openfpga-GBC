# GBC Cover Companion

A Mac app that builds the cover pack for the Analogue Pocket GBC cover picker core.
It finds your Pocket's SD card, names each ROM, fetches box art, lets you fix anything
it got wrong, and writes `covers.bin` to the card.

It is a local web app, built like PocketTunes Sync. A Hono (Node) backend on
`127.0.0.1` does the disk and image work. A Vite + React + TypeScript UI talks to it.
There is no Python dependency.

## What it does

1. Finds the Pocket card: a volume under `/Volumes` with `Cores/` and `Assets/` at the
   root (exFAT, or with `Analogue_Pocket.json`). Shows its free space. You can also
   pick any folder with the same layout, which is handy for testing.
2. Lists the `.gb` and `.gbc` files in `Assets/gbc/common`. Hidden files, including the
   `._` files macOS leaves on exFAT, are skipped.
3. Names each ROM by CRC32 against the No-Intro DATs, and finds box art in
   libretro-thumbnails (see "How matching works").
4. Shows the library as a grid. Each card shows the cover as the Pocket will draw it,
   a clean title you can rename, and a status: Exact, Guessed, No art, Picked or
   Your image.
5. Click a cover to change it: search the libretro box art, use a title card, or drop
   in your own PNG or JPEG. The preview shows the 128 by 128 center image and the
   80 by 80 list image, in the Pocket's 16 bit color.
6. The core holds 31 games. With more ROMs than that, the first 31 in alphabetical
   order are checked, and you can change which ones go on with the checkboxes.
7. Sync to Pocket builds `covers.bin`, writes it to `Assets/gbc/common/covers.bin`,
   reads it back to verify it byte for byte, then offers Eject.

Sync writes that one file and nothing else. It never touches ROMs, `.sav` or `.sus`
files. Before it overwrites an existing `covers.bin`, it keeps a copy on the Mac
(see "Where data lives").

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
npm test           # pack compatibility tests (needs the Pillow venv, see below)
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
4. **Your choices win.** Anything you pick, a title you type, and the checkboxes are
   saved per ROM CRC32, so they follow the ROM even if you rename the file.

The default title is the No-Intro name (or the file name) without tags, with
"Legend of Zelda, The" turned into "The Legend of Zelda" and accents removed. The core
shows 39 ASCII characters. Longer titles are cut, and other characters show as `?`.

The ROM, `.sav` and `.sus` paths in the pack always come from the file name, as the core
expects. The full ROM path must fit in 79 bytes; ROMs with longer names are flagged and
left out until you rename them on the card.

## The cover pack

The format is defined by `tools/make_cover_pack.py` (v6), and `server/src/pack.ts`
follows it. The art step (`fit()`: Lanczos resize, Gaussian blur, darken, sharpen,
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

The tests use the venv at `cover-picker/.venv` (Pillow 11.3). Set
`COVER_PICKER_PYTHON` to use another Python with Pillow.

PNG art is decoded with pngjs, which matches Pillow exactly. JPEG and other formats you
drop in are decoded by sharp; those may differ from Pillow by a few values per pixel,
which does not matter on the device.

## Where data lives

- `~/Library/Application Support/GBC Cover Companion/`
  - `choices.json`: titles, art picks and checkboxes, keyed by ROM CRC32.
  - `custom-art/`: images you dropped in.
- `~/Library/Caches/GBC Cover Companion/`
  - `dats/`: No-Intro DATs. Refreshed after 30 days.
  - `thumbnail-lists/`: box art file lists from GitHub. Refreshed after 7 days.
  - `boxart/`: downloaded box art.
  - `rom-crc.json`: CRC32 per file path, size and date, so ROMs are hashed once.
  - `covers-backups/`: the previous `covers.bin` from the card, saved before each sync.

The cache can be deleted at any time. `COMPANION_DATA_DIR` and `COMPANION_CACHE_DIR`
override both locations.

## Eject

Eject runs `diskutil eject`. If macOS refuses (often because loginwindow holds the
volume), the app runs `sync`, then `diskutil unmountDisk force` on the whole disk, then
ejects it.

## Project layout

```
companion/
  server/   Hono backend (TypeScript, run with tsx)
    src/
      index.ts     routes, sync progress stream, static files
      config.ts    port, data folders, ROM folders on the card
      volumes.ts   /Volumes listing, Pocket detection, eject
      roms.ts      ROM scan and CRC32
      dat.ts       No-Intro DAT download and parsing
      thumbs.ts    libretro-thumbnails lists and box art download
      match.ts     title cleanup and name matching
      choices.ts   saved choices
      library.ts   everything the UI shows for one card
      art.ts       loading art and fitted previews
      pillow.ts    port of the Pillow steps used by make_cover_pack.py
      image.ts     decoding, PNG encoding, title cards
      pack.ts      covers.bin writer
      sync.ts      build, write, verify
    test/          compatibility tests against the Python tool
  web/      Vite + React UI
```

## Limits in this version

- Only `Assets/gbc/common` is scanned, because that is where the core looks.
  `ROM_FOLDERS` in `server/src/config.ts` is where `Assets/gb/common` would be added.
- macOS only.
- Box art comes from libretro-thumbnails, a community collection.
