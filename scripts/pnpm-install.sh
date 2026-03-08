#!/usr/bin/env bash
# Wrapper around pnpm install that temporarily disables .pnpmfile.cjs
# so that local link overrides don't get baked into pnpm-lock.yaml.
#
# Use this instead of raw `pnpm install` when the lockfile will be committed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/.pnpmfile.cjs"
BACKUP="$ROOT/.pnpmfile.cjs.bak"

cleanup() {
  if [ -f "$BACKUP" ]; then
    mv "$BACKUP" "$HOOK"
  fi
}
trap cleanup EXIT

if [ -f "$HOOK" ]; then
  mv "$HOOK" "$BACKUP"
fi

cd "$ROOT"
pnpm install "$@"
