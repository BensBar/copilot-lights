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
}
