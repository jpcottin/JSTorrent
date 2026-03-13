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

    private func makeSocketEnvironment() throws -> (JSEngine, NativeBindings, SocketBindings, URL, UserDefaults, String) {
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
        let sockets = SocketBindings(engine: engine)
        sockets.register()
        bindings.registerCoreBindings()
        return (engine, bindings, sockets, baseDirectory, userDefaults, suiteName)
    }

    private func repositoryRootURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func waitUntil(
        timeout: TimeInterval = 2.0,
        pollInterval: TimeInterval = 0.01,
        condition: () throws -> Bool
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try condition() {
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
        }

        XCTFail("Timed out waiting for condition")
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

    func testVerifiedWriteBatchFlushDispatchesCallbackManagerFormat() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let goodHash = Data(Insecure.SHA1.hash(data: Data("ok".utf8))).map { String(format: "%02x", $0) }.joined()
        let badHash = Data(Insecure.SHA1.hash(data: Data("xx".utf8))).map { String(format: "%02x", $0) }.joined()

        _ = try engine.evaluate(
            """
            function encodeUtf8(str) {
              return new Uint8Array(__jstorrent_text_encode(str));
            }

            function packVerifiedWrites(items) {
              let total = 4;
              for (const item of items) {
                const rootKey = encodeUtf8(item.rootKey);
                const path = encodeUtf8(item.path);
                const callbackId = encodeUtf8(item.callbackId);
                const hashHex = encodeUtf8(item.expectedHashHex);
                total += 1 + rootKey.length;
                total += 2 + path.length;
                total += 8;
                total += 4 + item.data.length;
                total += 40;
                total += 1 + callbackId.length;
              }

              const buffer = new ArrayBuffer(total);
              const view = new DataView(buffer);
              const bytes = new Uint8Array(buffer);
              let offset = 0;
              view.setUint32(offset, items.length, true);
              offset += 4;

              for (const item of items) {
                const rootKey = encodeUtf8(item.rootKey);
                const path = encodeUtf8(item.path);
                const callbackId = encodeUtf8(item.callbackId);
                const hashHex = encodeUtf8(item.expectedHashHex);

                bytes[offset] = rootKey.length;
                offset += 1;
                bytes.set(rootKey, offset);
                offset += rootKey.length;

                view.setUint16(offset, path.length, true);
                offset += 2;
                bytes.set(path, offset);
                offset += path.length;

                view.setUint32(offset, item.position >>> 0, true);
                view.setUint32(offset + 4, Math.floor(item.position / 0x100000000) >>> 0, true);
                offset += 8;

                view.setUint32(offset, item.data.length, true);
                offset += 4;
                bytes.set(item.data, offset);
                offset += item.data.length;

                bytes.set(hashHex, offset);
                offset += 40;

                bytes[offset] = callbackId.length;
                offset += 1;
                bytes.set(callbackId, offset);
                offset += callbackId.length;
              }

              return buffer;
            }

            globalThis.__writeResults = {};
            globalThis.__jstorrent_file_write_callbacks = {
              vw1(bytesWritten, resultCode) {
                __writeResults.vw1 = { bytesWritten, resultCode };
              },
              vw2(bytesWritten, resultCode) {
                __writeResults.vw2 = { bytesWritten, resultCode };
              }
            };
            globalThis.__jstorrent_file_dispatch_batch = (packed) => {
              const view = new DataView(packed);
              const bytes = new Uint8Array(packed);
              let offset = 0;
              const count = view.getUint32(offset, true);
              offset += 4;

              for (let i = 0; i < count; i++) {
                const callbackIdLen = bytes[offset];
                offset += 1;
                const callbackId = __jstorrent_text_decode(bytes.slice(offset, offset + callbackIdLen).buffer);
                offset += callbackIdLen;
                const bytesWritten = view.getInt32(offset, true);
                offset += 4;
                const resultCode = bytes[offset];
                offset += 1;
                const callback = globalThis.__jstorrent_file_write_callbacks[callbackId];
                if (callback) {
                  delete globalThis.__jstorrent_file_write_callbacks[callbackId];
                  callback(bytesWritten, resultCode);
                }
              }
            };

            __jstorrent_file_write_verified_batch(packVerifiedWrites([
              {
                rootKey: "default",
                path: "verified/good.bin",
                position: 0,
                data: encodeUtf8("ok"),
                expectedHashHex: "\(goodHash)",
                callbackId: "vw1"
              },
              {
                rootKey: "default",
                path: "verified/bad.bin",
                position: 0,
                data: encodeUtf8("no"),
                expectedHashHex: "\(badHash)",
                callbackId: "vw2"
              }
            ]));
            """,
            filename: "verified-write-batch.js"
        )

        let asyncExpectation = expectation(description: "verified write queued")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            asyncExpectation.fulfill()
        }
        wait(for: [asyncExpectation], timeout: 1.0)

        _ = try engine.evaluate("__jstorrent_file_flush()", filename: "verified-write-flush.js")

        let result = try engine.evaluate(
            """
            JSON.stringify({
              results: __writeResults,
              goodExists: __jstorrent_file_exists("default", "verified/good.bin"),
              badExists: __jstorrent_file_exists("default", "verified/bad.bin"),
              goodData: Array.from(new Uint8Array(__jstorrent_file_read("default", "verified/good.bin", 0, 2)))
            });
            """,
            filename: "verified-write-check.js"
        )

        let payload = try XCTUnwrap(result?.toString().data(using: .utf8))
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        let results = try XCTUnwrap(decoded["results"] as? [String: [String: Any]])
        XCTAssertEqual(results["vw1"]?["bytesWritten"] as? Int, 2)
        XCTAssertEqual(results["vw1"]?["resultCode"] as? Int, 0)
        XCTAssertEqual(results["vw2"]?["bytesWritten"] as? Int, 0)
        XCTAssertEqual(results["vw2"]?["resultCode"] as? Int, 1)
        XCTAssertEqual(decoded["goodExists"] as? Bool, true)
        XCTAssertEqual(decoded["badExists"] as? Bool, false)
        XCTAssertEqual(decoded["goodData"] as? [Int], [111, 107])
    }

    func testAsyncReadBatchFlushDispatchesCallbackManagerFormat() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        _ = try engine.evaluate(
            """
            __jstorrent_file_write("default", "reads/file.bin", 0, new Uint8Array([1, 2, 3, 4]).buffer);

            function encodeUtf8(str) {
              return new Uint8Array(__jstorrent_text_encode(str));
            }

            function packReads(items) {
              let total = 4;
              for (const item of items) {
                const rootKey = encodeUtf8(item.rootKey);
                const path = encodeUtf8(item.path);
                const callbackId = encodeUtf8(item.callbackId);
                total += 1 + rootKey.length;
                total += 2 + path.length;
                total += 8;
                total += 4;
                total += 1 + callbackId.length;
              }

              const buffer = new ArrayBuffer(total);
              const view = new DataView(buffer);
              const bytes = new Uint8Array(buffer);
              let offset = 0;
              view.setUint32(offset, items.length, true);
              offset += 4;

              for (const item of items) {
                const rootKey = encodeUtf8(item.rootKey);
                const path = encodeUtf8(item.path);
                const callbackId = encodeUtf8(item.callbackId);

                bytes[offset] = rootKey.length;
                offset += 1;
                bytes.set(rootKey, offset);
                offset += rootKey.length;

                view.setUint16(offset, path.length, true);
                offset += 2;
                bytes.set(path, offset);
                offset += path.length;

                view.setUint32(offset, item.position >>> 0, true);
                view.setUint32(offset + 4, Math.floor(item.position / 0x100000000) >>> 0, true);
                offset += 8;

                view.setUint32(offset, item.length, true);
                offset += 4;

                bytes[offset] = callbackId.length;
                offset += 1;
                bytes.set(callbackId, offset);
                offset += callbackId.length;
              }

              return buffer;
            }

            globalThis.__readResults = {};
            globalThis.__jstorrent_file_read_callbacks = {
              rd1(resultCode, data) {
                __readResults.rd1 = { resultCode, data: Array.from(new Uint8Array(data)) };
              },
              rd2(resultCode, data) {
                __readResults.rd2 = { resultCode, data: Array.from(new Uint8Array(data)) };
              }
            };
            globalThis.__jstorrent_file_dispatch_read_batch = (packed) => {
              const view = new DataView(packed);
              const bytes = new Uint8Array(packed);
              let offset = 0;
              const count = view.getUint32(offset, true);
              offset += 4;

              for (let i = 0; i < count; i++) {
                const callbackIdLen = bytes[offset];
                offset += 1;
                const callbackId = __jstorrent_text_decode(bytes.slice(offset, offset + callbackIdLen).buffer);
                offset += callbackIdLen;
                const resultCode = bytes[offset];
                offset += 1;
                const dataLen = view.getUint32(offset, true);
                offset += 4;
                const data = packed.slice(offset, offset + dataLen);
                offset += dataLen;
                const callback = globalThis.__jstorrent_file_read_callbacks[callbackId];
                if (callback) {
                  delete globalThis.__jstorrent_file_read_callbacks[callbackId];
                  callback(resultCode, data);
                }
              }
            };

            __jstorrent_file_read_batch(packReads([
              { rootKey: "default", path: "reads/file.bin", position: 0, length: 2, callbackId: "rd1" },
              { rootKey: "default", path: "reads/file.bin", position: 2, length: 2, callbackId: "rd2" }
            ]));
            """,
            filename: "async-read-batch.js"
        )

        let asyncExpectation = expectation(description: "async read queued")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            asyncExpectation.fulfill()
        }
        wait(for: [asyncExpectation], timeout: 1.0)

        _ = try engine.evaluate("__jstorrent_file_flush()", filename: "async-read-flush.js")

        let result = try engine.evaluate(
            "JSON.stringify(__readResults)",
            filename: "async-read-check.js"
        )

        let payload = try XCTUnwrap(result?.toString().data(using: .utf8))
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: [String: Any]]
        )
        XCTAssertEqual(decoded["rd1"]?["resultCode"] as? Int, 0)
        XCTAssertEqual(decoded["rd1"]?["data"] as? [Int], [1, 2])
        XCTAssertEqual(decoded["rd2"]?["resultCode"] as? Int, 0)
        XCTAssertEqual(decoded["rd2"]?["data"] as? [Int], [3, 4])
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
            globalThis.__jstorrent_hash_dispatch_batch = (packed) => {
              const bytes = new Uint8Array(packed);
              const view = new DataView(packed);
              let offset = 0;
              const count = view.getUint32(offset, true);
              offset += 4;

              for (let i = 0; i < count; i++) {
                const callbackIdLen = bytes[offset];
                offset += 1;
                const callbackId = __jstorrent_text_decode(bytes.slice(offset, offset + callbackIdLen).buffer);
                offset += callbackIdLen;
                const hashLen = bytes[offset];
                offset += 1;
                const hash = packed.slice(offset, offset + hashLen);
                offset += hashLen;
                __jstorrent_hash_dispatch_result(callbackId, hash);
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
        _ = try engine.evaluate("__jstorrent_hash_flush()", filename: "hash-flush.js")

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

    func testTCPBindingsSupportLoopbackBatchFlush() throws {
        let (engine, _, _, baseDirectory, userDefaults, suiteName) = try makeSocketEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        _ = try engine.evaluate(
            """
            function encodeUtf8(str) {
              return new Uint8Array(__jstorrent_text_encode(str));
            }

            function packSends(items) {
              let total = 4;
              for (const item of items) {
                total += 8 + item.data.length;
              }

              const buffer = new ArrayBuffer(total);
              const view = new DataView(buffer);
              const bytes = new Uint8Array(buffer);
              let offset = 0;
              view.setUint32(offset, items.length, true);
              offset += 4;

              for (const item of items) {
                view.setUint32(offset, item.socketId, true);
                offset += 4;
                view.setUint32(offset, item.data.length, true);
                offset += 4;
                bytes.set(item.data, offset);
                offset += item.data.length;
              }

              return buffer;
            }

            globalThis.__tcpState = {
              listening: null,
              connected: null,
              accepted: null,
              received: {},
              closes: [],
              errors: []
            };

            __jstorrent_tcp_on_connected((socketId, success, errorMessage) => {
              __tcpState.connected = { socketId, success, errorMessage };
            });

            __jstorrent_tcp_on_listening((serverId, success, port) => {
              __tcpState.listening = { serverId, success, port };
            });

            __jstorrent_tcp_on_accept((serverId, socketId, remoteAddr, remotePort) => {
              __tcpState.accepted = { serverId, socketId, remoteAddr, remotePort };
            });

            __jstorrent_tcp_on_close((socketId, hadError) => {
              __tcpState.closes.push({ socketId, hadError });
            });

            __jstorrent_tcp_on_error((socketId, message) => {
              __tcpState.errors.push({ socketId, message });
            });

            globalThis.__jstorrent_tcp_dispatch_batch = (packed) => {
              const view = new DataView(packed);
              let offset = 0;
              const count = view.getUint32(offset, true);
              offset += 4;

              for (let i = 0; i < count; i++) {
                const socketId = view.getUint32(offset, true);
                offset += 4;
                const len = view.getUint32(offset, true);
                offset += 4;
                const data = packed.slice(offset, offset + len);
                offset += len;
                const text = __jstorrent_text_decode(data);
                (__tcpState.received[socketId] ||= []).push(text);
              }
            };

            __jstorrent_tcp_listen(501, 0);
            """,
            filename: "tcp-loopback-init.js"
        )

        try waitUntil {
            let result = try engine.evaluate(
                "JSON.stringify(__tcpState.listening)",
                filename: "tcp-listening-check.js"
            )
            return result?.toString() != "null"
        }

        let portValue = try engine.evaluate("__tcpState.listening.port", filename: "tcp-port.js")
        let port = Int(portValue?.toInt32() ?? 0)
        XCTAssertGreaterThan(port, 0)

        _ = try engine.evaluate(
            "__jstorrent_tcp_connect(101, '127.0.0.1', \(port));",
            filename: "tcp-connect.js"
        )

        try waitUntil {
            let result = try engine.evaluate(
                "__tcpState.connected && __tcpState.connected.success === true && __tcpState.accepted !== null",
                filename: "tcp-connect-wait.js"
            )
            return result?.toBool() ?? false
        }

        _ = try engine.evaluate(
            """
            __jstorrent_tcp_send_batch(packSends([
              { socketId: 101, data: encodeUtf8("ping") },
              { socketId: __tcpState.accepted.socketId, data: encodeUtf8("pong") }
            ]));
            """,
            filename: "tcp-batch-send.js"
        )

        try waitUntil {
            _ = try engine.evaluate("__jstorrent_tcp_flush()", filename: "tcp-flush.js")
            let result = try engine.evaluate(
                """
                Boolean(
                  __tcpState.received["101"] &&
                  __tcpState.received["101"][0] === "pong" &&
                  __tcpState.received[String(__tcpState.accepted.socketId)] &&
                  __tcpState.received[String(__tcpState.accepted.socketId)][0] === "ping"
                )
                """,
                filename: "tcp-receive-check.js"
            )
            return result?.toBool() ?? false
        }

        _ = try engine.evaluate("__jstorrent_tcp_close(101)", filename: "tcp-close.js")

        try waitUntil {
            let result = try engine.evaluate(
                "__tcpState.closes.length > 0",
                filename: "tcp-close-check.js"
            )
            return result?.toBool() ?? false
        }

        let result = try engine.evaluate(
            "JSON.stringify(__tcpState)",
            filename: "tcp-final-state.js"
        )
        let payload = try XCTUnwrap(result?.toString().data(using: .utf8))
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        let listening = try XCTUnwrap(decoded["listening"] as? [String: Any])
        XCTAssertEqual(listening["success"] as? Bool, true)

        let connected = try XCTUnwrap(decoded["connected"] as? [String: Any])
        XCTAssertEqual(connected["socketId"] as? Int, 101)
        XCTAssertEqual(connected["success"] as? Bool, true)

        let accepted = try XCTUnwrap(decoded["accepted"] as? [String: Any])
        XCTAssertNotNil(accepted["socketId"] as? Int)
        XCTAssertGreaterThan(accepted["remotePort"] as? Int ?? 0, 0)

        let received = try XCTUnwrap(decoded["received"] as? [String: [String]])
        XCTAssertEqual(received["101"], ["pong"])
        let acceptedSocketId = try XCTUnwrap(accepted["socketId"] as? Int)
        XCTAssertEqual(received[String(acceptedSocketId)], ["ping"])

        let closes = try XCTUnwrap(decoded["closes"] as? [[String: Any]])
        XCTAssertFalse(closes.isEmpty)
        XCTAssertEqual(decoded["errors"] as? [[String: String]], [])

        _ = try engine.evaluate("__jstorrent_tcp_server_close(501)", filename: "tcp-server-close.js")
    }

    func testUDPBindingsSupportLoopbackBatchFlush() throws {
        let (engine, _, _, baseDirectory, userDefaults, suiteName) = try makeSocketEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        _ = try engine.evaluate(
            """
            function encodeUtf8(str) {
              return new Uint8Array(__jstorrent_text_encode(str));
            }

            globalThis.__udpState = {
              bounds: {},
              received: {}
            };

            __jstorrent_udp_on_bound((socketId, success, port) => {
              __udpState.bounds[socketId] = { success, port };
            });

            globalThis.__jstorrent_udp_dispatch_batch = (packed) => {
              const view = new DataView(packed);
              const bytes = new Uint8Array(packed);
              let offset = 0;
              const count = view.getUint32(offset, true);
              offset += 4;

              for (let i = 0; i < count; i++) {
                const socketId = view.getUint32(offset, true);
                offset += 4;
                const srcPort = view.getUint16(offset, true);
                offset += 2;
                const addrLen = bytes[offset];
                offset += 1;
                const addr = __jstorrent_text_decode(bytes.slice(offset, offset + addrLen).buffer);
                offset += addrLen;
                const dataLen = view.getUint32(offset, true);
                offset += 4;
                const data = packed.slice(offset, offset + dataLen);
                offset += dataLen;

                (__udpState.received[socketId] ||= []).push({
                  addr,
                  port: srcPort,
                  text: __jstorrent_text_decode(data)
                });
              }
            };

            __jstorrent_udp_bind(201, "127.0.0.1", 0);
            __jstorrent_udp_bind(202, "127.0.0.1", 0);
            """,
            filename: "udp-loopback-init.js"
        )

        try waitUntil {
            let result = try engine.evaluate(
                """
                Boolean(
                  __udpState.bounds["201"] &&
                  __udpState.bounds["202"] &&
                  __udpState.bounds["201"].success === true &&
                  __udpState.bounds["202"].success === true
                )
                """,
                filename: "udp-bound-check.js"
            )
            return result?.toBool() ?? false
        }

        _ = try engine.evaluate(
            """
            const port201 = __udpState.bounds["201"].port;
            const port202 = __udpState.bounds["202"].port;
            __jstorrent_udp_send(201, "127.0.0.1", port202, encodeUtf8("alpha"));
            __jstorrent_udp_send(202, "127.0.0.1", port201, encodeUtf8("beta"));
            __jstorrent_udp_join_multicast(201, "224.0.0.251");
            __jstorrent_udp_leave_multicast(201, "224.0.0.251");
            """,
            filename: "udp-send.js"
        )

        try waitUntil {
            _ = try engine.evaluate("__jstorrent_udp_flush()", filename: "udp-flush.js")
            let result = try engine.evaluate(
                """
                Boolean(
                  __udpState.received["201"] &&
                  __udpState.received["201"][0].text === "beta" &&
                  __udpState.received["202"] &&
                  __udpState.received["202"][0].text === "alpha"
                )
                """,
                filename: "udp-receive-check.js"
            )
            return result?.toBool() ?? false
        }

        let result = try engine.evaluate(
            "JSON.stringify(__udpState)",
            filename: "udp-final-state.js"
        )

        let payload = try XCTUnwrap(result?.toString().data(using: .utf8))
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload) as? [String: Any]
        )
        let bounds = try XCTUnwrap(decoded["bounds"] as? [String: [String: Any]])
        XCTAssertEqual(bounds["201"]?["success"] as? Bool, true)
        XCTAssertEqual(bounds["202"]?["success"] as? Bool, true)
        XCTAssertGreaterThan(bounds["201"]?["port"] as? Int ?? 0, 0)
        XCTAssertGreaterThan(bounds["202"]?["port"] as? Int ?? 0, 0)

        let received = try XCTUnwrap(decoded["received"] as? [String: [[String: Any]]])
        XCTAssertEqual(received["201"]?.first?["text"] as? String, "beta")
        XCTAssertEqual(received["202"]?.first?["text"] as? String, "alpha")
        XCTAssertEqual(received["201"]?.first?["addr"] as? String, "127.0.0.1")
        XCTAssertEqual(received["202"]?.first?["addr"] as? String, "127.0.0.1")

        _ = try engine.evaluate("__jstorrent_udp_close(201)", filename: "udp-close-201.js")
        _ = try engine.evaluate("__jstorrent_udp_close(202)", filename: "udp-close-202.js")
    }

    func testNetworkInfoBindingsReturnJSONShapes() throws {
        let (engine, _, baseDirectory, userDefaults, suiteName) = try makeBindingsEnvironment()
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let interfacesValue = try engine.evaluate(
            "__jstorrent_get_network_interfaces()",
            filename: "network-interfaces.js"
        )
        let gatewayValue = try engine.evaluate(
            "__jstorrent_get_default_gateway()",
            filename: "default-gateway.js"
        )

        let interfacesData = try XCTUnwrap(interfacesValue?.toString().data(using: .utf8))
        let interfaces = try XCTUnwrap(
            JSONSerialization.jsonObject(with: interfacesData) as? [[String: Any]]
        )
        for interface in interfaces {
            XCTAssertNotNil(interface["name"] as? String)
            XCTAssertNotNil(interface["address"] as? String)
            XCTAssertNotNil(interface["prefixLength"] as? Int)
        }

        XCTAssertEqual(gatewayValue?.toString(), "null")
    }

    @MainActor
    func testEngineControllerAppliesTorrentPayload() {
        let controller = EngineController(
            bootstrapConfig: EngineBootstrapConfig(contentRoots: [])
        )

        controller.applyStateUpdate(
            payload: """
            {
              "torrents": [
                {
                  "infoHash": "abc123",
                  "name": "Ubuntu ISO",
                  "progress": 0.5,
                  "downloadSpeed": 1024,
                  "uploadSpeed": 512,
                  "status": "downloading",
                  "numPeers": 12
                }
              ]
            }
            """
        )

        XCTAssertEqual(controller.torrents.count, 1)
        XCTAssertEqual(controller.torrents.first?.name, "Ubuntu ISO")
        XCTAssertEqual(controller.torrents.first?.status, "downloading")
        XCTAssertEqual(controller.torrents.first?.numPeers, 12)
    }

    func testTorrentListItemDecodesQueryTorrentListPeerShape() throws {
        let data = Data(
            """
            {
              "torrents": [
                {
                  "infoHash": "abc123",
                  "name": "Ubuntu ISO",
                  "progress": 0.5,
                  "downloadSpeed": 1024,
                  "uploadSpeed": 512,
                  "status": "downloading",
                  "peersConnected": 7
                }
              ]
            }
            """.utf8
        )

        let payload = try JSONDecoder().decode(EngineStatePayload.self, from: data)
        XCTAssertEqual(payload.torrents?.first?.numPeers, 7)
    }

    @MainActor
    func testEngineControllerAppliesStructuredRuntimeErrorPayload() {
        let controller = EngineController(
            bootstrapConfig: EngineBootstrapConfig(contentRoots: [])
        )

        controller.applyRuntimeError(
            payload: """
            {
              "error": "Disk write failed"
            }
            """
        )

        XCTAssertEqual(controller.lastError, "Disk write failed")
        XCTAssertEqual(controller.status, .failed("Disk write failed"))
    }

    func testRuntimePauseAndResumeCommandsInvokeJSGlobals() throws {
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let runtime = try JSTorrentRuntime(
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory
        )

        try runtime.engine.evaluate(
            """
            globalThis.__pause_calls = [];
            globalThis.__resume_calls = [];
            globalThis.__jstorrent_cmd_pause = function (infoHash) {
              globalThis.__pause_calls.push(infoHash);
            };
            globalThis.__jstorrent_cmd_resume = function (infoHash) {
              globalThis.__resume_calls.push(infoHash);
            };
            """,
            filename: "runtime-command-test.js"
        )

        try runtime.pauseTorrent("pause-hash")
        try runtime.resumeTorrent("resume-hash")

        XCTAssertEqual(
            try runtime.engine.evaluate("__pause_calls[0]", filename: "runtime-command-read.js")?.toString(),
            "pause-hash"
        )
        XCTAssertEqual(
            try runtime.engine.evaluate("__resume_calls[0]", filename: "runtime-command-read.js")?.toString(),
            "resume-hash"
        )
    }

    func testRuntimeQueryTorrentListDecodesResponse() throws {
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let runtime = try JSTorrentRuntime(
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory
        )

        try runtime.engine.evaluate(
            """
            globalThis.__jstorrent_query_torrent_list = function () {
              return JSON.stringify({
                torrents: [{
                  infoHash: "query-hash",
                  name: "Query Torrent",
                  progress: 0.25,
                  downloadSpeed: 1,
                  uploadSpeed: 2,
                  status: "downloading",
                  peersConnected: 3
                }]
              });
            };
            """,
            filename: "runtime-query-torrent-list-test.js"
        )

        let payload = try runtime.queryTorrentList()
        XCTAssertEqual(payload.torrents?.count, 1)
        XCTAssertEqual(payload.torrents?.first?.name, "Query Torrent")
        XCTAssertEqual(payload.torrents?.first?.numPeers, 3)
    }

    func testRuntimeRemoveCommandInvokesJSGlobal() throws {
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let runtime = try JSTorrentRuntime(
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory
        )

        try runtime.engine.evaluate(
            """
            globalThis.__remove_calls = [];
            globalThis.__jstorrent_cmd_remove = async function (infoHash, deleteFiles) {
              globalThis.__remove_calls.push([infoHash, deleteFiles]);
              return { ok: true };
            };
            """,
            filename: "runtime-remove-test.js"
        )

        try runtime.removeTorrent("remove-hash", deleteFiles: true)

        XCTAssertEqual(
            try runtime.engine.evaluate("__remove_calls[0][0]", filename: "runtime-remove-read.js")?.toString(),
            "remove-hash"
        )
        XCTAssertEqual(
            try runtime.engine.evaluate("__remove_calls[0][1]", filename: "runtime-remove-read.js")?.toBool(),
            true
        )
    }

    func testRuntimeLoadsRealBundleAndInitializesInHostMode() throws {
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let stateExpectation = expectation(description: "initial state callback")
        stateExpectation.assertForOverFulfill = false
        let sink = NativeEventSink(
            onStateUpdate: { payload in
                if payload.contains("\"torrents\"") {
                    stateExpectation.fulfill()
                }
            }
        )

        let runtime = try JSTorrentRuntime(
            eventSink: sink,
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory
        )
        let bundleURL = repositoryRootURL()
            .appendingPathComponent("packages/engine/dist/engine.native.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

        try runtime.loadBundle(from: bundleURL)
        try runtime.initialize(
            with: EngineBootstrapConfig(
                contentRoots: [ContentRoot(key: "default", label: "Default")],
                defaultContentRoot: "default",
                shouldRemainSuspended: true
            )
        )

        try waitUntil {
            try runtime.isInitialized()
        }

        try runtime.setTickMode(.host)
        try runtime.subscribe(type: "torrents", intervalMs: 50)

        wait(for: [stateExpectation], timeout: 2.0)

        let tick = try runtime.tick()
        XCTAssertGreaterThanOrEqual(tick.delayMs, 0)
        XCTAssertTrue(sink.errors.isEmpty)
        XCTAssertFalse(sink.stateUpdates.isEmpty)
    }

    func testRuntimeAddTestTorrentAppearsInStateUpdates() throws {
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let sink = NativeEventSink()
        let runtime = try JSTorrentRuntime(
            eventSink: sink,
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory
        )
        let bundleURL = repositoryRootURL()
            .appendingPathComponent("packages/engine/dist/engine.native.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

        try runtime.loadBundle(from: bundleURL)
        try runtime.initialize(
            with: EngineBootstrapConfig(
                contentRoots: [ContentRoot(key: "default", label: "Default")],
                defaultContentRoot: "default",
                shouldRemainSuspended: true
            )
        )

        try waitUntil {
            try runtime.isInitialized()
        }

        try runtime.setTickMode(.host)
        try runtime.subscribe(type: "torrents", intervalMs: 50)
        try runtime.addTestTorrent()

        try waitUntil(timeout: 3.0) {
            _ = try runtime.tick()
            return sink.stateUpdates.contains(where: { $0.contains("testdata_100mb.bin") })
        }

        XCTAssertTrue(sink.errors.isEmpty)
    }
}
