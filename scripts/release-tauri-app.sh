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

# Fail if working tree is dirty (avoid releasing with uncommitted changes)
if ! git diff-index --quiet HEAD --; then
  echo "Error: Working tree has uncommitted changes. Please commit or stash first."
  git diff --stat
  exit 1
fi

TAG="tauri-app-v${VERSION}"
CHANGELOG="$REPO_ROOT/desktop/tauri-app/CHANGELOG.md"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" "$CHANGELOG" 2>/dev/null; then
  echo "Error: $CHANGELOG doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Update version in all files
"$REPO_ROOT/desktop/scripts/set-tauri-version.sh" "$VERSION"

# Commit version bump
TAURI_CONF="$REPO_ROOT/desktop/tauri-app/src-tauri/tauri.conf.json"
PKG_JSON="$REPO_ROOT/desktop/tauri-app/package.json"
WORKSPACE_TOML="$REPO_ROOT/desktop/Cargo.toml"

git add "$TAURI_CONF" "$PKG_JSON" "$WORKSPACE_TOML" "$REPO_ROOT/desktop/Cargo.lock" "$CHANGELOG"
git commit -m "Release Tauri App v${VERSION}"

# Push commit and tag
git push origin HEAD

# Create and push tag separately (this triggers the release build)
git tag "$TAG"
git push origin "$TAG"

echo "Created and pushed tag $TAG"
