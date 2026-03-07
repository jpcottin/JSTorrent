#!/usr/bin/env bash
# Generate test video fixtures for streaming integration tests.
# Requires ffmpeg. Run from any directory.
set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg is required. Install with: brew install ffmpeg" >&2
  exit 1
fi

# ── MP4 fixture: 8s video for basic streaming tests ──
MP4_OUTPUT="$FIXTURES_DIR/test-video-long.mp4"

if [ -f "$MP4_OUTPUT" ]; then
  echo "Fixture already exists: $MP4_OUTPUT"
else
  echo "Generating MP4 test fixture (8s)..."
  ffmpeg -y \
    -f lavfi -i "testsrc2=duration=8:size=320x240:rate=30" \
    -f lavfi -i "sine=frequency=440:duration=8:sample_rate=44100" \
    -vcodec libx264 -preset ultrafast -crf 28 \
    -force_key_frames "expr:eq(mod(n,30),0)" \
    -acodec aac -b:a 64k \
    -movflags +faststart \
    "$MP4_OUTPUT" 2>&1 | tail -5
  echo "Generated: $MP4_OUTPUT ($(wc -c < "$MP4_OUTPUT" | tr -d ' ') bytes)"
fi

# ── MKV fixture: 30s video with many clusters for I/O behavior testing ──
MKV_OUTPUT="$FIXTURES_DIR/test-video-long.mkv"

if [ -f "$MKV_OUTPUT" ]; then
  echo "Fixture already exists: $MKV_OUTPUT"
else
  echo "Generating MKV test fixture (30s, keyframe every 1s)..."
  ffmpeg -y \
    -f lavfi -i "testsrc2=duration=30:size=320x240:rate=30" \
    -f lavfi -i "sine=frequency=440:duration=30:sample_rate=44100" \
    -vcodec libx264 -preset ultrafast -crf 28 \
    -force_key_frames "expr:eq(mod(n,30),0)" \
    -acodec aac -b:a 64k \
    -f matroska \
    "$MKV_OUTPUT" 2>&1 | tail -5
  echo "Generated: $MKV_OUTPUT ($(wc -c < "$MKV_OUTPUT" | tr -d ' ') bytes)"
fi
