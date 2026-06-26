import Foundation

/// Codable mirror of `~/.copilot-lights/config.json` (keep keys aligned with
/// the zod schema in src/config/schema.ts). Unknown fields are tolerated by
/// JSONDecoder by default; we only declare what the UI edits.
struct CopilotLightsConfigDoc: Codable, Equatable {
    var adapter: AdapterKind
    /// Optional multi-backend selection. When present and non-empty the daemon
    /// drives ALL listed adapters at once (composite) and this wins over
    /// `adapter`. `adapter` is kept for back-compat / single-backend fallback.
    var adapters: [AdapterKind]?
    var homeAssistant: HomeAssistantConfig?
    var hue: HueConfig?
    var govee: GoveeConfig?
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
            adapters: nil,
            homeAssistant: nil,
            hue: nil,
            govee: nil,
            states: [:],
            transitionMs: 600,
            restoreOnExit: true,
            errorTtlMs: 4000,
            doneTtlMs: 1500,
            socketPath: nil,
            http: nil
        )
    }

    /// The set of backends currently enabled, derived from `adapters` (multi)
    /// falling back to the single `adapter`. Mock is dropped when any real
    /// backend is enabled, mirroring the daemon's `activeAdapterKinds`.
    var enabledAdapters: [AdapterKind] {
        let raw = (adapters?.isEmpty == false) ? adapters! : [adapter]
        var seen = Set<AdapterKind>()
        let unique = raw.filter { seen.insert($0).inserted }
        let real = unique.filter { $0 != .mock }
        return real.isEmpty ? [.mock] : real
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

/// Mirrors `GoveeConfigSchema` in src/config/schema.ts. We model every field
/// (not just `devices`) so that saving from the Settings UI never drops a
/// user's hand-tuned timing values.
struct GoveeConfig: Codable, Equatable {
    var devices: [GoveeDeviceConfig]
    var discoveryTimeoutMs: Int?
    var minSendIntervalMs: Int?
    var interPacketGapMs: Int?
}

struct GoveeDeviceConfig: Codable, Equatable, Identifiable {
    var ip: String
    var sku: String?
    var name: String?
    /// Device MAC / stable ID from discovery; survives DHCP lease changes.
    var mac: String?
    /// Manual device-type override (one of `GoveeDeviceCatalog.types`). When
    /// set, it wins over the daemon's SKU-derived guess on the next scan and
    /// drives which recommended scene set applies. Optional — omitted devices
    /// fall back to auto-detection.
    var type: String?

    /// Stable identity for SwiftUI lists. Prefer the MAC (does not move),
    /// then fall back to the current IP.
    var id: String { mac ?? ip }
}

/// UI-side mirror of the Govee device-type catalog in
/// `src/adapters/govee-models.ts`. Used for the per-device manual type
/// override picker. Kept in sync by hand (the list is short and stable).
enum GoveeDeviceCatalog {
    /// Ordered list of selectable types (matches `GOVEE_DEVICE_TYPES`).
    static let types: [String] = [
        "bulb", "light-strip", "floor-lamp", "table-lamp", "wall-panel",
        "tv-backlight", "downlight", "ceiling", "outdoor", "string-lights", "unknown",
    ]

    /// Human-readable label for a type (matches `typeLabel` in TS).
    static func label(_ type: String) -> String {
        switch type {
        case "bulb": return "Smart Bulb"
        case "light-strip": return "Light Strip"
        case "floor-lamp": return "Floor Lamp"
        case "table-lamp": return "Table Lamp"
        case "wall-panel": return "Wall Panel"
        case "tv-backlight": return "TV Backlight"
        case "downlight": return "Downlight"
        case "ceiling": return "Ceiling Light"
        case "outdoor": return "Outdoor Light"
        case "string-lights": return "String Lights"
        case "unknown": return "Unknown"
        default: return type.capitalized
        }
    }
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
