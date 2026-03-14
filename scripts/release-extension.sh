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

TAG="extension-v${VERSION}"
MANIFEST="extension/public/manifest.json"
CHANGELOG="extension/CHANGELOG.md"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" "$CHANGELOG" 2>/dev/null; then
  echo "Error: $CHANGELOG doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Check companion smoke test was run
SMOKE_FLAG="/tmp/jstorrent-companion-smoke-passed"
if [[ ! -f "$SMOKE_FLAG" ]] || [[ $(find "$SMOKE_FLAG" -mmin +120 2>/dev/null) ]]; then
  echo ""
  echo "WARNING: Companion smoke test not run recently."
  echo "  Run:  ./scripts/e2e-companion-smoke.sh"
  echo "  Or:   FULL_DOWNLOAD=1 ./scripts/e2e-companion-smoke.sh  (1GB test)"
  echo ""
  read -p "Continue without smoke test? [y/N] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted. Run the smoke test first."
    exit 1
  fi
else
  echo "Companion smoke test passed recently. ✓"
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
