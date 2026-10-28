<p align="center"><img src="docs/images/hero.png" alt="The cover flow menu on the Pocket next to the companion app's library" width="100%"></p>

# Cover Flow for the Analogue Pocket

A box-art game menu that lives inside the Game Boy Color core on the Analogue Pocket, and a Mac app that fills it. Turn the core on and you land on your library as full-color covers at 320x288: the selected game in the middle, its neighbors either side, reflections on the floor and the title underneath. Libraries of hundreds of games stream from the card as you scroll; Up and Down jump by letter, Select shows only your favorites, and X opens a game's options. Press A and the game boots with its battery save loaded. Press L in game to pause, then Resume, or go Home to the covers with the game suspended. Pick it again later and it comes back on the exact frame you left. With a cartridge in the slot, the menu opens on that game's cover, labeled CARTRIDGE, and A plays the real cart. On the Mac, the companion app names every ROM in your library by checksum, finds its box art, and syncs it all to the SD card.

<p align="center"><b>Get it: <a href="https://github.com/maxsorto/openfpga-GBC/tree/cover-picker">the cover-picker branch</a></b><br>Analogue Pocket, openFPGA. Game Boy and Game Boy Color games.<br><b>Fill it: <a href="companion/">the companion app</a></b> (in <code>companion/</code>), runs on your Mac in the browser.</p>

This is a fork of budude2's openFPGA GBC core, which is a port of the MiSTer Gameboy core. The emulation is theirs. The menu, saves, suspend, cartridge detection and the companion app are new. No ROMs, BIOS files or box art are in this repo.

<table>
  <tr>
    <td width="50%"><img src="docs/images/menu-1.png" alt="Cover flow at 320x288 with a game selected"></td>
    <td width="50%"><img src="docs/images/menu-2.png" alt="Cover flow, another game selected"></td>
  </tr>
  <tr>
    <td><img src="docs/images/menu-slide.png" alt="Covers gliding mid-step"></td>
    <td><img src="docs/images/menu-3.png" alt="Cover flow, a Game Boy game selected"></td>
  </tr>
  <tr>
    <td><img src="docs/images/pause-resume.png" alt="Pause panel over the dimmed game, Resume selected"></td>
    <td><img src="docs/images/pause-home.png" alt="Pause panel, Home selected"></td>
  </tr>
</table>

## What it does

| | |
|---|---|
| Browse | Left and Right glide the covers over 8 frames with an ease-out. Hold to scroll. Long titles scroll as a marquee. |
| Jump | Up and Down jump to the previous and next letter (and to your favorites at the top). The letter shows under the title. |
| Select | Steps through All games, Favorites, and the inserted Cartridge (when there is one). The mode shows under the title. |
| Cartridge | With a cart in the slot, the core reads the cart's header at boot. If it matches a game in your pack (the exact revision, or failing that the same internal title), the menu opens on that cover labeled CARTRIDGE, and A boots the real cart with the save on its own battery. Left or Right goes to your list. A cart that isn't in your library is ignored, unless you chose Play Cartridge in the Pocket's menu, which boots it directly. The menu checks the slot about once a second, so you can swap carts while it's open: a new cart jumps to its cover, and pulling one goes back to your list with CARTRIDGE REMOVED. |
| Options | X opens the selected game's options: Play, Start over (drops a suspend point and boots fresh), favorite on or off, Back. Favorites changed on the Pocket go to `favorites.cfg` and the companion app applies them on the next sync. |
| Launch | A opens the ROM, streams it into cartridge memory, loads its `.sav` and boots it. |
| Pause | L in game freezes the Game Boy, dims the picture and shows Resume and Home with a short chime. B or L again resumes. |
| Home | Writes the battery save, writes a save state to a `.sus` file next to it, and goes back to the covers. |
| Resume | Launching a game with a `.sus` file restores that save state, then empties the file so it is used once. |
| Saves | Uses the same `/Saves/gbc/common/<game>.sav` files as the original core, so existing saves carry over. |

R is still fast forward. In game, Select and X are left alone because games use them.

## The companion app

