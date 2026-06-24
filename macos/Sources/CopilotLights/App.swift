import SwiftUI

@main
struct CopilotLightsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // The real Settings UI is presented in an AppKit-owned window by
        // `SettingsWindowController` (reliable from a menu-bar `.accessory`
        // app). This empty Settings scene only satisfies SwiftUI's
        // requirement that an App declare at least one Scene.
        Settings {
            EmptyView()
        }
    }
}
