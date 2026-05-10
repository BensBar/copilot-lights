import Foundation
import Network

/// One-shot Unix-socket sender used by Settings panes. Mirrors the
/// fire-and-forget style of the existing hook bridge: connect, send a single
/// line, optionally read one reply, close.
enum SocketSend {
    /// Fire a single line to the daemon socket; ignore any reply. Returns
    /// true on send success. Best-effort.
    static func fireAndForget(line: String, socketPath: String, timeoutMs: UInt64 = 250) async -> Bool {
        let conn = NWConnection(to: .unix(path: socketPath), using: .tcp)
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            var done = false
            func finish(_ ok: Bool) {
                if !done { done = true; cont.resume(returning: ok); conn.cancel() }
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    conn.send(content: Data(line.utf8), completion: .contentProcessed { err in
                        finish(err == nil)
                    })
                case .failed:
                    finish(false)
                default: break
                }
            }
            conn.start(queue: .global())
            Task {
                try? await Task.sleep(for: .milliseconds(timeoutMs))
                finish(false)
            }
        }
    }
}
