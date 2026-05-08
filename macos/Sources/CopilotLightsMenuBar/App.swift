import SwiftUI

@main
struct CopilotLightsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsView()
                .environmentObject(appDelegate.configStore)
                .environmentObject(appDelegate.uiSettings)
        }
    }
}