<table>
  <tr>
    <td width="50%"><img src="docs/images/companion-library.png" alt="Library view: 702 games with box art, matched by checksum"></td>
    <td width="50%"><img src="docs/images/companion-pocket.png" alt="Pocket view: favorites first, then everything else A to Z"></td>
  </tr>
  <tr>
    <td><img src="docs/images/companion-picker.png" alt="Cover picker with alternative box art"></td>
    <td><img src="docs/images/companion-sync.png" alt="Sync plan with each save matched to its ROM"></td>
  </tr>
  <tr>
    <td><img src="docs/images/companion-gbc.png" alt="Game Boy Color theme, Atomic Purple shell over the board"></td>
    <td><img src="docs/images/companion-gbc-teal.png" alt="Game Boy Color theme, Teal shell"></td>
  </tr>
</table>

A local web app: a Node backend that reads your ROM folder and the SD card, and a React page in your browser. It lives in [`companion/`](companion/).

| | |
|---|---|
| Library | Point it at one folder. Every ROM is named by CRC32 against the No-Intro database, and duplicates merge. |
| Box art | Found in libretro-thumbnails automatically. Click a cover to pick another, search, or drop in your own image. |
| Favorites | Star games in the app. The Pocket shows them first, and again under their letter in the full A to Z list. The pack carries a letter index, so Up and Down jump straight to a letter. A new dump of a game at the same path keeps its star, cover and title. |
| Sync | A plan shows what will be copied, removed and kept, and checks free space first, then shows live progress. ROMs are copied, checked by CRC, then renamed into place. The app only removes ROMs it placed, and it never touches battery saves. |
| Your card | ROMs already on the card are adopted under their current names, so their saves keep working. A card ROM with the same name as a library game but different contents is kept, because its save is tied to that name. If a ROM's contents change, its suspend point (a save state of the old ROM) is backed up and cleared; battery saves are never touched. |
| Cartridges | The pack carries a fingerprint of every game (header checksums and internal title), so the core can recognize an inserted cart, even a different revision of a game you own. |
| Favorites from the Pocket | Stars changed on the Pocket (X, then favorite) are saved on the card and applied on the next sync. |
| Themes | DMG, and Game Boy Color with six shells. Atomic Purple shows the board through the plastic. |

The app reads the core version on the card. With the streaming core it writes every game (up to 2047) to the pack; with an older core it writes the first 31 of the sync order.

```sh
cd companion
npm install
npm start          # opens http://localhost:4390
```

## Using it

1. Copy the `Cores/maxsorto.GBC` folder from a build to the card, next to the original core.
2. Open the companion app, pick your ROM folder and the card, and sync. It writes the ROMs and `/Assets/gbc/common/covers.bin`. (`tools/make_cover_pack.py` makes the pack from the command line too.)
3. Open the core. The menu appears after about a second. It can be turned off in Core Settings, Cover Menu.

Controls in the menu: Left and Right to browse, Up and Down to jump by letter, Select for all games, favorites or the cartridge, X for a game's options, A to play. In game: L to pause, Up and Down to choose, A to confirm.

## How it works

<p align="center"><img src="docs/images/pipeline.svg" alt="Pipeline from box art to a running game" width="100%"></p>

