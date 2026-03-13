#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
source_bundle="${repo_root}/packages/engine/dist/engine.native.js"
destination_bundle="${repo_root}/ios/JSTorrent/Resources/engine.bundle.js"
localization_script="${repo_root}/ios/scripts/sync-android-localizations.mjs"

if [[ -f "${source_bundle}" ]]; then
  cp "${source_bundle}" "${destination_bundle}"
  echo "Synced engine bundle to ${destination_bundle}"
else
  echo "warning: ${source_bundle} not found; keeping existing ${destination_bundle}" >&2
fi

if [[ -x "${localization_script}" ]]; then
  "${localization_script}"
fi
