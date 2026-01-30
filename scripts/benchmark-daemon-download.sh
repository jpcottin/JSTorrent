#!/bin/bash
#
# Benchmark download speed using the Node.js daemon client against Android companion.
#
# This runs a stateless 1GB download test via the daemon RPC interface.
# Used to measure baseline download throughput for performance optimization.
#
# Prerequisites:
#   - Android companion app running on ChromeOS (at 100.115.92.2:7800)
#   - .env file configured on chromebook at ~/code/jstorrent/.env
#   - 1GB test seeder running at 192.168.1.107:6881
#   - Node.js v25+ available via nvm on chromebook
#
# Usage:
#   ./scripts/benchmark-daemon-download.sh [chromebook_host] [seeder_ip:port]
#
# Examples:
#   ./scripts/benchmark-daemon-download.sh                    # defaults: chromebook, 192.168.1.107:6881
#   ./scripts/benchmark-daemon-download.sh myhost             # custom SSH host
#   ./scripts/benchmark-daemon-download.sh chromebook 10.0.0.5:6881  # custom seeder
#
# To start the seeder on another machine:
#   pnpm seed-for-test --size 1gb
#

set -e

CHROMEBOOK_HOST="${1:-chromebook}"
SEEDER="${2:-192.168.1.107:6881}"
MAGNET="magnet:?xt=urn:btih:18a7aacab6d2bc518e336921ccd4b6cc32a9624b&dn=testdata_1gb.bin&x.pe=${SEEDER}"
INFOHASH="18a7aacab6d2bc518e336921ccd4b6cc32a9624b"
RPC_PORT=3000

echo "=== Daemon Download Benchmark ==="
echo "Host: $CHROMEBOOK_HOST"
echo "Seeder: $SEEDER"
echo "Torrent: 1GB test file"
echo ""

# Sync latest engine code
echo "Syncing engine source..."
rsync -az --delete packages/engine/src/ "${CHROMEBOOK_HOST}:~/code/jstorrent/packages/engine/src/" 2>/dev/null || true

# Start daemon client in background
echo "Starting daemon client..."
ssh "$CHROMEBOOK_HOST" "bash -l -c 'export NVM_DIR=~/.nvm && source ~/.nvm/nvm.sh && nvm use 25 && cd ~/code/jstorrent && set -a && source .env && set +a && ./packages/engine/node_modules/.bin/tsx packages/engine/src/cmd/run-daemon-rpc.ts --no-session'" &
DAEMON_PID=$!

# Wait for RPC server to be ready
echo "Waiting for RPC server..."
for i in {1..20}; do
    if ssh "$CHROMEBOOK_HOST" "curl -s http://localhost:${RPC_PORT}/engine/status" 2>/dev/null | grep -q '"running":true'; then
        break
    fi
    sleep 0.5
done

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
