#!/usr/bin/env bash
#
# dev-memory-run.sh - Run a repeatable Android memory capture on a real device
#
# Usage:
#   ./dev-memory-run.sh <device> [launch options] [magnet:?xt=urn:btih:...]
#
# This script:
#   1. Starts logcat capture for memory / lifecycle / LMK-related tags
#   2. Installs the app via dev-test-native.sh (--no-launch)
#   3. Removes the target torrent with deleteFiles=true before adding it back
#   4. Launches NativeStandaloneActivity with the target magnet
#   5. Captures initial engine and memory snapshots
#   6. Backgrounds the app after a delay
#   7. Periodically collects memory broadcasts, dumpsys meminfo, and status
#   8. Stops early if the app process dies
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/device-config.sh"

PACKAGE="com.jstorrent.app"
ACTIVITY="com.jstorrent.app/.NativeStandaloneActivity"
DEBUG_RECEIVER="com.jstorrent.app/.debug.DebugReceiver"
DEBUG_ACTION="com.jstorrent.DEBUG"
INFO_HASH_100MB="67d01ece1b99c49c257baada0f760b770a7530b9"
INFO_HASH_1GB="18a7aacab6d2bc518e336921ccd4b6cc32a9624b"
MAGNET_100MB="magnet:?xt=urn:btih:${INFO_HASH_100MB}&dn=testdata_100mb.bin&x.pe=10.0.2.2:6881&x.pe=127.0.0.1:6881&x.pe=100.115.92.206:6881&x.pe=192.168.1.107:6881&x.pe=192.168.1.131:6881&x.pe=192.168.1.139:6881"
MAGNET_1GB="magnet:?xt=urn:btih:${INFO_HASH_1GB}&dn=testdata_1gb.bin&x.pe=10.0.2.2:6881&x.pe=127.0.0.1:6881&x.pe=100.115.92.206:6881&x.pe=192.168.1.107:6881&x.pe=192.168.1.131:6881&x.pe=192.168.1.139:6881"

DEVICE_NAME=""
RUN_DURATION_SEC=300
SAMPLE_INTERVAL_SEC=15
DETAIL_INTERVAL_SEC=30
BACKGROUND_AFTER_SEC=45
WAIT_AFTER_LAUNCH_SEC=8
BACKGROUND_APP=true
CLEAR_LOGCAT=true
OUT_DIR=""
INCLUDE_JS_LOGS=false
LAUNCH_ARGS=()
SIZE_CHOICE="100mb"
STORAGE_MODE=""
TARGET_MAGNET=""
TARGET_INFO_HASH=""

usage() {
    cat <<EOF
Usage: $0 <device> [OPTIONS] [magnet:?xt=urn:btih:...]

Run a repeatable memory capture against a real Android device.

General options:
  --duration SEC          Total capture duration (default: 300)
  --sample-interval SEC   Seconds between memory samples (default: 15)
  --detail-interval SEC   Seconds between status/peer snapshots (default: 30)
  --background-after SEC  Send app to HOME after N seconds (default: 45)
  --wait-after-launch SEC Wait after launch before first snapshot (default: 8)
  --out-dir DIR           Output directory (default: android/tmp/memory-runs/<timestamp>)
  --keep-foreground       Do not send the app to HOME
  --no-clear-logcat       Keep existing logcat buffer
  --include-js-logs       Include JSTorrent-JS in streamed logcat
  -h, --help              Show this help

Launch options forwarded to dev-test-native.sh:
  --no-build
  --no-bundle
  --release
  --clear
  --size SIZE
  --private
  --null
  magnet:?xt=urn:btih:...

Examples:
  $0 pixel9 --size 1gb --duration 600 --background-after 30
  $0 pixel9 --clear --private "magnet:?xt=urn:btih:..."
EOF
}

timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

log() {
    echo "[$(timestamp)] $*"
}

append_note() {
    echo "[$(timestamp)] $*" >> "$RUN_LOG"
}

run_device() {
    run_adb_command "$DEVICE_NAME" "$@"
}

run_debug_cmd() {
    local cmd="$1"
    shift || true
    run_device shell am broadcast -n "$DEBUG_RECEIVER" -a "$DEBUG_ACTION" --es cmd "$cmd" "$@" >/dev/null
}

encode_base64() {
    if [[ "$(uname)" == "Darwin" ]]; then
        echo -n "$1" | base64
    else
        echo -n "$1" | base64 -w0
    fi
}

extract_info_hash() {
    local magnet="$1"
    local hash
    hash=$(printf '%s\n' "$magnet" | sed -n 's/.*xt=urn:btih:\([A-Fa-f0-9]\{40\}\).*/\1/p' | head -1)
    printf '%s' "${hash,,}"
}

