#!/usr/bin/env bash
set -e

VERSION="$1"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9] ]]; then
  echo "Error: Version must start with a number (e.g., 1.0.0, not v1.0.0)"
  exit 1
fi

TAG="extension-v${VERSION}"
MANIFEST="extension/public/manifest.json"
CHANGELOG="extension/CHANGELOG.md"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" "$CHANGELOG" 2>/dev/null; then
  echo "Error: $CHANGELOG doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Get current version
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' "$MANIFEST" | grep -o '[0-9][^"]*')
echo "Updating manifest version: $CURRENT_VERSION -> $VERSION"

# Update manifest.json version
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$MANIFEST"

# Commit, tag, and push
git add "$MANIFEST" "$CHANGELOG"
git commit -m "Release Extension v${VERSION}"
git tag "$TAG"
git push origin main "$TAG"

echo "Released Extension v${VERSION}"
echo "CI will build and create GitHub release: https://github.com/kzahel/jstorrent/actions"
