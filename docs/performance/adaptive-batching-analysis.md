# Adaptive Batching Analysis

Date: 2026-01-30

## Summary

Phase 3 of the adaptive HTTP batching implementation is complete. The feature works correctly but provides only marginal improvement (~3%) due to Android companion memory limitations that prevent concurrent batch processing.

## Benchmark Results

| Mode | Time | Speed | Improvement |
|------|------|-------|-------------|
| Baseline (no batching) | 34s | 30.1 MB/s | - |
| Adaptive batching (1 concurrent) | 33s | 31.0 MB/s | +3% |
| Adaptive batching (3 concurrent) | CRASH | - | N/A |

## Batching Statistics (1 concurrent)

- **Total pieces**: 1024 (1GB / 1MB pieces)
- **Batch HTTP requests**: 42
- **Pieces in batches**: ~700 (68%)
- **Pieces written individually**: ~324 (32%)
- **Typical batch size**: 1 + 16 = 17 pieces per batch
- **HTTP request reduction**: ~2.8x fewer requests (366 vs 1024)

## Why Only 3% Improvement?

### Root Cause: Android Memory Pressure

When attempting 3 concurrent batch requests, the Android companion triggers blocking GC:

```
Waiting for a blocking GC Alloc
WaitForGcToComplete blocked Alloc on Alloc for 50-70ms
Alloc concurrent copying GC freed 512(78MB) LOS objects
```

Each batch request holds ~16MB in memory. With 3 concurrent batches + write buffers, heap usage spikes to 100MB+, triggering stop-the-world GC pauses that cause:
1. WebSocket connection timeouts
2. HTTP request failures (`fetch failed`)
3. Cascading write errors

### Secondary Factor: HTTP Latency Not the Bottleneck

At 30MB/s, the primary bottleneck is disk I/O on the Android side, not HTTP round-trip latency. Reducing HTTP requests from 1024 to 366 (2.8x) only yields 3% improvement because:
- Each HTTP request is ~1MB average, network transfer is fast
- The disk writes themselves take the same time regardless of batching
- WebSocket ACK latency is minimal

## Current Implementation

### Configuration
```typescript
const LOW_BACKLOG_THRESHOLD = 5 * 1024 * 1024  // 5MB queue depth triggers batching
const MAX_BATCH_BYTES = 16 * 1024 * 1024       // 16MB max per batch
const MAX_BATCH_COUNT = 64                      // 64 pieces max per batch
const MAX_CONCURRENT_BATCHES = 1               // Only 1 batch in-flight
```

### Enable via environment variable
```bash
USE_ADAPTIVE_BATCHING=1 ./scripts/benchmark-daemon-download.sh
```

### Code Flow
1. Worker checks `diskQueue.pendingBytes` against threshold
2. If backlog exists and `batchesInFlight < MAX_CONCURRENT_BATCHES`:
   - Call `diskQueue.grabPending()` to atomically dequeue extra jobs
   - Pack all writes into single HTTP POST to `/write-batch/{rootKey}`
   - Android returns 202 Accepted immediately
   - Wait for WebSocket ACKs for each write
3. Otherwise, fall back to single write

## Follow-up: Android Companion Improvements

To enable concurrent batching without memory pressure:

### Option 1: Streaming Write Processing
Instead of holding entire batch in memory:
```kotlin
// Current (bad): Read entire batch into memory
val packed = ByteArray(content.readableBytes())
content.readBytes(packed)
val writes = unpackVerifiedWriteBatch(packed)

// Better: Stream-parse and process writes one at a time
val buffer = content.nioBuffer()
val count = buffer.getInt()
for (i in 0 until count) {
    val write = parseNextWrite(buffer)  // Parse one write
    processWrite(write)                  // Write immediately, release memory
}
```

### Option 2: Memory-Mapped File Writes
Use `FileChannel.map()` for zero-copy writes instead of allocating byte arrays.

### Option 3: Smaller Batches When Concurrent
Reduce `MAX_BATCH_BYTES` dynamically when multiple batches are in-flight:
```typescript
const effectiveMaxBytes = MAX_BATCH_BYTES / (this.batchesInFlight + 1)
```

### Option 4: Backpressure from Android
Have Android report memory pressure via WebSocket, JS throttles accordingly.

## Files Modified

| File | Changes |
|------|---------|
| `packages/engine/src/core/disk-queue.ts` | Added `pendingBytes`, `pendingCount`, `grabPending()` |
| `packages/engine/src/adapters/daemon/daemon-file-handle.ts` | Added `writeBatch()` method |
| `packages/engine/src/core/torrent-content-storage.ts` | Batching logic in execute callback |
| `scripts/benchmark-daemon-download.sh` | Added `USE_ADAPTIVE_BATCHING` support |

## Conclusion

The adaptive batching infrastructure is working correctly. The 3% improvement with 1 concurrent batch is real but limited by Android memory constraints. Enabling concurrent batches requires Android-side memory optimizations as outlined above.

For now, `MAX_CONCURRENT_BATCHES = 1` is the stable configuration. The feature can be enabled by default once Android memory handling is improved.