resolve_target() {
    if [[ -z "$TARGET_MAGNET" ]]; then
        case "${SIZE_CHOICE,,}" in
            1gb)
                TARGET_MAGNET="$MAGNET_1GB"
                TARGET_INFO_HASH="$INFO_HASH_1GB"
                ;;
            100mb|"")
                TARGET_MAGNET="$MAGNET_100MB"
                TARGET_INFO_HASH="$INFO_HASH_100MB"
                ;;
            *)
                echo "Error: Unknown size '$SIZE_CHOICE'. Use '100mb' or '1gb'." >&2
                exit 1
                ;;
        esac
    else
        TARGET_INFO_HASH="$(extract_info_hash "$TARGET_MAGNET")"
    fi
}

launch_target_torrent() {
    local encoded_magnet
    local intent_uri
    local escaped_uri

    encoded_magnet="$(encode_base64 "$TARGET_MAGNET")"
    intent_uri="jstorrent://native?magnet_b64=$encoded_magnet"
    if [[ -n "$STORAGE_MODE" ]]; then
        intent_uri="${intent_uri}&storage=$STORAGE_MODE"
    fi
    escaped_uri="${intent_uri//&/\\&}"

    run_device shell am start -n "$ACTIVITY" -a android.intent.action.VIEW -d "$escaped_uri" >/dev/null
}

capture_meminfo() {
    {
        echo "=== $(timestamp) dumpsys meminfo ==="
        run_device shell dumpsys meminfo "$PACKAGE" || true
        echo
    } >> "$MEMINFO_LOG"
}

capture_proc_state() {
    local pid
    pid=$(run_device shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' || true)
    if [[ -z "$pid" ]]; then
        echo "[$(timestamp)] pid=dead" >> "$PROCESS_LOG"
        return 1
    fi
    echo "[$(timestamp)] pid=$pid" >> "$PROCESS_LOG"
    return 0
}

start_logcat_capture() {
    local filters=(
        "JSTorrent-Mem:I"
        "JSTorrent-Debug:I"
        "EngineController:I"
        "ActivityManager:I"
        "lmkd:I"
        "AndroidRuntime:E"
        "*:S"
    )
    if $INCLUDE_JS_LOGS; then
        filters=("JSTorrent-JS:I" "${filters[@]}")
    fi

    if $CLEAR_LOGCAT; then
        log "Clearing logcat buffer"
        run_device logcat -c || true
    fi

    log "Starting logcat capture -> $LOGCAT_LOG"
    run_device logcat -v threadtime "${filters[@]}" > "$LOGCAT_LOG" 2>&1 &
    LOGCAT_PID=$!
}

cleanup() {
    if [[ -n "${LOGCAT_PID:-}" ]]; then
        kill "$LOGCAT_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --duration)
            RUN_DURATION_SEC="$2"
            shift 2
            ;;
        --sample-interval)
            SAMPLE_INTERVAL_SEC="$2"
            shift 2
            ;;
        --detail-interval)
            DETAIL_INTERVAL_SEC="$2"
            shift 2
            ;;
        --background-after)
            BACKGROUND_AFTER_SEC="$2"
            shift 2
            ;;
        --wait-after-launch)
            WAIT_AFTER_LAUNCH_SEC="$2"
            shift 2
            ;;
        --out-dir)
            OUT_DIR="$2"
            shift 2
            ;;
        --keep-foreground)
            BACKGROUND_APP=false
            shift
            ;;
        --no-clear-logcat)
            CLEAR_LOGCAT=false
            shift
            ;;
        --include-js-logs)
            INCLUDE_JS_LOGS=true
            shift
            ;;
        --no-build|--no-bundle|--release|--clear)
            LAUNCH_ARGS+=("$1")
            shift
            ;;
        --private)
            STORAGE_MODE="private"
            LAUNCH_ARGS+=("$1")
            shift
            ;;
        --null)
            STORAGE_MODE="null"
            LAUNCH_ARGS+=("$1")
            shift
            ;;
        --size)
            SIZE_CHOICE="$2"
            LAUNCH_ARGS+=("$1" "$2")
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        magnet:*)
            TARGET_MAGNET="$1"
            LAUNCH_ARGS+=("$1")
            shift
            ;;
        -*)
            echo "Error: Unknown option: $1" >&2
            usage
            exit 1
            ;;
        *)
            if [[ -z "$DEVICE_NAME" ]]; then
                DEVICE_NAME="$1"
                shift
            else
                echo "Error: Multiple device names specified" >&2
                usage
                exit 1
            fi
            ;;
    esac
done

if [[ -z "$DEVICE_NAME" ]]; then
    echo "Error: Device name required" >&2
    usage
    exit 1
fi

if ! load_device_config "$DEVICE_NAME"; then
    echo
    echo "Available devices:"
    list_all_devices 2>/dev/null || true
    exit 1
fi

if ! check_device_connected "$DEVICE_NAME"; then
    echo "Error: Device '$DEVICE_NAME' is not connected" >&2
    exit 1
