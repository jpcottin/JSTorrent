import Foundation
import JavaScriptCore

public enum JSEngineError: Error, LocalizedError {
    case contextUnavailable
    case globalFunctionNotFound(String)
    case javaScriptException(String)
    case unsupportedBinaryValue
    case typedArrayConversionFailed(String)

    public var errorDescription: String? {
        switch self {
        case .contextUnavailable:
            return "Failed to create JavaScriptCore context."
        case .globalFunctionNotFound(let name):
            return "Global JavaScript function '\(name)' was not found."
        case .javaScriptException(let message):
            return message
        case .unsupportedBinaryValue:
            return "Expected an ArrayBuffer or TypedArray."
        case .typedArrayConversionFailed(let reason):
            return reason
        }
    }
}

public enum JSFunctionArgument {
    case value(Any?)
    case binary(Data)
}

public enum JSFunctionResult {
    case undefined
    case value(Any?)
    case binary(Data)
}

private func releaseJSBuffer(
    _ bytes: UnsafeMutableRawPointer?,
    _ deallocatorContext: UnsafeMutableRawPointer?
) {
    bytes?.deallocate()
}

public final class JSEngine {
    public let virtualMachine: JSVirtualMachine
    public let context: JSContext
    public let jsQueue: DispatchQueue

    private var lastExceptionMessage: String?
    private let queueKey = DispatchSpecificKey<Void>()

    public init(label: String = "com.jstorrent.ios.js") throws {
        guard let virtualMachine = JSVirtualMachine() else {
            throw JSEngineError.contextUnavailable
        }
        guard let context = JSContext(virtualMachine: virtualMachine) else {
            throw JSEngineError.contextUnavailable
        }
        let queue = DispatchQueue(label: label)

        self.virtualMachine = virtualMachine
        self.context = context
        self.jsQueue = queue

        queue.setSpecific(key: queueKey, value: ())

        context.exceptionHandler = { [weak self] _, exception in
            self?.lastExceptionMessage = exception?.toString() ?? "Unknown JavaScript exception"
        }
    }

    @discardableResult
    public func evaluate(_ script: String, filename: String = "inline.js") throws -> JSValue? {
        try performSync {
            lastExceptionMessage = nil
            let sourceURL = URL(fileURLWithPath: filename)
            let result = context.evaluateScript(script, withSourceURL: sourceURL)

            if let lastExceptionMessage {
                throw JSEngineError.javaScriptException(lastExceptionMessage)
            }

            return result
        }
    }

    public func setGlobalValue(_ value: Any, for name: String) {
        performSyncWithoutThrowing {
            self.context.setObject(value, forKeyedSubscript: name as NSString)
        }
    }

    public func setGlobalFunction(
        _ name: String,
        callback: @escaping ([JSValue]) throws -> JSFunctionResult
    ) {
        performSyncWithoutThrowing {
            let block: @convention(block) () -> Any? = { [weak self] in
                guard let self else {
                    return nil
                }

                let callbackContext = JSContext.current() ?? self.context
                let arguments = (JSContext.currentArguments() as? [JSValue]) ?? []

                do {
                    let result = try callback(arguments)
                    return try self.convertFunctionResult(result, in: callbackContext)
                } catch {
                    callbackContext.exception = JSValue(
                        newErrorFromMessage: error.localizedDescription,
                        in: callbackContext
                    )
                    return nil
                }
            }

            self.context.setObject(block, forKeyedSubscript: name as NSString)
        }
    }

    @discardableResult
    public func callGlobalFunction(
        _ name: String,
        arguments: [JSFunctionArgument] = []
    ) throws -> JSValue? {
        let function = try performSync {
            guard let function = context.globalObject.forProperty(name), !function.isUndefined else {
                throw JSEngineError.globalFunctionNotFound(name)
            }
            return function
        }

        return try callFunction(function, arguments: arguments)
    }

    @discardableResult
    public func callFunction(
        _ function: JSValue,
        arguments: [JSFunctionArgument] = []
    ) throws -> JSValue? {
        try performSync {
            lastExceptionMessage = nil

            let jsArguments = try arguments.map { argument in
                switch argument {
                case .value(let value):
                    return try jsValue(for: .value(value), in: context)
                case .binary(let data):
                    return try jsValue(for: .binary(data), in: context)
                }
            }

            let result = function.call(withArguments: jsArguments)
            if let lastExceptionMessage {
                throw JSEngineError.javaScriptException(lastExceptionMessage)
            }
            return result
        }
    }

