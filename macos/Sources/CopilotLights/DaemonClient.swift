import Foundation
import Network
import Combine

enum PollResult: Equatable {
    case offline
    case ok(StatusReply)
    case error(String)
    
    static func == (lhs: PollResult, rhs: PollResult) -> Bool {
        switch (lhs, rhs) {
        case (.offline, .offline):
            return true
        case let (.ok(lStatus), .ok(rStatus)):
            return lStatus.state == rStatus.state && lStatus.sessions == rStatus.sessions
        case let (.error(lMsg), .error(rMsg)):
            return lMsg == rMsg
        default:
            return false
        }
    }
}

actor DaemonClient {
    @Published private(set) var status: PollResult = .offline
    
    private var pollTask: Task<Void, Never>?
    private let socketPath: String
    /// Backoff between reconnect attempts after the subscribe connection
    /// closes. (Named `pollIntervalMs` for source/init compatibility with
    /// the previous polling client.)
    private let pollIntervalMs: UInt64
    /// Guard for how long we wait for the connection to reach `.ready`
    /// before treating the attempt as a failure and reconnecting.
    private let timeoutMs: UInt64

    /// How many consecutive failed connection attempts we tolerate before
    /// actually surfacing an offline/error state to the UI. A single
    /// transient socket close (e.g. the daemon briefly stalling under
    /// heavy agent load) reconnects within `pollIntervalMs` and delivers a
    /// fresh snapshot frame, so without this hysteresis it would flip the
    /// widget to gray and back, producing visible flicker.
    private let failureTolerance: Int
    private var consecutiveFailures = 0
    private var lastGood: PollResult = .offline

    var statusPublisher: Published<PollResult>.Publisher { $status }

    init(socketPath: String = SocketPath.resolve(), pollIntervalMs: UInt64 = 250, timeoutMs: UInt64 = 600, failureTolerance: Int = 3) {
        self.socketPath = socketPath
        self.pollIntervalMs = pollIntervalMs
        self.timeoutMs = timeoutMs
        self.failureTolerance = failureTolerance
    }
    
    func start() {
        pollTask?.cancel()
        pollTask = Task { await self.runSubscription() }
    }
    
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Maintain a single long-lived subscribe connection. While it is open
    /// the daemon pushes a full status frame on every transition, which we
    /// publish immediately. When the connection closes we apply the
    /// failure hysteresis and reconnect after a short backoff, so a
    /// transient blip never reaches the UI but a truly-down daemon
    /// eventually surfaces offline.
    private func runSubscription() async {
        while !Task.isCancelled {
            for await result in openSubscription() {
                applyResult(result)
            }
            if Task.isCancelled { break }
            try? await Task.sleep(for: .milliseconds(pollIntervalMs))
        }
    }

    /// Publish a single stream element, running it through the shared
    /// hysteresis so a live frame resets the failure streak and a terminal
    /// close only surfaces offline after `failureTolerance` failed
    /// reconnects.
    private func applyResult(_ result: PollResult) {
        let resolved = DaemonClient.resolveStatus(
            result: result,
            lastGood: lastGood,
            consecutiveFailures: consecutiveFailures,
            failureTolerance: failureTolerance
        )
        consecutiveFailures = resolved.consecutiveFailures
        lastGood = resolved.lastGood
        status = resolved.status
    }

    /// Pure hysteresis decision, factored out so it can be unit tested
    /// without real socket I/O. Given the latest poll `result` and the
    /// prior `lastGood` / `consecutiveFailures`, returns what the widget
    /// should display plus the updated bookkeeping.
    nonisolated static func resolveStatus(
        result: PollResult,
        lastGood: PollResult,
        consecutiveFailures: Int,
        failureTolerance: Int
    ) -> (status: PollResult, lastGood: PollResult, consecutiveFailures: Int) {
        switch result {
        case .ok:
            return (result, result, 0)
        case .offline, .error:
            let failures = consecutiveFailures + 1
            if failures >= failureTolerance {
                return (result, lastGood, failures)
            }
            return (lastGood, lastGood, failures)
        }
    }
    
    /// Pure helper: given an accumulated byte buffer, return the first
    /// complete newline-terminated line as a String, or nil if the buffer
    /// does not yet contain a newline. Factored out so the multi-segment
    /// reassembly can be unit tested without a live socket.
    nonisolated static func firstCompleteLine(in data: Data) -> String? {
        guard let newlineIndex = data.firstIndex(of: 0x0A) else { return nil }
        let lineData = data[data.startIndex..<newlineIndex]
        return String(data: lineData, encoding: .utf8)
    }

    /// Pure helper: split an accumulated buffer into every complete
    /// newline-terminated line plus the leftover partial remainder. A
    /// subscribe connection delivers many frames over its lifetime, and a
    /// single read can carry several complete frames and/or a partial
    /// trailing frame, so the streaming client must drain them all and
    /// retain the remainder for the next read. Factored out so this can be
    /// unit tested without a live socket.
    nonisolated static func splitCompleteLines(in data: Data) -> (lines: [String], remainder: Data) {
        var lines: [String] = []
        var lineStart = data.startIndex
        var index = data.startIndex
        while index < data.endIndex {
            if data[index] == 0x0A {
                let lineData = data[lineStart..<index]
                if let line = String(data: lineData, encoding: .utf8) {
                    lines.append(line)
                }
                lineStart = data.index(after: index)
            }
            index = data.index(after: index)
        }
        return (lines, Data(data[lineStart..<data.endIndex]))
    }

    private func openSubscription() -> AsyncStream<PollResult> {
        let socketPath = self.socketPath
        let timeoutMs = self.timeoutMs

        return AsyncStream { continuation in
            let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
            let buffer = LineBuffer()
            // Ensures we yield exactly one terminal element and finish the
            // stream once, no matter which handler (state / receive) races
            // to observe the close first.
            let finished = ResumedFlag()

            @Sendable func finish(_ terminal: PollResult) {
                if finished.claim() {
                    continuation.yield(terminal)
                    continuation.finish()
                    connection.cancel()
                }
            }

            // Drain and publish every complete newline-terminated frame the
            // daemon has pushed. A subscribe connection delivers many frames
            // over its lifetime (one per state transition), and multiple
            // frames — or a partial trailing frame — can arrive in a single
            // read, so we split on every newline rather than just the first.
            @Sendable func drainFrames() {
                for line in buffer.takeAllCompleteLines() {
                    guard let jsonData = line.data(using: .utf8),
                          let reply = try? JSONDecoder().decode(StatusReply.self, from: jsonData) else {
                        // Ignore unparseable/blank lines; a genuinely partial
                        // frame stays buffered until its newline arrives.
                        continue
                    }
                    continuation.yield(.ok(reply))
                }
            }

            @Sendable func receiveLoop() {
                connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                    if let error = error {
                        finish(.error(error.localizedDescription))
                        return
                    }

                    if let data = data, !data.isEmpty {
                        buffer.append(data)
                        drainFrames()
                    }

                    if isComplete {
                        // Peer closed the connection — treat as a transient
                        // offline; the reconnect loop will re-establish it.
                        finish(.offline)
                        return
                    }

                    receiveLoop()
                }
            }

            func sendSubscribe() {
                guard let jsonData = try? JSONEncoder().encode(SubscribeQuery()),
                      let jsonString = String(data: jsonData, encoding: .utf8) else {
                    finish(.error("encoding failed"))
                    return
                }

                let message = (jsonString + "\n").data(using: .utf8)!
                connection.send(content: message, completion: .contentProcessed { error in
                    if let error = error {
                        finish(.error(error.localizedDescription))
                        return
                    }
                    receiveLoop()
                })
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    sendSubscribe()
                case .failed(let error):
                    if case .posix(let code) = error, code == .ENOENT || code == .ECONNREFUSED {
                        finish(.offline)
                    } else {
                        finish(.error(error.localizedDescription))
                    }
                case .cancelled:
                    finish(.offline)
                default:
                    break
                }
            }

            // Guard against a connection that never reaches `.ready` (e.g. the
            // socket file exists but nothing is accepting). Give it a bounded
            // window, then treat the attempt as offline so the reconnect loop
            // can retry.
            let readyDeadline = DispatchTime.now() + .milliseconds(Int(timeoutMs))
            DispatchQueue.global().asyncAfter(deadline: readyDeadline) {
                if connection.state != .ready {
                    finish(.offline)
                }
            }

            continuation.onTermination = { _ in
                connection.cancel()
            }

            connection.start(queue: .global())
        }
    }
}

