import AppKit
import Foundation

@MainActor
class MenuBuilder: NSObject, NSMenuDelegate {
    private let daemonClient: DaemonClient
    private let configStore: ConfigStore
    private var currentStatus: PollResult = .offline

    init(daemonClient: DaemonClient, configStore: ConfigStore) {
        self.daemonClient = daemonClient
        self.configStore = configStore
        super.init()

        Task {
            for await status in await daemonClient.statusPublisher.values {
                self.currentStatus = status
            }
        }
    }
    
    func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        return menu
    }
    
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        
        let header = NSMenuItem(title: "Copilot Lights", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        
        menu.addItem(NSMenuItem.separator())
        
        switch currentStatus {
        case .ok(let status):
            let stateItem = NSMenuItem(title: "State: \(status.state)", action: nil, keyEquivalent: "")
            stateItem.isEnabled = false
            menu.addItem(stateItem)
            
            // Compute active vs idle counts so the dropdown reads as
            // "1 active · 5 idle" rather than a flat session count.
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            let list = status.sessionList ?? []
            let activeCount = list.filter { !Self.isIdle($0, nowMs: nowMs) }.count
            let idleCount = list.count - activeCount
            let breakdown: String
            if list.isEmpty {
                breakdown = "0"
            } else if idleCount == 0 {
                breakdown = "\(activeCount) active"
            } else if activeCount == 0 {
                breakdown = "\(idleCount) idle"
            } else {
                breakdown = "\(activeCount) active · \(idleCount) idle"
            }
            let sessionsItem = NSMenuItem(title: "Sessions: \(breakdown)", action: nil, keyEquivalent: "")
            sessionsItem.isEnabled = false
            menu.addItem(sessionsItem)

            // Show each active session's state, working directory, and most
            // recent tool. Each row uses an attributed title with a coloured
            // bullet matching the session's resolved state, so the user can
            // see at a glance why the global aggregate (the bulb) is what it
            // is when multiple Copilot windows are running.
            if !list.isEmpty {
                // Active sessions first (newest activity first within each
                // group), idle sessions last. Keeps the noisy / interesting
                // rows at the top.
                let sorted = list.sorted { a, b in
                    let aIdle = Self.isIdle(a, nowMs: nowMs)
                    let bIdle = Self.isIdle(b, nowMs: nowMs)
                    if aIdle != bIdle { return !aIdle }
                    return a.lastEventTs > b.lastEventTs
                }
                for session in sorted {
                    let item = NSMenuItem(title: "",
                                          action: #selector(revealSessionCwd(_:)),
                                          keyEquivalent: "")
                    item.attributedTitle = sessionRowAttributedTitle(session, nowMs: nowMs)
                    item.representedObject = session.cwd
                    item.target = self
                    item.isEnabled = (session.cwd != nil)
                    item.toolTip = session.id
                    menu.addItem(item)
                }
            }
            
            let adapterStatus = status.adapter.ok ? "✓" : "✗"
            let adapterItem = NSMenuItem(title: "Adapter: \(status.adapter.kind) \(adapterStatus)", action: nil, keyEquivalent: "")
            adapterItem.isEnabled = false
            
            if !status.adapter.ok, let error = status.adapter.lastError {
                adapterItem.title += "\n  \(error)"
            }
            
            menu.addItem(adapterItem)
            
            if let frame = status.frame {
                let colorItem = NSMenuItem(title: "Color: \(frame.rgb.hexString) @ \(frame.brightness)%", action: nil, keyEquivalent: "")
                colorItem.isEnabled = false
                menu.addItem(colorItem)
            }
            
        case .offline:
            let offlineItem = NSMenuItem(title: "Status: Daemon offline", action: nil, keyEquivalent: "")
            offlineItem.isEnabled = false
            menu.addItem(offlineItem)
            
        case .error(let msg):
            let errorItem = NSMenuItem(title: "Status: Error - \(msg)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)
        }
        
        menu.addItem(NSMenuItem.separator())
        
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        menu.addItem(settingsItem)
        menu.addItem(NSMenuItem(title: "Edit Config (raw)…", action: #selector(editConfig), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Reveal Config in Finder", action: #selector(revealConfig), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Daemon", action: #selector(restartDaemon), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Logs…", action: #selector(openLogs), keyEquivalent: ""))
        
        menu.addItem(NSMenuItem.separator())
        
        menu.addItem(NSMenuItem(title: "About copilot-lights", action: #selector(openAbout), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        
        for item in menu.items {
            if item.action != nil && item.target == nil {
                item.target = self
            }
        }
    }
    
    @objc private func editConfig() {
        let configPath = (NSHomeDirectory() as NSString).appendingPathComponent(".copilot-lights/config.json")
        let url = URL(fileURLWithPath: configPath)
        NSWorkspace.shared.open(url)
    }

    @objc private func openSettings() {
        // Menu-bar-only apps (.accessory) don't have a normal app window in
        // the responder chain, so SwiftUI's Settings scene won't reliably
        // open via `showSettingsWindow:` alone. Promote to .regular, activate,
        // and dispatch the open action on the next runloop tick so AppKit has
        // a chance to wire up the application's menu / responder chain. Only
        // then do we send `showSettingsWindow:`. After the settings window
        // closes, we return to .accessory so the app stays out of the Dock.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        // First: bring an already-open settings window forward immediately.
        if presentExistingSettingsWindow() { return }

        // Otherwise: ask AppKit to create one. Do it on the next runloop tick
        // so the policy change has settled.
        DispatchQueue.main.async { [weak self] in
            self?.requestOpenSettingsWindow()

            // Give SwiftUI a brief moment to instantiate the window, then
            // surface it and arm the close-observer that drops policy back.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                if !(self?.presentExistingSettingsWindow() ?? false) {
                    // Last-ditch: try the open action one more time.
                    self?.requestOpenSettingsWindow()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                        _ = self?.presentExistingSettingsWindow()
                    }
                }
            }
        }
    }

    /// Find any already-open Settings/Preferences window, surface it, and
    /// wire up an observer to drop the activation policy back to .accessory
    /// when the user closes it. Returns true if such a window was found.
    @discardableResult
    private func presentExistingSettingsWindow() -> Bool {
        guard let window = settingsWindow() else { return false }
        window.collectionBehavior.insert(.moveToActiveSpace)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        attachSettingsCloseObserver(window)
        return true
    }

    private func settingsWindow() -> NSWindow? {
        for window in NSApp.windows {
            // SwiftUI Settings scene window identifier on macOS 13+.
            if window.identifier?.rawValue == "com_apple_SwiftUI_Settings_window" {
                return window
            }
            let title = window.title
            if title.localizedCaseInsensitiveContains("settings")
                || title.localizedCaseInsensitiveContains("preferences")
            {
                return window
            }
        }
        return nil
    }

    private func requestOpenSettingsWindow() {
        // The Settings/Preferences action is implemented by a private
        // SwiftUI responder, not by NSApplication itself. Sending the
        // selector directly to NSApp crashes ("unrecognized selector"); 
        // sending with `to: nil` walks the responder chain, which is
        // unreliable from a status-item context.
        //
        // The trick that works in both contexts: find the existing
        // "Settings…" / "Preferences…" item in the app's main menu — its
        // `target` is the right responder, set up by SwiftUI when the app
        // promotes to .regular. Trigger the action through that item.
        if let item = findSettingsMenuItem(), let action = item.action {
            _ = NSApp.sendAction(action, to: item.target, from: item)
            return
        }

        // Fallback: responder-chain delivery. Works when the app menu is
        // already wired up (e.g., immediately after activation).
        if #available(macOS 14, *) {
            _ = NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        } else {
            _ = NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }

    /// Locate the SwiftUI-installed Settings/Preferences menu item in the
    /// application's main menu. Walks every top-level menu (typically the
    /// app menu is at index 0, but be defensive).
    private func findSettingsMenuItem() -> NSMenuItem? {
        guard let mainMenu = NSApp.mainMenu else { return nil }
        let settingsSelector = Selector(("showSettingsWindow:"))
        let preferencesSelector = Selector(("showPreferencesWindow:"))
        for top in mainMenu.items {
            guard let submenu = top.submenu else { continue }
            for item in submenu.items {
                if let action = item.action,
                   action == settingsSelector || action == preferencesSelector {
                    return item
                }
            }
        }
        return nil
    }

    private func attachSettingsCloseObserver(_ window: NSWindow) {
        // Avoid stacking duplicate observers if the user opens settings repeatedly.
        NotificationCenter.default.removeObserver(self,
                                                  name: NSWindow.willCloseNotification,
                                                  object: window)
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { _ in
            NSApp.setActivationPolicy(.accessory)
        }
    }
    
    @objc private func revealConfig() {
        let configPath = (NSHomeDirectory() as NSString).appendingPathComponent(".copilot-lights/config.json")
        let url = URL(fileURLWithPath: configPath)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
    
    @objc private func restartDaemon() {
        let process = Process()
        process.launchPath = "/bin/sh"
        process.arguments = ["-c", "launchctl kickstart -k gui/$(id -u)/com.copilot-lights.daemon 2>&1 || echo 'Daemon not loaded via launchd'"]
        
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        
        do {
            try process.run()
            process.waitUntilExit()
            
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                let alert = NSAlert()
                alert.messageText = "Restart Daemon"
                alert.informativeText = output
                alert.alertStyle = .informational
                alert.runModal()
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Failed to Restart"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.runModal()
        }
    }
    
    @objc private func openLogs() {
        let logPath = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/copilot-lights.log")
        let url = URL(fileURLWithPath: logPath)
        
        if FileManager.default.fileExists(atPath: logPath) {
            NSWorkspace.shared.open(url)
        } else {
            let alert = NSAlert()
            alert.messageText = "Log File Not Found"
            alert.informativeText = "The log file does not exist at:\n\(logPath)"
            alert.alertStyle = .informational
            alert.runModal()
        }
    }
    
    @objc private func openAbout() {
        let url = URL(string: "https://github.com/copilot-lights")!
        NSWorkspace.shared.open(url)
    }
    
    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func revealSessionCwd(_ sender: NSMenuItem) {
        guard let cwd = sender.representedObject as? String, !cwd.isEmpty else { return }
        let url = URL(fileURLWithPath: cwd, isDirectory: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func abbreviateHome(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path == home { return "~" }
        if path.hasPrefix(home + "/") {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    /// A session counts as "idle" when it has resolved to `ready` or `done`
    /// and has had no event in the last 30s. These rows render dimmed in the
    /// dropdown so the user's eye snaps to the actively-engaged session.
    private static let idleAgeThresholdMs: Int = 30_000
    static func isIdle(_ session: SessionDetail, nowMs: Int) -> Bool {
        let state = session.state ?? "ready"
        guard state == "ready" || state == "done" else { return false }
        return (nowMs - session.lastEventTs) >= idleAgeThresholdMs
    }

    /// Compact, human-friendly age string ("12s", "3m", "1h").
    private static func ageString(_ ageMs: Int) -> String {
        let s = max(0, ageMs / 1000)
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        return "\(h)h"
    }

    /// Build "● state · ~/path · tool" with the bullet tinted to the session's
    /// state colour. Falls back gracefully when the daemon doesn't supply
    /// per-session state (older daemon, edge cases). Idle sessions render
    /// dimmed with their last-event age in place of the tool name.
    private func sessionRowAttributedTitle(_ session: SessionDetail, nowMs: Int) -> NSAttributedString {
        let stateName = session.state ?? "ready"
        let idle = Self.isIdle(session, nowMs: nowMs)
        let style = configStore.doc.style(for: stateName)
        let baseColor = nsColor(fromHex: style.color) ?? NSColor.systemGray
        let bulletColor: NSColor = idle ? NSColor.tertiaryLabelColor : baseColor
        let labelColor: NSColor = idle ? NSColor.secondaryLabelColor : NSColor.labelColor
        let pathColor: NSColor = idle ? NSColor.tertiaryLabelColor : NSColor.secondaryLabelColor

        let attr = NSMutableAttributedString()
        // Two leading spaces match the left-indent of the header rows above.
        attr.append(NSAttributedString(string: "  "))
        // Coloured bullet (dimmed to gray for idle sessions).
        attr.append(NSAttributedString(
            string: "●",
            attributes: [
                .foregroundColor: bulletColor,
                .font: NSFont.systemFont(ofSize: 12, weight: .bold),
            ]
        ))
        // Pretty-printed state label.
        let displayState = idle
            ? "Idle"
            : stateName.replacingOccurrences(of: "_", with: " ").capitalized
        attr.append(NSAttributedString(
            string: " " + displayState,
            attributes: [
                .font: NSFont.menuFont(ofSize: 0),
                .foregroundColor: labelColor,
            ]
        ))
        // cwd
        if let cwd = session.cwd, !cwd.isEmpty {
            attr.append(NSAttributedString(
                string: " · " + abbreviateHome(cwd),
                attributes: [
                    .font: NSFont.menuFont(ofSize: 0),
                    .foregroundColor: pathColor,
                ]
            ))
        }
        // Trailing detail: tool name when actively engaged, age when idle.
        if idle {
            let age = Self.ageString(nowMs - session.lastEventTs)
            attr.append(NSAttributedString(
                string: " · \(age) ago",
                attributes: [
                    .font: NSFont.menuFont(ofSize: 0),
                    .foregroundColor: NSColor.tertiaryLabelColor,
                ]
            ))
        } else {
            let showTool: Bool = (stateName == "thinking" || stateName == "awaiting_input")
            if showTool, let tool = session.lastToolName, !tool.isEmpty {
                attr.append(NSAttributedString(
                    string: " · " + tool,
                    attributes: [
                        .font: NSFont.menuFont(ofSize: 0),
                        .foregroundColor: NSColor.tertiaryLabelColor,
                    ]
                ))
            }
        }
        return attr
    }

    private func nsColor(fromHex hex: String) -> NSColor? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        let r = CGFloat((v >> 16) & 0xff) / 255.0
        let g = CGFloat((v >> 8) & 0xff) / 255.0
        let b = CGFloat(v & 0xff) / 255.0
        return NSColor(red: r, green: g, blue: b, alpha: 1.0)
    }
}
