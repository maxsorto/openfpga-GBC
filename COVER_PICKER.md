# Cover picker (fork of budude2/openfpga-GBC)

A box-art game menu inside the GBC core. On boot the core reads `/Assets/gbc/common/covers.bin`, shows one cover at
a time with the title, Left/Right to browse, A to load the game. Hold Select+Start for one second in game to come
back to the menu. Toggle it in Core Settings > Cover Menu.

How it works: `src/core/cover_picker.sv` pulls the pack with core-initiated data slot reads (APF 0x0180, slot 100,
deferload), opens the chosen ROM into the cartridge slot with 0x0192 (parameter struct served at bridge 0xF3000000),
streams it into cartridge memory and resets the core.

Make a pack on a PC:

    python3 tools/fetch_boxart.py "/Volumes/Pocket/Assets/gbc/common" covers/
    python3 tools/make_cover_pack.py --roms "/Volumes/Pocket/Assets/gbc/common" --covers covers/ --out covers.bin
    cp covers.bin "/Volumes/Pocket/Assets/gbc/common/"

Simulation (Icarus): `tools/sim/tb_cover_picker.sv` (browse + launch against a fake APF host), `tools/sim/tb_frame.sv`
(renders one menu frame to a PPM).

Status: simulated, not yet verified on hardware.
