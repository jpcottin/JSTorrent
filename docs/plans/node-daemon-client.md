# Node.js Daemon-Backed Engine Client

## Goal

Create a Node.js BitTorrent engine client that runs on Chromebook Crostini and uses an external daemon (Android companion server or Rust io-daemon) for all network/disk I/O. This enables easier testing and performance benchmarking of the companion server without needing to reload the Chrome extension.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chromebook Crostini                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Node.js Engine Client                                    │  │
│  │  ┌────────────────┐    ┌─────────────────────────────┐   │  │
│  │  │ HTTP RPC Server│◄───│ Python test client / curl   │   │  │
│  │  │ (port 3000)    │    └─────────────────────────────┘   │  │
│  │  └───────┬────────┘                                      │  │
│  │          │                                                │  │
│  │  ┌───────▼────────┐                                      │  │
│  │  │   BtEngine     │  (torrent logic, piece management)   │  │
│  │  └───────┬────────┘                                      │  │
│  │          │                                                │  │
│  │  ┌───────▼────────┐                                      │  │
│  │  │DaemonConnection│  WebSocket binary protocol           │  │
│  │  └───────┬────────┘                                      │  │
│  └──────────┼───────────────────────────────────────────────┘  │
│             │                                                   │
│             ▼                                                   │
│  ┌──────────────────────┐    OR    ┌────────────────────────┐  │
│  │ Android Companion    │          │ Rust io-daemon         │  │
│  │ 100.115.92.2:7800    │          │ localhost:7800         │  │
│  │ (ARC container)      │          │ (standalone mode)      │  │
│  └──────────────────────┘          └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Create `run-daemon-rpc.ts` CLI

**File:** `packages/engine/src/cmd/run-daemon-rpc.ts`

```typescript
// CLI arguments:
// --host <ip>       Daemon host (default: 127.0.0.1)
// --port <port>     Daemon port (default: 7800)
// --token <token>   Auth token (required, or use JST_TOKEN env var)
// --rpc-port <port> HTTP RPC server port (default: 3000)
// --download-dir    Override default download directory (optional)

// Flow:
// 1. Parse CLI args
// 2. Create DaemonConnection with host/port/token
// 3. Connect WebSocket
// 4. Fetch storage roots from daemon: GET /roots
// 5. Create engine with createDaemonEngine()
// 6. Start HttpRpcServer
// 7. Print "RPC_PORT=<port>" for test harness
```

### Phase 2: Add `/roots` endpoint support to DaemonConnection

The `DaemonConnection` class already has `request()` method for HTTP. Add a helper:

```typescript
// In daemon-connection.ts or a new daemon-client.ts
async function fetchDaemonRoots(connection: DaemonConnection): Promise<StorageRoot[]> {
  const response = await connection.request<{ roots: DaemonRoot[] }>('GET', '/roots')
  return response.roots.map(r => ({
    key: r.key,
    label: r.display_name,
    path: r.path,
  }))
}
```

### Phase 3: Modify `createDaemonEngine` to accept pre-connected DaemonConnection

Currently `createDaemonEngine` creates its own connection. For flexibility, allow passing an existing connection:

```typescript
export interface DaemonEngineConfig {
  // Option A: Pass connection params (current behavior)
  daemon?: { port: number; authToken: string; host?: string }
  // Option B: Pass pre-connected connection (new)
  connection?: DaemonConnection
  // ... rest of config
}
```

### Phase 4: Token/Pairing Strategy

For testing, support multiple token sources:

1. **CLI arg:** `--token <token>`
2. **Environment variable:** `JST_TOKEN`
3. **Config file:** `~/.config/jstorrent-node-client/config.json`
4. **Auto-pair:** If no token, call `/pair` endpoint (needs extension ID)

For initial implementation, require explicit token (options 1 or 2).

### Phase 5: Session Store for Daemon Mode

The daemon engine needs a session store for torrent metadata. Options:

1. **In-memory:** Lost on restart (fine for testing)
2. **JSON file in Crostini:** `~/.config/jstorrent-node-client/session.json`
3. **On daemon side:** Would need new endpoint (future work)

Start with option 2 (local JSON file).

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/engine/src/cmd/run-daemon-rpc.ts` | Create | New CLI entry point |
| `packages/engine/src/presets/daemon.ts` | Modify | Accept pre-connected DaemonConnection |
| `packages/engine/src/adapters/daemon/daemon-client.ts` | Create | Helper for fetching roots, status, etc. |
| `packages/engine/src/node-rpc/controller.ts` | Modify | Add `startDaemonEngine()` method |

## Usage Examples

### Connect to Android Companion Server

```bash
# Get token from Android app (via adb or manually)
export JST_TOKEN="abc123..."

# Run the client
cd /path/to/jstorrent
pnpm tsx packages/engine/src/cmd/run-daemon-rpc.ts \
  --host 100.115.92.2 \
  --port 7800

# In another terminal, control it
curl -X POST http://localhost:3000/engine/start
curl -X POST http://localhost:3000/torrent/add \
  -H "Content-Type: application/json" \
  -d '{"type":"magnet","data":"magnet:?xt=urn:btih:..."}'
```

### Connect to Rust io-daemon (Standalone)

```bash
# Start io-daemon in standalone mode
./jstorrent-io-daemon --standalone --download-root ~/Downloads --bind 0.0.0.0

# Get token from config
export JST_TOKEN=$(jq -r .token ~/.config/jstorrent-standalone/config.json)

# Run the client
pnpm tsx packages/engine/src/cmd/run-daemon-rpc.ts \
  --host localhost \
  --port 7800
```

### Use with Python Test Client

```python
from jst import JSTEngine

# Point to the daemon-backed RPC server
engine = JSTEngine(
    download_dir="/tmp/unused",  # Ignored, daemon provides roots
    rpc_url="http://localhost:3000"  # Connect to running daemon client
)

# Or if we add external connection support to JSTEngine:
engine = JSTEngine.connect("http://localhost:3000")

torrent_id = engine.add_magnet("magnet:?...")
engine.wait_for_download(torrent_id, timeout=300)
```

## Testing on Chromebook

### Prerequisites

1. **Node.js in Crostini:** Should already be available via `nvm` or system install
2. **pnpm:** Install with `npm install -g pnpm`
3. **Clone repo:** `git clone` or rsync from dev machine
4. **Android companion server running:** App installed and server started

### Quick Test

```bash
# From Crostini terminal
cd ~/code/jstorrent
pnpm install

# Check connectivity to Android
curl http://100.115.92.2:7800/status

# Get/set token (may need to pair first via extension or manually)
# For testing, can use adb to read token from Android shared prefs

# Run daemon client
pnpm tsx packages/engine/src/cmd/run-daemon-rpc.ts \
  --host 100.115.92.2 \
  --port 7800 \
  --token "$JST_TOKEN"

# Test with curl
curl http://localhost:3000/engine/status
```

## Future Enhancements

1. **Auto-discovery:** Scan for daemon on known addresses (ARC, localhost)
2. **Pairing flow:** Interactive pairing like the extension does
3. **Performance logging:** Track I/O latency through daemon
4. **Multiple daemon connections:** Compare Android vs Rust performance
5. **Standalone binary:** Bundle with `pkg` or similar for easy deployment

## Notes

- The ADB path on Chromebook is: `/home/graehlarts/android-sdk/platform-tools/adb`
- ARC container IP is typically `100.115.92.2`
- Rust io-daemon in Crostini binds to `penguin.linux.test` or `localhost`
