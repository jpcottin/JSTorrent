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
}
