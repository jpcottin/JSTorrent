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

TAG="tauri-app-v${VERSION}"
CHANGELOG="$REPO_ROOT/desktop/tauri-app/CHANGELOG.md"

# Check that changelog has been updated (hard fail)
if ! grep -q "## \[${VERSION}\]" "$CHANGELOG" 2>/dev/null; then
  echo "Error: $CHANGELOG doesn't have an entry for version ${VERSION}"
  echo "Please add a '## [${VERSION}]' section before releasing."
  exit 1
fi

# Update version in tauri.conf.json
TAURI_CONF="$REPO_ROOT/desktop/tauri-app/src-tauri/tauri.conf.json"
PKG_JSON="$REPO_ROOT/desktop/tauri-app/package.json"
CARGO_TOML="$REPO_ROOT/desktop/tauri-app/src-tauri/Cargo.toml"

if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS sed requires -i ''
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$TAURI_CONF"
  sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$PKG_JSON"
  sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" "$CARGO_TOML"
else
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$TAURI_CONF"
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$PKG_JSON"
  sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" "$CARGO_TOML"
fi

# Update Cargo.lock
(cd "$REPO_ROOT/desktop" && cargo check --quiet)

# Commit version bump
git add "$TAURI_CONF" "$PKG_JSON" "$CARGO_TOML" "$REPO_ROOT/desktop/Cargo.lock" "$CHANGELOG"
git commit -m "Release Tauri App v${VERSION}"

# Push commit and tag
git push origin HEAD

# Create and push tag separately (this triggers the release build)
git tag "$TAG"
git push origin "$TAG"

echo "Created and pushed tag $TAG"
