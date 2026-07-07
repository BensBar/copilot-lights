import SwiftUI
import AppKit

/// Tinted Copilot mark with a soft state-colored glow halo. Used in the
/// floating window in place of the old StateOrb + multicolor robot pair, so
/// the on-screen widget mirrors the menu-bar icon: same mark, same color,
/// but bigger and surrounded by light.
struct GlowingCopilotMark: View {
    /// Hex color string (e.g. "#4ade80"). Falls back to gray on parse failure.
    let colorHex: String
    /// 0–100. Both scales the glow intensity AND darkens the mark's fill to the
    /// shade the physical bulb emits at this brightness, so the orb matches the
    /// light's color and shade exactly.
    let brightness: Int
    /// Diameter of the mark in points. The glow extends beyond this.
    let size: CGFloat
    /// When false, the mark is drawn desaturated and the glow is suppressed.
    let online: Bool
    /// Resolved daemon state name (e.g. "ready", "thinking", "error").
    /// Drives the mouth expression so the widget smiles when ready and
    /// frowns on error, matching the menu-bar icon.
    let state: String

    /// Full-saturation hue used for the ambient glow halo. The glow reads as
    /// the light spilling into the air, so it keeps the pure hue and conveys
    /// brightness through opacity (see `glowOpacity`) rather than darkening.
    private var glowHue: NSColor {
        let base: Color
        if online, let parsed = Color(hex: colorHex) {
            base = parsed
        } else {
            base = Color(white: 0.55)
        }
        return NSColor(base)
    }

    /// The mark's fill: the *emitted shade* the bulb actually produces =
    /// hue scaled by brightness. This is what makes the on-screen widget and
    /// the physical light share the exact same color and shade.
    private var tint: NSColor {
        guard online, let parsed = RGBColor.fromHex(colorHex) else {
            return NSColor(Color(white: 0.55))
        }
        let shade = parsed.scaled(byBrightness: brightness)
        return NSColor(
            srgbRed: CGFloat(shade.r) / 255.0,
            green: CGFloat(shade.g) / 255.0,
            blue: CGFloat(shade.b) / 255.0,
            alpha: 1.0
        )
    }

    private var tintSwiftUI: Color { Color(nsColor: glowHue) }

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
                    .fill(tintSwiftUI.opacity(glowOpacity * 0.55))
                    .frame(width: size * 1.55, height: size * 1.55)
                    .blur(radius: size * 0.45)
                Circle()
                    .fill(tintSwiftUI.opacity(glowOpacity))
                    .frame(width: size * 1.05, height: size * 1.05)
                    .blur(radius: size * 0.22)
            }

            CopilotMarkPathView(
                tint: tint,
                mouth: online ? CopilotMarkPath.Mouth.for(state: state) : .neutral
            )
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
        .frame(width: size * 1.6, height: size * 1.6)
    }
}

/// SwiftUI wrapper around an NSView that fills `CopilotMarkPath` with the
/// requested tint and mouth expression. We render via NSBezierPath rather
/// than the bundled SVG so the smile/frown geometry — which only lives in
/// `CopilotMarkPath` — actually shows up in the floating widget.
private struct CopilotMarkPathView: NSViewRepresentable {
    let tint: NSColor
    let mouth: CopilotMarkPath.Mouth

    func makeNSView(context: Context) -> MarkView {
        let view = MarkView()
        view.tint = tint
        view.mouth = mouth
        return view
    }

    func updateNSView(_ nsView: MarkView, context: Context) {
        nsView.tint = tint
        nsView.mouth = mouth
        nsView.needsDisplay = true
    }

    final class MarkView: NSView {
        var tint: NSColor = .labelColor { didSet { needsDisplay = true } }
        var mouth: CopilotMarkPath.Mouth = .neutral { didSet { needsDisplay = true } }

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            // Layer-back the view so SwiftUI's compositor treats it as a
            // single opaque-alpha surface. Without this the host
            // NSHostingView re-renders our draw(_:) output against the
            // transparent panel each frame, which on macOS produces
            // scattered colored grains around the silhouette — looks
            // like blue dots flickering outside the widget.
            wantsLayer = true
            layer?.isOpaque = false
            layer?.backgroundColor = .clear
            layer?.drawsAsynchronously = false
        }

        required init?(coder: NSCoder) {
            super.init(coder: coder)
            wantsLayer = true
            layer?.isOpaque = false
            layer?.backgroundColor = .clear
        }

        override var isFlipped: Bool { false }

        override func draw(_ dirtyRect: NSRect) {
            tint.setFill()
            CopilotMarkPath.path(in: bounds, mouth: mouth).fill()
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
        let bundleName = "CopilotLights_CopilotLights.bundle"
        if let bundleURL = Bundle.main.resourceURL?.appendingPathComponent(bundleName),
           let bundle = Bundle(url: bundleURL),
           let url = bundle.url(forResource: "copilot-mark", withExtension: "svg") {
            return NSImage(contentsOf: url)
        }
        return nil
    }
}
