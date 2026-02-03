#!/bin/bash
# Build website and copy assets to Android (if needed)
set -e

cd "$(dirname "$0")/.."

WEBSITE_DIR="website"
ANDROID_ASSETS="android/app/src/main/assets"

echo "Building website..."
cd "$WEBSITE_DIR"
pnpm build

echo "Copying assets to Android..."
cd ..

# Ensure assets directory exists
mkdir -p "$ANDROID_ASSETS"

# Copy assets that exist (standalone dirs are legacy, may not exist)
for dir in standalone standalone_full assets; do
    if [ -d "$WEBSITE_DIR/dist/$dir" ]; then
        rm -rf "$ANDROID_ASSETS/$dir"
        cp -r "$WEBSITE_DIR/dist/$dir" "$ANDROID_ASSETS/"
        echo "  Copied $dir"
    fi
done

echo "Done."
