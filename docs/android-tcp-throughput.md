# Android TCP Throughput Investigation

## Problem Statement

Android native app achieves ~45 MB/s download speed vs ~90 MB/s on desktop (Chrome extension + Rust io-daemon) from the same seeder on LAN.

## Investigation Summary (2025-01-29)

### What We Ruled Out

| Suspect | Finding | Why Ruled Out |
|---------|---------|---------------|
| FFI overhead | 7 µs per crossing | See `docs/ffi-crossing-cost.md` - essentially free |
| Pipeline depth | 1500 blocks (24MB) | Plenty of headroom, not request-limited |
| TCP kernel buffers | 2-8 MB available | `/proc/sys/net/ipv4/tcp_rmem` shows adequate max |
| JS tick loop | Queue depth = 0 | JS draining queue as fast as data arrives |
| Tick batching | N/A | Data not backing up in queue |

### Root Cause: Socket Buffer Configuration

The Kotlin TCP read loop was configured with small buffers:

```kotlin
// TcpSocketService.kt - BEFORE
private const val RECEIVE_BUFFER_SIZE = 256 * 1024  // 256KB (kernel doubles to 512KB)

// TcpConnection.kt - BEFORE
private const val READ_BUFFER_SIZE = 128 * 1024     // 128KB per read
```

**Effect**: Small SO_RCVBUF caused TCP flow control to throttle the sender. The kernel buffer filled up between read() calls, closing the TCP window.

### The Fix

```kotlin
// TcpSocketService.kt - AFTER
private const val RECEIVE_BUFFER_SIZE = 2 * 1024 * 1024  // 2MB (kernel gives 4MB)

// TcpConnection.kt - AFTER
private const val READ_BUFFER_SIZE = 512 * 1024          // 512KB per read
```

### Results

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| SO_RCVBUF | 512 KB | 4 MB | 8x |
| READ_BUFFER | 128 KB | 512 KB | 4x |
| TCP recv rate | 48 MB/s | **68 MB/s** | **+42%** |
| Reads/sec | 770 | 1205 | +56% |
| Avg read size | 69 KB | 58 KB | -16% |

## Remaining Gap

Still ~22 MB/s short of desktop's 90 MB/s. Potential causes:

### 1. `buffer.copyOf()` Allocation Pressure

Every read allocates a new ByteArray:
```kotlin
onData(buffer.copyOf(bytesRead))  // 1200 reads/s × 58KB = 70MB/s allocations
```

**Potential fix**: Buffer pool to reuse allocations.

### 2. Java InputStream 128KB Cap

Even with 512KB READ_BUFFER, max actual read is 128KB:
```
max=131072 bytes/read
```

This appears to be a Java/Android InputStream limitation.

**Potential fix**: Use NIO SocketChannel instead of InputStream.

### 3. Blocking I/O vs Async

Desktop uses Rust async I/O:
```rust
read_half.read(&mut buf).await  // Zero-copy, no thread blocking
```

Android uses blocking InputStream on coroutine:
```kotlin
input.read(buffer)  // Blocks thread, coroutine overhead
```

**Potential fix**: Migrate to NIO with Selector, or use Ktor/OkHttp NIO layers.

## Key Diagnostic Commands

```bash
# TCP socket buffer limits
adb shell cat /proc/sys/net/ipv4/tcp_rmem

# Watch TCP read stats (requires instrumentation in TcpConnection.kt)
adb logcat -s TcpConnection:I TcpBindings:I

# Key metrics to watch:
# - "TCP recv: X MB/s (raw)" - actual socket throughput
# - "pending: N events" - queue backup (should be 0-1)
# - "reads/s, MB/s, avg/min/max bytes/read" - read loop efficiency
```

## Architecture Overview

```
Seeder → TCP → Kernel buffer (SO_RCVBUF) → read() → ByteArray copy → Queue → JS tick → Process
                     ↑                         ↑           ↑
              TCP flow control          128KB cap    Allocation pressure
              throttles sender          per read     (GC)
```

## Files Changed

- `android/io-core/src/main/java/com/jstorrent/io/socket/TcpSocketService.kt` - RECEIVE_BUFFER_SIZE
- `android/io-core/src/main/java/com/jstorrent/io/socket/TcpConnection.kt` - READ_BUFFER_SIZE, logging

## NIO Migration (2025-01-29)

Migrated from InputStream to NIO SocketChannel for plain TCP connections.

### Changes

| Component | Before | After |
|-----------|--------|-------|
| Read API | `InputStream.read(byte[])` | `SocketChannel.read(ByteBuffer)` |
| Buffer type | Heap ByteArray | Direct ByteBuffer (off-heap) |
| Max read size | 128KB (Java InputStream limit) | 1MB (no cap) |
| TLS connections | SSLSocket + InputStream | SSLSocket + InputStream (unchanged) |

### Files Changed

- `TcpConnectionNio.kt` - New NIO-based connection handler with direct ByteBuffers
- `TcpConnectionBase.kt` - Common interface for both connection types
- `TcpSocketService.kt` - Uses SocketChannel for connects, dispatches to appropriate connection type
- `TcpConnection.kt` - Implements TcpConnectionBase (kept for TLS and server sockets)

### Expected Benefits

1. **No 128KB read cap** - SocketChannel can read up to buffer size (1MB)
2. **Reduced GC pressure** - Direct ByteBuffer is off-heap, doesn't pressure GC
3. **Larger reads per syscall** - Fewer context switches
4. **Foundation for future optimization** - Buffer pooling now easier to implement

### Still Allocating

The `ByteArray(bytesRead)` allocation still happens in TcpConnectionNio for queuing to JS.
This is the next target for optimization via buffer pooling.

## Next Steps

1. **Buffer pooling** - Pool ByteArrays to eliminate per-read allocations
2. **Measure improvement** - Compare throughput before/after NIO migration
3. **Profile GC** - Check if allocation pressure is reduced
4. **Compare with iperf3** - Establish raw TCP baseline on device
