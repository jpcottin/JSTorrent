#!/usr/bin/env bash
#
# sim-install.sh - Build, install, and launch JSTorrent on the iOS simulator
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/.." && pwd)"
# shellcheck source=lib/simulator-device.sh
source "$SCRIPT_DIR/lib/simulator-device.sh"

PROJECT_PATH="$IOS_DIR/JSTorrent.xcodeproj"
PROJECT_SPEC="$IOS_DIR/project.yml"
SCHEME="${SCHEME:-JSTorrent}"
BUNDLE_ID="${BUNDLE_ID:-com.jstorrent.ios}"
CONFIGURATION="Debug"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$IOS_DIR/build}"
DEVICE_NAME="${DEVICE_NAME:-$DEFAULT_SIM_DEVICE_NAME}"
BUILD=true
BUILD_BUNDLE=true
LAUNCH=true

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --device NAME       Build for and install to a specific simulator name
  --no-build          Skip the Xcode build and engine bundle build
  --no-bundle         Skip only the TypeScript engine bundle build
  --no-launch         Install but do not launch the app
  --release           Build the Release configuration instead of Debug
  --derived-data DIR  Override DerivedData output path
  -h, --help          Show this help message

Environment:
  DEVICE_NAME         Default simulator name (default: $DEFAULT_SIM_DEVICE_NAME)
  SCHEME              Xcode scheme (default: JSTorrent)
  BUNDLE_ID           App bundle id (default: com.jstorrent.ios)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --device)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --device requires a simulator name" >&2
                exit 1
            fi
            DEVICE_NAME="$2"
            shift 2
            ;;
        --no-build)
            BUILD=false
            BUILD_BUNDLE=false
            shift
            ;;
        --no-bundle)
            BUILD_BUNDLE=false
            shift
            ;;
        --no-launch)
            LAUNCH=false
            shift
            ;;
        --release)
            CONFIGURATION="Release"
            shift
            ;;
        --derived-data)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --derived-data requires a path" >&2
                exit 1
            fi
            DERIVED_DATA_PATH="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Error: unknown option '$1'" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ -n "$(sim_find_booted_udid)" ]]; then
    UDID="$(sim_find_booted_udid)"
else
    "$SCRIPT_DIR/sim-start.sh" --device "$DEVICE_NAME" --no-open
    UDID="$(sim_resolve_udid "$DEVICE_NAME")"
fi

DEVICE_LABEL="$(sim_device_name_for_udid "$UDID")"
if [[ -z "$DEVICE_LABEL" ]]; then
    echo "Error: failed to resolve simulator for UDID $UDID" >&2
    exit 1
fi

if $BUILD_BUNDLE; then
    echo ">>> Building TypeScript engine bundle..."
    pnpm -C "$REPO_ROOT/packages/engine" bundle:native
fi

# Sync engine bundle before xcodegen so the file exists when the project is generated
# (otherwise xcodegen won't create a resource copy phase for it)
"$SCRIPT_DIR/sync-engine-bundle.sh"

echo ">>> Generating Xcode project..."
xcodegen generate --spec "$PROJECT_SPEC"

if $BUILD; then
    echo ">>> Building $CONFIGURATION app for '$DEVICE_LABEL'..."
    xcodebuild \
        -project "$PROJECT_PATH" \
        -scheme "$SCHEME" \
        -configuration "$CONFIGURATION" \
        -destination "id=$UDID" \
        -derivedDataPath "$DERIVED_DATA_PATH" \
        CODE_SIGNING_ALLOWED=NO \
        build
fi

APP_PATH="$DERIVED_DATA_PATH/Build/Products/$CONFIGURATION-iphonesimulator/$SCHEME.app"
if [[ ! -d "$APP_PATH" ]]; then
    echo "Error: app bundle not found at $APP_PATH" >&2
    exit 1
fi

echo ">>> Installing app to '$DEVICE_LABEL'..."
xcrun simctl install "$UDID" "$APP_PATH"

if $LAUNCH; then
    open -a Simulator --args -CurrentDeviceUDID "$UDID"
    echo ">>> Launching $BUNDLE_ID..."
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl launch "$UDID" "$BUNDLE_ID"
fi

echo ""
echo "=== Installed $CONFIGURATION ==="
echo "Device: $DEVICE_LABEL"
echo "App:    $APP_PATH"
echo ""
echo "Useful commands:"
echo "    $SCRIPT_DIR/sim-install.sh --no-build"
echo "    xcrun simctl launch $UDID $BUNDLE_ID"
echo "    xcrun simctl terminate $UDID $BUNDLE_ID"
