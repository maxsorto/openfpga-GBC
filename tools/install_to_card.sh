#!/bin/sh
# Copy the staged core onto the Pocket's SD card (merging folders). Usage: install_to_card.sh [stage] [card]
set -e
STAGE="${1:-$HOME/Documents/analogue-pocket/stage}"; CARD="${2:-/Volumes/Pocket}"
[ -d "$CARD/Cores" ] || { echo "card not mounted at $CARD"; exit 1; }
rsync -av "$STAGE/Cores/" "$CARD/Cores/"; rsync -av "$STAGE/Assets/" "$CARD/Assets/"
echo "installed. Eject the card, boot the Pocket, pick openFPGA > GBC (maxsorto)."