- **The pack.** The companion app (or `tools/make_cover_pack.py`) fits each cover on a blurred copy of itself and stores it in 16-bit color: a 128x128 center and an 80x80 preview. Titles, ROM sizes, and the ROM, save and suspend paths go in the same file.
- **Streaming covers.** The Pocket's SDRAM holds 128 covers above the cartridge ROM area, as a cache: game g lives in slot g mod 128. A background loader reads the covers nearest the selection from the card with APF target command 0x0180 (the selected game first, then its neighbors, then four ahead in the scroll direction), about 29 ms each. A cover may only evict a slot whose game is further from the selection, so nearby games never take turns evicting each other. Each game's title and flags are read from the card when it is selected. A library can have up to 2047 games.
- **Sharing SDRAM.** Cover words wait in a 256-entry FIFO and are written in the SDRAM cycles the line fetcher leaves free, so the menu keeps drawing while covers load. A cover that has not arrived yet draws as a dark tile.
- **Cartridges.** Cart power is on while the core runs (core.json `cartridge_adapter` 0x41000000). At boot, with the Game Boy held in reset, the core reads header bytes 0x134 to 0x14F over the cart bus, checks the header checksum, then scans the pack's fingerprint table: first for the same global and header checksums, then for the same 11-byte title CRC. When a game cart is in and the core isn't playing it, every cart pin is held at bus idle (address 0, /RD, /WR and /CS high), so a powered cart never sees stray writes. Launching the cart switches the Game Boy to physical cartridge mode.
- **Video.** The menu has its own 320x288 timing on its own scaler mode. A line fetcher reads each cover from SDRAM two lines ahead, scaled on the fly, so covers can grow, shrink and slide every frame. The title uses Inter at 13 px with antialiasing. The game switches back to the Game Boy's 160x144 when it launches.
- **Opening files.** Paths are copied from the pack straight into the 0x0192 parameter struct. The struct answers bridge reads one transaction late, which is how every APF bridge device behaves. Getting that wrong returns "malformed path".
- **Saves.** The core reports the save size in its data table. The menu opens the matching `.sav` into the Save slot, reads it into cartridge RAM, and creates it at that size if it does not exist yet.
- **Suspend.** Home triggers the core's own save state machinery, the same one the Pocket's save states use, and streams it into the game's `.sus` file with 0x0184. Resume streams it back and signals a load.
- **Testing.** Icarus Verilog testbenches play the Pocket's side: a fake card that serves opens, reads and writes, and a model of the SDRAM. `tools/sim/tb_suspend.sv` runs launch, pause, Home and resume end to end. `tools/sim/tb_stream.sv` holds Right through a library bigger than a deliberately tiny 8-slot cache and checks every visible cover word for word against the pack. The menu screenshots here are frames from that simulation.

## Debugging on hardware

The menu runs on the Pocket's FPGA, so a hardware bug can't be stepped through. Two aids are built in.

**Debug log.** The core records events in a 511-entry buffer: state machine steps with their data slot errors, changes in the SDRAM and reset signals, samples of the cover pixels it fetched, the Pocket's cartridge message, and the inserted cart's header and title CRC. The first 64 entries (the boot) are kept; the rest is a ring of the latest events. The per-character text layout steps are not recorded. About 3 seconds after the menu settles, after boot and after every Home, it writes the buffer to `/Saves/gbc/common/picker.log` on the SD card. The file is data slot 103. Put the card in a computer and run:

```sh
python3 tools/read_picker_log.py /Volumes/Pocket/Saves/gbc/common/picker.log
```

It prints one line per event with a timestamp in milliseconds and the state names taken from `cover_picker.sv`. The cover pack holds the log's path after the game paths, so packs made with an older `make_cover_pack.py` have no log.

**Status squares.** Set `DEBUG_SQUARES` to 1 at the top of `cover_picker.sv` and rebuild, and a row of small squares along the top of the menu shows the same signals live. Green means the signal was seen in the last 30 ms and dark red means it wasn't. They're in groups of four, left to right, in the order of the `DBG` list in `tools/read_picker_log.py`. A phone video of the screen is enough to read them.

