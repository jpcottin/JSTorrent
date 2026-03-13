#!/usr/bin/env bash
#
# sim-start.sh - Boot the iOS simulator for JSTorrent development
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/simulator-device.sh
source "$SCRIPT_DIR/lib/simulator-device.sh"

DEVICE_NAME="${DEVICE_NAME:-$DEFAULT_SIM_DEVICE_NAME}"
OPEN_SIMULATOR=true

usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --device NAME    Boot a specific simulator device name
  --no-open        Boot it without foregrounding the Simulator app
  -h, --help       Show this help message

Environment:
  DEVICE_NAME      Default simulator name (default: $DEFAULT_SIM_DEVICE_NAME)
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
        --no-open)
            OPEN_SIMULATOR=false
            shift
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

UDID="$(sim_resolve_udid "$DEVICE_NAME")"
RESOLVED_NAME="$(sim_device_name_for_udid "$UDID")"
STATE="$(sim_device_state_for_udid "$UDID")"

if [[ -z "$RESOLVED_NAME" ]]; then
    echo "Error: failed to resolve simulator name for $UDID" >&2
    exit 1
fi

if [[ "$STATE" != "Booted" ]]; then
    echo ">>> Booting simulator '$RESOLVED_NAME'..."
    xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
    xcrun simctl bootstatus "$UDID" -b
else
    echo "Simulator already booted: $RESOLVED_NAME"
fi

if $OPEN_SIMULATOR; then
    open -a Simulator --args -CurrentDeviceUDID "$UDID"
fi

echo ""
echo "=== Simulator Ready ==="
echo "Device: $RESOLVED_NAME"
echo "UDID:   $UDID"
echo ""
echo "Next step:"
echo "    $SCRIPT_DIR/sim-install.sh"
