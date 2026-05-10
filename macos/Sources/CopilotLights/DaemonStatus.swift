import Foundation

struct StatusReply: Codable {
    let kind: String
    let state: String
    let sessions: Int
    let sessionList: [SessionDetail]?
    let adapter: AdapterInfo
    let frame: FrameInfo?
    let uptimeMs: Int
    /// Session id currently being followed (light reflects only this session).
    /// Nil when in aggregate mode. Optional for back-compat with older daemons.
    let followedSessionId: String?
}

struct SessionDetail: Codable, Identifiable, Hashable {
    let id: String
    let cwd: String?
    let lastEventTs: Int
    /// Per-session resolved state. Daemon now includes this in every
    /// `sessionList` entry. Optional for back-compat with older daemons that
    /// did not emit it.
    let state: String?
    /// Most recent tool name observed on this session (PreToolUse).
    let lastToolName: String?
    let activeTools: Int?
    let activeSubagents: Int?
    let pendingTurns: Int?
    let awaitingPermission: Bool?
    let hasAttentionNotification: Bool?
    let lastDoneTs: Int?
    /// True when the daemon has inferred that this session is running in
    /// autopilot mode (every tool's PermissionRequest is being silently
    /// auto-approved). Surfaced in the menubar so the user can see at a
    /// glance which streams are autonomous.
    let autopilot: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, cwd, lastEventTs, state, lastToolName
        case activeTools, activeSubagents, pendingTurns
        case awaitingPermission, hasAttentionNotification, lastDoneTs, autopilot
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        lastEventTs = try c.decode(Int.self, forKey: .lastEventTs)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        lastToolName = try c.decodeIfPresent(String.self, forKey: .lastToolName)
        activeTools = try c.decodeIfPresent(Int.self, forKey: .activeTools)
        activeSubagents = try c.decodeIfPresent(Int.self, forKey: .activeSubagents)
        pendingTurns = try c.decodeIfPresent(Int.self, forKey: .pendingTurns)
        awaitingPermission = try c.decodeIfPresent(Bool.self, forKey: .awaitingPermission)
        hasAttentionNotification = try c.decodeIfPresent(Bool.self, forKey: .hasAttentionNotification)
        lastDoneTs = try c.decodeIfPresent(Int.self, forKey: .lastDoneTs)
        autopilot = try c.decodeIfPresent(Bool.self, forKey: .autopilot)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(cwd, forKey: .cwd)
        try c.encode(lastEventTs, forKey: .lastEventTs)
        try c.encodeIfPresent(state, forKey: .state)
        try c.encodeIfPresent(lastToolName, forKey: .lastToolName)
        try c.encodeIfPresent(activeTools, forKey: .activeTools)
        try c.encodeIfPresent(activeSubagents, forKey: .activeSubagents)
        try c.encodeIfPresent(pendingTurns, forKey: .pendingTurns)
        try c.encodeIfPresent(awaitingPermission, forKey: .awaitingPermission)
        try c.encodeIfPresent(hasAttentionNotification, forKey: .hasAttentionNotification)
        try c.encodeIfPresent(lastDoneTs, forKey: .lastDoneTs)
        try c.encodeIfPresent(autopilot, forKey: .autopilot)
    }
}

struct AdapterInfo: Codable {
    let kind: String
    let ok: Bool
    let lastError: String?
}

struct FrameInfo: Codable {
    let rgb: RGBColor
    let brightness: Int
    let transitionMs: Int

    private enum CodingKeys: String, CodingKey {
        case rgb
        case brightness
        case transitionMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rgb = try c.decode(RGBColor.self, forKey: .rgb)
        transitionMs = try c.decode(Int.self, forKey: .transitionMs)
        // Daemon emits brightness as a Double in [0, 1]. Older readers (and the
        // rest of this app) treat brightness as an Int percentage in [0, 100],
        // so accept either shape and normalize on the way in.
        if let asDouble = try? c.decode(Double.self, forKey: .brightness) {
            let scaled = asDouble <= 1.0 ? asDouble * 100.0 : asDouble
            brightness = max(0, min(100, Int(scaled.rounded())))
        } else {
            let asInt = try c.decode(Int.self, forKey: .brightness)
            brightness = max(0, min(100, asInt))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(rgb, forKey: .rgb)
        try c.encode(brightness, forKey: .brightness)
        try c.encode(transitionMs, forKey: .transitionMs)
    }
}

struct RGBColor: Codable {
    let r: Int
    let g: Int
    let b: Int
    
    var hexString: String {
        String(format: "#%02x%02x%02x", r, g, b)
    }
}

struct StatusQuery: Codable {
    let kind: String = "query"
    let query: String = "status"
}
