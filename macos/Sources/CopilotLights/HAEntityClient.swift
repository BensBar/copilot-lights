import Foundation

/// Calls Home Assistant's REST API directly from the Settings UI to populate
/// the entity picker. Stays out of the daemon to avoid a round-trip and
/// because the UI already has the token (resolved from Keychain).
struct HAEntity: Identifiable, Hashable {
    let entityId: String
    let friendlyName: String?
    var id: String { entityId }
    var displayName: String { friendlyName ?? entityId }
}

@MainActor
final class HAEntityClient {
    enum HAError: Error, LocalizedError {
        case invalidUrl
        case http(Int, String)
        case decode(String)
        case transport(String)
        case unauthorized

        var errorDescription: String? {
            switch self {
            case .invalidUrl: return "Invalid base URL"
            case .http(let code, let body): return "HTTP \(code): \(body.prefix(200))"
            case .decode(let m): return "Decode error: \(m)"
            case .transport(let m): return "Network error: \(m)"
            case .unauthorized: return "Unauthorized — check your token"
            }
        }
    }

    /// GET `<baseUrl>/api/states` and filter to `light.*`. Sorted by friendly
    /// name (case-insensitive) for stable UI.
    func listLightEntities(baseUrl: String, token: String) async throws -> [HAEntity] {
        let trimmed = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let url = URL(string: trimmed + "/api/states") else { throw HAError.invalidUrl }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 6

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw HAError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw HAError.transport("Non-HTTP response")
        }
        if http.statusCode == 401 { throw HAError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw HAError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        guard let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw HAError.decode("expected array of states")
        }
        var entities: [HAEntity] = []
        for s in arr {
            guard let eid = s["entity_id"] as? String, eid.hasPrefix("light.") else { continue }
            let attrs = s["attributes"] as? [String: Any]
            let friendly = attrs?["friendly_name"] as? String
            entities.append(HAEntity(entityId: eid, friendlyName: friendly))
        }
        entities.sort { lhs, rhs in
            lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
        }
        return entities
    }

    /// Hits `<baseUrl>/api/` to verify the token works. Returns nil on success,
    /// or a human-readable error message.
    func testConnection(baseUrl: String, token: String) async -> String? {
        let trimmed = baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let url = URL(string: trimmed + "/api/") else { return "Invalid base URL" }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return "Non-HTTP response" }
            if http.statusCode == 401 { return "Unauthorized — check your token" }
            if !(200..<300).contains(http.statusCode) { return "HTTP \(http.statusCode)" }
            return nil
        } catch {
            return "Network error: \(error.localizedDescription)"
        }
    }
}
