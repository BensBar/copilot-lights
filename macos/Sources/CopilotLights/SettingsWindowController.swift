import AppKit
import SwiftUI

/// Owns a single, reusable Settings window hosting `SettingsView`.
///
/// Menu-bar-only (`.accessory`) apps can't reliably drive SwiftUI's
/// `Settings` scene via `showSettingsWindow:` — the responder chain isn't
/// wired up without a real app window, so the action silently no-ops. That
/// was the root cause of "Settings doesn't load." Hosting the same SwiftUI
/// view in an `NSWindow` we control removes that dependency entirely: the
/// window always opens, on the active Space, and focuses if already open.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let configStore: ConfigStore
    private let uiSettings: UISettings

    init(configStore: ConfigStore, uiSettings: UISettings) {
        self.configStore = configStore
        self.uiSettings = uiSettings
        super.init()
    }

    /// Show (creating if needed) and focus the Settings window.
    func show() {
        // Promote to a regular app while settings are open so the window can
        // take keyboard focus and show in the Dock/⌘-Tab; we drop back to
        // `.accessory` in `windowWillClose`.
        NSApp.setActivationPolicy(.regular)

        if window == nil {
            let root = SettingsView()
                .environmentObject(configStore)
                .environmentObject(uiSettings)

            let hosting = NSHostingController(rootView: root)
            let win = NSWindow(contentViewController: hosting)
            win.title = "Copilot Lights Settings"
            win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            win.setContentSize(NSSize(width: 760, height: 520))
            win.contentMinSize = NSSize(width: 640, height: 420)
            win.isReleasedWhenClosed = false
            win.identifier = NSUserInterfaceItemIdentifier("copilot-lights-settings")
            win.center()
            win.delegate = self
            window = win
        }

        guard let window = window else { return }
        window.collectionBehavior.insert(.moveToActiveSpace)

        // Bring to front above other apps' windows. `orderFrontRegardless`
        // is the key: without it the window can open *behind* the frontmost
        // app (e.g. the terminal) because activation from a menu-bar
        // `.accessory` context isn't immediate. Re-assert on the next runloop
        // tick once the `.regular` policy change has settled.
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.main.async { [weak window] in
            NSApp.activate(ignoringOtherApps: true)
            window?.makeKeyAndOrderFront(nil)
            window?.orderFrontRegardless()
        }
    }

    func windowWillClose(_ notification: Notification) {
        // Return to menu-bar-only so the app leaves the Dock when settings
        // are dismissed. The window is retained (not released) for reuse.
        NSApp.setActivationPolicy(.accessory)
    }
}
