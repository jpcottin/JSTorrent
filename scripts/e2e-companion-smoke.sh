#!/usr/bin/env bash
#
# E2E smoke test: Extension + Android Companion via emulator.
#
# Validates the full ChromeOS extension path:
#   Extension (Playwright) → ChromeOS bootstrap → Android companion (emulator) → download
#
# Run this before a release to verify the companion pipeline works
# without needing physical ChromeOS hardware.
#
# Usage:
#   ./scripts/e2e-companion-smoke.sh              # 100MB download (default)
#   FULL_DOWNLOAD=1 ./scripts/e2e-companion-smoke.sh  # Full 1GB download
#   ./scripts/e2e-companion-smoke.sh --skip-build  # Skip extension build
#
# Prerequisites (auto-managed by this script):
#   - Android emulator AVD 'jstorrent-dev' created (run setup-emulator.sh once)
#   - Extension built (or use --skip-build if already built)
#   - Python + uv (for seeder)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_BUILD=false
SEEDER_PID=""
COMPANION_PORT="${COMPANION_PORT:-7800}"

# Parse args
for arg in "$@"; do
    case $arg in
        --skip-build) SKIP_BUILD=true ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ─── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
    echo ""
    echo ">>> Cleaning up..."
    # Kill seeder
    if [[ -n "$SEEDER_PID" ]]; then
        kill "$SEEDER_PID" 2>/dev/null || true
        wait "$SEEDER_PID" 2>/dev/null || true
    fi
    # Remove adb reverse for seeder
    adb reverse --remove tcp:6881 2>/dev/null || true
    # Don't stop the emulator or uninstall the app — user may want them running
    echo "Done."
}
trap cleanup EXIT INT TERM

# ─── Environment ──────────────────────────────────────────────────────────────

echo "=== E2E Companion Smoke Test ==="
echo ""

# Source Android env for emu commands
if [[ -f "$HOME/.profile" ]]; then
    source "$HOME/.profile"
fi
if [[ -f "$ROOT_DIR/android/scripts/android-env.sh" ]]; then
    source "$ROOT_DIR/android/scripts/android-env.sh"
fi

# ─── Step 1: Emulator ────────────────────────────────────────────────────────

echo ">>> Step 1: Checking emulator..."
if adb devices 2>/dev/null | grep -q "emulator-"; then
    echo "    Emulator already running."
else
    echo "    Starting emulator..."
    bash "$ROOT_DIR/android/scripts/emu-start.sh"
fi

# Ensure all companion ports are forwarded (base + ws + streaming)
for OFFSET in 0 1 2; do
    adb forward tcp:$((COMPANION_PORT + OFFSET)) tcp:$((COMPANION_PORT + OFFSET)) 2>/dev/null || true
done

# ─── Step 2: Install app ─────────────────────────────────────────────────────

echo ""
echo ">>> Step 2: Checking app installation..."
if adb shell pm list packages 2>/dev/null | grep -q "com.jstorrent.app"; then
    echo "    App already installed."
else
    echo "    Installing app..."
    bash "$ROOT_DIR/android/scripts/emu-install.sh"
fi

# ─── Step 3: Start companion mode ────────────────────────────────────────────

echo ""
echo ">>> Step 3: Starting companion mode..."
adb shell am start -n com.jstorrent.app/.MainActivity -e force_companion true 2>/dev/null

# Wait for companion server to be ready
echo -n "    Waiting for companion server"
READY=0
for i in {1..30}; do
    if curl -s "http://127.0.0.1:${COMPANION_PORT}/health" >/dev/null 2>&1; then
        READY=1
        break
    fi
    echo -n "."
    sleep 1
done
echo ""

if [[ "$READY" != "1" ]]; then
    echo "Error: Companion server not reachable at 127.0.0.1:${COMPANION_PORT} after 30s"
    echo "Check that the app is running in companion mode."
    exit 1
fi
echo "    Companion server ready."

# ─── Step 3b: Ensure storage root exists ─────────────────────────────────────

