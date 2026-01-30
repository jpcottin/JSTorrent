# HTTP Batched Writes for ChromeOS

## Problem Statement

On ChromeOS, the extension communicates with the Android companion app via HTTP. Each piece write (typically 1MB) requires a separate HTTP request with ~7ms overhead. With downloads running at 60 MB/s but writes limited to ~20-30 MB/s, the disk queue fills up and backpressure throttles downloads.

## Design Goal

Batch multiple piece writes into a single HTTP request to reduce per-request overhead. Only batch when the disk queue is backed up (has pending writes) - don't add latency when writes can keep up.

## Current Implementation

### Files

| File | Purpose |
|------|---------|
| `packages/engine/src/adapters/daemon/http-batching-disk-queue.ts` | Batching queue implementation |
| `packages/engine/src/adapters/daemon/daemon-file-handle.ts` | Routes writes to batch queue |
| `packages/engine/src/presets/daemon.ts` | Wires batching for Node.js daemon client |
| `packages/client/src/engine-manager/chrome-extension-engine-manager.ts` | Wires batching for ChromeOS extension |

### Toggle Locations

**ChromeOS Extension** (`chrome-extension-engine-manager.ts:35`):
```typescript
const USE_BATCHED_WRITES = true  // Set to false to disable
```

**Node.js Daemon CLI** (`run-daemon-rpc.ts`):
```bash
# Environment variable
USE_BATCHED_WRITES=1 ./scripts/benchmark-daemon-download.sh

# Or CLI flag
--batched-writes
```

### Config Options

```typescript
interface HttpBatchingDiskQueueConfig {
  batchSizeThreshold?: number  // Bytes, default 16MB - flush when batch reaches this size
}
```

## Batching Logic

Current simplified logic (single in-flight):

1. Write comes in
2. If no batch in-flight → send immediately (no added latency)
3. If batch in-flight → queue to buffer
4. When in-flight completes → flush queued batch (backpressure trigger)
5. If size threshold reached → flush even if already in-flight

## Benchmark

### Running the Benchmark

```bash
# Prerequisites:
# - Android companion app running on ChromeOS
# - 1GB test seeder: pnpm seed-for-test --size 1gb
# - Config in ~/.jstorrent-devices:
#     seeder=<ip>:6881
#     benchmark_host=chromebook

# Without batching
./scripts/benchmark-daemon-download.sh

# With batching
USE_BATCHED_WRITES=1 ./scripts/benchmark-daemon-download.sh
```

### Current Results (2025-01-30)

| Mode | Speed | Time | Notes |
|------|-------|------|-------|
| No batching | 31.0 MB/s | 33s | 5 parallel HTTP workers |
| With batching | 25.6 MB/s | 40s | Single in-flight, 2-3 writes/batch |

**Batching is currently slower.**

## Issue: Small Batch Sizes

With single in-flight batching, batches are tiny:
- Average 2.4 writes/batch (2-3MB)
- Average 190ms HTTP latency per batch
- Effective throughput: ~6.5 MB/s

The problem: single in-flight serializes all writes. We don't accumulate enough writes during the ~190ms HTTP window to reach meaningful batch sizes (16MB target).

Compare to non-batched: 5 workers running in parallel overlap their HTTP latency, achieving better throughput despite per-request overhead.

### Log Output (batched)
```
[HttpBatch] 2 writes, 2.00MB data, packed 2048.2KB, pack 1ms, HTTP 147ms, trigger=backpressure
[HttpBatch] 3 writes, 3.00MB data, packed 3072.3KB, pack 4ms, HTTP 220ms, trigger=backpressure
[HttpBatch] Stats: 14 batches, 33 writes, 33.00MB total (~6.52MB/s), avg 2.4 writes/batch
```

## Potential Fixes

### Option 1: Allow Multiple Batches In-Flight

Re-add `maxBatchesInFlight` (was 6, matching browser connection limit). This allows parallelism while still batching when capacity is full.

**Pros:** Combines parallelism with batching
**Cons:** More complex, was considered "wrongheaded"

### Option 2: Accumulation Timer

Add a small delay (e.g., 50ms) before first send to let writes accumulate.

**Pros:** Larger batches
**Cons:** Adds latency even at low load, which violates "only batch when backed up"

### Option 3: Hybrid Approach

- Use normal 5-worker TorrentDiskQueue
- Batch at the DaemonFileHandle level only when workers are waiting
- Each worker's batch accumulates while that specific worker is in-flight

### Option 4: Abandon Batching

Accept that 5 parallel unbatched HTTP requests is optimal for this scenario. The HTTP overhead (~7ms) may be acceptable when amortized across 5 parallel workers.

## Architecture Notes

### Current Disk Queue Flow

```
TorrentContentStorage.writePiece()
  → diskQueue.enqueue(job, execute callback)
    → DaemonFileHandle.write()
      → if batchingQueue: queueVerifiedWrite()
      → else: direct HTTP/WebSocket write
```

The disk queue (5 workers) controls concurrency. The batching queue intercepts writes at the file handle level.

### Why Batching Needs WebSocket

Batch writes return HTTP 202 Accepted immediately. Results (success/hash mismatch) come back via WebSocket ACK frames. This allows the HTTP connection to be reused while waiting for disk I/O on the companion.

## Related Files

- `docs/performance/batched-http-writes-plan.md` - Original design plan
- `android/companion-server/src/main/java/.../BatchWriteResults.kt` - Android batch write handling
- `packages/engine/test/adapters/daemon/http-batching-disk-queue.test.ts` - Unit tests