    @discardableResult
    public func evaluateBundle(at url: URL) throws -> JSValue? {
        let source = try EngineBundle.load(from: url)
        return try evaluate(source, filename: url.lastPathComponent)
    }

    public func data(from value: JSValue?) throws -> Data? {
        try performSync {
            guard let value else {
                return nil
            }

            var exception: JSValueRef?
            let contextRef = context.jsGlobalContextRef
            let valueRef = value.jsValueRef
            let type = JSValueGetTypedArrayType(contextRef, valueRef, &exception)

            if let exception {
                throw JSEngineError.typedArrayConversionFailed(
                    JSValue(
                        jsValueRef: exception,
                        in: context
                    ).toString() ?? "Typed array inspection failed."
                )
            }

            guard let objectRef = JSValueToObject(contextRef, valueRef, nil) else {
                throw JSEngineError.unsupportedBinaryValue
            }

            switch type {
            case kJSTypedArrayTypeArrayBuffer:
                let length = JSObjectGetArrayBufferByteLength(contextRef, objectRef, &exception)
                guard let bytes = JSObjectGetArrayBufferBytesPtr(contextRef, objectRef, &exception) else {
                    throw JSEngineError.unsupportedBinaryValue
                }
                if let exception {
                    throw JSEngineError.typedArrayConversionFailed(
                        JSValue(jsValueRef: exception, in: context).toString() ?? "Failed to read ArrayBuffer bytes."
                    )
                }
                return Data(bytes: bytes, count: length)
            case kJSTypedArrayTypeNone:
                throw JSEngineError.unsupportedBinaryValue
            default:
                let length = JSObjectGetTypedArrayByteLength(contextRef, objectRef, &exception)
                guard let bytes = JSObjectGetTypedArrayBytesPtr(contextRef, objectRef, &exception) else {
                    throw JSEngineError.unsupportedBinaryValue
                }
                if let exception {
                    throw JSEngineError.typedArrayConversionFailed(
                        JSValue(jsValueRef: exception, in: context).toString() ?? "Failed to read TypedArray bytes."
                    )
                }
                return Data(bytes: bytes, count: length)
            }
        }
    }

    private func convertFunctionResult(_ result: JSFunctionResult, in context: JSContext) throws -> Any? {
        switch result {
        case .undefined:
            return JSValue(undefinedIn: context)
        case .value(let value):
            if value == nil {
                return JSValue(nullIn: context)
            }
            if let jsValue = value as? JSValue {
                return jsValue
            }
            return value
        case .binary(let data):
            return try makeArrayBuffer(from: data, in: context)
        }
    }

    private func jsValue(for result: JSFunctionResult, in context: JSContext) throws -> JSValue {
        switch result {
        case .undefined:
            return JSValue(undefinedIn: context)
        case .value(let value):
            if value == nil {
                return JSValue(nullIn: context)
            }
            if let jsValue = value as? JSValue {
                return jsValue
            }
            return JSValue(object: value, in: context)
        case .binary(let data):
            return try makeArrayBuffer(from: data, in: context)
        }
    }

    private func makeArrayBuffer(from data: Data, in context: JSContext) throws -> JSValue {
        let count = data.count
        let bytes = UnsafeMutableRawPointer.allocate(
            byteCount: max(count, 1),
            alignment: MemoryLayout<UInt8>.alignment
        )

        if count > 0 {
            data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: count)
        }

        var exception: JSValueRef?
        guard let objectRef = JSObjectMakeArrayBufferWithBytesNoCopy(
            context.jsGlobalContextRef,
            bytes,
            count,
            releaseJSBuffer,
            nil,
            &exception
        ) else {
            bytes.deallocate()
            if let exception {
                throw JSEngineError.typedArrayConversionFailed(
                    JSValue(jsValueRef: exception, in: context).toString() ?? "Failed to create ArrayBuffer."
                )
            }
            throw JSEngineError.typedArrayConversionFailed("Failed to create ArrayBuffer.")
        }

        return JSValue(jsValueRef: objectRef, in: context)
    }

    private func performSync<T>(_ work: () throws -> T) throws -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            return try work()
        }

        return try jsQueue.sync(execute: work)
    }

    private func performSyncWithoutThrowing(_ work: @escaping () -> Void) {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            work()
            return
        }

        jsQueue.sync(execute: work)
    }
}
