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
    
    var statusPublisher: Published<PollResult>.Publisher { $status }
    
    init(socketPath: String = SocketPath.resolve(), pollIntervalMs: UInt64 = 250, timeoutMs: UInt64 = 200) {
        self.socketPath = socketPath
        self.pollIntervalMs = pollIntervalMs
        self.timeoutMs = timeoutMs
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
        
        status = result
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
            
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    break
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
            
            Task {
                try? await Task.sleep(for: .milliseconds(50))
                
                guard !resumed.isClaimed else { return }
                
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
                    
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                        defer {
                            connection.cancel()
                        }
                        
                        if resumed.claim() {
                            if let error = error {
                                continuation.resume(returning: .error(error.localizedDescription))
                                return
                            }
                            
                            guard let data = data, let response = String(data: data, encoding: .utf8) else {
                                continuation.resume(returning: .error("no data"))
                                return
                            }
                            
                            let lines = response.split(separator: "\n", omittingEmptySubsequences: true)
                            guard let firstLine = lines.first else {
                                continuation.resume(returning: .error("empty response"))
                                return
                            }
                            
                            guard let jsonData = String(firstLine).data(using: .utf8),
                                  let statusReply = try? JSONDecoder().decode(StatusReply.self, from: jsonData) else {
                                continuation.resume(returning: .error("parse failed"))
                                return
                            }
                            
                            continuation.resume(returning: .ok(statusReply))
                        }
                    }
                })
            }
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
