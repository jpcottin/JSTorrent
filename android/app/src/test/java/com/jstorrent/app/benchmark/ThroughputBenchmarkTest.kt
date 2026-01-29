package com.jstorrent.app.benchmark

import org.junit.Ignore
import org.junit.Test

/**
 * TCP receive throughput benchmark for Android app.
 *
 * Measures download path throughput:
 * Mock Seeder (TCP) → Daemon (TCP read) → WebSocket TCP_RECV frames → Test Client
 *
 * This simulates a real BitTorrent download where a remote peer seeds data
 * and the daemon bridges it to the browser.
 *
 * ## Test Types
 *
 * ### 1. Standalone Tests (no external daemon needed)
 * Uses embedded JVM WebSocket server using java-websocket library:
 * - `standalone_100MB` - 100 MB with 16 KB chunks
 * - `standalone_10MB` - Quick 10 MB test
 * - `standalone_LargeChunks` - 100 MB with 64 KB chunks
 * - `standalone_VaryBufferSizes` - Compare different TCP buffer sizes
 *
 * ### 2. Ktor Server Tests (no external daemon needed)
 * Uses embedded Ktor/Netty server to isolate Ktor WebSocket performance:
 * - `ktor_100MB` - 100 MB with 16 KB chunks
 * - `ktor_10MB` - Quick 10 MB test
 * - `ktor_Sustained30s` - Sustained transfer for 30+ seconds
 * - `ktor_vs_JavaWebSocket` - Side-by-side comparison
 *
 * ### 3. External Daemon Tests
 * Requires Android daemon running (app or standalone):
 *   1. Start the daemon (Android app or standalone io-daemon)
 *   2. Set DAEMON_TOKEN environment variable
 *   3. Optionally set DAEMON_PORT (default 7800)
 *   4. Run: ./gradlew test --tests "*.ThroughputBenchmarkTest.external*"
 *
 * ## Interpreting Results
 *
 * Expected throughput baselines (approximate):
 * - java-websocket (TestDaemonServer): 150-200+ MB/s on JVM
 * - Ktor/Netty (KtorBenchmarkServer): 80-120 MB/s on JVM
 * - Android daemon (emulator): 30-50 MB/s
 * - Android daemon (real device): 40-60 MB/s
 * - Ktor on ChromeOS: 12-14 MB/s (the bottleneck we're investigating)
 *
 * The goal is to identify if Ktor WebSocket layer is the bottleneck.
 */
class ThroughputBenchmarkTest {

    companion object {
        // Daemon connection settings (for external daemon tests)
        val DAEMON_HOST = System.getenv("DAEMON_HOST") ?: "localhost"
        val DAEMON_PORT = System.getenv("DAEMON_PORT")?.toIntOrNull() ?: 7800
        const val DAEMON_PATH = "/io"

        // Auth token - read from environment for external tests
        val AUTH_TOKEN = System.getenv("DAEMON_TOKEN") ?: "test-token"

        // Test parameters
        const val TOTAL_BYTES = 100L * 1024 * 1024 // 100 MB
        const val CHUNK_SIZE = 16 * 1024 // 16 KB chunks from mock seeder
        const val DEFAULT_BUFFER_SIZE = 64 * 1024

        // Timeouts
        const val CONNECT_TIMEOUT_MS = 5000L
        const val FRAME_TIMEOUT_MS = 2000L

        // Sustained test duration
        const val SUSTAINED_DURATION_MS = 30_000L
    }

    // ==================== STANDALONE TESTS (java-websocket) ====================

