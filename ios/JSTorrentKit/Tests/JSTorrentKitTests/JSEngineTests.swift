import JavaScriptCore
import XCTest
@testable import JSTorrentKit

final class JSEngineTests: XCTestCase {
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
}
