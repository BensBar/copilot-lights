import XCTest
@testable import CopilotLights

final class SettingsCoreTests: XCTestCase {

    /// Round-trip a value through the actual macOS Keychain under a unique
    /// account name so we don't collide with the user's real HASS_TOKEN.
    func testKeychainRoundTrip() throws {
        let account = "CL_TEST_KEY_\(UUID().uuidString.prefix(8))"
        defer { try? KeychainHelper.delete(account: String(account)) }

        let pre = try KeychainHelper.read(account: String(account))
        XCTAssertNil(pre, "unique account should start empty")

        try KeychainHelper.write(account: String(account), value: "shhh-1")
        XCTAssertEqual(try KeychainHelper.read(account: String(account)), "shhh-1")

        // Overwriting an existing entry should replace, not error.
        try KeychainHelper.write(account: String(account), value: "shhh-2")
        XCTAssertEqual(try KeychainHelper.read(account: String(account)), "shhh-2")

        try KeychainHelper.delete(account: String(account))
        XCTAssertNil(try KeychainHelper.read(account: String(account)))
    }

    func testStateStyleDefaultsCoverEveryState() {
        for state in ["ready", "thinking", "awaiting_input", "error", "done"] {
            let style = StateStyle.defaultFor(state)
            XCTAssertFalse(style.color.isEmpty, "\(state) default missing color")
        }
    }

    func testCopilotLightsConfigDocEncodesAndDecodes() throws {
        let doc = CopilotLightsConfigDoc.empty()
        let data = try JSONEncoder().encode(doc)
        let back = try JSONDecoder().decode(CopilotLightsConfigDoc.self, from: data)
        XCTAssertEqual(back.adapter, doc.adapter)
    }

    func testAdaptersArrayRoundTripsAndDerivesEnabled() throws {
        var doc = CopilotLightsConfigDoc.empty()
        doc.adapters = [.govee, .hue]
        let data = try JSONEncoder().encode(doc)
        let back = try JSONDecoder().decode(CopilotLightsConfigDoc.self, from: data)
        XCTAssertEqual(back.adapters, [.govee, .hue])
        XCTAssertEqual(back.enabledAdapters, [.govee, .hue])
    }

    func testEnabledAdaptersFallsBackToSingleAdapter() {
        var doc = CopilotLightsConfigDoc.empty()
        doc.adapter = .hue
        doc.adapters = nil
        XCTAssertEqual(doc.enabledAdapters, [.hue])
        doc.adapters = []          // empty also falls back
        XCTAssertEqual(doc.enabledAdapters, [.hue])
    }

    func testEnabledAdaptersDropsMockWhenRealPresent() {
        var doc = CopilotLightsConfigDoc.empty()
        doc.adapters = [.mock, .govee]
        XCTAssertEqual(doc.enabledAdapters, [.govee])
    }

    func testEnabledAdaptersDefaultsToMock() {
        let doc = CopilotLightsConfigDoc.empty()
        XCTAssertEqual(doc.enabledAdapters, [.mock])
    }

    func testGoveeScanReplyDecodes() throws {
        let json = """
        {
          "kind": "govee-scan",
          "devices": [
            {"ip":"192.168.1.5","sku":"H6159","mac":"AA:BB:CC","model":"RGB Light Strip","type":"light-strip","typeLabel":"Light Strip"}
          ],
          "scenesByType": {
            "light-strip": {"ready": {"color":"#4ade80","brightness":30,"effect":"steady"}}
          },
          "rationaleByType": {"light-strip": "Accent lighting — balanced default scenes."}
        }
        """
        let reply = try JSONDecoder().decode(GoveeScanReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.kind, "govee-scan")
        XCTAssertEqual(reply.devices.count, 1)
        XCTAssertEqual(reply.devices[0].typeLabel, "Light Strip")
        XCTAssertEqual(reply.devices[0].id, "AA:BB:CC")
        XCTAssertEqual(reply.scenesByType["light-strip"]?["ready"]?.color, "#4ade80")
        XCTAssertNotNil(reply.rationaleByType["light-strip"])
    }