To add a signal, wire it into `dbg` in `core_top.sv` (or the picker's own bits), then add its name to `DBG`. To log a new event, add a branch to the logger at the end of `cover_picker.sv`.

## Build it

Quartus Prime Lite 22.1 runs in an x86 container. On Apple Silicon that means Colima with Rosetta.

```sh
colima start -p quartus --vm-type vz --vz-rosetta --cpu 8 --memory 16
cd src
docker run --rm --platform linux/amd64 -v "$PWD/..":/build -w /build/src \
  didiermalenfant/quartus:22.1-apple-silicon \
  /opt/intelFPGA/quartus/bin/quartus_sh --flow compile ap_core.qpf

python3 -m venv .venv && .venv/bin/pip install pillow
.venv/bin/python tools/fetch_boxart.py /Volumes/Pocket/Assets/gbc/common covers
.venv/bin/python tools/make_cover_pack.py --roms /Volumes/Pocket/Assets/gbc/common --covers covers --out covers.bin
sh tools/package_core.sh covers.bin stage
cp -R stage/. /Volumes/Pocket/
```

A full compile takes about ten minutes. `ap_core.qsf` limits Quartus to one worker because parallel fitting deadlocks under emulation.

## What's done and what's next

Done:
- Cover flow menu at 320x288 with full-color covers, reflections, eased animation, marquee titles and a position bar
- Streaming covers for libraries up to 2047 games (700+ verified on hardware)
- Letter jumps, a favorites mode, and a per-game options menu with Start over and favorites saved on the Pocket
- Launching from the menu, battery saves in the usual place, pause, Home and suspend to the exact frame
- Cartridges: the inserted cart shows on its own cover and plays with its own save
- An on-card debug log and diagnostic squares for hardware bugs
- The companion app: library by checksum, automatic box art, favorites, a sync plan that protects saves, two themes

Next:
- Copy a cartridge's save to the SD card from the cart's options, so the ROM version continues it
- A grid view, then play history (recently played first) and a settings screen
- A web version of the companion app for Windows and Linux, and a release for the openFPGA cores inventory

## Repository layout

- `src/core/cover_picker.sv`: the menu, cover cache, launch, pause, save and suspend logic, cartridge lookup, debug log and the pause chime
- `src/core/core_top.sv`: wiring into the GBC core (bridge, data slots, save states, SDRAM sharing, the cart header reader and pin idling, video and audio mix)
- `src/core/picker_dpram.v`: block RAM wrapper used by the menu
- `pkg/gbc/Cores/budude2.GBC/data.json`: data slots, including Cover Pack (100), Game (101), Suspend (102), Debug Log (103) and Favorites (104)
- `companion/`: the Mac companion app (Hono backend in `server/`, React UI in `web/`)
- `tools/`: pack builder, box art fetcher, bitstream reverser, packaging script, debug log reader
- `tools/sim/`: Icarus testbenches with a fake Pocket host
- `docs/images/`: README images

## Credits, license and legal

- The emulation is the MiSTer Gameboy core by its contributors, ported to the Pocket by budude2. The openFPGA framework files are Analogue's. Their code keeps its original terms.
- The cover picker module, the testbenches and the tools in `tools/` are MIT.
- The 5x7 font is the Adafruit GFX glcdfont (BSD).
- Box art in the screenshots comes from the libretro-thumbnails community scans. Covers are not in the repo. `fetch_boxart.py` downloads them on your machine. The in-game frame under the pause panel is a libretro-thumbnails snap.
- Game Boy, Game Boy Color and Analogue Pocket are trademarks of their owners. This project is not affiliated with Nintendo or Analogue.
- Bring your own ROMs and BIOS. If you own something shown here and want it removed, open an issue and it will come down.

The original core's README follows.

---

# Gameboy/Game Boy Color for Analogue Pocket
Ported from the original core developed at https://github.com/MiSTer-devel/Gameboy_MiSTer

Please report any issues encountered to this repo. Issues will be upstreamed as necessary.

## Installation
To install the core, copy the `Assets`, `Cores`, and `Platform` folders over to the root of your SD card. Please note that Finder on macOS automatically _replaces_ folders, rather than merging them like Windows does, so you have to manually merge the folders.

Place the GBC bios in `/Assets/gbc/common` named "gbc_bios.bin", the GB bios in `/Assets/gb/common` named "gb_bios.bin", and the SGB bios in `/Assets/gb/common` named "sgb_boot.bin".

## Usage
ROMs should be placed in `/Assets/gbc/common`, and `/Assets/gb/common`

## Features

### Supported
* Real-Time Clock
* Fastforward
* Original Gameboy display modes
* Super Gameboy Emulation
* Custom Borders (SGB)
* Custom Palettes (SGB)
* Enhance GBA features
* Save States and Sleep
* External Cartridges

### In Progress
¯\\_(ツ)_/¯
