import AppKit

/// Geometry for the Copilot mark, expressed as a single even-odd `NSBezierPath`
/// scaled into a target rect.
///
/// We previously loaded `copilot-mark.svg` via `NSImage(contentsOfFile:)`, but
/// AppKit does not actually rasterize arbitrary SVGs — the image returned
/// drew as a featureless rectangle, which is why both the menu-bar icon and
/// the .app icon previously rendered as a solid black tile with no mark
/// visible. Hand-porting the primitives here makes the mark deterministic
/// across both surfaces and removes the SVG dependency from the runtime.
///
/// Coordinates are in the SVG's `viewBox 0 0 14 14` space (y-down) and
/// converted to Cocoa space (y-up) by `ty = 14 - y`. Keep this file in sync
/// with `Sources/CopilotLights/Resources/copilot-mark.svg`.
enum CopilotMarkPath {
    /// Mouth expression to draw on the mark. Driven by the resolved
    /// daemon state so the icon reads as "happy / focused / unhappy"
    /// in addition to the colour swatch.
    enum Mouth {
        case neutral
        case smile
        case frown

        /// Map the resolved daemon state name to a mouth expression.
        /// Ready is a smile, error is a frown; everything in between
        /// (thinking, awaiting_input, done) is the neutral slot so the
        /// active states don't over-emote. Shared by the menu-bar
        /// status item and the floating widget so they always match.
        static func `for`(state: String) -> Mouth {
            switch state {
            case "ready": return .smile
            case "error": return .frown
            default:      return .neutral
            }
        }
    }

    /// Build a single even-odd path that, when filled, draws the Copilot mark
    /// (head + ears + antenna) with the eye / mouth holes punched through.
    static func path(in rect: NSRect, mouth: Mouth = .neutral) -> NSBezierPath {
        let scale = rect.width / 14.0
        func tx(_ x: CGFloat) -> CGFloat { rect.minX + x * scale }
        func ty(_ y: CGFloat) -> CGFloat { rect.minY + (14.0 - y) * scale }
        func sr(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
            NSRect(x: tx(x), y: ty(y + h), width: w * scale, height: h * scale)
        }

        let path = NSBezierPath()
        path.windingRule = .evenOdd

        // Antenna rod + ball.
        path.append(NSBezierPath(rect: sr(6.55, 1.0, 0.9, 1.6)))
        let ballRect = NSRect(
            x: tx(7 - 0.8),
            y: ty(0.8 + 0.8),
            width: 1.6 * scale,
            height: 1.6 * scale
        )
        path.append(NSBezierPath(ovalIn: ballRect))

        // Ears.
        path.append(NSBezierPath(
            roundedRect: sr(0.6, 6.2, 1.4, 2.8),
            xRadius: 0.5 * scale, yRadius: 0.5 * scale))
        path.append(NSBezierPath(
            roundedRect: sr(12.0, 6.2, 1.4, 2.8),
            xRadius: 0.5 * scale, yRadius: 0.5 * scale))

        // Head.
        path.append(NSBezierPath(
            roundedRect: sr(2, 3, 10, 8),
            xRadius: 2 * scale, yRadius: 2 * scale))

        // Eye cutouts (subtracted by even-odd fill rule).
        let leftEye  = NSRect(x: tx(5 - 1), y: ty(6.4 + 1), width: 2 * scale, height: 2 * scale)
        let rightEye = NSRect(x: tx(9 - 1), y: ty(6.4 + 1), width: 2 * scale, height: 2 * scale)
        path.append(NSBezierPath(ovalIn: leftEye))
        path.append(NSBezierPath(ovalIn: rightEye))

        // Mouth cutout — flat slot, smile crescent, or frown crescent.
        switch mouth {
        case .neutral:
            path.append(NSBezierPath(rect: sr(5, 8.8, 4, 0.7)))
        case .smile:
            path.append(makeCrescent(leftX: 5, rightX: 9, baselineY: 8.6,
                                      thickness: 0.7, bow: 0.9,
                                      tx: tx, ty: ty))
        case .frown:
            path.append(makeCrescent(leftX: 5, rightX: 9, baselineY: 9.2,
                                      thickness: 0.7, bow: -0.9,
                                      tx: tx, ty: ty))
        }

        return path
    }

    /// Build a filled crescent between two SVG-space x coordinates, used
    /// for the smile / frown mouths. `bow > 0` curves the shape downward
    /// in SVG space (= smile in screen space, since SVG y is flipped);
    /// `bow < 0` curves it upward (frown). The crescent is two quadratic
    /// curves stacked `thickness` apart, joined into one closed path so
    /// it can be appended to the main even-odd mark path as a cutout.
    private static func makeCrescent(
        leftX: CGFloat,
        rightX: CGFloat,
        baselineY: CGFloat,
        thickness: CGFloat,
        bow: CGFloat,
        tx: (CGFloat) -> CGFloat,
        ty: (CGFloat) -> CGFloat
    ) -> NSBezierPath {
        let midX = (leftX + rightX) / 2
        // Top edge of the crescent (in SVG y-down terms).
        let topLeft  = NSPoint(x: tx(leftX),  y: ty(baselineY))
        let topRight = NSPoint(x: tx(rightX), y: ty(baselineY))
        let topCtl   = NSPoint(x: tx(midX),   y: ty(baselineY + bow))
        // Bottom edge runs parallel, offset by `thickness` in SVG-y.
        let botLeft  = NSPoint(x: tx(leftX),  y: ty(baselineY + thickness))
        let botRight = NSPoint(x: tx(rightX), y: ty(baselineY + thickness))
        let botCtl   = NSPoint(x: tx(midX),   y: ty(baselineY + bow + thickness))

        let p = NSBezierPath()
        p.move(to: topLeft)
        // NSBezierPath has only cubic curves; emulate the quadratic by
        // using the same control point twice.
        p.curve(to: topRight, controlPoint1: topCtl, controlPoint2: topCtl)
        p.line(to: botRight)
        p.curve(to: botLeft, controlPoint1: botCtl, controlPoint2: botCtl)
        p.close()
        return p
    }
}
