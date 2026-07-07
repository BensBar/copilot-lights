import XCTest
import Network
import AppKit
@testable import CopilotLights

final class DaemonClientTests: XCTestCase {
    func testCopilotMarkSVGExists() {
        // Test that the SVG file exists in the Resources directory
        // The app will gracefully fall back to a circle if it can't load
        let fileManager = FileManager.default
        let resourcePath = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources")
            .appendingPathComponent("CopilotLights")
            .appendingPathComponent("Resources")
            .appendingPathComponent("copilot-mark.svg")
        
        XCTAssertTrue(fileManager.fileExists(atPath: resourcePath.path), 
                      "copilot-mark.svg should exist in Resources/")
    }
    
    func testSocketPathResolution() {
        setenv("COPILOT_LIGHTS_SOCKET", "/custom/socket", 1)
        XCTAssertEqual(SocketPath.resolve(), "/custom/socket")
        unsetenv("COPILOT_LIGHTS_SOCKET")
        
        setenv("XDG_RUNTIME_DIR", "/run/user/1000", 1)
        XCTAssertEqual(SocketPath.resolve(), "/run/user/1000/copilot-lights/sock")
        unsetenv("XDG_RUNTIME_DIR")
        
        let home = NSHomeDirectory()
        XCTAssertEqual(SocketPath.resolve(), "\(home)/.copilot-lights/sock")
    }
    
    func testDaemonClientOfflineWhenSocketMissing() async {
        let tempDir = NSTemporaryDirectory()
        let nonExistentSocket = "\(tempDir)/nonexistent-\(UUID().uuidString).sock"
        
        let client = DaemonClient(socketPath: nonExistentSocket, pollIntervalMs: 100, timeoutMs: 100)
        
        await client.start()
        
        try? await Task.sleep(for: .milliseconds(300))
        
        let status = await client.status
        XCTAssertEqual(status, .offline)
        
        await client.stop()
    }
    
    func testDaemonClientDecodesParsedJSON() throws {
        let json = """
        {"kind":"status","state":"ready","sessions":2,"adapter":{"kind":"home-assistant","ok":true,"lastError":null},"frame":{"rgb":{"r":126,"g":231,"b":135},"brightness":25,"transitionMs":600},"uptimeMs":12345}
        """
        
        let data = json.data(using: .utf8)!
        let reply = try JSONDecoder().decode(StatusReply.self, from: data)
        
        XCTAssertEqual(reply.state, "ready")
        XCTAssertEqual(reply.sessions, 2)
        XCTAssertEqual(reply.adapter.kind, "home-assistant")
        XCTAssertTrue(reply.adapter.ok)
        XCTAssertNil(reply.adapter.lastError)
        
        XCTAssertNotNil(reply.frame)
        XCTAssertEqual(reply.frame?.rgb.r, 126)
        XCTAssertEqual(reply.frame?.rgb.g, 231)
        XCTAssertEqual(reply.frame?.rgb.b, 135)
        XCTAssertEqual(reply.frame?.brightness, 25)
        XCTAssertEqual(reply.frame?.rgb.hexString, "#7ee787")
    }
    
    func testDaemonClientDecodesNullFrame() throws {
        let json = """
        {"kind":"status","state":"off","sessions":0,"adapter":{"kind":"home-assistant","ok":false,"lastError":"Connection refused"},"frame":null,"uptimeMs":5000}
        """
        
        let data = json.data(using: .utf8)!
        let reply = try JSONDecoder().decode(StatusReply.self, from: data)
        
        XCTAssertEqual(reply.state, "off")
        XCTAssertEqual(reply.sessions, 0)
        XCTAssertFalse(reply.adapter.ok)
        XCTAssertEqual(reply.adapter.lastError, "Connection refused")
        XCTAssertNil(reply.frame)
    }

    // MARK: - Hysteresis (resolveStatus)

    private func okReply(_ state: String, sessions: Int = 1) -> StatusReply {
        let json = """
        {"kind":"status","state":"\(state)","sessions":\(sessions),"adapter":{"kind":"mock","ok":true,"lastError":null},"frame":null,"uptimeMs":1}
        """
        return try! JSONDecoder().decode(StatusReply.self, from: json.data(using: .utf8)!)
    }

    func testResolveStatusPublishesOKImmediatelyAndResetsFailures() {
        let ok = PollResult.ok(okReply("thinking"))
        let r = DaemonClient.resolveStatus(
            result: ok, lastGood: .offline, consecutiveFailures: 2, failureTolerance: 3)
        XCTAssertEqual(r.status, ok)
        XCTAssertEqual(r.lastGood, ok)
        XCTAssertEqual(r.consecutiveFailures, 0)
    }

    func testResolveStatusHoldsLastGoodDuringTransientFailure() {
        let good = PollResult.ok(okReply("thinking"))
        // First failure after a good poll: keep showing the good state.
        let r1 = DaemonClient.resolveStatus(
            result: .error("timeout"), lastGood: good, consecutiveFailures: 0, failureTolerance: 3)
        XCTAssertEqual(r1.status, good)
        XCTAssertEqual(r1.lastGood, good)
        XCTAssertEqual(r1.consecutiveFailures, 1)

        // Second failure: still within tolerance, still showing good.
        let r2 = DaemonClient.resolveStatus(
            result: .offline, lastGood: good, consecutiveFailures: 1, failureTolerance: 3)
        XCTAssertEqual(r2.status, good)
        XCTAssertEqual(r2.consecutiveFailures, 2)
    }

    func testResolveStatusSurfacesFailureAtTolerance() {
        let good = PollResult.ok(okReply("thinking"))
        let r = DaemonClient.resolveStatus(
            result: .offline, lastGood: good, consecutiveFailures: 2, failureTolerance: 3)
        XCTAssertEqual(r.status, .offline)
        // lastGood is preserved so recovery re-shows the prior state.
        XCTAssertEqual(r.lastGood, good)
        XCTAssertEqual(r.consecutiveFailures, 3)
    }

    // MARK: - Multi-segment reassembly

    func testFirstCompleteLineReturnsNilWithoutNewline() {
        // A partial payload (no newline yet) must not be parsed — this is
        // the exact case that used to fail as "parse failed" and flicker
        // the widget gray under load.
        let partial = Data("{\"kind\":\"status\",\"state\":\"think".utf8)
        XCTAssertNil(DaemonClient.firstCompleteLine(in: partial))
    }

    func testFirstCompleteLineReturnsLineWhenNewlinePresent() {
        let full = Data("{\"kind\":\"status\"}\n".utf8)
        XCTAssertEqual(DaemonClient.firstCompleteLine(in: full), "{\"kind\":\"status\"}")
    }

    func testFirstCompleteLineStopsAtFirstNewline() {
        let two = Data("first\nsecond\n".utf8)
        XCTAssertEqual(DaemonClient.firstCompleteLine(in: two), "first")
    }

    func testFirstCompleteLineReassemblesFragments() {
        // Simulate the payload arriving in three TCP segments; only after
        // the final chunk (carrying the newline) do we get a complete line.
        let buffer = Data()
        var acc = buffer
        acc.append(Data("{\"kind\":".utf8))
        XCTAssertNil(DaemonClient.firstCompleteLine(in: acc))
        acc.append(Data("\"status\"}".utf8))
        XCTAssertNil(DaemonClient.firstCompleteLine(in: acc))
        acc.append(Data("\n".utf8))
        XCTAssertEqual(DaemonClient.firstCompleteLine(in: acc), "{\"kind\":\"status\"}")
    }
}
