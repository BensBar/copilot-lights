import SwiftUI
import AppKit

/// Loads the colorful Copilot robot SVG from app resources and renders it as
/// a SwiftUI `Image`. Falls back to a tinted `cpu` symbol if the asset can't
/// be located (e.g. when running tests outside the .app bundle).
struct RobotIconView: View {
    let size: CGFloat

    var body: some View {
        if let nsImage = RobotIconView.loadColorRobot() {
            Image(nsImage: nsImage)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "cpu")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
        }
    }

    static func loadColorRobot() -> NSImage? {
        if let resourcePath = Bundle.main.resourcePath {
            let direct = (resourcePath as NSString).appendingPathComponent("copilot-robot-color.svg")
            if FileManager.default.fileExists(atPath: direct),
               let img = NSImage(contentsOfFile: direct) {
                return img
            }
        }
        let bundleName = "CopilotLightsMenuBar_CopilotLightsMenuBar.bundle"
        if let bundleURL = Bundle.main.resourceURL?.appendingPathComponent(bundleName),
           let bundle = Bundle(url: bundleURL),
           let url = bundle.url(forResource: "copilot-robot-color", withExtension: "svg") {
            return NSImage(contentsOf: url)
        }
        return nil
    }
}
