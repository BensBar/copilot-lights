import Foundation

enum SocketPath {
    static func resolve() -> String {
        let env = ProcessInfo.processInfo.environment
        
        if let socketPath = env["COPILOT_LIGHTS_SOCKET"] {
            return socketPath
        }
        
        if let xdgRuntime = env["XDG_RUNTIME_DIR"] {
            return "\(xdgRuntime)/copilot-lights/sock"
        }
        
        let home = NSHomeDirectory()
        return "\(home)/.copilot-lights/sock"
    }
}
