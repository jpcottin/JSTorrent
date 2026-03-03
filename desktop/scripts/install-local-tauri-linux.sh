#!/bin/bash
set -e

if [[ "$(uname)" != "Linux" ]]; then
    echo "Error: This script is for Linux only."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/../tauri-app"

if [ ! -f "$TAURI_DIR/src-tauri/tauri.conf.json" ]; then
    echo "Error: Cannot find tauri-app at $TAURI_DIR"
    exit 1
fi

# Read version from tauri.conf.json
VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_DIR/src-tauri/tauri.conf.json'))['version'])")
ARCH=$(uname -m)
case "$ARCH" in
    aarch64) ARCH_LABEL="aarch64" ;;
    x86_64) ARCH_LABEL="x86_64" ;;
    *) echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "Building Tauri app v${VERSION} (${ARCH_LABEL}) in release mode..."
cd "$TAURI_DIR"
# --no-sign: skip updater signing (no TAURI_SIGNING_PRIVATE_KEY needed for local testing)
pnpm tauri build --no-sign --bundles appimage

APPIMAGE_NAME="JSTorrent_${VERSION}_${ARCH_LABEL}.AppImage"
BUILD_APPIMAGE="$SCRIPT_DIR/../target/release/bundle/appimage/$APPIMAGE_NAME"

if [ ! -f "$BUILD_APPIMAGE" ]; then
    echo "Error: Built AppImage not found at $BUILD_APPIMAGE"
    exit 1
fi

INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
DEST="$INSTALL_DIR/JSTorrent.AppImage"

echo "Installing to $DEST..."
cp "$BUILD_APPIMAGE" "$DEST"
chmod +x "$DEST"

# Create .desktop entry so it shows in app launchers
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/jstorrent.desktop" << EOF
[Desktop Entry]
Name=JSTorrent
Exec=$DEST
Icon=jstorrent
Type=Application
Categories=Network;FileTransfer;
Comment=BitTorrent client
MimeType=application/x-bittorrent;x-scheme-handler/magnet;
EOF

echo "Installed: $DEST"
echo "Desktop entry: $DESKTOP_DIR/jstorrent.desktop"
echo ""
echo "Run with: $DEST"
