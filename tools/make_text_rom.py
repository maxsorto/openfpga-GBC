#!/usr/bin/env python3
"""The menu's fixed strings as a ROM for cover_picker.sv: 32 strings of up to 32 characters, string i at i * 32,
zero padded. Writes text_rom.hex (1024 lines, one byte each) into src/ and src/core/ (Quartus and the RTL read it
from the project folder) and, when given, into a simulation folder. The order is the T_* list in cover_picker.sv."""
import os, sys
STRINGS = [
    "GAME BOY COLOR", "GAME BOY", "SUSPENDED", "FAVORITES", "ALL GAMES", "CARTRIDGE REMOVED", "RECENT",
    "GET THE COMPANION APP", "< PLAY >", "< START OVER >", "< UNFAVORITE >", "< ADD TO FAVORITES >", "< BACK >",
    "CARTRIDGE", " GAMES", "ERROR ",
    "< START IN: COVER FLOW >", "< START IN: GRID >", "< START IN: LAST USED >",
    "< OPENS ON: FAVORITES >", "< OPENS ON: RECENT >", "< OPENS ON: ALL GAMES >",
    "< LEGEND: ON >", "< LEGEND: OFF >", "< SOUNDS: ON >", "< SOUNDS: OFF >",
    "All games", "Settings", "No cover pack on this card", "No cartridge", "Clean the contacts",
]
assert len(STRINGS) <= 32 and all(len(s) <= 31 for s in STRINGS)
rom = bytearray(1024)
for i, s in enumerate(STRINGS): rom[i * 32:i * 32 + len(s)] = s.encode('ascii')
here = os.path.dirname(os.path.abspath(__file__))
outs = [os.path.join(here, '..', 'src', 'text_rom.hex'), os.path.join(here, '..', 'src', 'core', 'text_rom.hex')] + sys.argv[1:]
for o in outs:
    with open(o if o.endswith('.hex') else os.path.join(o, 'text_rom.hex'), 'w') as f: f.write('\n'.join(f'{b:02x}' for b in rom) + '\n')
print(len(STRINGS), 'strings ->', ', '.join(outs))
