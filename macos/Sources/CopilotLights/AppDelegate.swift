import AppKit
import Combine
import Carbon.HIToolbox

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItemController: StatusItemController!
    private var menuBuilder: MenuBuilder!
    private var floatingController: FloatingWindowController!
    private var settingsWindowController: SettingsWindowController!
    private var overlayHotKey: GlobalHotKey?
    let daemonClient = DaemonClient()
    let configStore = ConfigStore()
    let uiSettings = UISettings()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        settingsWindowController = SettingsWindowController(configStore: configStore, uiSettings: uiSettings)
        statusItemController = StatusItemController(daemonClient: daemonClient, configStore: configStore)
        menuBuilder = MenuBuilder(daemonClient: daemonClient, configStore: configStore, ui: uiSettings, settingsWindow: settingsWindowController)
        floatingController = FloatingWindowController(daemonClient: daemonClient, ui: uiSettings, configStore: configStore)

        statusItemController.setup()
        statusItemController.setMenu(menuBuilder.buildMenu())

        // Global hotkey ⌥⇧L toggles the floating overlay window from anywhere.
        // Hardcoded for now; a Settings shortcut field can come later.
        overlayHotKey = GlobalHotKey(
            keyCode: UInt32(kVK_ANSI_L),
            modifiers: UInt32(optionKey | shiftKey)
        ) { [weak self] in
            Task { @MainActor in
                self?.uiSettings.floatingWindowEnabled.toggle()
            }
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        Task {
            await daemonClient.stop()
        }
    }
}
