import Foundation

public final class NativeEventSink {
    public var onStateUpdate: (@Sendable (String) -> Void)?
    public var onError: (@Sendable (String) -> Void)?

    public private(set) var stateUpdates: [String] = []
    public private(set) var errors: [String] = []

    public init(
        onStateUpdate: (@Sendable (String) -> Void)? = nil,
        onError: (@Sendable (String) -> Void)? = nil
    ) {
        self.onStateUpdate = onStateUpdate
        self.onError = onError
    }

    func recordStateUpdate(_ payload: String) {
        stateUpdates.append(payload)
        onStateUpdate?(payload)
    }

    func recordError(_ payload: String) {
        errors.append(payload)
        onError?(payload)
    }
}
