#!/bin/bash
#
# Deploy extension to Windows VM shared folder for testing.
#
# Prerequisites:
#   - Shared folder mounted at ~/Downloads/WindowsShared
#   - Extension loaded in Windows Chrome from the shared folder
#
# Usage:
#   ./scripts/deploy-windows-vm.sh
#
set -e
cd "$(dirname "$0")/.."

DEST="${WINDOWS_SHARED:-$HOME/Downloads/WindowsShared}/jstorrent-extension"

echo "Building extension..."
pnpm build

echo "Deploying to $DEST/"
mkdir -p "$DEST"

rsync -av --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    extension/dist/ \
    "$DEST/"

echo "Done! Extension deployed to $DEST"
