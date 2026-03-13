import CryptoKit
import JavaScriptCore
import XCTest
@testable import JSTorrentKit

final class JSEngineTests: XCTestCase {
    private final class LogCapture: @unchecked Sendable {
        var value: (String, String)?
    }

    private func makeBindingsEnvironment() throws -> (JSEngine, NativeBindings, URL, UserDefaults, String) {
        let engine = try JSEngine()
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let bindings = NativeBindings(
            engine: engine,
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory,
            defaultRootKey: "default"
        )
        bindings.registerCoreBindings()
        return (engine, bindings, baseDirectory, userDefaults, suiteName)
    }

    func testEvaluateSimpleExpression() throws {
        let engine = try JSEngine()

        let result = try engine.evaluate("1 + 1", filename: "math.js")

        XCTAssertEqual(result?.toInt32(), 2)
    }

    func testGlobalValueIsVisibleToJavaScript() throws {
        let engine = try JSEngine()
        engine.setGlobalValue("hello", for: "nativeGreeting")

        let result = try engine.evaluate("nativeGreeting", filename: "globals.js")

        XCTAssertEqual(result?.toString(), "hello")
    }

    func testJavaScriptExceptionsAreSurfaced() throws {
        let engine = try JSEngine()

        XCTAssertThrowsError(try engine.evaluate("throw new Error('boom')", filename: "throws.js"))
    }

    func testRegisterGlobalFunctionReceivesArgumentsAndReturnsValue() throws {
        let engine = try JSEngine()
        engine.setGlobalFunction("__native_add") { arguments in
            let values = arguments.map { $0.toInt32() }
            return .value(Int(values.reduce(0, +)))
        }

        let result = try engine.evaluate("__native_add(20, 22)", filename: "native-add.js")

        XCTAssertEqual(result?.toInt32(), 42)
    }

    func testCallGlobalFunctionSupportsBinaryArgument() throws {
        let engine = try JSEngine()
        _ = try engine.evaluate(
            """
            function firstByte(buffer) {
              return new Uint8Array(buffer)[0]
            }
            """,
            filename: "binary-arg.js"
        )

        let result = try engine.callGlobalFunction(
            "firstByte",
            arguments: [.binary(Data([7, 8, 9]))]
        )

        XCTAssertEqual(result?.toInt32(), 7)
    }

    func testGlobalFunctionCanRoundTripArrayBuffer() throws {
        let engine = try JSEngine()
        engine.setGlobalFunction("__native_echo_buffer") { [weak engine] arguments in
            guard
                let engine,
                let data = try engine.data(from: arguments.first)
            else {
                return .undefined
            }

            return .binary(data)
        }

        let result = try engine.evaluate(
            """
            const input = new Uint8Array([1, 2, 3]).buffer;
            const output = __native_echo_buffer(input);
            JSON.stringify(Array.from(new Uint8Array(output)));
            """,
            filename: "binary-roundtrip.js"
        )

        XCTAssertEqual(result?.toString(), "[1,2,3]")
    }

    func testBundleLoaderReadsSourceFile() throws {
        let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString + ".js"
        )
        try "globalThis.answer = 42;".write(to: temporaryURL, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(at: temporaryURL)
        }

        let bundle = try EngineBundle.load(from: temporaryURL)