/// Thread-safe single-shot flag. The NWConnection handlers and the
/// follow-up Task in `queryDaemon` race to resume the continuation
/// exactly once; this wraps the "did anyone resume yet?" bit in a lock
/// so the capture is safe under strict concurrency.
private final class ResumedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    /// Atomically attempt to be the first caller. Returns true exactly
    /// once across all callers; subsequent calls return false.
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if value { return false }
        value = true
        return true
    }

    /// Non-mutating read — useful for fast-path bail-outs before doing
    /// expensive work. Not a substitute for `claim()` when actually
    /// resuming the continuation.
    var isClaimed: Bool {
        lock.lock(); defer { lock.unlock() }
        return value
    }
}

/// Thread-safe accumulator for bytes received across multiple NWConnection
/// `receive` callbacks. The status reply can span several TCP segments, so
/// we append each chunk and check whether a complete newline-terminated
/// line has arrived yet.
private final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        data.append(chunk)
    }

    /// Removes and returns all complete newline-terminated lines, dropping
    /// them (and their newlines) from the buffer while retaining any
    /// partial trailing frame. Used by the subscribe stream to drain every
    /// pushed frame that has arrived so far.
    func takeAllCompleteLines() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let (lines, remainder) = DaemonClient.splitCompleteLines(in: data)
        data = remainder
        return lines
    }
}
