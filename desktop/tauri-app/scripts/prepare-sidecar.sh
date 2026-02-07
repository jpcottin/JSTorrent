#!/usr/bin/env bash
# Build io-daemon and copy to target dirs for Tauri dev/build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="$DESKTOP_DIR/target"
TRIPLE="$(rustc --print host-tuple)"

# Build io-daemon (release for performance even in dev)
cargo build --release -p jstorrent-io-daemon --manifest-path "$DESKTOP_DIR/Cargo.toml"

SRC="$TARGET_DIR/release/jstorrent-io-daemon"

# Copy for tauri build (src-tauri/binaries/ with triple suffix)
mkdir -p "$SCRIPT_DIR/../src-tauri/binaries"
cp "$SRC" "$SCRIPT_DIR/../src-tauri/binaries/jstorrent-io-daemon-$TRIPLE"

# Copy for tauri dev (target/debug/binaries/ without triple suffix)
mkdir -p "$TARGET_DIR/debug/binaries"
cp "$SRC" "$TARGET_DIR/debug/binaries/jstorrent-io-daemon"

echo "io-daemon sidecar prepared for $TRIPLE"