        XCTAssertTrue(bundle.contains("answer"))
    }

    func testBundleEvaluatorLoadsBundleIntoEngine() throws {
        let engine = try JSEngine()
        let temporaryURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString + ".js"
        )
        try """
        globalThis.jstorrent = { init() {}, isInitialized() { return false } };
        """.write(to: temporaryURL, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(at: temporaryURL)
        }

        try EngineBundle.evaluate(from: temporaryURL, using: engine)
        let result = try engine.evaluate("typeof jstorrent.init", filename: "bundle-check.js")

        XCTAssertEqual(result?.toString(), "function")
    }

    func testPolyfillTextBindingsRoundTripUTF8() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let result = try engine.evaluate(
            """
            const encoded = __jstorrent_text_encode("hello π");
            __jstorrent_text_decode(encoded);
            """,
            filename: "text-roundtrip.js"
        )

        XCTAssertEqual(result?.toString(), "hello π")
    }

    func testRandomBytesBindingReturnsRequestedLength() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let result = try engine.evaluate(
            "new Uint8Array(__jstorrent_random_bytes(16)).length",
            filename: "random-bytes.js"
        )

        XCTAssertEqual(result?.toInt32(), 16)
    }

    func testConsoleLogBindingForwardsLevelAndMessage() throws {
        let engine = try JSEngine()
        let expectation = expectation(description: "console log forwarded")
        let capture = LogCapture()
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        let userDefaults = UserDefaults(suiteName: suiteName) ?? .standard
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }
        let bindings = NativeBindings(engine: engine, userDefaults: userDefaults, fileBaseDirectory: baseDirectory, logHandler: { level, message in
            capture.value = (level, message)
            expectation.fulfill()
        })
        bindings.registerCoreBindings()

        _ = try engine.evaluate(
            "__jstorrent_console_log('warn', 'hello from js')",
            filename: "console-log.js"
        )

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(capture.value?.0, "warn")
        XCTAssertEqual(capture.value?.1, "hello from js")
    }

    func testStateUpdateCallbackReachesSwiftLayer() throws {
        let engine = try JSEngine()
        let expectation = expectation(description: "state callback")
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        let userDefaults = UserDefaults(suiteName: suiteName) ?? .standard
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }
        let sink = NativeEventSink(onStateUpdate: { payload in
            XCTAssertEqual(payload, "{\"ready\":true}")
            expectation.fulfill()
        })
        let bindings = NativeBindings(engine: engine, eventSink: sink, userDefaults: userDefaults, fileBaseDirectory: baseDirectory)
        bindings.registerCoreBindings()

        _ = try engine.evaluate(
            "__jstorrent_on_state_update('{\"ready\":true}')",
            filename: "state-callback.js"
        )

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(sink.stateUpdates, ["{\"ready\":true}"])
    }

    func testErrorCallbackReachesSwiftLayer() throws {
        let engine = try JSEngine()
        let expectation = expectation(description: "error callback")
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        let userDefaults = UserDefaults(suiteName: suiteName) ?? .standard
        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }
        let sink = NativeEventSink(onError: { payload in
            XCTAssertEqual(payload, "{\"error\":\"boom\"}")
            expectation.fulfill()
        })
        let bindings = NativeBindings(engine: engine, eventSink: sink, userDefaults: userDefaults, fileBaseDirectory: baseDirectory)
        bindings.registerCoreBindings()

        _ = try engine.evaluate(
            "__jstorrent_on_error('{\"error\":\"boom\"}')",
            filename: "error-callback.js"
        )

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(sink.errors, ["{\"error\":\"boom\"}"])
    }

    func testTimeoutFiresOnce() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        _ = try engine.evaluate(
            """
            globalThis.__timeoutCount = 0;
            __jstorrent_set_timeout(() => { globalThis.__timeoutCount += 1; }, 10);
            """,
            filename: "timeout.js"
        )

        let expectation = expectation(description: "timeout fired")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let result = try engine.evaluate("globalThis.__timeoutCount", filename: "timeout-check.js")
        XCTAssertEqual(result?.toInt32(), 1)
    }

    func testIntervalRepeatsUntilCleared() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        _ = try engine.evaluate(
            """
            globalThis.__intervalCount = 0;
            const intervalId = __jstorrent_set_interval(() => {
              globalThis.__intervalCount += 1;
              if (globalThis.__intervalCount >= 2) {
                __jstorrent_clear_interval(intervalId);
              }
            }, 10);
            """,
            filename: "interval.js"
        )

        let expectation = expectation(description: "interval fired enough times")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.08) {
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 1.0)

        let result = try engine.evaluate("globalThis.__intervalCount", filename: "interval-check.js")
        XCTAssertEqual(result?.toInt32(), 2)
    }

    func testStorageBindingsCRUDAndPrefixKeys() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let result = try engine.evaluate(
            """
            __jstorrent_storage_set("session:a", "one");
            __jstorrent_storage_set("session:b", "two");
            const beforeDelete = __jstorrent_storage_get("session:a");
            __jstorrent_storage_delete("session:a");
            JSON.stringify({
              beforeDelete,
              afterDelete: __jstorrent_storage_get("session:a"),
              keys: JSON.parse(__jstorrent_storage_keys("session:"))
            });
            """,
            filename: "storage-crud.js"
        )

        XCTAssertEqual(
            result?.toString(),
            #"{"beforeDelete":"one","afterDelete":null,"keys":["session:b"]}"#
        )
    }

    func testFileBindingsReadWriteStatAndListTree() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let result = try engine.evaluate(
            """
            const created = __jstorrent_file_mkdir("default", "movies") === true;
            const written = __jstorrent_file_write("default", "movies/test.bin", 0, new Uint8Array([1,2,3,4]).buffer);
            const readBack = Array.from(new Uint8Array(__jstorrent_file_read("default", "movies/test.bin", 0, 4)));
            const stat = JSON.parse(__jstorrent_file_stat("default", "movies/test.bin"));
            const entries = JSON.parse(__jstorrent_file_readdir("default", "movies"));
            const tree = JSON.parse(__jstorrent_file_list_tree("default", "movies"));
            JSON.stringify({ created, written, readBack, size: stat.size, isFile: stat.isFile, entries, tree });
            """,
            filename: "file-read-write.js"
        )

        let payload = try XCTUnwrap(result?.toString().data(using: .utf8))
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        XCTAssertEqual(decoded["created"] as? Bool, true)
        XCTAssertEqual(decoded["written"] as? Int, 4)
        XCTAssertEqual(decoded["readBack"] as? [Int], [1, 2, 3, 4])
        XCTAssertEqual(decoded["size"] as? Int, 4)
        XCTAssertEqual(decoded["isFile"] as? Bool, true)
        XCTAssertEqual(decoded["entries"] as? [String], ["test.bin"])

        let tree = try XCTUnwrap(decoded["tree"] as? [[String: Any]])
        XCTAssertEqual(tree.count, 1)
        XCTAssertEqual(tree.first?["path"] as? String, "test.bin")
        XCTAssertEqual(tree.first?["size"] as? Int, 4)
    }

    func testFileBindingsDeleteAndBatchDelete() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let result = try engine.evaluate(
            """
            __jstorrent_file_mkdir("default", "batch");
            __jstorrent_file_write("default", "batch/a.txt", 0, __jstorrent_text_encode("a"));
            __jstorrent_file_write("default", "batch/b.txt", 0, __jstorrent_text_encode("b"));
            const failed = JSON.parse(__jstorrent_file_batch_delete("default", JSON.stringify({
              directory: "batch",
              entries: ["a.txt", "missing.txt"]
            })));
            const deleted = __jstorrent_file_delete("default", "batch/b.txt") === true;
            JSON.stringify({
              failed,
              remaining: JSON.parse(__jstorrent_file_readdir("default", "batch")),
              deleted
            });
            """,
            filename: "file-delete.js"
        )

        XCTAssertEqual(
            result?.toString(),
            #"{"failed":[],"remaining":[],"deleted":true}"#
        )
    }

    func testVerifyChunksReportsMatchAndMismatch() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let matchHash = Data(Insecure.SHA1.hash(data: Data("abc".utf8))).base64EncodedString()
        let mismatchHash = Data(Insecure.SHA1.hash(data: Data("xyz".utf8))).base64EncodedString()

        let result = try engine.evaluate(
            """
            __jstorrent_file_write("default", "verify/test.txt", 0, __jstorrent_text_encode("abc"));
            const match = Array.from(new Uint8Array(__jstorrent_file_verify_chunks("default", JSON.stringify({
              files: [{ path: "verify/test.txt", length: 3 }],
              chunkSize: 3,
              hashes: "\(matchHash)",
              startChunk: 0,
              chunkCount: 1
            }))));
            const mismatch = Array.from(new Uint8Array(__jstorrent_file_verify_chunks("default", JSON.stringify({
              files: [{ path: "verify/test.txt", length: 3 }],
              chunkSize: 3,
              hashes: "\(mismatchHash)",
              startChunk: 0,
              chunkCount: 1
            }))));
            JSON.stringify({ match, mismatch });
            """,
            filename: "verify-chunks.js"
        )

        XCTAssertEqual(result?.toString(), #"{"match":[0],"mismatch":[1]}"#)
    }

    func testHashBindingsSyncBatchAndAsync() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let asyncExpectation = expectation(description: "async hash callback")
        _ = try engine.evaluate(
            """
            globalThis.__hashResult = null;
            globalThis.__jstorrent_hash_callbacks = {
              cb1(hash) {
                __hashResult = Array.from(new Uint8Array(hash));
              }
            };
            globalThis.__jstorrent_hash_dispatch_result = (callbackId, hash) => {
              const callback = globalThis.__jstorrent_hash_callbacks[callbackId];
              if (callback) {
                delete globalThis.__jstorrent_hash_callbacks[callbackId];
                callback(hash);
              }
            };
            """,
            filename: "hash-callback-init.js"
        )

        _ = try engine.evaluate(
            """
            __jstorrent_sha1_async(__jstorrent_text_encode("abc"), "cb1");
            """,
            filename: "hash-async.js"
        )

        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            asyncExpectation.fulfill()
        }
        wait(for: [asyncExpectation], timeout: 1.0)

        let result = try engine.evaluate(
            """
            function pack(inputs) {
              let total = 4;
              for (const input of inputs) total += 4 + input.length;
              const buffer = new ArrayBuffer(total);
              const view = new DataView(buffer);
              let offset = 0;
              view.setUint32(offset, inputs.length, true);
              offset += 4;
              for (const input of inputs) {
                view.setUint32(offset, input.length, true);
                offset += 4;
                new Uint8Array(buffer, offset, input.length).set(input);
                offset += input.length;
              }
              return buffer;
            }

            const single = Array.from(new Uint8Array(__jstorrent_sha1(__jstorrent_text_encode("abc"))));
            const batch = Array.from(new Uint8Array(__jstorrent_sha1_batch_sync(pack([
              new Uint8Array(__jstorrent_text_encode("abc")),
              new Uint8Array(__jstorrent_text_encode("xyz"))
            ]))));
            JSON.stringify({
              singleLength: single.length,
              batchLength: batch.length,
              asyncLength: __hashResult.length,
              samePrefix: JSON.stringify(single) === JSON.stringify(batch.slice(0, 20))
            });
            """,
            filename: "hash-sync-batch.js"
        )

        XCTAssertEqual(
            result?.toString(),
            #"{"singleLength":20,"batchLength":40,"asyncLength":20,"samePrefix":true}"#
        )
    }
}
