#!/usr/bin/env bash
set -e

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9] ]]; then
  echo "Error: Version must start with a number (e.g., 1.0.0, not v1.0.0)"
  exit 1
fi

TAG="system-bridge-v${VERSION}"
CHANGELOG="$REPO_ROOT/desktop/CHANGELOG.md"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" "$CHANGELOG" 2>/dev/null; then
  echo "Error: $CHANGELOG doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Update Cargo.toml versions (cross-platform sed -i)
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" "$REPO_ROOT/desktop/Cargo.toml"
  sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" "$REPO_ROOT/desktop/io-daemon/Cargo.toml"
else
  sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" "$REPO_ROOT/desktop/Cargo.toml"
  sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" "$REPO_ROOT/desktop/io-daemon/Cargo.toml"
fi

# Update Cargo.lock
(cd "$REPO_ROOT/desktop" && cargo check --quiet)

# Commit version bump
git add "$REPO_ROOT/desktop/Cargo.toml" "$REPO_ROOT/desktop/io-daemon/Cargo.toml" "$REPO_ROOT/desktop/Cargo.lock"
git commit -m "Release System Bridge v${VERSION}"

# Push commit and tag
git push origin HEAD

# Create and push tag separately (this triggers the release build)
git tag "$TAG"
git push origin "$TAG"

echo "Created and pushed tag $TAG"
