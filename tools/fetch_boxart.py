#!/usr/bin/env python3
"""Download box art for the ROMs on the card from the libretro-thumbnails GBC/GB sets (CC-BY-NC community scans).
Matches each ROM's file stem to a thumbnail name by prefix, ignoring region/revision tags. Saves PNGs into ./covers."""
import json, os, re, sys, urllib.request, urllib.parse
ROMS = sys.argv[1]; OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
REPOS = ["Nintendo_-_Game_Boy_Color", "Nintendo_-_Game_Boy"]
def norm(s): return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()
trees = {}
for repo in REPOS:
    url = f"https://api.github.com/repos/libretro-thumbnails/{repo}/git/trees/master?recursive=1"
    req = urllib.request.Request(url, headers={"User-Agent": "curl", "Accept": "application/vnd.github+json"})
    try: t = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e: print("tree fetch failed", repo, e); continue
    trees[repo] = [p["path"] for p in t.get("tree", []) if p["path"].startswith("Named_Boxarts/") and p["path"].endswith(".png")]
    print(repo, len(trees[repo]), "boxarts")
for rom in sorted(os.listdir(ROMS)):
    if not rom.lower().endswith((".gbc", ".gb")): continue
    stem = os.path.splitext(rom)[0]; key = norm(stem); best = None
    for repo, paths in trees.items():
        for p in paths:
            name = os.path.splitext(os.path.basename(p))[0]
            base = norm(re.sub(r"\s*\(.*?\)", "", name))
            if base == key or base.startswith(key) or key.startswith(base) and len(base) > 8:
                score = (base == key, "usa" in name.lower(), -len(name))
                if best is None or score > best[0]: best = (score, repo, p)
    if not best: print("no match:", rom); continue
    _, repo, p = best
    dst = os.path.join(OUT, stem + ".png")
    u = f"https://raw.githubusercontent.com/libretro-thumbnails/{repo}/master/{urllib.parse.quote(p)}"
    try: urllib.request.urlretrieve(u, dst); print(f"{rom}  <-  {os.path.basename(p)}")
    except Exception as e: print("download failed:", rom, e)
