import XCTest
@testable import CopilotLights

final class DaemonStatusTests: XCTestCase {
    private func decode(_ json: String) throws -> StatusReply {
        let data = Data(json.utf8)
        return try JSONDecoder().decode(StatusReply.self, from: data)
    }

    /// Regression test: the daemon emits frame.brightness as a Double in [0, 1].
    /// Decoding into `Int` previously failed silently, leaving the widget stuck
    /// reporting 0 sessions and the last-known color.
    func testDecodesFloatBrightnessFromDaemon() throws {
        let json = """
        {
          "kind": "status",
          "state": "thinking",
          "sessions": 1,
          "adapter": {"kind": "home-assistant", "ok": true, "lastError": null},
          "frame": {"rgb": {"r": 88, "g": 166, "b": 255}, "brightness": 0.6819562929541989, "transitionMs": 100},
          "uptimeMs": 12345
        }
        """
        let reply = try decode(json)
        XCTAssertEqual(reply.sessions, 1)
        XCTAssertEqual(reply.state, "thinking")
        XCTAssertEqual(reply.frame?.brightness, 68)
        XCTAssertEqual(reply.frame?.rgb.hexString, "#58a6ff")
    }

    func testDecodesIntBrightnessForBackwardsCompat() throws {
        let json = """
        {
          "kind": "status",
          "state": "ready",
          "sessions": 0,
          "adapter": {"kind": "home-assistant", "ok": true, "lastError": null},
          "frame": {"rgb": {"r": 0, "g": 0, "b": 0}, "brightness": 42, "transitionMs": 100},
          "uptimeMs": 1
        }
        """
        let reply = try decode(json)
        XCTAssertEqual(reply.frame?.brightness, 42)
    }

    func testFrameOptionalWhenNull() throws {
        let json = """
        {
          "kind": "status",
          "state": "off",
          "sessions": 0,
          "adapter": {"kind": "home-assistant", "ok": true, "lastError": null},
          "frame": null,
          "uptimeMs": 1
        }
        """
        let reply = try decode(json)
        XCTAssertNil(reply.frame)
        XCTAssertEqual(reply.sessions, 0)
    }
}
