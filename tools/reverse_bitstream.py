#!/usr/bin/env python3
"""Turn Quartus' .rbf into the Analogue Pocket's .rbf_r (every byte bit-reversed)."""
import sys
src, dst = sys.argv[1], sys.argv[2]
table = bytes(int(f"{i:08b}"[::-1], 2) for i in range(256))
data = open(src, "rb").read()
open(dst, "wb").write(data.translate(table))
print(f"{dst}: {len(data)} bytes")
