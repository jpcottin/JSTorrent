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

TAG="android-v${VERSION}"
BUILD_GRADLE="android/app/build.gradle.kts"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" android/CHANGELOG.md 2>/dev/null; then
  echo "Error: android/CHANGELOG.md doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Get current versionCode and increment
CURRENT_CODE=$(grep -o 'versionCode = [0-9]*' "$BUILD_GRADLE" | grep -o '[0-9]*')
NEW_CODE=$((CURRENT_CODE + 1))

echo "Updating version: $CURRENT_CODE -> $NEW_CODE, versionName: $VERSION"

# Update build.gradle.kts
sed -i '' "s/versionCode = $CURRENT_CODE/versionCode = $NEW_CODE/" "$BUILD_GRADLE"
sed -i '' "s/versionName = \"[^\"]*\"/versionName = \"$VERSION\"/" "$BUILD_GRADLE"

# Commit, tag, and push
git add "$BUILD_GRADLE"
git commit -m "Release Android v${VERSION}"
git tag "$TAG"
git push origin main "$TAG"

echo "Released Android v${VERSION} (versionCode: $NEW_CODE)"
echo "CI will build the signed APK: https://github.com/kzahel/jstorrent/actions"
