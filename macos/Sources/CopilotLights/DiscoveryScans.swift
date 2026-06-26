import Foundation

/// Reply to `{kind:"query", query:"hueScan"}`. The daemon talks to the paired
/// Hue bridge (it owns the application key) and returns the available lights so
/// the Settings UI can present a pick / blink / save flow.
struct HueScanReply: Codable, Equatable {
    let kind: String
    let lights: [HueScanLight]
    /// Present only when discovery failed (e.g. bridge unconfigured).
    let error: String?
}

struct HueScanLight: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    /// Optional archetype hint (e.g. "table_shade") — purely cosmetic.
    let archetype: String?
}

/// Reply to `{kind:"query", query:"haScan"}`. The daemon lists Home Assistant
/// `light.*` entities via its configured base URL + token.
struct HAScanReply: Codable, Equatable {
    let kind: String
    let lights: [HAScanLight]
    let error: String?
}

struct HAScanLight: Codable, Equatable, Identifiable {
    let entityId: String
    let name: String
    var id: String { entityId }
}

/// Reply to `{kind:"identify", ...}` — a request to make one specific light
/// visibly blink so the user can physically locate it.
struct IdentifyReply: Codable, Equatable {
    let kind: String
    let ok: Bool
    let error: String?
}
