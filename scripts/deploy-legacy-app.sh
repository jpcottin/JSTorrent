#!/bin/bash
#
# Deploy legacy Chrome App to Chromebook for testing (load as unpacked).
#
# Prerequisites:
#   - SSH access: ssh chromebook works
#   - Load unpacked once from ~/Downloads/crostini-shared/jstorrent-legacy-app/
#
# Usage:
#   ./scripts/deploy-legacy-app.sh
#
set -e
cd "$(dirname "$0")/.."

CHROMEBOOK_HOST="${CHROMEBOOK_HOST:-chromebook}"
REMOTE_PATH="/mnt/chromeos/MyFiles/Downloads/crostini-shared/jstorrent-legacy-app"

# Warn if running from Crostini
if [[ -f /etc/apt/sources.list.d/cros.list ]]; then
    echo "Warning: Running from Crostini. This script is meant for external dev machines."
    echo "   Press Ctrl+C to cancel, or wait 3s to continue anyway..."
    sleep 3
fi

echo "Deploying legacy app to $CHROMEBOOK_HOST:$REMOTE_PATH/"

# Create target directory if needed
ssh "$CHROMEBOOK_HOST" "mkdir -p '$REMOTE_PATH'"

rsync -av --delete \
    --exclude='.git' \
    --exclude='package.sh' \
    --exclude='README.md' \
    --exclude='TODO.txt' \
    --exclude='LICENSE' \
    archive/legacy-app/ \
    "$CHROMEBOOK_HOST:$REMOTE_PATH/"

echo "Done! Legacy app deployed to $REMOTE_PATH"
echo "Load as unpacked Chrome App at chrome://extensions/ (enable Developer mode)"
