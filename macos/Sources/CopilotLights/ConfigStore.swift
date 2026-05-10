import Foundation
import Combine
import Network

/// Reads, mutates, and writes ~/.copilot-lights/config.json. Hot-reloads the
/// daemon over the Unix socket after every save (best-effort; ignores errors
/// because the daemon may not be running).
@MainActor
final class ConfigStore: ObservableObject {
    @Published private(set) var doc: CopilotLightsConfigDoc = .empty()
    @Published private(set) var lastError: String?
    @Published private(set) var lastReloadResult: String?

    let path: URL

    init(path: URL? = nil) {
        self.path = path ?? ConfigStore.defaultPath()
        load()
    }

    nonisolated static func defaultPath() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".copilot-lights/config.json")
    }

    func load() {
        do {
            let data: Data
            if FileManager.default.fileExists(atPath: path.path) {
                data = try Data(contentsOf: path)
            } else {
                data = Data("{}".utf8)
            }
            // Tolerate missing keys by merging into a default doc.
            let dec = JSONDecoder()
            let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            let merged = mergedDocDictionary(raw)
            let mergedData = try JSONSerialization.data(withJSONObject: merged)
            doc = try dec.decode(CopilotLightsConfigDoc.self, from: mergedData)
            lastError = nil
        } catch {
            lastError = "Failed to load config: \(error.localizedDescription)"
        }
    }

    func save() {
        do {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try enc.encode(doc)
            try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: path, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            lastError = nil
            Task { await reloadDaemon() }
        } catch {
            lastError = "Failed to save config: \(error.localizedDescription)"
        }
    }

    /// Sends `{kind:"reload"}` over the socket and stores the daemon's reply
    /// in `lastReloadResult` so the UI can surface adapter restart errors.
    func reloadDaemon(socketPath: String = SocketPath.resolve()) async {
        let line = "{\"kind\":\"reload\"}\n"
        let reply = await sendOneShot(line: line, socketPath: socketPath, timeoutMs: 1500)
        await MainActor.run {
            self.lastReloadResult = reply ?? "(no reply — daemon offline?)"
        }
    }

    /// Sends `{kind:"follow", sessionId: <id|null>}` to the daemon. Pass
    /// `nil` to clear (aggregate all sessions).
    func setFollowedSession(_ sessionId: String?, socketPath: String = SocketPath.resolve()) async {
        let payload: String
        if let id = sessionId {
            // Conservative escape — session ids are UUIDs in practice but
            // belt-and-suspenders this in case that ever changes.
            let safe = id.replacingOccurrences(of: "\\", with: "\\\\")
                         .replacingOccurrences(of: "\"", with: "\\\"")
            payload = "{\"kind\":\"follow\",\"sessionId\":\"\(safe)\"}\n"
        } else {
            payload = "{\"kind\":\"follow\",\"sessionId\":null}\n"
        }
        _ = await sendOneShot(line: payload, socketPath: socketPath, timeoutMs: 1500)
    }

    private func sendOneShot(line: String, socketPath: String, timeoutMs: UInt64) async -> String? {
        let conn = NWConnection(to: .unix(path: socketPath), using: .tcp)
        return await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            var done = false
            func finish(_ value: String?) {
                if !done { done = true; cont.resume(returning: value); conn.cancel() }
            }
            conn.stateUpdateHandler = { state in
                if case .failed = state { finish(nil) }
                if case .ready = state {
                    conn.send(content: Data(line.utf8), completion: .contentProcessed { err in
                        if err != nil { finish(nil); return }
                        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                            if let d = data, let s = String(data: d, encoding: .utf8) {
                                finish(s.trimmingCharacters(in: .whitespacesAndNewlines))
                            } else {
                                finish(nil)
                            }
                        }
                    })
                }
            }
            conn.start(queue: .global())
            Task {
                try? await Task.sleep(for: .milliseconds(timeoutMs))
                finish(nil)
            }
        }
    }

    // MARK: Mutation helpers

    func setAdapter(_ a: AdapterKind) {
        doc.adapter = a
    }

    func setHomeAssistant(baseUrl: String, tokenPlain: String?, entities: [String]) {
        // If user provided a fresh plaintext token, stash it in Keychain and
        // store `keychain:HASS_TOKEN` in the config file.
        var tokenRef = doc.homeAssistant?.token ?? "keychain:HASS_TOKEN"
        if let t = tokenPlain, !t.isEmpty {
            do {
                try KeychainHelper.write(account: "HASS_TOKEN", value: t)
                tokenRef = "keychain:HASS_TOKEN"
            } catch {
                lastError = "Failed to store token: \(error.localizedDescription)"
            }
        }
        doc.homeAssistant = HomeAssistantConfig(baseUrl: baseUrl, token: tokenRef, entities: entities)
    }

    func setStateStyle(_ name: String, _ style: StateStyle) {
        doc.states[name] = style
    }

    /// Resolves a stored token reference (`keychain:NAME`, `env:NAME`, or
    /// inline) back to the underlying secret. Used for direct HA calls from
    /// the UI (entity picker / test connection) without going through the
    /// daemon. Returns nil when unavailable.
    func resolveToken(_ ref: String) -> String? {
        if ref.hasPrefix("keychain:") {
            let acct = String(ref.dropFirst("keychain:".count))
            return (try? KeychainHelper.read(account: acct)) ?? nil
        }
        if ref.hasPrefix("env:") {
            return ProcessInfo.processInfo.environment[String(ref.dropFirst("env:".count))]
        }
        return ref
    }
}

/// Merge raw config dict over defaults so missing keys don't blow up Codable
/// decoding. Cheap, since the doc is tiny.
private func mergedDocDictionary(_ raw: [String: Any]) -> [String: Any] {
    var out: [String: Any] = [
        "adapter": "mock",
        "states": [:] as [String: Any],
        "transitionMs": 600,
        "restoreOnExit": true,
        "errorTtlMs": 4000,
        "doneTtlMs": 1500,
    ]
    for (k, v) in raw { out[k] = v }
    return out
}
