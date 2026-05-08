import Foundation

/// User preferences for which desktop widget surfaces are enabled and where
/// the floating window lives. Persisted via UserDefaults so it survives
/// restarts. Values are observable so SwiftUI panes can rebind to them.
@MainActor
final class UISettings: ObservableObject {
    @Published var floatingWindowEnabled: Bool {
        didSet { UserDefaults.standard.set(floatingWindowEnabled, forKey: Self.kFloating) }
    }

    @Published var floatingWindowFrame: CGRect {
        didSet {
            let arr = [floatingWindowFrame.origin.x, floatingWindowFrame.origin.y,
                       floatingWindowFrame.size.width, floatingWindowFrame.size.height]
            UserDefaults.standard.set(arr, forKey: Self.kFloatingFrame)
        }
    }

    init() {
        let d = UserDefaults.standard
        self.floatingWindowEnabled = d.bool(forKey: Self.kFloating)
        if let arr = d.array(forKey: Self.kFloatingFrame) as? [Double], arr.count == 4 {
            self.floatingWindowFrame = CGRect(x: arr[0], y: arr[1], width: arr[2], height: arr[3])
        } else {
            self.floatingWindowFrame = CGRect(x: 200, y: 200, width: 220, height: 90)
        }
    }

    private static let kFloating = "ui.floatingWindow.enabled"
    private static let kFloatingFrame = "ui.floatingWindow.frame"
}
