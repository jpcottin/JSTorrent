#!/bin/bash
# Build signed Android App Bundle for Play Store upload
set -e

SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR/../android"

# Path relative to app/ module (for gradle)
KEYSTORE_PATH="signing/upload.keystore"
KEY_ALIAS="upload"

# Check file exists (path relative to android/)
if [ ! -f "app/$KEYSTORE_PATH" ]; then
    echo "Error: Keystore not found at app/$KEYSTORE_PATH"
    exit 1
fi

# Prompt for password (hidden input)
echo -n "Enter keystore password: "
read -s PASSWORD
echo

# Build the bundle
./gradlew bundleRelease \
    -PUPLOAD_KEYSTORE_PATH="$KEYSTORE_PATH" \
    -PUPLOAD_KEYSTORE_PASSWORD="$PASSWORD" \
    -PUPLOAD_KEY_ALIAS="$KEY_ALIAS" \
    -PUPLOAD_KEY_PASSWORD="$PASSWORD"

OUTPUT="app/build/outputs/bundle/release/app-release.aab"
MAPPING="app/build/outputs/mapping/release/mapping.txt"

echo ""
echo "=== Build Complete ==="
echo ""
echo "Bundle: $(pwd)/$OUTPUT"
echo "Size:   $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "Mapping file: $(pwd)/$MAPPING"
echo "Size:         $(du -h "$MAPPING" | cut -f1)"
echo ""
echo "Upload the bundle to Play Console."
echo "Upload the mapping file to: App bundle explorer → Release → Downloads → Upload"
