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
    private let pollIntervalMs: UInt64
    private let timeoutMs: UInt64

    /// How many consecutive failed polls we tolerate before actually
    /// surfacing an offline/error state to the UI. Under heavy agent
    /// load the daemon's single-threaded loop can occasionally miss the
    /// poll budget; without this hysteresis a single slow reply would
    /// flip the widget to gray and back, producing visible flicker.
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
        pollTask = Task {
            while !Task.isCancelled {
                await poll()
                try? await Task.sleep(for: .milliseconds(pollIntervalMs))
            }
        }
    }
    
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }
    
    private func poll() async {
        let result = await withTaskGroup(of: PollResult.self) { group -> PollResult in
            group.addTask {
                await self.queryDaemon()
            }
            
            group.addTask {
                try? await Task.sleep(for: .milliseconds(self.timeoutMs))
                return .error("timeout")
            }
            
            guard let firstResult = await group.next() else {
                return .error("no result")
            }
            
            group.cancelAll()
            return firstResult
        }
        
        // Hysteresis: a successful poll clears the failure streak and is
        // published immediately. A failure only surfaces to the UI once
        // we've missed `failureTolerance` polls in a row; until then we
        // keep showing the last good status so a single slow reply under
        // load doesn't flicker the widget to gray.
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

    private func queryDaemon() async -> PollResult {
        let connection = NWConnection(to: .unix(path: socketPath), using: .tcp)
        
        return await withCheckedContinuation { continuation in
            // `resumed` is read and written from multiple concurrent
            // closures (NWConnection's state/receive/send handlers run
            // on internal queues; the Task ran below runs separately).
            // Wrap it in a tiny thread-safe holder so Swift's strict-
            // concurrency checker accepts the capture — a plain `var`
            // shared across nonisolated closures is rejected.
            let resumed = ResumedFlag()

            // Send the status query as soon as the socket is ready and
            // wire up the receive. Previously this was fired after a blind
            // 50ms sleep, which burned a quarter of the poll budget for no
            // reason; sending on `.ready` reclaims that time.
            func sendQuery() {
                let query = StatusQuery()
                guard let jsonData = try? JSONEncoder().encode(query),
                      let jsonString = String(data: jsonData, encoding: .utf8) else {
                    if resumed.claim() {
                        continuation.resume(returning: .error("encoding failed"))
                        connection.cancel()
                    }
                    return
                }

                let message = (jsonString + "\n").data(using: .utf8)!

                connection.send(content: message, completion: .contentProcessed { error in
                    if let error = error {
                        if resumed.claim() {
                            continuation.resume(returning: .error(error.localizedDescription))
                            connection.cancel()
                        }
                        return
                    }

                    // The status payload grows with the number of active
                    // sessions and now routinely exceeds 2 KB, so it can be
                    // split across multiple TCP segments. A single receive
                    // with minimumIncompleteLength: 1 frequently returns only
                    // a fragment; parsing that fragment fails and — under
                    // steady load where every payload fragments the same way —
                    // exhausts the failure hysteresis and flips the widget to
                    // gray. Accumulate chunks until we have a complete
                    // newline-terminated line before parsing.
                    let buffer = LineBuffer()

                    func receiveLoop() {
                        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                            if let error = error {
                                if resumed.claim() {
                                    continuation.resume(returning: .error(error.localizedDescription))
                                    connection.cancel()
                                }
                                return
                            }

                            if let data = data, !data.isEmpty {
                                buffer.append(data)
                            }

                            if let line = buffer.firstCompleteLine() {
                                if resumed.claim() {
                                    if let jsonData = line.data(using: .utf8),
                                       let statusReply = try? JSONDecoder().decode(StatusReply.self, from: jsonData) {
                                        continuation.resume(returning: .ok(statusReply))
                                    } else {
                                        continuation.resume(returning: .error("parse failed"))
                                    }
                                    connection.cancel()
                                }
                                return
                            }

                            if isComplete {
                                if resumed.claim() {
                                    continuation.resume(returning: .error("incomplete response"))
                                    connection.cancel()
                                }
                                return
                            }

                            // No complete line yet and the peer hasn't closed;
                            // keep reading until the newline arrives.
                            receiveLoop()
                        }
                    }

                    receiveLoop()
                })
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    sendQuery()
                case .failed(let error):
                    if resumed.claim() {
                        if case .posix(let code) = error, code == .ENOENT || code == .ECONNREFUSED {
                            continuation.resume(returning: .offline)
                        } else {
                            continuation.resume(returning: .error(error.localizedDescription))
                        }
                        connection.cancel()
                    }
                case .cancelled:
                    if resumed.claim() {
                        continuation.resume(returning: .offline)
                    }
                default:
                    break
                }
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

    /// Returns the first newline-terminated line accumulated so far, or
    /// nil if no complete line has arrived yet.
    func firstCompleteLine() -> String? {
        lock.lock(); defer { lock.unlock() }
        return DaemonClient.firstCompleteLine(in: data)
    }
}
