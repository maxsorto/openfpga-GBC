#!/bin/sh
# Package the built core as "maxsorto.GBC" (cover picker build) into a staging folder laid out like the SD card root.
# Usage: package_core.sh [covers.bin] [out-dir]   (run from anywhere; the repo is the parent of this folder)
set -e
TOOLS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$TOOLS")"
PACK="${1:-covers.bin}"
OUT="${2:-stage}"
RBF="$REPO/src/output_files/ap_core.rbf"
[ -f "$RBF" ] || { echo "no bitstream at $RBF (build first)"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/Cores/maxsorto.GBC" "$OUT/Assets/gbc/common" "$OUT/Platforms"
cp "$REPO/pkg/gbc/Cores/budude2.GBC/"*.json "$REPO/pkg/gbc/Cores/budude2.GBC/icon.bin" "$REPO/pkg/gbc/Cores/budude2.GBC/info.txt" "$OUT/Cores/maxsorto.GBC/" 2>/dev/null || true
python3 -I - "$OUT/Cores/maxsorto.GBC/core.json" <<'PY'
import json, sys, datetime
p = sys.argv[1]; d = json.load(open(p)); m = d["core"]["metadata"]
m["author"] = "maxsorto"; m["shortname"] = "GBC"; m["version"] = m.get("version", "1.4.0") + "-cover1"
m["date_release"] = datetime.date.today().isoformat(); m["url"] = "https://github.com/maxsorto/openfpga-GBC"
m["description"] = (m.get("description", "") + " Cover picker: box-art game menu; press L in game to pause, resume or go home.").strip()
json.dump(d, open(p, "w"), indent=2); print("core.json:", m["author"], m["version"])
PY
python3 -I "$TOOLS/reverse_bitstream.py" "$RBF" "$OUT/Cores/maxsorto.GBC/gbc.rbf_r"
cp "$PACK" "$OUT/Assets/gbc/common/covers.bin"
cp -R "$REPO/pkg/gbc/Platforms/." "$OUT/Platforms/" 2>/dev/null || true
echo "staged at $OUT:"; find "$OUT" -type f | sed "s|$OUT/||"