# The companion needs at least one storage root. On first run, no SAF root has
# been approved via the UI, so we create a file:// root in the app's internal
# storage. This is idempotent — if roots.json already has entries, we skip.
EXISTING_ROOTS=$(adb shell "run-as com.jstorrent.app cat files/roots.json" 2>/dev/null || echo '{"roots":[]}')
ROOT_COUNT=$(echo "$EXISTING_ROOTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['roots']))" 2>/dev/null || echo "0")

if [[ "$ROOT_COUNT" == "0" ]]; then
    echo "    No storage roots configured — creating test root..."
    adb shell "run-as com.jstorrent.app mkdir -p files/test_downloads" 2>/dev/null || true
    adb shell "run-as com.jstorrent.app sh -c 'cat > files/roots.json'" <<'ROOTJSON'
{
    "roots": [
        {
            "key": "test-root-01",
            "uri": "file:///data/data/com.jstorrent.app/files/test_downloads",
            "display_name": "Test Downloads",
            "removable": false,
            "last_stat_ok": true,
            "last_checked": 1710000000000,
            "volume_id": "primary"
        }
    ]
}
ROOTJSON
    # Restart companion to pick up the new root
    adb shell am force-stop com.jstorrent.app
    sleep 1
    adb shell am start -n com.jstorrent.app/.MainActivity -e force_companion true 2>/dev/null
    echo -n "    Waiting for companion restart"
    for i in {1..15}; do
        if curl -s "http://127.0.0.1:${COMPANION_PORT}/health" >/dev/null 2>&1; then
            break
        fi
        echo -n "."
        sleep 1
    done
    echo ""
    echo "    Test root created."
else
    echo "    Storage roots OK ($ROOT_COUNT root(s))."
fi

# ─── Step 4: Start seeder ────────────────────────────────────────────────────

echo ""
echo ">>> Step 4: Starting seeder..."

# Kill any existing seeder
if lsof -i :6881 >/dev/null 2>&1; then
    echo "    Killing existing process on port 6881..."
    lsof -ti :6881 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

cd "$ROOT_DIR"
SEEDER_ARGS=()
if [[ "${FULL_DOWNLOAD:-}" == "1" ]]; then
    SEEDER_ARGS+=(--size 1gb)
fi
pnpm seed-for-test "${SEEDER_ARGS[@]}" &>/tmp/jstorrent-seeder.log &
SEEDER_PID=$!

# Wait for seeder to be ready
echo -n "    Waiting for seeder"
SEEDER_READY=0
for i in {1..30}; do
    if nc -z 127.0.0.1 6881 2>/dev/null; then
        SEEDER_READY=1
        break
    fi
    echo -n "."
    sleep 1
done
echo ""

if [[ "$SEEDER_READY" != "1" ]]; then
    echo "Error: Seeder not ready after 30s. Check /tmp/jstorrent-seeder.log"
    exit 1
fi
echo "    Seeder ready (PID: $SEEDER_PID)."

# Set up adb reverse so emulator can reach the seeder
adb reverse tcp:6881 tcp:6881
echo "    adb reverse tcp:6881 active."

# ─── Step 5: Build extension ─────────────────────────────────────────────────

if [[ "$SKIP_BUILD" == "true" ]]; then
    echo ""
    echo ">>> Step 5: Skipping extension build (--skip-build)"
else
    echo ""
    echo ">>> Step 5: Building extension..."
    cd "$ROOT_DIR"
    pnpm --dir "$ROOT_DIR/extension" build
fi

# ─── Step 6: Run Playwright test ──────────────────────────────────────────────

echo ""
echo ">>> Step 6: Running Playwright test..."
echo ""

cd "$ROOT_DIR"
COMPANION_HOST=127.0.0.1 \
COMPANION_PORT=$COMPANION_PORT \
FULL_DOWNLOAD="${FULL_DOWNLOAD:-}" \
pnpm --dir "$ROOT_DIR/extension" exec playwright test e2e/companion-download.spec.ts --reporter=list

EXIT_CODE=$?

echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
    echo "=== PASS ==="
    # Write timestamp so release-extension.sh knows the smoke test passed recently
    date > /tmp/jstorrent-companion-smoke-passed
else
    echo "=== FAIL (exit code: $EXIT_CODE) ==="
fi

exit $EXIT_CODE
