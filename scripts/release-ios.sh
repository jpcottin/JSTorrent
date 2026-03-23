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

# Fail if working tree is dirty (avoid releasing with uncommitted changes)
if ! git diff-index --quiet HEAD --; then
  echo "Error: Working tree has uncommitted changes. Please commit or stash first."
  git diff --stat
  exit 1
fi

TAG="ios-v${VERSION}"
PROJECT_YML="ios/project.yml"
CHANGELOG="ios/CHANGELOG.md"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" "$CHANGELOG" 2>/dev/null; then
  echo "Error: $CHANGELOG doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Get current build number and increment
CURRENT_BUILD=$(grep "CURRENT_PROJECT_VERSION:" "$PROJECT_YML" | grep -o "'[0-9]*'" | tr -d "'")
NEW_BUILD=$((CURRENT_BUILD + 1))

echo "Updating iOS version: $VERSION (build $NEW_BUILD)"

# Update project.yml
sed -i '' "s/MARKETING_VERSION: '[^']*'/MARKETING_VERSION: '$VERSION'/" "$PROJECT_YML"
sed -i '' "s/CURRENT_PROJECT_VERSION: '[^']*'/CURRENT_PROJECT_VERSION: '$NEW_BUILD'/" "$PROJECT_YML"

# Commit, tag, and push
git add "$PROJECT_YML" "$CHANGELOG"
git commit -m "Release iOS v${VERSION}"
git push origin HEAD

# Create and push tag separately (this triggers the release build)
git tag "$TAG"
git push origin "$TAG"

echo ""
echo "Released iOS v${VERSION} (build: $NEW_BUILD)"
echo "CI will build, upload to ASC, submit for notarization, fetch ADP, and publish."
echo "Monitor: https://github.com/kzahel/jstorrent/actions"
echo ""
echo "If CI times out waiting for notarization, re-run via:"
echo "  GitHub Actions → 'iOS Finalize Release' → Run workflow → version: $VERSION"
