import SwiftUI
import AppKit

/// Tinted Copilot mark with a soft state-colored glow halo. Used in the
/// floating window in place of the old StateOrb + multicolor robot pair, so
/// the on-screen widget mirrors the menu-bar icon: same mark, same color,
/// but bigger and surrounded by light.
struct GlowingCopilotMark: View {
    /// Hex color string (e.g. "#4ade80"). Falls back to gray on parse failure.
    let colorHex: String
    /// 0–100. Scales glow intensity (not the mark's opacity — the mark stays
    /// fully opaque so the silhouette reads cleanly at any state).
    let brightness: Int
    /// Diameter of the mark in points. The glow extends beyond this.
    let size: CGFloat
    /// When false, the mark is drawn desaturated and the glow is suppressed.
    let online: Bool

    private var tint: Color {
        guard online else { return Color(white: 0.55) }
        return Color(hex: colorHex) ?? Color(white: 0.55)
    }

    /// Glow opacity scales with brightness so dim states (`ready` at 30%)
    /// don't bloom as aggressively as bright ones (`error` at 85%, `awaiting`
    /// at 75%).
    private var glowOpacity: Double {
        guard online else { return 0 }
        let b = max(0, min(100, brightness))
        // Floor at 0.35 so even low-brightness states still read as "on".
        return 0.35 + (Double(b) / 100.0) * 0.45
    }

    var body: some View {
        ZStack {
            if online {
                // Two-layer glow: a wide soft halo + a tighter bloom right
                // around the silhouette.
                Circle()
                    .fill(tint.opacity(glowOpacity * 0.55))
                    .frame(width: size * 1.55, height: size * 1.55)
                    .blur(radius: size * 0.45)
                Circle()
                    .fill(tint.opacity(glowOpacity))
                    .frame(width: size * 1.05, height: size * 1.05)
                    .blur(radius: size * 0.22)
            }

            CopilotMarkImage(tint: tint)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
        .frame(width: size * 1.6, height: size * 1.6)
    }
}

/// SwiftUI wrapper that renders the bundled `copilot-mark.svg` template
/// silhouette filled with the given color. Same compositing trick as
/// `StatusItemController.drawTintedMark` so the menubar and floating window
/// always look like the same icon in the same color.
private struct CopilotMarkImage: View {
    let tint: Color

    var body: some View {
        if let template = CopilotMarkAsset.shared.image {
            Canvas { ctx, size in
                let rect = CGRect(origin: .zero, size: size)
                ctx.draw(Image(nsImage: template), in: rect)
                ctx.fill(
                    Path(rect),
                    with: .color(tint),
                    style: FillStyle()
                )
            }
            .compositingGroup()
            .mask(
                Image(nsImage: template)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            )
        } else {
            Image(systemName: "cpu")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(tint)
        }
    }
}

/// One-time loader for `copilot-mark.svg`. Shared between the floating
/// window and the menu-bar status item so we only have one bundle-lookup
/// path to maintain.
final class CopilotMarkAsset {
    static let shared = CopilotMarkAsset()

    let image: NSImage?

    private init() {
        self.image = Self.load()
    }

    private static func load() -> NSImage? {
        if let resourcePath = Bundle.main.resourcePath {
            let svgPath = (resourcePath as NSString).appendingPathComponent("copilot-mark.svg")
            if let img = NSImage(contentsOfFile: svgPath) {
                return img
            }
        }
        let bundleName = "CopilotLightsMenuBar_CopilotLightsMenuBar.bundle"
        if let bundleURL = Bundle.main.resourceURL?.appendingPathComponent(bundleName),
           let bundle = Bundle(url: bundleURL),
           let url = bundle.url(forResource: "copilot-mark", withExtension: "svg") {
            return NSImage(contentsOf: url)
        }
        return nil
    }
}
