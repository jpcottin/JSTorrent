#!/bin/bash
#
# Benchmark download speed using the Node.js daemon client against Android companion.
#
# This runs a stateless 1GB download test via the daemon RPC interface.
# Used to measure baseline download throughput for performance optimization.
#
# Prerequisites:
#   - Android companion app running on ChromeOS
#   - .env file configured on chromebook at ~/code/jstorrent/.env
#   - 1GB test seeder running (use: pnpm seed-for-test --size 1gb)
#   - Node.js v25+ available via nvm on chromebook
#   - ~/.jstorrent-devices with seeder= and benchmark_host= configured
#
# Usage:
#   ./scripts/benchmark-daemon-download.sh              # Without batching
#   USE_BATCHED_WRITES=1 ./scripts/benchmark-daemon-download.sh  # With batching
#

set -e

CONFIG_FILE="${HOME}/.jstorrent-devices"

# Read config from ~/.jstorrent-devices
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: $CONFIG_FILE not found"
    echo ""
    echo "Create it with:"
    echo "  seeder=<ip>:6881"
    echo "  benchmark_host=chromebook"
    exit 1
fi

# Parse config file (simple key=value format, ignore comments)
SEEDER=$(grep -E '^seeder=' "$CONFIG_FILE" | cut -d= -f2 | tr -d ' ')
CHROMEBOOK_HOST=$(grep -E '^benchmark_host=' "$CONFIG_FILE" | cut -d= -f2 | tr -d ' ')

if [ -z "$SEEDER" ]; then
    echo "Error: seeder= not configured in $CONFIG_FILE"
    exit 1
fi

if [ -z "$CHROMEBOOK_HOST" ]; then
    echo "Error: benchmark_host= not configured in $CONFIG_FILE"
    exit 1
fi

MAGNET="magnet:?xt=urn:btih:18a7aacab6d2bc518e336921ccd4b6cc32a9624b&dn=testdata_1gb.bin&x.pe=${SEEDER}"
INFOHASH="18a7aacab6d2bc518e336921ccd4b6cc32a9624b"
RPC_PORT=3000

# Check if batched writes are enabled
BATCHED_WRITES_FLAG=""
if [ "${USE_BATCHED_WRITES:-0}" = "1" ]; then
    BATCHED_WRITES_FLAG="--batched-writes"
fi

echo "=== Daemon Download Benchmark ==="
echo "Host: $CHROMEBOOK_HOST"
echo "Seeder: $SEEDER"
echo "Torrent: 1GB test file"
echo "Batched writes: ${USE_BATCHED_WRITES:-0}"
echo ""

# Check if port is already in use on remote host
if ssh "$CHROMEBOOK_HOST" "nc -z localhost ${RPC_PORT}" 2>/dev/null; then
    echo "Error: Port ${RPC_PORT} already in use on ${CHROMEBOOK_HOST}"
    echo "Kill existing daemon: ssh $CHROMEBOOK_HOST 'pkill -f run-daemon-rpc'"
    exit 1
fi

# Sync latest engine code
echo "Syncing engine source..."
rsync -az --delete packages/engine/src/ "${CHROMEBOOK_HOST}:~/code/jstorrent/packages/engine/src/" 2>/dev/null || true

# Start daemon client in background
echo "Starting daemon client..."
ssh "$CHROMEBOOK_HOST" "bash -l -c 'export NVM_DIR=~/.nvm && source ~/.nvm/nvm.sh && nvm use 25 && cd ~/code/jstorrent && set -a && source .env && set +a && ./packages/engine/node_modules/.bin/tsx packages/engine/src/cmd/run-daemon-rpc.ts --no-session $BATCHED_WRITES_FLAG'" &
DAEMON_PID=$!

# Wait for RPC server to be ready
echo "Waiting for RPC server..."
SERVER_READY=0
for i in {1..20}; do
    # Check if daemon process died (e.g., port bind error)
    if ! kill -0 $DAEMON_PID 2>/dev/null; then
        echo ""
        echo "Error: Daemon process died. Check for port conflicts or other errors."
        exit 1
    fi
    if ssh "$CHROMEBOOK_HOST" "curl -s http://localhost:${RPC_PORT}/engine/status" 2>/dev/null | grep -q '"running":true'; then
        SERVER_READY=1
        break
    fi
    sleep 0.5
done

if [ "$SERVER_READY" != "1" ]; then
    echo ""
    echo "Error: RPC server did not start within 10 seconds"
    kill $DAEMON_PID 2>/dev/null || true
    exit 1
fi

# Add torrent
echo "Adding torrent..."
RESULT=$(ssh "$CHROMEBOOK_HOST" "curl -s -X POST http://localhost:${RPC_PORT}/torrent/add -H 'Content-Type: application/json' -d '{\"type\":\"magnet\",\"data\":\"${MAGNET}\"}'")
if ! echo "$RESULT" | grep -q '"ok":true'; then
    echo "Failed to add torrent: $RESULT"
    exit 1
fi

# Monitor progress
echo ""
echo "Downloading..."
START=$(date +%s)
while true; do
    STATUS=$(ssh "$CHROMEBOOK_HOST" "curl -s http://localhost:${RPC_PORT}/torrent/${INFOHASH}/status" 2>/dev/null)
    if [ -z "$STATUS" ]; then
        sleep 1
        continue
    fi

    PROG=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('progress',0)*100)" 2>/dev/null || echo "0")
    RATE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('downloadRate',0)/1048576)" 2>/dev/null || echo "0")
    PEERS=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('peers',0))" 2>/dev/null || echo "0")

    printf "\rProgress: %5.1f%% | Speed: %5.1f MB/s | Peers: %s    " "$PROG" "$RATE" "$PEERS"

    if [ "$(echo "$PROG >= 100" | bc)" = "1" ]; then
        END=$(date +%s)
        DURATION=$((END-START))
        AVG=$(echo "scale=1; 1024/$DURATION" | bc)
        echo ""
        echo ""
        echo "=== Results ==="
        echo "Time: ${DURATION}s"
        echo "Average: ${AVG} MB/s"
        break
    fi

    sleep 1
done

# Cleanup
echo ""
echo "Cleaning up..."
ssh "$CHROMEBOOK_HOST" "curl -s -X POST http://localhost:${RPC_PORT}/torrent/${INFOHASH}/remove -H 'Content-Type: application/json' -d '{\"deleteData\":true}'" >/dev/null
ssh "$CHROMEBOOK_HOST" "curl -s -X POST http://localhost:${RPC_PORT}/shutdown" >/dev/null

# Kill background process
kill $DAEMON_PID 2>/dev/null || true

echo "Done."
