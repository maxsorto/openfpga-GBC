#!/usr/bin/env python3
"""Decode the cover picker's debug log (/Saves/gbc/common/picker.log on the SD card).

The core keeps a ring of 511 eight-byte records and writes it to that file after the menu has sat idle for 3 s
following boot or Home. Record 0 is a header ("PLOG", next write slot, total records written). Each record is
tag (S, D, Q, C, H or T), time in units of 4096 cycles of the 74.25 MHz clock, and 32 bits of data:
  S  state change: new state, previous state, last data slot error, open error, game index
  D  diagnostic bits changed (the same bits as the squares along the top of the menu)
  Q  SDRAM sample: the pixel fetched for screen (160, 100) and the low 16 bits of its row base address
  C  the cartridge slot message from the Pocket (APF 0x00B1 payload) changed
  H  an inserted cart's header: global checksum (0x14E, 0x14F), header checksum (0x14D), version (0x14C)
  T  that cart's title CRC32 (bytes 0x134..0x13E), the value matched against the pack's FPR2 table

Usage: read_picker_log.py picker.log [cover_picker.sv]
"""
import os, re, struct, sys

TICK_MS = 4096 / 74_250_000 * 1000

# diagnostic bits, square 0 (leftmost) first
DBG = ["ce", "own", "rd", "nz", "cart_dl", "art_dl", "ioctl_dl", "paused",
       "ff_on", "gb_reset", "load_done", "sd_we", "ss_sleep", "hold_s", "art_wr", "boot_dl",
       "menu", "hold_gb", "art_err", "art_done", "tick", "line_rq", "fetch", "lb_we"]

def state_names(sv):
    names = {}
    if sv and os.path.exists(sv):
        for n, v in re.findall(r"\b(S_\w+)\s*=\s*(\d+)", open(sv).read()):
            names.setdefault(int(v), n)
    return names

def bits(v):
    return " ".join(n for i, n in enumerate(DBG) if v >> i & 1)

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    raw = open(sys.argv[1], "rb").read()
    here = os.path.dirname(os.path.abspath(__file__))
    sv = sys.argv[2] if len(sys.argv) > 2 else next((p for p in (
        os.path.join(here, "..", "src", "core", "cover_picker.sv"),
        os.path.join(here, "..", "openfpga-GBC", "src", "core", "cover_picker.sv")) if os.path.exists(p)), None)
    names = state_names(sv)
    if raw[:4] == b"PLOG": end = ">"
    elif raw[:4] == b"GOLP": end = "<"
    else: sys.exit(f"not a picker log (starts with {raw[:4]!r})")
    words = struct.unpack(f"{end}{len(raw) // 4}I", raw[:len(raw) // 4 * 4])
    recs = [(words[2 * i], words[2 * i + 1]) for i in range(len(words) // 2)]
    wp, total = recs[0][1] >> 16 & 0x1FF, recs[0][1] & 0xFFFF
    # records 1..64 are the first 64 written (the boot) and are never overwritten; 65..511 are a ring
    order = list(range(1, 65)) + list(range(wp, 512)) + list(range(65, wp)) if total > 511 else list(range(1, wp))
    print(f"{total} records written, showing {len(order)}")
    st = lambda v: names.get(v, str(v))
    for i in order:
        hi, lo = recs[i]
        tag, t = chr(hi >> 24), (hi & 0xFFFFFF) * TICK_MS
        if tag == "S":
            new, old = lo >> 25 & 0x7F, lo >> 18 & 0x7F
            terr, oerr, idx = lo >> 15 & 7, lo >> 12 & 7, lo & 0x7FF
            print(f"{t:10.2f} ms  S  {st(old)} -> {st(new)}  game {idx}  slot_err {terr} open_err {oerr}")
        elif tag == "D":
            print(f"{t:10.2f} ms  D  {lo & 0xFFFFFF:06x}  [{bits(lo)}]")
        elif tag == "C":
            print(f"{t:10.2f} ms  C  cartridge slot (APF 0x00B1): {lo:08x}  play_cartridge={lo >> 24 & 1}")
        elif tag == "H":
            print(f"{t:10.2f} ms  H  cart header: global checksum {lo >> 16:04x}  header checksum {lo >> 8 & 0xFF:02x}  version {lo & 0xFF:02x}")
        elif tag == "T":
            print(f"{t:10.2f} ms  T  cart title CRC32 {lo:08x}")
        elif tag == "Q":
            print(f"{t:10.2f} ms  Q  row base ..{lo >> 16:04x}  pixel {lo & 0xFFFF:04x}")
        else:
            print(f"{t:10.2f} ms  ?  {hi:08x} {lo:08x}")

if __name__ == "__main__": main()
