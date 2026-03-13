import Foundation
import JavaScriptCore

public enum JSEngineError: Error, LocalizedError {
    case contextUnavailable
    case javaScriptException(String)

    public var errorDescription: String? {
        switch self {
        case .contextUnavailable:
            return "Failed to create JavaScriptCore context."
        case .javaScriptException(let message):
            return message
        }
    }
}

public final class JSEngine {
    public let virtualMachine: JSVirtualMachine
    public let context: JSContext

    private var lastExceptionMessage: String?

    public init() throws {
        guard let virtualMachine = JSVirtualMachine() else {
            throw JSEngineError.contextUnavailable
        }
        guard let context = JSContext(virtualMachine: virtualMachine) else {
            throw JSEngineError.contextUnavailable
        }

        self.virtualMachine = virtualMachine
        self.context = context

        context.exceptionHandler = { [weak self] _, exception in
            self?.lastExceptionMessage = exception?.toString() ?? "Unknown JavaScript exception"
        }
    }

    @discardableResult
    public func evaluate(_ script: String, filename: String = "inline.js") throws -> JSValue? {
        lastExceptionMessage = nil
        let sourceURL = URL(fileURLWithPath: filename)
        let result = context.evaluateScript(script, withSourceURL: sourceURL)

        if let lastExceptionMessage {
            throw JSEngineError.javaScriptException(lastExceptionMessage)
        }

        return result
    }

    public func setGlobalValue(_ value: Any, for name: String) {
        context.setObject(value, forKeyedSubscript: name as NSString)
    }
}
