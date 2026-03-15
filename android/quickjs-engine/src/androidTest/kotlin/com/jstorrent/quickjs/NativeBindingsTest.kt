package com.jstorrent.quickjs

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.io.file.FileManagerImpl
import com.jstorrent.quickjs.bindings.EngineStateListener
import com.jstorrent.quickjs.bindings.NativeBindings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class NativeBindingsTest {

    private lateinit var engine: QuickJsEngine
    private lateinit var bindings: NativeBindings
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val fileManager = FileManagerImpl(context)
        engine = QuickJsEngine()
        bindings = NativeBindings(context, engine.jsThread, scope, fileManager)
        engine.postAndWait {
            bindings.registerAll(engine.context)
        }
    }

    @After
    fun tearDown() {
        bindings.shutdown()
        engine.close()
    }

    // ========================================
    // Text Encode/Decode Tests
    // ========================================

    @Test
    fun textEncodeDecodeRoundTrips() {
        val result = engine.evaluate("""
            const encoded = __jstorrent_text_encode("Hello, World!");
            __jstorrent_text_decode(encoded);
        """.trimIndent())

        assertEquals("Hello, World!", result)
    }

    @Test
    fun textEncodeReturnsArrayBuffer() {
        val result = engine.evaluate("""
            const encoded = __jstorrent_text_encode("ABC");
            encoded.constructor.name;
        """.trimIndent())

        assertEquals("ArrayBuffer", result)
    }

    @Test
    fun textEncodeLength() {
        val result = engine.evaluate("""
            const encoded = __jstorrent_text_encode("Hello");
            encoded.byteLength;
        """.trimIndent())

        assertEquals(5, result)
    }

    @Test
    fun textEncodeUnicode() {
        val result = engine.evaluate("""
            const encoded = __jstorrent_text_encode("こんにちは");
            __jstorrent_text_decode(encoded);
        """.trimIndent())

        assertEquals("こんにちは", result)
    }

    // ========================================
    // SHA1 Tests
    // ========================================

    @Test
    fun sha1ReturnsArrayBuffer() {
        val result = engine.evaluate("""
            const data = __jstorrent_text_encode("test");
            const hash = __jstorrent_sha1(data);
            hash.constructor.name;
        """.trimIndent())

        assertEquals("ArrayBuffer", result)
    }

    @Test
    fun sha1Returns20Bytes() {
        val result = engine.evaluate("""
            const data = __jstorrent_text_encode("test");
            const hash = __jstorrent_sha1(data);
            hash.byteLength;
        """.trimIndent())

        assertEquals(20, result)
    }

    @Test
    fun sha1ProducesCorrectHash() {
        // SHA1("test") = a94a8fe5ccb19ba61c4c0873d391e987982fbbd3
        val result = engine.evaluate("""
            const data = __jstorrent_text_encode("test");
            const hash = __jstorrent_sha1(data);
            const view = new Uint8Array(hash);
            Array.from(view).map(b => b.toString(16).padStart(2, '0')).join('');
        """.trimIndent())

        assertEquals("a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", result)
    }

    // ========================================
    // Random Bytes Tests
    // ========================================

    @Test
    fun randomBytesReturnsArrayBuffer() {
        val result = engine.evaluate("""
            const bytes = __jstorrent_random_bytes(16);
            bytes.constructor.name;
        """.trimIndent())

        assertEquals("ArrayBuffer", result)
    }

    @Test
    fun randomBytesReturnsCorrectLength() {
        val result = engine.evaluate("""
            const bytes = __jstorrent_random_bytes(32);
            bytes.byteLength;
        """.trimIndent())

        assertEquals(32, result)
    }

    @Test
    fun randomBytesProducesDifferentValues() {
        val result = engine.evaluate("""
            const bytes1 = __jstorrent_random_bytes(16);
            const bytes2 = __jstorrent_random_bytes(16);
            const view1 = new Uint8Array(bytes1);
            const view2 = new Uint8Array(bytes2);

            // Compare - should be different
            let same = true;
            for (let i = 0; i < 16; i++) {
                if (view1[i] !== view2[i]) {
                    same = false;
                    break;
                }
            }
            same;
        """.trimIndent())

        assertEquals(false, result)
    }

    // ========================================
    // Console Log Tests
    // ========================================

    @Test
    fun consoleLogDoesNotThrow() {
        // Just verify it doesn't throw
        engine.evaluate("""
            __jstorrent_console_log("info", "Test message");
            __jstorrent_console_log("warn", "Warning message");
            __jstorrent_console_log("error", "Error message");
            __jstorrent_console_log("debug", "Debug message");
        """.trimIndent())
    }

    // ========================================
    // Timer Tests
    // ========================================

    @Test
    fun setTimeoutFiresCallback() {
        var fired = false
        var attempts = 0

        engine.postAndWait {
            engine.context.evaluate("""
                globalThis.timerFired = false;
                __jstorrent_set_timeout(function() {
                    globalThis.timerFired = true;
                }, 50);
            """.trimIndent())
        }

        // Poll for result with timeout (timer + dispatch may take time)
        while (attempts < 20 && !fired) {
            Thread.sleep(50)
            attempts++

            engine.postAndWait {
                val result = engine.context.evaluate("globalThis.timerFired")
                fired = result == true
            }
        }

        assertTrue(fired, "Timer should have fired (attempts: $attempts)")
    }

    @Test
    fun clearTimeoutCancelsTimer() {
        engine.postAndWait {
            engine.context.evaluate("""
                globalThis.timerFired = false;
                const timerId = __jstorrent_set_timeout(function() {
                    globalThis.timerFired = true;
                }, 100);
                __jstorrent_clear_timeout(timerId);
            """.trimIndent())
        }

        // Wait longer than the timer would have fired
        Thread.sleep(200)

        val result = engine.evaluate("globalThis.timerFired")
        assertEquals(false, result, "Timer should have been cancelled")
    }

    // ========================================
    // Callback Bindings Tests
    // ========================================

    @Test
    fun stateUpdateCallsListener() {
        val latch = CountDownLatch(1)
        var receivedState: String? = null

        bindings.stateListener = object : EngineStateListener {
            override fun onStateUpdate(stateJson: String) {
                receivedState = stateJson
                latch.countDown()
            }
        }

        engine.evaluate("""
            __jstorrent_on_state_update('{"torrents":[],"downloadSpeed":0}');
        """.trimIndent())

        latch.await(1, TimeUnit.SECONDS)
        assertNotNull(receivedState)
        assertTrue(receivedState!!.contains("torrents"))
    }

    // ========================================
    // ArrayBuffer JNI Tests
    // ========================================

    @Test
    fun callGlobalFunctionWithBinaryWorks() {
        // Register a function that echoes binary data
        engine.postAndWait {
            engine.context.setGlobalFunctionReturnsBinary("__test_echo_binary", 0) { _, binary ->
                binary
            }
        }

        val result = engine.evaluate("""
            const input = __jstorrent_text_encode("Hello Binary");
            const output = __test_echo_binary(input);
            __jstorrent_text_decode(output);
        """.trimIndent())

        assertEquals("Hello Binary", result)
    }

    // ========================================
    // UDP Binding Tests (Phase 3c)
    // ========================================

    @Test
    fun udpBindFiresCallback() {
        var boundSuccess = false
        var boundPort = 0
        var attempts = 0

        engine.postAndWait {
            engine.context.evaluate("""
                globalThis.udpBoundResult = null;
                __jstorrent_udp_on_bound(function(socketId, success, port) {
                    globalThis.udpBoundResult = { socketId, success, port };
                });
                __jstorrent_udp_bind(100, "", 0);
            """.trimIndent())
        }

        // Poll for result with timeout (async callback may take time)
        while (attempts < 20 && !boundSuccess) {
            Thread.sleep(100)
            attempts++

            engine.postAndWait {
                val result = engine.context.evaluate("globalThis.udpBoundResult")
                if (result != null) {
                    val success = engine.context.evaluate("globalThis.udpBoundResult.success")
                    val port = engine.context.evaluate("globalThis.udpBoundResult.port")
                    boundSuccess = success == true
                    boundPort = (port as? Number)?.toInt() ?: 0
                }
            }
        }

        assertTrue(boundSuccess, "UDP bind should succeed (attempts: $attempts)")
        assertTrue(boundPort > 0, "UDP should bind to a port > 0, got $boundPort")
    }

    @Test
    fun udpCloseDoesNotThrow() {
        // Bind then close - should not throw
        engine.postAndWait {
            engine.context.evaluate("""
                __jstorrent_udp_on_bound(function() {});
                __jstorrent_udp_bind(2, "", 0);
            """.trimIndent())
        }

        Thread.sleep(100)

        engine.evaluate("__jstorrent_udp_close(2)")
        // If we get here without exception, test passes
    }

    // ========================================
    // File I/O Binding Tests (Stateless API)
    // ========================================

    @Test
    fun fileWriteReadRoundTrip() {
        val testData = "Hello, JSTorrent File System!"

        val result = engine.evaluate("""
            // Write data (stateless - creates file automatically)
            const data = __jstorrent_text_encode("$testData");
            const written = __jstorrent_file_write("default", "test_roundtrip.txt", 0, data);

            if (written < 0) {
                throw new Error("Failed to write file: " + written);
            }

            // Read data back (stateless)
            const readData = __jstorrent_file_read("default", "test_roundtrip.txt", 0, ${testData.length});

            // Decode and return
            __jstorrent_text_decode(readData);
        """.trimIndent())

        assertEquals(testData, result)
    }

    @Test
    fun fileExistsWorks() {
        // Create a file using stateless write
        engine.evaluate("""
            const data = __jstorrent_text_encode("test");
            __jstorrent_file_write("default", "exists_test.txt", 0, data);
        """.trimIndent())

        val exists = engine.evaluate("""
            __jstorrent_file_exists("default", "exists_test.txt");
        """.trimIndent())

        assertEquals("true", exists)
    }

    @Test
    fun fileStatReturnsSize() {
        val testContent = "12345678901234567890" // 20 bytes

        engine.evaluate("""
            const data = __jstorrent_text_encode("$testContent");
            __jstorrent_file_write("default", "stat_test.txt", 0, data);
        """.trimIndent())

        val stat = engine.evaluate("""
            const statJson = __jstorrent_file_stat("default", "stat_test.txt");
            JSON.parse(statJson).size;
        """.trimIndent())

        assertEquals(20, stat)
    }

    @Test
    fun fileMkdirWorks() {
        val result = engine.evaluate("""
            __jstorrent_file_mkdir("default", "test_subdir");
        """.trimIndent())

        assertEquals("true", result)

        val exists = engine.evaluate("""
            __jstorrent_file_exists("default", "test_subdir");
        """.trimIndent())

        assertEquals("true", exists)
    }

    @Test
    fun fileDeleteWorks() {
        // Create then delete using stateless API
        engine.evaluate("""
            const data = __jstorrent_text_encode("delete me");
            __jstorrent_file_write("default", "delete_test.txt", 0, data);
        """.trimIndent())

        val deleted = engine.evaluate("""
            __jstorrent_file_delete("default", "delete_test.txt");
        """.trimIndent())

        assertEquals("true", deleted)

        val existsAfter = engine.evaluate("""
            __jstorrent_file_exists("default", "delete_test.txt");
        """.trimIndent())

        assertEquals("false", existsAfter)
    }

    // ========================================
    // Storage Binding Tests (Phase 3c)
    // ========================================

    @Test
    fun storageSetGetWorks() {
        engine.evaluate("""
            __jstorrent_storage_set("test_key_1", "test_value_1");
        """.trimIndent())

        val result = engine.evaluate("""
            __jstorrent_storage_get("test_key_1");
        """.trimIndent())

        assertEquals("test_value_1", result)
    }

    @Test
    fun storageGetReturnsNullForMissing() {
        val result = engine.evaluate("""
            __jstorrent_storage_get("nonexistent_key_xyz");
        """.trimIndent())

        assertEquals(null, result)
    }

    @Test
    fun storageDeleteWorks() {
        engine.evaluate("""
            __jstorrent_storage_set("delete_me_key", "some_value");
            __jstorrent_storage_delete("delete_me_key");
        """.trimIndent())

        val result = engine.evaluate("""
            __jstorrent_storage_get("delete_me_key");
        """.trimIndent())

        assertEquals(null, result)
    }

    // ========================================
    // File listTree Binding Tests
    // ========================================

    @Test
    fun fileListTreeReturnsFilesWithSizes() {
        engine.evaluate("""
            const d1 = __jstorrent_text_encode("AAAA");
            __jstorrent_file_write("default", "tree_test/file1.txt", 0, d1);
            const d2 = __jstorrent_text_encode("BBBBBB");
            __jstorrent_file_write("default", "tree_test/sub/file2.bin", 0, d2);
        """.trimIndent())

        val result = engine.evaluate("""
            const json = __jstorrent_file_list_tree("default", "tree_test");
            const entries = JSON.parse(json);
            entries.sort((a, b) => a.path.localeCompare(b.path));
            JSON.stringify(entries);
        """.trimIndent())

        val entries = org.json.JSONArray(result as String)
        assertEquals(2, entries.length())
        assertEquals("file1.txt", entries.getJSONObject(0).getString("path"))
        assertEquals(4, entries.getJSONObject(0).getInt("size"))
        assertEquals("sub/file2.bin", entries.getJSONObject(1).getString("path"))
        assertEquals(6, entries.getJSONObject(1).getInt("size"))
    }

    @Test
    fun fileListTreeReturnsEmptyForNonexistent() {
        val result = engine.evaluate("""
            __jstorrent_file_list_tree("default", "nonexistent_tree_dir");
        """.trimIndent())

        assertEquals("[]", result)
    }

    // ========================================
    // Async Write Batch Tests (__jstorrent_file_write_batch)
    // ========================================

    /**
     * Set up the JS-side dispatch function for async write results.
     *
     * In production this is defined by callback-manager.ts (imported via
     * createNativeEngine → native adapters), but that module is only
     * tree-shaken in when jstorrent.init() runs.  Loading the full bundle
     * without init() doesn't trigger the import.
     *
     * The logic below is identical to the production implementation in
     * callback-manager.ts — it unpacks the binary batch and dispatches
     * each result to the corresponding callback in __jstorrent_file_write_callbacks.
     */
    private fun registerWriteDispatchFunction() {
        engine.evaluate("""
            globalThis.__jstorrent_file_dispatch_batch = function(packed) {
                var view = new DataView(packed);
                var bytes = new Uint8Array(packed);
                var offset = 0;
                var count = view.getUint32(offset, true); offset += 4;
                for (var i = 0; i < count; i++) {
                    var idLen = bytes[offset]; offset += 1;
                    var id = '';
                    for (var j = 0; j < idLen; j++) { id += String.fromCharCode(bytes[offset + j]); }
                    offset += idLen;
                    var bytesWritten = view.getInt32(offset, true); offset += 4;
                    var resultCode = bytes[offset]; offset += 1;
                    var cb = globalThis.__jstorrent_file_write_callbacks[id];
                    if (cb) {
                        delete globalThis.__jstorrent_file_write_callbacks[id];
                        cb(bytesWritten, resultCode);
                    }
                }
            };
        """.trimIndent())
    }

    @Test
    fun fileWriteBatchWritesDataAndCallsBack() {
        // This test exercises the full async write path:
        // JS packs binary -> __jstorrent_file_write_batch FFI -> Kotlin I/O thread ->
        // queueDiskWriteResult -> __jstorrent_file_flush -> __jstorrent_file_dispatch_batch -> JS callback

        // Register the JS dispatch function (mirrors callback-manager.ts)
        registerWriteDispatchFunction()

        val result = engine.evaluate("""
            (function() {
                // Set up callback tracking
                globalThis.__test_write_result = null;
                globalThis.__jstorrent_file_write_callbacks = globalThis.__jstorrent_file_write_callbacks || {};

                var callbackId = "wr_test_1";

                // Register callback
                globalThis.__jstorrent_file_write_callbacks[callbackId] = function(bytesWritten, resultCode) {
                    globalThis.__test_write_result = { bytesWritten: Number(bytesWritten), resultCode: Number(resultCode) };
                };

                // Pack a single write request in the batch format:
                // [count: u32 LE] [rootKeyLen: u8] [rootKey] [pathLen: u16 LE] [path]
                // [position: u64 LE] [dataLen: u32 LE] [data] [callbackIdLen: u8] [callbackId]
                var rootKey = "default";
                var path = "async_write_test.txt";
                var data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

                var rootKeyBytes = new Uint8Array(__jstorrent_text_encode(rootKey));
                var pathBytes = new Uint8Array(__jstorrent_text_encode(path));
                var callbackIdBytes = new Uint8Array(__jstorrent_text_encode(callbackId));

                var totalSize = 4 + 1 + rootKeyBytes.length + 2 + pathBytes.length + 8 + 4 + data.length + 1 + callbackIdBytes.length;
                var packed = new ArrayBuffer(totalSize);
                var view = new DataView(packed);
                var bytes = new Uint8Array(packed);
                var offset = 0;

                // count = 1
                view.setUint32(offset, 1, true); offset += 4;
                // rootKeyLen + rootKey
                bytes[offset] = rootKeyBytes.length; offset += 1;
                bytes.set(rootKeyBytes, offset); offset += rootKeyBytes.length;
                // pathLen + path
                view.setUint16(offset, pathBytes.length, true); offset += 2;
                bytes.set(pathBytes, offset); offset += pathBytes.length;
                // position = 0 (u64 LE)
                view.setUint32(offset, 0, true); offset += 4;
                view.setUint32(offset, 0, true); offset += 4;
                // dataLen + data
                view.setUint32(offset, data.length, true); offset += 4;
                bytes.set(data, offset); offset += data.length;
                // callbackIdLen + callbackId
                bytes[offset] = callbackIdBytes.length; offset += 1;
                bytes.set(callbackIdBytes, offset); offset += callbackIdBytes.length;

                // Send the batch
                __jstorrent_file_write_batch(packed);

                return "dispatched";
            })();
        """.trimIndent())

        assertEquals("dispatched", result)

        // Wait for I/O thread to complete and flush results
        var attempts = 0
        var writeResult: Any? = null
        while (attempts < 40 && writeResult == null) {
            Thread.sleep(100)
            attempts++

            engine.postAndWait {
                // Flush results from I/O threads to JS
                engine.context.evaluate("__jstorrent_file_flush()")

                val r = engine.context.evaluate("globalThis.__test_write_result")
                if (r != null) {
                    writeResult = r
                }
            }
        }

        assertNotNull(writeResult, "Write callback should have fired (attempts: $attempts)")

        // Verify the callback reported success
        val resultCode = engine.evaluate("globalThis.__test_write_result.resultCode")
        assertEquals(0, resultCode) // SUCCESS = 0

        val bytesWritten = engine.evaluate("globalThis.__test_write_result.bytesWritten")
        assertEquals(5, bytesWritten) // "Hello" = 5 bytes

        // Verify the file was actually written by reading it back
        val readBack = engine.evaluate("""
            var readData = __jstorrent_file_read("default", "async_write_test.txt", 0, 5);
            __jstorrent_text_decode(readData);
        """.trimIndent())

        assertEquals("Hello", readBack)
    }

    @Test
    fun fileWriteBatchMultipleWrites() {
        // Register the JS dispatch function (mirrors callback-manager.ts)
        registerWriteDispatchFunction()

        // Test batching multiple writes in a single FFI call
        val result = engine.evaluate("""
            (function() {
                globalThis.__test_write_results = {};
                globalThis.__jstorrent_file_write_callbacks = globalThis.__jstorrent_file_write_callbacks || {};

                var writes = [
                    { rootKey: "default", path: "batch_a.txt", data: [65, 65, 65], callbackId: "wr_a" },
                    { rootKey: "default", path: "batch_b.txt", data: [66, 66, 66, 66], callbackId: "wr_b" },
                ];

                for (var i = 0; i < writes.length; i++) {
                    var w = writes[i];
                    globalThis.__jstorrent_file_write_callbacks[w.callbackId] = (function(id) {
                        return function(bytesWritten, resultCode) {
                            globalThis.__test_write_results[id] = { bytesWritten: Number(bytesWritten), resultCode: Number(resultCode) };
                        };
                    })(w.callbackId);
                }

                // Pack both writes
                var totalSize = 4; // count
                var encodedWrites = [];
                for (var i = 0; i < writes.length; i++) {
                    var w = writes[i];
                    var rk = new Uint8Array(__jstorrent_text_encode(w.rootKey));
                    var p = new Uint8Array(__jstorrent_text_encode(w.path));
                    var cb = new Uint8Array(__jstorrent_text_encode(w.callbackId));
                    var d = new Uint8Array(w.data);
                    totalSize += 1 + rk.length + 2 + p.length + 8 + 4 + d.length + 1 + cb.length;
                    encodedWrites.push({ rk: rk, p: p, cb: cb, d: d });
                }

                var packed = new ArrayBuffer(totalSize);
                var view = new DataView(packed);
                var bytes = new Uint8Array(packed);
                var offset = 0;

                view.setUint32(offset, writes.length, true); offset += 4;

                for (var i = 0; i < encodedWrites.length; i++) {
                    var e = encodedWrites[i];
                    bytes[offset] = e.rk.length; offset += 1;
                    bytes.set(e.rk, offset); offset += e.rk.length;
                    view.setUint16(offset, e.p.length, true); offset += 2;
                    bytes.set(e.p, offset); offset += e.p.length;
                    view.setUint32(offset, 0, true); offset += 4;
                    view.setUint32(offset, 0, true); offset += 4;
                    view.setUint32(offset, e.d.length, true); offset += 4;
                    bytes.set(e.d, offset); offset += e.d.length;
                    bytes[offset] = e.cb.length; offset += 1;
                    bytes.set(e.cb, offset); offset += e.cb.length;
                }

                __jstorrent_file_write_batch(packed);
                return "dispatched";
            })();
        """.trimIndent())

        assertEquals("dispatched", result)

        // Wait for both callbacks
        var attempts = 0
        var bothDone = false
        while (attempts < 40 && !bothDone) {
            Thread.sleep(100)
            attempts++

            engine.postAndWait {
                engine.context.evaluate("__jstorrent_file_flush()")
                val keys = engine.context.evaluate("Object.keys(globalThis.__test_write_results).length")
                bothDone = (keys as? Number)?.toInt() == 2
            }
        }

        assertTrue(bothDone, "Both write callbacks should have fired (attempts: $attempts)")

        // Verify both succeeded
        assertEquals(0, engine.evaluate("globalThis.__test_write_results['wr_a'].resultCode"))
        assertEquals(3, engine.evaluate("globalThis.__test_write_results['wr_a'].bytesWritten"))
        assertEquals(0, engine.evaluate("globalThis.__test_write_results['wr_b'].resultCode"))
        assertEquals(4, engine.evaluate("globalThis.__test_write_results['wr_b'].bytesWritten"))

        // Verify files were written
        assertEquals("AAA", engine.evaluate("__jstorrent_text_decode(__jstorrent_file_read('default', 'batch_a.txt', 0, 3))"))
        assertEquals("BBBB", engine.evaluate("__jstorrent_text_decode(__jstorrent_file_read('default', 'batch_b.txt', 0, 4))"))
    }

    @Test
    fun storageKeysWithPrefix() {
        engine.evaluate("""
            __jstorrent_storage_set("prefix_a", "1");
            __jstorrent_storage_set("prefix_b", "2");
            __jstorrent_storage_set("other_c", "3");
        """.trimIndent())

        val result = engine.evaluate("""
            const keys = JSON.parse(__jstorrent_storage_keys("prefix_"));
            keys.filter(k => k.startsWith("prefix_")).length;
        """.trimIndent())

        assertTrue((result as Number).toInt() >= 2, "Should find at least 2 keys with prefix_")
    }
}
