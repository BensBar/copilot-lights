import XCTest
@testable import CopilotLightsMenuBar

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
}
