#!/usr/bin/env bash
# Build system-bridge (native host) and io-daemon, copy to target dirs for Tauri dev/build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="$DESKTOP_DIR/target"
TRIPLE="$(rustc --print host-tuple)"

# If sidecar binaries already exist for this triple (e.g. CI pre-built them), skip building
if [ -f "$SCRIPT_DIR/../src-tauri/binaries/jstorrent-host-$TRIPLE" ] || \
   [ -f "$SCRIPT_DIR/../src-tauri/binaries/jstorrent-host-$TRIPLE.exe" ]; then
  echo "Sidecar binaries already present for $TRIPLE, skipping build"
  exit 0
fi

# Build system-bridge (native host) - release for performance even in dev
cargo build --release -p jstorrent-host --manifest-path "$DESKTOP_DIR/Cargo.toml"

# Build io-daemon - release for performance even in dev
cargo build --release -p jstorrent-io-daemon --manifest-path "$DESKTOP_DIR/Cargo.toml"

HOST_SRC="$TARGET_DIR/release/jstorrent-host"
DAEMON_SRC="$TARGET_DIR/release/jstorrent-io-daemon"

# Copy for tauri build (src-tauri/binaries/ with triple suffix)
mkdir -p "$SCRIPT_DIR/../src-tauri/binaries"
cp "$HOST_SRC" "$SCRIPT_DIR/../src-tauri/binaries/jstorrent-host-$TRIPLE"
cp "$DAEMON_SRC" "$SCRIPT_DIR/../src-tauri/binaries/jstorrent-io-daemon-$TRIPLE"

# Copy for tauri dev (target/debug/binaries/ without triple suffix)
mkdir -p "$TARGET_DIR/debug/binaries"
cp "$HOST_SRC" "$TARGET_DIR/debug/binaries/jstorrent-host"
cp "$DAEMON_SRC" "$TARGET_DIR/debug/binaries/jstorrent-io-daemon"

echo "Sidecars prepared for $TRIPLE (jstorrent-host + jstorrent-io-daemon)"
