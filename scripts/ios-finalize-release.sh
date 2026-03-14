#!/usr/bin/env bash
set -e

VERSION="$1"
ADP_URL="$2"

if [ -z "$VERSION" ] || [ -z "$ADP_URL" ]; then
  echo "Usage: $0 <version> <adp-manifest-url>"
  echo ""
  echo "Run after Apple notarization is approved and ADP is hosted."
  echo ""
  echo "Example:"
  echo "  $0 1.0.0 https://github.com/kzahel/jstorrent/releases/download/ios-v1.0.0/manifest.json"
  exit 1
fi

TAG="ios-v${VERSION}"
TEMPLATE="ios/altstore-source.template.json"
OUTPUT="website/public/altstore-source.json"
CHANGELOG="ios/CHANGELOG.md"

if [ ! -f "$TEMPLATE" ]; then
  echo "Error: Template not found at $TEMPLATE"
  exit 1
fi

# Extract release notes (first 20 lines of version section)
NOTES=$(awk "/^## \[${VERSION}\]/{found=1; next} /^## \[/{found=0} found" "$CHANGELOG" | head -20)
NOTES_ONELINE=$(echo "$NOTES" | tr '\n' ' ' | sed 's/  */ /g' | sed 's/"/\\"/g' | sed 's/^ *//' | sed 's/ *$//')

# Get build number from project.yml
BUILD_VERSION=$(grep "CURRENT_PROJECT_VERSION:" "ios/project.yml" | grep -o "'[0-9]*'" | tr -d "'")

# Get current date in ISO 8601
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Substitute placeholders
sed \
  -e "s|%%VERSION%%|${VERSION}|g" \
  -e "s|%%BUILD_VERSION%%|${BUILD_VERSION}|g" \
  -e "s|%%DATE%%|${DATE}|g" \
  -e "s|%%ADP_DOWNLOAD_URL%%|${ADP_URL}|g" \
  -e "s|%%IPA_SIZE%%|0|g" \
  -e "s|%%RELEASE_NOTES%%|${NOTES_ONELINE}|g" \
  "$TEMPLATE" > "$OUTPUT"

echo "Updated $OUTPUT"
echo ""
echo "Next steps:"
echo "  1. Commit and push:  git add $OUTPUT && git commit -m 'Update AltStore source for iOS v${VERSION}' && git push"
echo "  2. Undraft release:  gh release edit $TAG --draft=false"
echo "  3. Verify source:    https://jstorrent.com/altstore-source.json"
