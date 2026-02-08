#!/usr/bin/env bash
# Build system-bridge (native host) and io-daemon, copy to target dirs for Tauri dev/build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET_DIR="$DESKTOP_DIR/target"
TRIPLE="$(rustc --print host-tuple)"

BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
HOST_BIN="$BIN_DIR/jstorrent-host-$TRIPLE"
DAEMON_BIN="$BIN_DIR/jstorrent-io-daemon-$TRIPLE"

# On Windows, binaries have .exe extension
if [[ "$TRIPLE" == *"windows"* ]]; then
  HOST_BIN="$HOST_BIN.exe"
  DAEMON_BIN="$DAEMON_BIN.exe"
fi

# In CI, sidecars are pre-built (possibly cross-compiled). Skip rebuild to avoid
# overwriting a cross-compiled binary with a host-triple build.
if [ "${CI:-}" = "true" ] && [ -s "$HOST_BIN" ] && [ -s "$DAEMON_BIN" ]; then
  echo "CI: sidecar binaries already built for $TRIPLE, skipping rebuild"
  exit 0
fi

# Build system-bridge (native host) - release for performance even in dev
cargo build --release -p jstorrent-host --manifest-path "$DESKTOP_DIR/Cargo.toml"

# Build io-daemon - release for performance even in dev
cargo build --release -p jstorrent-io-daemon --manifest-path "$DESKTOP_DIR/Cargo.toml"

HOST_SRC="$TARGET_DIR/release/jstorrent-host"
DAEMON_SRC="$TARGET_DIR/release/jstorrent-io-daemon"

# Copy for tauri build (src-tauri/binaries/ with triple suffix)
mkdir -p "$BIN_DIR"
cp "$HOST_SRC" "$HOST_BIN"
cp "$DAEMON_SRC" "$DAEMON_BIN"

# Copy for tauri dev (target/debug/binaries/ without triple suffix)
mkdir -p "$TARGET_DIR/debug/binaries"
cp "$HOST_SRC" "$TARGET_DIR/debug/binaries/jstorrent-host"
cp "$DAEMON_SRC" "$TARGET_DIR/debug/binaries/jstorrent-io-daemon"

echo "Sidecars prepared for $TRIPLE (jstorrent-host + jstorrent-io-daemon)"