fi

if [[ -z "$OUT_DIR" ]]; then
    RUN_ID="$(date '+%Y%m%d-%H%M%S')-$DEVICE_NAME"
    OUT_DIR="$PROJECT_DIR/tmp/memory-runs/$RUN_ID"
fi

resolve_target

mkdir -p "$OUT_DIR"
RUN_LOG="$OUT_DIR/run.log"
LOGCAT_LOG="$OUT_DIR/logcat.log"
MEMINFO_LOG="$OUT_DIR/meminfo.log"
PROCESS_LOG="$OUT_DIR/process.log"
COMMANDS_LOG="$OUT_DIR/commands.log"

{
    echo "device=$DEVICE_NAME"
    echo "package=$PACKAGE"
    echo "activity=$ACTIVITY"
    echo "duration_sec=$RUN_DURATION_SEC"
    echo "sample_interval_sec=$SAMPLE_INTERVAL_SEC"
    echo "detail_interval_sec=$DETAIL_INTERVAL_SEC"
    echo "background_after_sec=$BACKGROUND_AFTER_SEC"
    echo "wait_after_launch_sec=$WAIT_AFTER_LAUNCH_SEC"
    echo "background_app=$BACKGROUND_APP"
    echo "storage_mode=$STORAGE_MODE"
    echo "target_info_hash=$TARGET_INFO_HASH"
    echo "target_magnet=$TARGET_MAGNET"
    echo "launch_args=${LAUNCH_ARGS[*]}"
} > "$COMMANDS_LOG"

log "Output directory: $OUT_DIR"
append_note "Starting memory run on $DEVICE_NAME"
append_note "Launch args: ${LAUNCH_ARGS[*]}"
append_note "Target info hash: ${TARGET_INFO_HASH:-unknown}"

start_logcat_capture

log "Installing app via dev-test-native.sh (--no-launch)"
"$SCRIPT_DIR/dev-test-native.sh" "$DEVICE_NAME" --no-launch "${LAUNCH_ARGS[@]}" "$TARGET_MAGNET"

if [[ -n "$TARGET_INFO_HASH" ]]; then
    log "Removing existing torrent/data for $TARGET_INFO_HASH before launch"
    append_note "Preflight remove for $TARGET_INFO_HASH"
    run_debug_cmd remove --es hash "$TARGET_INFO_HASH" --ez delete_files true || true
    sleep 5
else
    append_note "Could not parse 40-char hex infohash from target magnet, skipping preflight remove"
fi

log "Launching target torrent"
launch_target_torrent

append_note "Launch complete, waiting ${WAIT_AFTER_LAUNCH_SEC}s before first snapshot"
sleep "$WAIT_AFTER_LAUNCH_SEC"

log "Capturing initial state"
run_debug_cmd power || true
run_debug_cmd status || true
run_debug_cmd torrents || true
run_debug_cmd peers || true
run_debug_cmd memory || true
capture_meminfo
capture_proc_state || true

START_TS=$(date +%s)
LAST_DETAIL_TS=$START_TS
BACKGROUND_DONE=false

while true; do
    NOW_TS=$(date +%s)
    ELAPSED=$((NOW_TS - START_TS))

    if (( ELAPSED >= RUN_DURATION_SEC )); then
        append_note "Reached run duration (${RUN_DURATION_SEC}s)"
        break
    fi

    if $BACKGROUND_APP && ! $BACKGROUND_DONE && (( ELAPSED >= BACKGROUND_AFTER_SEC )); then
        log "Backgrounding app (HOME)"
        append_note "Sending app to HOME at ${ELAPSED}s"
        run_device shell input keyevent KEYCODE_HOME || true
        run_debug_cmd power || true
        BACKGROUND_DONE=true
    fi

    if ! capture_proc_state; then
        append_note "App process not found at ${ELAPSED}s"
        log "App process died or was killed"
        break
    fi

    append_note "Sampling at ${ELAPSED}s"
    run_debug_cmd memory || true
    capture_meminfo

    if (( NOW_TS - LAST_DETAIL_TS >= DETAIL_INTERVAL_SEC )); then
        run_debug_cmd status || true
        run_debug_cmd torrents || true
        run_debug_cmd peers || true
        LAST_DETAIL_TS=$NOW_TS
    fi

    sleep "$SAMPLE_INTERVAL_SEC"
done

log "Collecting final state"
run_debug_cmd status || true
run_debug_cmd torrents || true
run_debug_cmd peers || true
run_debug_cmd memory || true
capture_meminfo
capture_proc_state || true

append_note "Memory run complete"
log "Done"
log "Artifacts:"
log "  $RUN_LOG"
log "  $LOGCAT_LOG"
log "  $MEMINFO_LOG"
log "  $PROCESS_LOG"
log "  $COMMANDS_LOG"
