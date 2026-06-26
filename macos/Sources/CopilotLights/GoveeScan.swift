import Foundation

/// Response to a `{kind:"query", query:"goveeScan"}` request sent to the
/// daemon over the Unix socket. The daemon performs the actual LAN discovery
/// (it owns the Govee adapter + the SKU→model catalog) and returns devices
/// already enriched with model/type info plus per-type recommended scenes, so
/// the Settings UI stays a thin consumer.
struct GoveeScanReply: Codable, Equatable {
    let kind: String
    let devices: [GoveeScanDevice]
    /// Recommended per-mode scene set, keyed by device type (e.g.
    /// "light-strip" → { "ready": StateStyle, ... }).
    let scenesByType: [String: [String: StateStyle]]
    /// One-line, human-readable rationale per device type.
    let rationaleByType: [String: String]
    /// Present only when the scan failed server-side.
    let error: String?
}

/// A single device that answered the discovery scan, enriched by the daemon.
struct GoveeScanDevice: Codable, Equatable, Identifiable {
    let ip: String
    let sku: String?
    let mac: String?
    let model: String
    let type: String
    let typeLabel: String

    /// Stable identity for SwiftUI lists — MAC survives DHCP, IP is the
    /// fallback for older daemons that didn't report a MAC.
    var id: String { mac ?? ip }
}
