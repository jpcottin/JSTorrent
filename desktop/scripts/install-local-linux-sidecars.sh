#!/bin/bash
set -e

if [[ "$(uname)" != "Linux" ]]; then
    echo "Error: This script is for Linux only."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$SCRIPT_DIR/.."

echo "Building jstorrent-host and jstorrent-io-daemon in release mode..."
cargo build --release -p jstorrent-host -p jstorrent-io-daemon --manifest-path "$DESKTOP_DIR/Cargo.toml"

INSTALL_DIR="$HOME/.local/lib/jstorrent"
mkdir -p "$INSTALL_DIR"

TARGET_DIR="$DESKTOP_DIR/target/release"

echo "Installing binaries to $INSTALL_DIR..."
cp "$TARGET_DIR/jstorrent-host" "$INSTALL_DIR/jstorrent-host"
cp "$TARGET_DIR/jstorrent-io-daemon" "$INSTALL_DIR/jstorrent-io-daemon"
chmod 755 "$INSTALL_DIR/jstorrent-host" "$INSTALL_DIR/jstorrent-io-daemon"

# Register native messaging host for Chrome/Chromium
HOST_PATH="$INSTALL_DIR/jstorrent-host"
MANIFEST='{
  "name": "com.jstorrent.native",
  "description": "JSTorrent Native Messaging Host",
  "path": "'"$HOST_PATH"'",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://dbokmlpefliilbjldladbimlcfgbolhk/",
    "chrome-extension://opkmhecbhgngcbglpcdfmnomkffenapc/"
  ]
}'

for BROWSER_DIR in \
    "$HOME/.config/google-chrome/NativeMessagingHosts" \
    "$HOME/.config/chromium/NativeMessagingHosts"; do
    mkdir -p "$BROWSER_DIR"
    echo "$MANIFEST" > "$BROWSER_DIR/com.jstorrent.native.json"
    echo "Registered native host: $BROWSER_DIR/com.jstorrent.native.json"
done

echo "Installed: $INSTALL_DIR/jstorrent-host"
echo "Installed: $INSTALL_DIR/jstorrent-io-daemon"
