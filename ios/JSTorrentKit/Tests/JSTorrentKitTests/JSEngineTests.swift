import JavaScriptCore
import XCTest
@testable import JSTorrentKit

final class JSEngineTests: XCTestCase {
    private final class LogCapture: @unchecked Sendable {
        var value: (String, String)?
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
        let engine = try JSEngine()
        let bindings = NativeBindings(engine: engine)
        bindings.registerCoreBindings()

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
        let engine = try JSEngine()
        let bindings = NativeBindings(engine: engine)
        bindings.registerCoreBindings()

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
        let bindings = NativeBindings(engine: engine, logHandler: { level, message in
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
        let sink = NativeEventSink(onStateUpdate: { payload in
            XCTAssertEqual(payload, "{\"ready\":true}")
            expectation.fulfill()
        })
        let bindings = NativeBindings(engine: engine, eventSink: sink)
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
        let sink = NativeEventSink(onError: { payload in
            XCTAssertEqual(payload, "{\"error\":\"boom\"}")
            expectation.fulfill()
        })
        let bindings = NativeBindings(engine: engine, eventSink: sink)
        bindings.registerCoreBindings()

        _ = try engine.evaluate(
            "__jstorrent_on_error('{\"error\":\"boom\"}')",
            filename: "error-callback.js"
        )

        wait(for: [expectation], timeout: 1.0)
        XCTAssertEqual(sink.errors, ["{\"error\":\"boom\"}"])
    }

    func testTimeoutFiresOnce() throws {
        let engine = try JSEngine()
        let bindings = NativeBindings(engine: engine)
        bindings.registerCoreBindings()

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
        let engine = try JSEngine()
        let bindings = NativeBindings(engine: engine)
        bindings.registerCoreBindings()

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
}