    /**
     * Standalone benchmark: 100 MB with 16 KB chunks.
     * Uses embedded JVM server - no external daemon needed.
     */
    @Test
    fun standalone_100MB() {
        runStandaloneBenchmark(
            label = "java-websocket",
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Standalone benchmark: Quick 10 MB test.
     */
    @Test
    fun standalone_10MB() {
        runStandaloneBenchmark(
            label = "java-websocket",
            totalBytes = 10L * 1024 * 1024,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Standalone benchmark: 100 MB with larger 64 KB chunks.
     */
    @Test
    fun standalone_LargeChunks() {
        runStandaloneBenchmark(
            label = "java-websocket",
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 64 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Compare different TCP read buffer sizes to find optimal.
     */
    @Test
    fun standalone_VaryBufferSizes() {
        val totalBytes = 50L * 1024 * 1024 // 50 MB for faster iteration
        val chunkSize = 16 * 1024
        val bufferSizes = listOf(16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024, 256 * 1024)

        println("=== Buffer Size Comparison (java-websocket) ===")
        println("Transfer: ${totalBytes / 1024 / 1024} MB, Chunk: ${chunkSize / 1024} KB")
        println()

        val results = mutableListOf<Pair<Int, Double>>()

        for (bufSize in bufferSizes) {
            print("Buffer ${bufSize / 1024} KB: ")
            val result = runStandaloneBenchmarkQuiet(totalBytes, chunkSize, bufSize)
            val mbps = (result.totalBytes / 1024.0 / 1024.0) / (result.elapsedNanos / 1_000_000_000.0)
            results.add(bufSize to mbps)
            println("${String.format("%.2f", mbps)} MB/s (${result.frameCount} frames)")
        }

        println()
        println("=== Summary ===")
        val best = results.maxByOrNull { it.second }!!
        println("Best: ${best.first / 1024} KB buffer → ${String.format("%.2f", best.second)} MB/s")
    }

    // ==================== RAW NETTY SERVER TESTS ====================

    /**
     * Raw Netty benchmark: 100 MB with 16 KB chunks.
     * Bypasses Ktor entirely for direct Netty performance measurement.
     */
    @Test
    fun netty_100MB() {
        runNettyBenchmark(
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Raw Netty benchmark: Quick 10 MB test.
     */
    @Test
    fun netty_10MB() {
        runNettyBenchmark(
            totalBytes = 10L * 1024 * 1024,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Raw Netty benchmark: 100 MB with 64 KB chunks.
     */
    @Test
    fun netty_LargeChunks() {
        runNettyBenchmark(
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 64 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Raw Netty sustained throughput test - run for 30+ seconds.
     */
    @Test
    fun netty_Sustained30s() {
        runSustainedBenchmark(
            serverType = ServerType.RAW_NETTY,
            durationMs = SUSTAINED_DURATION_MS,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    // ==================== KTOR SERVER TESTS ====================

    /**
     * Ktor benchmark: 100 MB with 16 KB chunks.
     * Isolates Ktor WebSocket layer performance on JVM.
     */
    @Test
    fun ktor_100MB() {
        runKtorBenchmark(
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Ktor benchmark: Quick 10 MB test.
     */
    @Test
    fun ktor_10MB() {
        runKtorBenchmark(
            totalBytes = 10L * 1024 * 1024,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Ktor benchmark: 100 MB with 64 KB chunks.
     */
    @Test
    fun ktor_LargeChunks() {
        runKtorBenchmark(
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 64 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Ktor sustained throughput test - run for 30+ seconds.
     * Measures performance stability over time.
     */
    @Test
    fun ktor_Sustained30s() {
        runSustainedBenchmark(
            serverType = ServerType.KTOR,
            durationMs = SUSTAINED_DURATION_MS,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * java-websocket sustained throughput test - baseline for comparison.
     */
    @Test
    fun standalone_Sustained30s() {
        runSustainedBenchmark(
            serverType = ServerType.JAVA_WEBSOCKET,
            durationMs = SUSTAINED_DURATION_MS,
            chunkSize = 16 * 1024,
            tcpReadBufferSize = DEFAULT_BUFFER_SIZE
        )
    }

    /**
     * Side-by-side comparison: Ktor vs java-websocket.
     * Runs both servers and reports relative performance.
     */
    @Test
    fun ktor_vs_JavaWebSocket() {
        val totalBytes = 100L * 1024 * 1024
        val chunkSize = 16 * 1024
        val bufferSize = DEFAULT_BUFFER_SIZE

        println("=== Ktor vs java-websocket Comparison ===")
        println("Transfer: ${totalBytes / 1024 / 1024} MB, Chunk: ${chunkSize / 1024} KB")
        println()

        // Run java-websocket first
        print("java-websocket: ")
        val javaWsResult = runStandaloneBenchmarkQuiet(totalBytes, chunkSize, bufferSize)
        val javaWsMbps = (javaWsResult.totalBytes / 1024.0 / 1024.0) / (javaWsResult.elapsedNanos / 1_000_000_000.0)
        println("${String.format("%.2f", javaWsMbps)} MB/s (${javaWsResult.frameCount} frames)")

        // Run Ktor
        print("Ktor/Netty:     ")
        val ktorResult = runKtorBenchmarkQuiet(totalBytes, chunkSize, bufferSize)
        val ktorMbps = (ktorResult.totalBytes / 1024.0 / 1024.0) / (ktorResult.elapsedNanos / 1_000_000_000.0)
        println("${String.format("%.2f", ktorMbps)} MB/s (${ktorResult.frameCount} frames)")

        println()
        println("=== Analysis ===")
        val ratio = javaWsMbps / ktorMbps
        println("java-websocket is ${String.format("%.1f", ratio)}x faster than Ktor")
        println("Ktor overhead: ${String.format("%.1f", (1 - ktorMbps / javaWsMbps) * 100)}%")

        // Document for Phase 1 reporting
        println()
        println("=== Phase 1 Baseline (JVM) ===")
        println("java-websocket: ${String.format("%.2f", javaWsMbps)} MB/s")
        println("Ktor/Netty:     ${String.format("%.2f", ktorMbps)} MB/s")
    }

    /**
     * Full comparison: java-websocket vs Raw Netty vs Ktor.
     * This is the key Phase 3 benchmark to determine if raw Netty improves on Ktor.
     */
    @Test
    fun all_servers_comparison() {
        val totalBytes = 100L * 1024 * 1024
        val chunkSize = 16 * 1024
        val bufferSize = DEFAULT_BUFFER_SIZE

        println("=== Full WebSocket Server Comparison (Phase 3) ===")
        println("Transfer: ${totalBytes / 1024 / 1024} MB, Chunk: ${chunkSize / 1024} KB")
        println()

        // Run java-websocket
        print("java-websocket: ")
        val javaWsResult = runStandaloneBenchmarkQuiet(totalBytes, chunkSize, bufferSize)
        val javaWsMbps = (javaWsResult.totalBytes / 1024.0 / 1024.0) / (javaWsResult.elapsedNanos / 1_000_000_000.0)
        println("${String.format("%.2f", javaWsMbps)} MB/s (${javaWsResult.frameCount} frames)")

        // Run Raw Netty
        print("Raw Netty:      ")
        val nettyResult = runNettyBenchmarkQuiet(totalBytes, chunkSize, bufferSize)
        val nettyMbps = (nettyResult.totalBytes / 1024.0 / 1024.0) / (nettyResult.elapsedNanos / 1_000_000_000.0)
        println("${String.format("%.2f", nettyMbps)} MB/s (${nettyResult.frameCount} frames)")

        // Run Ktor
        print("Ktor/Netty:     ")
        val ktorResult = runKtorBenchmarkQuiet(totalBytes, chunkSize, bufferSize)
        val ktorMbps = (ktorResult.totalBytes / 1024.0 / 1024.0) / (ktorResult.elapsedNanos / 1_000_000_000.0)
        println("${String.format("%.2f", ktorMbps)} MB/s (${ktorResult.frameCount} frames)")

        println()
        println("=== Analysis ===")
        println("java-websocket vs Ktor:       ${String.format("%.1f", javaWsMbps / ktorMbps)}x faster")
        println("Raw Netty vs Ktor:            ${String.format("%.1f", nettyMbps / ktorMbps)}x faster")
        println("java-websocket vs Raw Netty:  ${String.format("%.1f", javaWsMbps / nettyMbps)}x faster")
        println()
        println("Ktor overhead vs Raw Netty:   ${String.format("%.1f", (1 - ktorMbps / nettyMbps) * 100)}%")
        println("Ktor overhead vs java-ws:     ${String.format("%.1f", (1 - ktorMbps / javaWsMbps) * 100)}%")

        println()
        println("=== Phase 3 Summary ===")
        println("java-websocket: ${String.format("%.2f", javaWsMbps)} MB/s (baseline)")
        println("Raw Netty:      ${String.format("%.2f", nettyMbps)} MB/s")
        println("Ktor/Netty:     ${String.format("%.2f", ktorMbps)} MB/s")
    }

    // ==================== EXTERNAL DAEMON TESTS ====================

    /**
     * External daemon throughput benchmark - 100 MB.
     * Requires external daemon running with DAEMON_TOKEN set.
     */
    @Test
    @Ignore("Requires external daemon running - set DAEMON_TOKEN env var")
    fun external_100MB() {
        runExternalBenchmark(
            totalBytes = 100L * 1024 * 1024,
            chunkSize = 16 * 1024
        )
    }

    /**
     * External daemon throughput benchmark - 10 MB quick test.
     */
    @Test
    @Ignore("Requires external daemon running - set DAEMON_TOKEN env var")
    fun external_10MB() {
        runExternalBenchmark(
            totalBytes = 10L * 1024 * 1024,
            chunkSize = 16 * 1024
        )
    }

    /**
     * External daemon sustained test - 30 seconds.
     */
    @Test
    @Ignore("Requires external daemon running - set DAEMON_TOKEN env var")
    fun external_Sustained30s() {
        runExternalSustainedBenchmark(
            durationMs = SUSTAINED_DURATION_MS,
            chunkSize = 16 * 1024
        )
    }

    // ==================== IMPLEMENTATION ====================

    private enum class ServerType { JAVA_WEBSOCKET, KTOR, RAW_NETTY }

    private fun runStandaloneBenchmark(
        label: String,
        totalBytes: Long,
        chunkSize: Int,
        tcpReadBufferSize: Int
    ) {
        println("=== TCP Recv Throughput Benchmark ($label) ===")
        println("Transfer size: ${totalBytes / 1024 / 1024} MB")
        println("Seeder chunk size: ${chunkSize / 1024} KB")
        println("TCP read buffer: ${tcpReadBufferSize / 1024} KB")
        println()

        TestDaemonServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
            daemon.start()
            println("Embedded daemon started on port ${daemon.port}")

            MockSeeder(totalBytes, chunkSize).use { seeder ->
                seeder.startAsync()
                println("Mock seeder started on port ${seeder.port}")

                TestWsClient(daemon.uri).use { ws ->
                    ws.connect(CONNECT_TIMEOUT_MS)
                    println("WebSocket connected")

                    performHandshake(ws)
                    println("Handshake complete, authenticated")

                    val socketId = 1
                    connectToSeeder(ws, socketId, seeder.port)
                    println("TCP connected to mock seeder")
                    println()

                    val result = receiveAllData(ws, socketId)
                    printResults(result, seeder, label)

                    println()
                    println("Server stats: ${daemon.totalBytesRelayed.get() / 1024 / 1024} MB relayed, " +
                        "${daemon.totalFramesSent.get()} frames sent")
                }
            }
        }
    }

    private fun runStandaloneBenchmarkQuiet(totalBytes: Long, chunkSize: Int, tcpReadBufferSize: Int): BenchmarkResult {
        TestDaemonServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
            daemon.start()

            MockSeeder(totalBytes, chunkSize).use { seeder ->
                seeder.startAsync()

                TestWsClient(daemon.uri).use { ws ->
                    ws.connect(CONNECT_TIMEOUT_MS)
                    performHandshake(ws)
                    val socketId = 1
                    connectToSeeder(ws, socketId, seeder.port)
                    return receiveAllDataQuiet(ws, socketId)
                }
            }
        }
    }

    private fun runKtorBenchmark(totalBytes: Long, chunkSize: Int, tcpReadBufferSize: Int) {
        println("=== TCP Recv Throughput Benchmark (Ktor/Netty) ===")
        println("Transfer size: ${totalBytes / 1024 / 1024} MB")
        println("Seeder chunk size: ${chunkSize / 1024} KB")
        println("TCP read buffer: ${tcpReadBufferSize / 1024} KB")
        println()

        KtorBenchmarkServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
            daemon.start()
            println("Ktor daemon started on port ${daemon.uri}")

            // Brief pause to let Ktor fully initialize
            Thread.sleep(500)

            MockSeeder(totalBytes, chunkSize).use { seeder ->
                seeder.startAsync()
                println("Mock seeder started on port ${seeder.port}")

                TestWsClient(daemon.uri).use { ws ->
                    ws.connect(CONNECT_TIMEOUT_MS)
                    println("WebSocket connected")

                    performHandshake(ws)
                    println("Handshake complete, authenticated")

                    val socketId = 1
                    connectToSeeder(ws, socketId, seeder.port)
                    println("TCP connected to mock seeder")
                    println()

                    val result = receiveAllData(ws, socketId)
                    printResults(result, seeder, "Ktor/Netty")

                    println()
                    println("Server stats: ${daemon.totalBytesRelayed.get() / 1024 / 1024} MB relayed, " +
                        "${daemon.totalFramesSent.get()} frames sent")
                }
            }
        }
    }

    private fun runKtorBenchmarkQuiet(totalBytes: Long, chunkSize: Int, tcpReadBufferSize: Int): BenchmarkResult {
        KtorBenchmarkServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
            daemon.start()
            Thread.sleep(500) // Let Ktor initialize

            MockSeeder(totalBytes, chunkSize).use { seeder ->
                seeder.startAsync()

                TestWsClient(daemon.uri).use { ws ->
                    ws.connect(CONNECT_TIMEOUT_MS)
                    performHandshake(ws)
                    val socketId = 1
                    connectToSeeder(ws, socketId, seeder.port)
                    return receiveAllDataQuiet(ws, socketId)
                }
            }
        }
    }

    private fun runNettyBenchmark(totalBytes: Long, chunkSize: Int, tcpReadBufferSize: Int) {
        println("=== TCP Recv Throughput Benchmark (Raw Netty) ===")
        println("Transfer size: ${totalBytes / 1024 / 1024} MB")
        println("Seeder chunk size: ${chunkSize / 1024} KB")
        println("TCP read buffer: ${tcpReadBufferSize / 1024} KB")
        println()

        NettyBenchmarkServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
            daemon.start()
            println("Raw Netty daemon started on ${daemon.uri}")

            // Brief pause to let Netty fully initialize
            Thread.sleep(200)

            MockSeeder(totalBytes, chunkSize).use { seeder ->
                seeder.startAsync()
                println("Mock seeder started on port ${seeder.port}")

                TestWsClient(daemon.uri).use { ws ->
                    ws.connect(CONNECT_TIMEOUT_MS)
                    println("WebSocket connected")

                    performHandshake(ws)
                    println("Handshake complete, authenticated")

                    val socketId = 1
                    connectToSeeder(ws, socketId, seeder.port)
                    println("TCP connected to mock seeder")
                    println()

                    val result = receiveAllData(ws, socketId)
                    printResults(result, seeder, "Raw Netty")

                    println()
                    println("Server stats: ${daemon.totalBytesRelayed.get() / 1024 / 1024} MB relayed, " +
                        "${daemon.totalFramesSent.get()} frames sent")
                }
            }
        }
    }

    private fun runNettyBenchmarkQuiet(totalBytes: Long, chunkSize: Int, tcpReadBufferSize: Int): BenchmarkResult {
        NettyBenchmarkServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
            daemon.start()
            Thread.sleep(200) // Let Netty initialize

            MockSeeder(totalBytes, chunkSize).use { seeder ->
                seeder.startAsync()

                TestWsClient(daemon.uri).use { ws ->
                    ws.connect(CONNECT_TIMEOUT_MS)
                    performHandshake(ws)
                    val socketId = 1
                    connectToSeeder(ws, socketId, seeder.port)
                    return receiveAllDataQuiet(ws, socketId)
                }
            }
        }
    }

    private fun runSustainedBenchmark(
        serverType: ServerType,
        durationMs: Long,
        chunkSize: Int,
        tcpReadBufferSize: Int
    ) {
        val label = when (serverType) {
            ServerType.JAVA_WEBSOCKET -> "java-websocket"
            ServerType.KTOR -> "Ktor/Netty"
            ServerType.RAW_NETTY -> "Raw Netty"
        }

        println("=== Sustained Throughput Benchmark ($label) ===")
        println("Duration: ${durationMs / 1000} seconds")
        println("Seeder chunk size: ${chunkSize / 1024} KB")
        println("TCP read buffer: ${tcpReadBufferSize / 1024} KB")
        println()

        // Use a large amount of data that will exceed our test duration
        val totalBytes = 10L * 1024 * 1024 * 1024 // 10 GB - more than we'll use

        when (serverType) {
            ServerType.JAVA_WEBSOCKET -> {
                TestDaemonServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
                    daemon.start()
                    runSustainedWithServer(daemon.uri, daemon.totalBytesRelayed, daemon.totalFramesSent,
                        totalBytes, chunkSize, durationMs, label)
                }
            }
            ServerType.KTOR -> {
                KtorBenchmarkServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
                    daemon.start()
                    Thread.sleep(500)
                    runSustainedWithServer(daemon.uri, daemon.totalBytesRelayed, daemon.totalFramesSent,
                        totalBytes, chunkSize, durationMs, label)
                }
            }
            ServerType.RAW_NETTY -> {
                NettyBenchmarkServer(port = 0, authToken = AUTH_TOKEN, tcpReadBufferSize = tcpReadBufferSize).use { daemon ->
                    daemon.start()
                    Thread.sleep(200)
                    runSustainedWithServer(daemon.uri, daemon.totalBytesRelayed, daemon.totalFramesSent,
                        totalBytes, chunkSize, durationMs, label)
                }
            }
        }
    }

    private fun runSustainedWithServer(
        uri: String,
        totalBytesRelayed: java.util.concurrent.atomic.AtomicLong,
        totalFramesSent: java.util.concurrent.atomic.AtomicLong,
        totalBytes: Long,
        chunkSize: Int,
        durationMs: Long,
        label: String
    ) {
        MockSeeder(totalBytes, chunkSize).use { seeder ->
            seeder.startAsync()
            println("Mock seeder started on port ${seeder.port}")

            TestWsClient(uri).use { ws ->
                ws.connect(CONNECT_TIMEOUT_MS)
                println("WebSocket connected")

                performHandshake(ws)
                println("Handshake complete")

                val socketId = 1
                connectToSeeder(ws, socketId, seeder.port)
                println("TCP connected, starting sustained transfer...")
                println()

                val result = receiveDataForDuration(ws, socketId, durationMs)
                printSustainedResults(result, label)
            }
        }
    }

    private fun runExternalBenchmark(totalBytes: Long, chunkSize: Int) {
        val wsUri = "ws://$DAEMON_HOST:$DAEMON_PORT$DAEMON_PATH"

        println("=== External Daemon Throughput Benchmark ===")
        println("Daemon: $wsUri")
        println("Transfer size: ${totalBytes / 1024 / 1024} MB")
        println("Chunk size: ${chunkSize / 1024} KB")
        println()

        MockSeeder(totalBytes, chunkSize).use { seeder ->
            seeder.startAsync()
            println("Mock seeder started on port ${seeder.port}")

            TestWsClient(wsUri).use { ws ->
                ws.connect(CONNECT_TIMEOUT_MS)
                println("WebSocket connected")

                performHandshake(ws)
                println("Handshake complete, authenticated")

                val socketId = 1
                connectToSeeder(ws, socketId, seeder.port)
                println("TCP connected to mock seeder")
                println()

                val result = receiveAllData(ws, socketId)
                printResults(result, seeder, "External Daemon")
            }
        }
    }

    private fun runExternalSustainedBenchmark(durationMs: Long, chunkSize: Int) {
        val wsUri = "ws://$DAEMON_HOST:$DAEMON_PORT$DAEMON_PATH"
        val totalBytes = 10L * 1024 * 1024 * 1024 // 10 GB

        println("=== External Daemon Sustained Benchmark ===")
        println("Daemon: $wsUri")
        println("Duration: ${durationMs / 1000} seconds")
        println()

        MockSeeder(totalBytes, chunkSize).use { seeder ->
            seeder.startAsync()
            println("Mock seeder started on port ${seeder.port}")

            TestWsClient(wsUri).use { ws ->
                ws.connect(CONNECT_TIMEOUT_MS)
                println("WebSocket connected")

                performHandshake(ws)
                println("Handshake complete")

                val socketId = 1
                connectToSeeder(ws, socketId, seeder.port)
                println("TCP connected, starting sustained transfer...")
                println()

                val result = receiveDataForDuration(ws, socketId, durationMs)
                printSustainedResults(result, "External Daemon")
            }
        }
    }

    private fun performHandshake(ws: TestWsClient) {
        // CLIENT_HELLO
        ws.sendFrame(Protocol.CLIENT_HELLO, 1)
        val hello = ws.receiveFrame(CONNECT_TIMEOUT_MS)
            ?: throw AssertionError("No SERVER_HELLO received")
        check(hello.opcode == Protocol.SERVER_HELLO) {
            "Expected SERVER_HELLO (0x02), got 0x${hello.opcode.toString(16)}"
        }

        // AUTH
        ws.sendFrame(Protocol.AUTH, 2, Protocol.authPayload(AUTH_TOKEN))
        val authResult = ws.receiveFrame(CONNECT_TIMEOUT_MS)
            ?: throw AssertionError("No AUTH_RESULT received")
        check(authResult.opcode == Protocol.AUTH_RESULT) {
            "Expected AUTH_RESULT (0x04), got 0x${authResult.opcode.toString(16)}"
        }
        check(authResult.payload.isNotEmpty() && authResult.payload[0] == 0.toByte()) {
            "Auth failed: status=${authResult.payload.getOrNull(0)}"
        }
    }

    private fun connectToSeeder(ws: TestWsClient, socketId: Int, port: Int) {
        ws.sendFrame(
            Protocol.TCP_CONNECT,
            3,
            Protocol.tcpConnectPayload(socketId, "127.0.0.1", port)
        )

        val connected = ws.receiveFrame(CONNECT_TIMEOUT_MS)
            ?: throw AssertionError("No TCP_CONNECTED received")
        check(connected.opcode == Protocol.TCP_CONNECTED) {
            "Expected TCP_CONNECTED (0x11), got 0x${connected.opcode.toString(16)}"
        }
        check(connected.payload.size >= 5 && connected.payload[4] == 0.toByte()) {
            "TCP connect failed: status=${connected.payload.getOrNull(4)}"
        }
    }

    private fun receiveAllData(ws: TestWsClient, expectedSocketId: Int): BenchmarkResult {
        var totalReceived = 0L
        var frameCount = 0
        val frameSizes = mutableListOf<Int>()
        var minFrameSize = Int.MAX_VALUE
        var maxFrameSize = 0
        val frameIntervals = mutableListOf<Long>()
        var lastFrameTime = System.nanoTime()

        val startTime = System.nanoTime()
        var lastProgressTime = startTime

        while (true) {
            val frame = ws.receiveFrame(FRAME_TIMEOUT_MS) ?: break

            when (frame.opcode) {
                Protocol.TCP_RECV -> {
                    val now = System.nanoTime()
                    val dataSize = frame.payload.size - 4
                    if (dataSize > 0) {
                        totalReceived += dataSize
                        frameCount++
                        frameSizes.add(dataSize)
                        if (dataSize < minFrameSize) minFrameSize = dataSize
                        if (dataSize > maxFrameSize) maxFrameSize = dataSize

                        // Track frame interval
                        if (frameCount > 1) {
                            frameIntervals.add(now - lastFrameTime)
                        }
                        lastFrameTime = now
                    }

                    // Progress reporting every second
                    if (totalReceived > 0 && (now - lastProgressTime) > 1_000_000_000L) {
                        val elapsed = (now - startTime) / 1_000_000_000.0
                        val mbps = (totalReceived / 1024.0 / 1024.0) / elapsed
                        val fps = frameCount / elapsed
                        println("  Progress: ${totalReceived / 1024 / 1024} MB, ${String.format("%.2f", mbps)} MB/s, ${String.format("%.0f", fps)} frames/s")
                        lastProgressTime = now
                    }
                }
                Protocol.TCP_CLOSE -> {
                    println("  TCP connection closed by daemon")
                    break
                }
                Protocol.ERROR -> {
                    val errorMsg = if (frame.payload.isNotEmpty()) {
                        String(frame.payload, Charsets.UTF_8)
                    } else "unknown"
                    println("  ERROR received: $errorMsg")
                    break
                }
                else -> {
                    println("  Unexpected opcode: 0x${frame.opcode.toString(16)}")
                }
            }
        }

        val elapsedNanos = System.nanoTime() - startTime

        // Calculate latency stats
        val avgIntervalUs = if (frameIntervals.isNotEmpty()) {
            frameIntervals.average() / 1000.0
        } else 0.0
        val p99IntervalUs = if (frameIntervals.size >= 100) {
            frameIntervals.sorted()[frameIntervals.size * 99 / 100] / 1000.0
        } else avgIntervalUs

        return BenchmarkResult(
            totalBytes = totalReceived,
            elapsedNanos = elapsedNanos,
            frameCount = frameCount,
            minFrameSize = if (minFrameSize == Int.MAX_VALUE) 0 else minFrameSize,
            maxFrameSize = maxFrameSize,
            frameSizes = frameSizes,
            avgIntervalUs = avgIntervalUs,
            p99IntervalUs = p99IntervalUs
        )
    }

    private fun receiveAllDataQuiet(ws: TestWsClient, expectedSocketId: Int): BenchmarkResult {
        var totalReceived = 0L
        var frameCount = 0
        var minFrameSize = Int.MAX_VALUE
        var maxFrameSize = 0

        val startTime = System.nanoTime()

        while (true) {
            val frame = ws.receiveFrame(FRAME_TIMEOUT_MS) ?: break

            when (frame.opcode) {
                Protocol.TCP_RECV -> {
                    val dataSize = frame.payload.size - 4
                    if (dataSize > 0) {
                        totalReceived += dataSize
                        frameCount++
                        if (dataSize < minFrameSize) minFrameSize = dataSize
                        if (dataSize > maxFrameSize) maxFrameSize = dataSize
                    }
                }
                Protocol.TCP_CLOSE -> break
                Protocol.ERROR -> break
            }
        }

        return BenchmarkResult(
            totalBytes = totalReceived,
            elapsedNanos = System.nanoTime() - startTime,
            frameCount = frameCount,
            minFrameSize = if (minFrameSize == Int.MAX_VALUE) 0 else minFrameSize,
            maxFrameSize = maxFrameSize,
            frameSizes = emptyList(),
            avgIntervalUs = 0.0,
            p99IntervalUs = 0.0
        )
    }

    private fun receiveDataForDuration(ws: TestWsClient, expectedSocketId: Int, durationMs: Long): SustainedResult {
        val intervals = mutableListOf<IntervalStats>()
        val startTime = System.currentTimeMillis()
        val endTime = startTime + durationMs

        var intervalBytes = 0L
        var intervalFrames = 0
        var intervalStartTime = startTime
        val intervalDurationMs = 5000L // Report every 5 seconds

        var totalBytes = 0L
        var totalFrames = 0

        while (System.currentTimeMillis() < endTime) {
            val frame = ws.receiveFrame(FRAME_TIMEOUT_MS) ?: break

            when (frame.opcode) {
                Protocol.TCP_RECV -> {
                    val dataSize = frame.payload.size - 4
                    if (dataSize > 0) {
                        totalBytes += dataSize
                        totalFrames++
                        intervalBytes += dataSize
                        intervalFrames++
                    }

                    // Check for interval boundary
                    val now = System.currentTimeMillis()
                    if (now - intervalStartTime >= intervalDurationMs) {
                        val elapsed = now - intervalStartTime
                        val mbps = intervalBytes / (elapsed / 1000.0) / (1024 * 1024)
                        val fps = intervalFrames / (elapsed / 1000.0)

                        intervals.add(IntervalStats(
                            startMs = intervalStartTime - startTime,
                            durationMs = elapsed,
                            bytes = intervalBytes,
                            frames = intervalFrames,
                            mbps = mbps,
                            fps = fps
                        ))

                        println("  [${(now - startTime) / 1000}s] ${String.format("%.2f", mbps)} MB/s, ${String.format("%.0f", fps)} frames/s")

                        intervalBytes = 0
                        intervalFrames = 0
                        intervalStartTime = now
                    }
                }
                Protocol.TCP_CLOSE -> break
                Protocol.ERROR -> break
            }
        }

        val totalElapsed = System.currentTimeMillis() - startTime

        return SustainedResult(
            totalBytes = totalBytes,
            totalFrames = totalFrames,
            totalDurationMs = totalElapsed,
            intervals = intervals
        )
    }

    private fun printResults(result: BenchmarkResult, seeder: MockSeeder, label: String) {
        val elapsedSec = result.elapsedNanos / 1_000_000_000.0
        val mbps = (result.totalBytes / 1024.0 / 1024.0) / elapsedSec
        val avgFrameSize = if (result.frameCount > 0) result.totalBytes / result.frameCount else 0
        val fps = result.frameCount / elapsedSec

        println()
        println("=== Results ($label) ===")
        println("Seeder sent:      ${seeder.bytesSent / 1024 / 1024} MB")
        println("Client received:  ${result.totalBytes / 1024 / 1024} MB")
        println("Time:             ${String.format("%.2f", elapsedSec)} sec")
        println("Throughput:       ${String.format("%.2f", mbps)} MB/s")
        println("Frame rate:       ${String.format("%.0f", fps)} frames/s")
        println("Frame count:      ${result.frameCount}")
        println("Avg frame size:   $avgFrameSize bytes")
        println("Min frame size:   ${result.minFrameSize} bytes")
        println("Max frame size:   ${result.maxFrameSize} bytes")

        // Latency stats
        if (result.avgIntervalUs > 0) {
            println()
            println("Frame timing:")
            println("  Avg interval:   ${String.format("%.1f", result.avgIntervalUs)} µs")
            println("  P99 interval:   ${String.format("%.1f", result.p99IntervalUs)} µs")
        }

        // Histogram of frame sizes
        if (result.frameSizes.isNotEmpty()) {
            println()
            println("Frame size distribution:")
            val buckets = mapOf(
                "0-1KB" to result.frameSizes.count { it < 1024 },
                "1-4KB" to result.frameSizes.count { it in 1024 until 4096 },
                "4-16KB" to result.frameSizes.count { it in 4096 until 16384 },
                "16-32KB" to result.frameSizes.count { it in 16384 until 32768 },
                "32-64KB" to result.frameSizes.count { it in 32768 until 65536 },
                "64KB+" to result.frameSizes.count { it >= 65536 }
            )
            for ((range, count) in buckets) {
                if (count > 0) {
                    val pct = count * 100.0 / result.frameSizes.size
                    println("  $range: $count (${String.format("%.1f", pct)}%)")
                }
            }
        }

        // Verify data integrity
        if (result.totalBytes < seeder.bytesSent) {
            val lostPct = (seeder.bytesSent - result.totalBytes) * 100.0 / seeder.bytesSent
            println()
            println("WARNING: Data loss detected!")
            println("  Lost: ${(seeder.bytesSent - result.totalBytes) / 1024} KB (${String.format("%.2f", lostPct)}%)")
        }
    }

    private fun printSustainedResults(result: SustainedResult, label: String) {
        val elapsedSec = result.totalDurationMs / 1000.0
        val avgMbps = (result.totalBytes / 1024.0 / 1024.0) / elapsedSec
        val avgFps = result.totalFrames / elapsedSec

        println()
        println("=== Sustained Results ($label) ===")
        println("Duration:         ${String.format("%.1f", elapsedSec)} seconds")
        println("Total received:   ${result.totalBytes / 1024 / 1024} MB")
        println("Total frames:     ${result.totalFrames}")
        println("Avg throughput:   ${String.format("%.2f", avgMbps)} MB/s")
        println("Avg frame rate:   ${String.format("%.0f", avgFps)} frames/s")

        if (result.intervals.isNotEmpty()) {
            val throughputs = result.intervals.map { it.mbps }
            val minThroughput = throughputs.minOrNull() ?: 0.0
            val maxThroughput = throughputs.maxOrNull() ?: 0.0
            val stdDev = if (throughputs.size > 1) {
                val mean = throughputs.average()
                kotlin.math.sqrt(throughputs.map { (it - mean) * (it - mean) }.average())
            } else 0.0

            println()
            println("Throughput stability:")
            println("  Min:            ${String.format("%.2f", minThroughput)} MB/s")
            println("  Max:            ${String.format("%.2f", maxThroughput)} MB/s")
            println("  Std dev:        ${String.format("%.2f", stdDev)} MB/s")
            println("  Variation:      ${String.format("%.1f", stdDev / avgMbps * 100)}%")
        }
    }

    data class BenchmarkResult(
        val totalBytes: Long,
        val elapsedNanos: Long,
        val frameCount: Int,
        val minFrameSize: Int,
        val maxFrameSize: Int,
        val frameSizes: List<Int>,
        val avgIntervalUs: Double,
        val p99IntervalUs: Double
    )

    data class IntervalStats(
        val startMs: Long,
        val durationMs: Long,
        val bytes: Long,
        val frames: Int,
        val mbps: Double,
        val fps: Double
    )

    data class SustainedResult(
        val totalBytes: Long,
        val totalFrames: Int,
        val totalDurationMs: Long,
        val intervals: List<IntervalStats>
    )
}
