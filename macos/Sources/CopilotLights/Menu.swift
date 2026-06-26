import AppKit
import Foundation

@MainActor
class MenuBuilder: NSObject, NSMenuDelegate {
    private let daemonClient: DaemonClient
    private let configStore: ConfigStore
    private let ui: UISettings
    private let settingsWindow: SettingsWindowController
    private var currentStatus: PollResult = .offline

    init(daemonClient: DaemonClient, configStore: ConfigStore, ui: UISettings, settingsWindow: SettingsWindowController) {
        self.daemonClient = daemonClient
        self.configStore = configStore
        self.ui = ui
        self.settingsWindow = settingsWindow
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
            //
            // Each row is *clickable to toggle Follow* — a check appears
            // beside the followed session and the bulb tracks only that
            // session's state. Hold ⌥ Option on the row to reveal the
            // session's working directory in Finder instead.
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
                let followedId = status.followedSessionId

                // Prominent "Following: <pretty>" indicator with one-click
                // "Stop Following" action — visible at a glance whenever the
                // bulb is locked to one session, no submenu hunting needed.
                if let fid = followedId {
                    let followed = list.first(where: { $0.id == fid })
                    let label = followed.flatMap { Self.prettySessionLabel($0) } ?? String(fid.prefix(8)) + "…"
                    let stopItem = NSMenuItem(title: "★ Following \(label) — click to unfollow",
                                              action: #selector(stopFollowing),
                                              keyEquivalent: "")
                    stopItem.target = self
                    menu.addItem(stopItem)
                }

                for session in sorted {
                    let hasOrigin = (session.origin?.isEmpty == false)
                    let appName = hasOrigin ? Self.appDisplayName(forBundleId: session.origin!) : nil

                    // Primary item (no modifier): open the owning app/terminal
                    // when we know it; otherwise fall back to toggling follow so
                    // the row is still actionable.
                    let item = NSMenuItem(
                        title: "",
                        action: hasOrigin ? #selector(openSessionApp(_:)) : #selector(toggleFollow(_:)),
                        keyEquivalent: "")
                    item.attributedTitle = sessionRowAttributedTitle(session, nowMs: nowMs, appName: appName)
                    item.representedObject = hasOrigin ? session.origin : session.id
                    item.target = self
                    if hasOrigin {
                        item.toolTip = "Click to open \(appName ?? "the owning app") · ⌥ follow · ⌃ reveal cwd in Finder"
                    } else {
                        item.toolTip = "Click to \(session.id == followedId ? "unfollow" : "follow") · ⌥ follow · ⌃ reveal cwd in Finder"
                    }
                    item.state = (session.id == followedId) ? .on : .off
                    menu.addItem(item)

                    // ⌥ Option alternate: toggle follow (bulb tracks only this
                    // session). Present on every row so following stays one
                    // keystroke away even when plain-click now opens the app.
                    let followAlt = NSMenuItem(
                        title: "Follow",
                        action: #selector(toggleFollow(_:)),
                        keyEquivalent: "")
                    let followVerb = (session.id == followedId) ? "Unfollow" : "Follow"
                    followAlt.attributedTitle = sessionRowAttributedTitle(session, nowMs: nowMs, suffix: " — \(followVerb)")
                    followAlt.representedObject = session.id
                    followAlt.target = self
                    followAlt.isAlternate = true
                    followAlt.keyEquivalentModifierMask = [.option]
                    followAlt.state = (session.id == followedId) ? .on : .off
                    menu.addItem(followAlt)

                    // ⌃ Control alternate: reveal the session's cwd in Finder.
                    if let cwd = session.cwd, !cwd.isEmpty {
                        let revealAlt = NSMenuItem(
                            title: "Reveal in Finder",
                            action: #selector(revealSessionCwd(_:)),
                            keyEquivalent: "")
                        revealAlt.attributedTitle = sessionRowAttributedTitle(session, nowMs: nowMs, suffix: " — Reveal in Finder")
                        revealAlt.representedObject = cwd
                        revealAlt.target = self
                        revealAlt.isAlternate = true
                        revealAlt.keyEquivalentModifierMask = [.control]
                        menu.addItem(revealAlt)
                    }
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

        // Top-level Floating Widget toggle. Hardcoded ⌥⇧L global hotkey is
        // wired in AppDelegate; mirror it here so users can find/toggle the
        // widget without digging into Settings.
        let widgetTitle = ui.floatingWindowEnabled ? "Hide Floating Widget" : "Show Floating Widget"
        let widgetItem = NSMenuItem(title: widgetTitle,
                                    action: #selector(toggleFloatingWidget),
                                    keyEquivalent: "L")
        widgetItem.keyEquivalentModifierMask = [.option, .shift]
        widgetItem.target = self
        widgetItem.state = ui.floatingWindowEnabled ? .on : .off
        menu.addItem(widgetItem)

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
        // Present our own NSWindow-hosted SettingsView. This avoids SwiftUI's
        // `Settings` scene + `showSettingsWindow:`, which doesn't reliably
        // open from a menu-bar-only (.accessory) app — the historical cause
        // of "Settings doesn't load."
        settingsWindow.show()
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

    /// Bring the GUI app that owns a session (terminal emulator or the Copilot
    /// desktop app) to the foreground. `representedObject` is the app's bundle
    /// identifier, captured by the hook and threaded through the daemon.
    @objc private func openSessionApp(_ sender: NSMenuItem) {
        guard let bundleId = sender.representedObject as? String, !bundleId.isEmpty else { return }
        let ws = NSWorkspace.shared
        guard let url = ws.urlForApplication(withBundleIdentifier: bundleId) else {
            // App isn't installed / resolvable on this machine — fail quietly
            // with a beep rather than silently doing nothing.
            NSSound.beep()
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        ws.openApplication(at: url, configuration: config, completionHandler: nil)
    }

    /// Friendly display name for a bundle id (e.g. "com.mitchellh.ghostty" →
    /// "Ghostty"). Returns nil when the app can't be resolved on this machine.
    static func appDisplayName(forBundleId bundleId: String) -> String? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            return nil
        }
        if let name = (try? url.resourceValues(forKeys: [.localizedNameKey]))?.localizedName {
            return name.hasSuffix(".app") ? String(name.dropLast(4)) : name
        }
        return url.deletingPathExtension().lastPathComponent
    }

    @objc private func toggleFollow(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        // If this session is already followed → unfollow (back to aggregate).
        // Otherwise → follow it.
        let target: String? = (sender.state == .on) ? nil : id
        Task { await configStore.setFollowedSession(target) }
    }

    @objc private func stopFollowing() {
        Task { await configStore.setFollowedSession(nil) }
    }

    @objc private func toggleFloatingWidget() {
        ui.floatingWindowEnabled.toggle()
    }

    /// Pretty label for a session: home-abbreviated cwd if available, else
    /// the first 8 chars of the session id.
    static func prettySessionLabel(_ session: SessionDetail) -> String? {
        if let cwd = session.cwd, !cwd.isEmpty {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            return cwd.hasPrefix(home) ? "~" + cwd.dropFirst(home.count) : cwd
        }
        return nil
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
    private func sessionRowAttributedTitle(_ session: SessionDetail, nowMs: Int, suffix: String? = nil, appName: String? = nil) -> NSAttributedString {
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
        if session.autopilot == true {
            // Compact badge so the user can tell at a glance which streams
            // are autonomous and explains why awaiting_input never appears
            // for them.
            attr.append(NSAttributedString(
                string: "  ⚡︎ autopilot",
                attributes: [
                    .font: NSFont.menuFont(ofSize: 0),
                    .foregroundColor: NSColor.systemYellow.withAlphaComponent(0.85),
                ]
            ))
        }
        // Owning app hint (e.g. "↗ Ghostty") so the user can see — and is
        // reminded they can click to focus — where each stream is running.
        if let appName = appName, !appName.isEmpty {
            attr.append(NSAttributedString(
                string: "  ↗ " + appName,
                attributes: [
                    .font: NSFont.menuFont(ofSize: 0),
                    .foregroundColor: NSColor.tertiaryLabelColor,
                ]
            ))
        }
        if let suffix = suffix, !suffix.isEmpty {
            attr.append(NSAttributedString(
                string: suffix,
                attributes: [
                    .font: NSFont.menuFont(ofSize: 0),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]
            ))
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
