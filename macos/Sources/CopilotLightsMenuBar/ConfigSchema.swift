import Foundation

/// Codable mirror of `~/.copilot-lights/config.json` (keep keys aligned with
/// the zod schema in src/config/schema.ts). Unknown fields are tolerated by
/// JSONDecoder by default; we only declare what the UI edits.
struct CopilotLightsConfigDoc: Codable, Equatable {
    var adapter: AdapterKind
    var homeAssistant: HomeAssistantConfig?
    var hue: HueConfig?
    /// Keyed by state name: ready / thinking / awaiting_input / error / done.
    /// We keep this as an ordered, well-known dictionary in the model layer.
    var states: [String: StateStyle]
    var transitionMs: Int
    var restoreOnExit: Bool
    var errorTtlMs: Int
    var doneTtlMs: Int
    var socketPath: String?
    var http: HttpConfig?

    static let stateOrder: [String] = ["ready", "thinking", "awaiting_input", "error", "done"]

    static func empty() -> CopilotLightsConfigDoc {
        CopilotLightsConfigDoc(
            adapter: .mock,
            homeAssistant: nil,
            hue: nil,
            states: [:],
            transitionMs: 600,
            restoreOnExit: true,
            errorTtlMs: 4000,
            doneTtlMs: 1500,
            socketPath: nil,
            http: nil
        )
    }
}

enum AdapterKind: String, Codable, CaseIterable, Identifiable {
    case homeAssistant = "home-assistant"
    case hue
    case govee
    case mock

    var id: String { rawValue }
    var label: String {
        switch self {
        case .homeAssistant: return "Home Assistant"
        case .hue: return "Philips Hue"
        case .govee: return "Govee (LAN)"
        case .mock: return "Mock (no lights)"
        }
    }
}

struct HomeAssistantConfig: Codable, Equatable {
    var baseUrl: String
    /// Stored on disk as either `env:NAME`, `keychain:NAME`, or an inline
    /// string. The Settings UI rewrites this to `keychain:HASS_TOKEN` when the
    /// user enters a fresh value.
    var token: String
    var entities: [String]
}

struct HueConfig: Codable, Equatable {
    var bridgeIp: String
    var applicationKey: String
    var lightIds: [String]
}

struct StateStyle: Codable, Equatable {
    var color: String
    var brightness: Int
    var effect: String
    var periodMs: Int?
    var count: Int?
    var ttlMs: Int?

    static let defaults: [String: StateStyle] = [
        "ready":          StateStyle(color: "#4ade80", brightness: 30, effect: "steady"),
        "thinking":       StateStyle(color: "#60a5fa", brightness: 55, effect: "steady"),
        "awaiting_input": StateStyle(color: "#fb923c", brightness: 75, effect: "steady"),
        "error":          StateStyle(color: "#ef4444", brightness: 85, effect: "flash",   count: 2, ttlMs: 4000),
        "done":           StateStyle(color: "#a3e635", brightness: 70, effect: "steady"),
    ]

    static func defaultFor(_ state: String) -> StateStyle {
        defaults[state] ?? StateStyle(color: "#888888", brightness: 50, effect: "steady")
    }
}

extension RGBColor {
    /// Parses "#rrggbb" / "rrggbb" / "#rgb" into an RGBColor. Returns nil on
    /// malformed input. Used by the menu-bar UI to derive the icon color from
    /// the *resolved state name* (rather than the daemon's mid-tween frame),
    /// so the displayed word and color always agree.
    static func fromHex(_ hex: String) -> RGBColor? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        return RGBColor(r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff)
    }
}

extension CopilotLightsConfigDoc {
    /// Returns the configured StateStyle for the given state name (or the
    /// built-in default). Used by menu-bar/floating-window code so the on-screen
    /// color matches the displayed state word, regardless of the daemon's
    /// tween-in-progress.
    func style(for state: String) -> StateStyle {
        states[state] ?? StateStyle.defaultFor(state)
    }
}

struct HttpConfig: Codable, Equatable {
    var port: Int
    var token: String?
}