    /// Saving the doc must preserve a Govee block (regression guard against the
    /// UI wiping `govee` config when other panes are saved).
    func testGoveeBlockSurvivesEncodeDecode() throws {
        var doc = CopilotLightsConfigDoc.empty()
        doc.govee = GoveeConfig(
            devices: [GoveeDeviceConfig(ip: "192.168.1.5", sku: "H6159", name: "Strip", mac: "AA:BB:CC")],
            discoveryTimeoutMs: 1500,
            minSendIntervalMs: nil,
            interPacketGapMs: nil
        )
        let data = try JSONEncoder().encode(doc)
        let back = try JSONDecoder().decode(CopilotLightsConfigDoc.self, from: data)
        XCTAssertEqual(back.govee?.devices.count, 1)
        XCTAssertEqual(back.govee?.devices.first?.mac, "AA:BB:CC")
        XCTAssertEqual(back.govee?.discoveryTimeoutMs, 1500)
        // Unset optionals must not be emitted as JSON nulls.
        let raw = (try JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let govee = raw?["govee"] as? [String: Any]
        XCTAssertNotNil(govee)
        XCTAssertNil(govee?["minSendIntervalMs"], "nil optionals should be omitted, not encoded as null")
    }

    func testGoveeDeviceTypeOverrideRoundTrips() throws {
        var doc = CopilotLightsConfigDoc.empty()
        doc.govee = GoveeConfig(
            devices: [GoveeDeviceConfig(ip: "192.168.1.5", sku: "H6159", name: "Strip", mac: "AA:BB:CC", type: "downlight")],
            discoveryTimeoutMs: nil, minSendIntervalMs: nil, interPacketGapMs: nil
        )
        let data = try JSONEncoder().encode(doc)
        let back = try JSONDecoder().decode(CopilotLightsConfigDoc.self, from: data)
        XCTAssertEqual(back.govee?.devices.first?.type, "downlight")
        // A device with no override must not emit a `type` key at all.
        let plain = try JSONEncoder().encode(GoveeDeviceConfig(ip: "1.2.3.4", sku: nil, name: nil, mac: nil, type: nil))
        let raw = (try JSONSerialization.jsonObject(with: plain)) as? [String: Any]
        XCTAssertNil(raw?["type"], "nil type override should be omitted")
    }

    func testHueScanReplyDecodes() throws {
        let json = """
        {"kind":"hue-scan","lights":[{"id":"uuid-a","name":"Desk","archetype":"table_shade"},{"id":"uuid-b","name":"Ceiling"}]}
        """
        let reply = try JSONDecoder().decode(HueScanReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.lights.count, 2)
        XCTAssertEqual(reply.lights[0].archetype, "table_shade")
        XCTAssertNil(reply.lights[1].archetype)
        XCTAssertNil(reply.error)
    }

    func testHueScanReplyDecodesErrorEnvelope() throws {
        let json = #"{"kind":"hue-scan","lights":[],"error":"Hue is not configured"}"#
        let reply = try JSONDecoder().decode(HueScanReply.self, from: Data(json.utf8))
        XCTAssertTrue(reply.lights.isEmpty)
        XCTAssertEqual(reply.error, "Hue is not configured")
    }

    func testHAScanReplyDecodes() throws {
        let json = """
        {"kind":"ha-scan","lights":[{"entityId":"light.desk","name":"Desk Lamp"}]}
        """
        let reply = try JSONDecoder().decode(HAScanReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.lights.first?.id, "light.desk")
        XCTAssertEqual(reply.lights.first?.name, "Desk Lamp")
    }

    func testIdentifyReplyDecodes() throws {
        let ok = try JSONDecoder().decode(IdentifyReply.self, from: Data(#"{"kind":"identify-result","ok":true}"#.utf8))
        XCTAssertTrue(ok.ok)
        let bad = try JSONDecoder().decode(IdentifyReply.self, from: Data(#"{"kind":"identify-result","ok":false,"error":"no IP"}"#.utf8))
        XCTAssertFalse(bad.ok)
        XCTAssertEqual(bad.error, "no IP")
    }
}
