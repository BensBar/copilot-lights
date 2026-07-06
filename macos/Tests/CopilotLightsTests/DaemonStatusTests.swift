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

    /// The daemon now includes a per-session `origin` (owning-app bundle id)
    /// so the menubar can focus the terminal/app on click. Older daemons omit
    /// it, so it must decode as nil without failing.
    func testDecodesSessionOrigin() throws {
        let json = """
        {
          "kind": "status",
          "state": "thinking",
          "sessions": 2,
          "sessionList": [
            {"id": "s1", "cwd": "/repo", "lastEventTs": 1000, "state": "thinking", "origin": "com.mitchellh.ghostty"},
            {"id": "s2", "cwd": "/other", "lastEventTs": 900, "state": "ready"}
          ],
          "adapter": {"kind": "mock", "ok": true, "lastError": null},
          "frame": null,
          "uptimeMs": 5
        }
        """
        let reply = try decode(json)
        let list = try XCTUnwrap(reply.sessionList)
        XCTAssertEqual(list.first(where: { $0.id == "s1" })?.origin, "com.mitchellh.ghostty")
        // Back-compat: a session without `origin` decodes to nil, not a throw.
        XCTAssertNil(list.first(where: { $0.id == "s2" })?.origin)
    }

    // MARK: - Emitted-shade matching (widget color == physical light shade)

    /// The physical bulb receives full-saturation rgb + a separate 0–100
    /// brightness and dims by scaling each channel. `scaled(byBrightness:)`
    /// mirrors that so the on-screen orb shows the same shade, not the bright
    /// full-saturation hue.
    func testScaledByBrightnessDarkensToEmittedShade() throws {
        let green = try XCTUnwrap(RGBColor.fromHex("#4ade80")) // (74, 222, 128)
        let dim = green.scaled(byBrightness: 30)
        XCTAssertEqual(dim.r, 22)  // round(74 * 0.30)
        XCTAssertEqual(dim.g, 67)  // round(222 * 0.30)
        XCTAssertEqual(dim.b, 38)  // round(128 * 0.30)
    }

    func testScaledByBrightnessFullIsUnchanged() throws {
        let c = RGBColor(r: 255, g: 128, b: 64)
        let full = c.scaled(byBrightness: 100)
        XCTAssertEqual(full.r, 255)
        XCTAssertEqual(full.g, 128)
        XCTAssertEqual(full.b, 64)
    }

    func testScaledByBrightnessZeroIsBlackAndClamps() throws {
        let c = RGBColor(r: 200, g: 200, b: 200)
        let off = c.scaled(byBrightness: 0)
        XCTAssertEqual(off.r, 0)
        XCTAssertEqual(off.g, 0)
        XCTAssertEqual(off.b, 0)
        // Out-of-range brightness clamps to [0, 100] rather than over/under-scaling.
        let overdriven = c.scaled(byBrightness: 150)
        XCTAssertEqual(overdriven.r, 200)
        let negative = c.scaled(byBrightness: -20)
        XCTAssertEqual(negative.r, 0)
    }
}
