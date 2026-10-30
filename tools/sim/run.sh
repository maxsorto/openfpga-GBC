#!/bin/sh
# Build and run testbenches with Verilator (about 20x faster than Icarus). Run from the folder that holds the
# testbenches' data files (packs as .hex, fonts). Usage: run.sh tb_name [extra verilator flags], e.g.
#   sh run.sh tb_vt -DSCEN_B
# Frames and logs land next to the data; the build goes to vl/<tb><flags>/.
set -e
here=$(cd "$(dirname "$0")" && pwd)
tb=$1; shift
tag=$(echo "$tb$*" | tr -c 'A-Za-z0-9_' '_')
verilator --binary --timing -j 8 -O3 -Wno-fatal -Wno-lint -Wno-style -Wno-MULTIDRIVEN -Wno-INITIALDLY \
  -DFIRST=${FIRST:-9999} "$@" --top-module "$tb" -Mdir "vl/$tag" -o "$tb" \
  "$here/$tb.sv" "$here/../../src/core/cover_picker.sv" "$here/dpram_sim.v" > "vl/$tag.build.log" 2>&1 \
  || { grep -E "%Error" "vl/$tag.build.log" | head -20; exit 1; }
"./vl/$tag/$tb"
