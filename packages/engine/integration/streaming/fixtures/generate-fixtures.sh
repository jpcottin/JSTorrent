#!/usr/bin/env bash
# Generate test video fixtures for streaming integration tests.
# Requires ffmpeg. Run from any directory.
set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="$FIXTURES_DIR/test-video-long.mp4"

if [ -f "$OUTPUT" ]; then
  echo "Fixture already exists: $OUTPUT"
  exit 0
fi

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg is required. Install with: brew install ffmpeg" >&2
  exit 1
fi

echo "Generating test video fixture..."
ffmpeg -y \
  -f lavfi -i "testsrc2=duration=8:size=320x240:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=8:sample_rate=44100" \
  -vcodec libx264 -preset ultrafast -crf 28 \
  -force_key_frames "expr:eq(mod(n,30),0)" \
  -acodec aac -b:a 64k \
  -movflags +faststart \
  "$OUTPUT" 2>&1 | tail -5

echo "Generated: $OUTPUT ($(wc -c < "$OUTPUT" | tr -d ' ') bytes)"
