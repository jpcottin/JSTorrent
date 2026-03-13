import Foundation
import JavaScriptCore

final class TimerRegistry {
    private final class TimerEntry {
        let callback: JSManagedValue
        let repeats: Bool
        let source: DispatchSourceTimer

        init(callback: JSManagedValue, repeats: Bool, source: DispatchSourceTimer) {
            self.callback = callback
            self.repeats = repeats
            self.source = source
        }
    }

    private let engine: JSEngine
    private let timerQueue = DispatchQueue(label: "com.jstorrent.ios.timers")
    private var nextTimerID = 1
    private var timers: [Int: TimerEntry] = [:]
    private let lock = NSLock()

    init(engine: JSEngine) {
        self.engine = engine
    }

    func setTimeout(callback: JSValue, delayMilliseconds: Int) -> Int {
        createTimer(callback: callback, delayMilliseconds: delayMilliseconds, repeats: false)
    }

    func setInterval(callback: JSValue, intervalMilliseconds: Int) -> Int {
        createTimer(callback: callback, delayMilliseconds: intervalMilliseconds, repeats: true)
    }

    func clearTimer(_ id: Int) {
        let entry = removeEntry(for: id)
        entry?.source.cancel()
    }

    private func createTimer(callback: JSValue, delayMilliseconds: Int, repeats: Bool) -> Int {
        let timerID = allocateTimerID()
        let interval = DispatchTimeInterval.milliseconds(max(delayMilliseconds, 0))
        guard let managedValue = JSManagedValue(value: callback) else {
            return timerID
        }
        engine.virtualMachine.addManagedReference(managedValue, withOwner: self)

        let source = DispatchSource.makeTimerSource(queue: timerQueue)
        if repeats {
            source.schedule(deadline: .now() + interval, repeating: interval)
        } else {
            source.schedule(deadline: .now() + interval, repeating: .never)
        }

        source.setEventHandler { [weak self] in
            guard let self else {
                return
            }

            self.engine.jsQueue.async {
                guard let value = managedValue.value else {
                    if !repeats {
                        self.clearTimer(timerID)
                    }
                    return
                }

                value.call(withArguments: [])
                if !repeats {
                    self.clearTimer(timerID)
                }
            }
        }

        let entry = TimerEntry(callback: managedValue, repeats: repeats, source: source)
        lock.lock()
        timers[timerID] = entry
        lock.unlock()

        source.resume()
        return timerID
    }

    private func allocateTimerID() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let id = nextTimerID
        nextTimerID += 1
        return id
    }

    private func removeEntry(for id: Int) -> TimerEntry? {
        lock.lock()
        let entry = timers.removeValue(forKey: id)
        lock.unlock()

        if let entry {
            engine.virtualMachine.removeManagedReference(entry.callback, withOwner: self)
        }

        return entry
    }
}
