#!/usr/bin/env swift
// Regenerates macos/Icon.iconset/*.png as a black rounded-square tile with the
// white Copilot mark centered. Mirrors StatusItemController's menubar icon so
// the Dock/Finder icon and the menubar badge read as the same brand mark.
//
// Usage: swift macos/Scripts/generate_app_icon.swift

import AppKit
import Foundation

// Resolve macos/ root from this script's location (Scripts/ is one level down).
let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let macosRoot = scriptURL.deletingLastPathComponent().deletingLastPathComponent()
let iconsetDir = macosRoot.appendingPathComponent("Icon.iconset")

// Draw the Copilot mark as a single even-odd NSBezierPath inside `markRect`,
// mirroring the geometry of Sources/CopilotLights/Resources/copilot-mark.svg
// (viewBox 0 0 14 14). NSImage cannot render SVG natively, so we hand-port
// the primitives. Coordinates are in SVG space (y-down) and converted to
// Cocoa space (y-up) by `ty = 14 - y`.
func drawCopilotMark(in markRect: NSRect) {
    let scale = markRect.width / 14.0
    func tx(_ x: CGFloat) -> CGFloat { markRect.minX + x * scale }
    func ty(_ y: CGFloat) -> CGFloat { markRect.minY + (14.0 - y) * scale }
    func sr(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
        // Convert SVG rect (y-down origin = top-left) to Cocoa rect (y-up).
        NSRect(x: tx(x), y: ty(y + h), width: w * scale, height: h * scale)
    }

    let path = NSBezierPath()
    path.windingRule = .evenOdd

    // Antenna rod.
    path.append(NSBezierPath(rect: sr(6.55, 1.0, 0.9, 1.6)))
    // Antenna ball (circle cx=7, cy=0.8, r=0.8).
    let ballRect = NSRect(
        x: tx(7 - 0.8),
        y: ty(0.8 + 0.8),
        width: 1.6 * scale,
        height: 1.6 * scale
    )
    path.append(NSBezierPath(ovalIn: ballRect))
    // Ears (rounded rects, rx=0.5).
    path.append(NSBezierPath(roundedRect: sr(0.6,  6.2, 1.4, 2.8), xRadius: 0.5 * scale, yRadius: 0.5 * scale))
    path.append(NSBezierPath(roundedRect: sr(12.0, 6.2, 1.4, 2.8), xRadius: 0.5 * scale, yRadius: 0.5 * scale))
    // Head (rounded rect 2,3..12,11 with rx=2).
    path.append(NSBezierPath(roundedRect: sr(2, 3, 10, 8), xRadius: 2 * scale, yRadius: 2 * scale))
    // Eye cutouts (r=1 circles at cx=5,9 cy=6.4) — evenodd subtracts these.
    let eyeR = 1.0 * scale
    let leftEye  = NSRect(x: tx(5 - 1), y: ty(6.4 + 1), width: 2 * scale, height: 2 * scale)
    let rightEye = NSRect(x: tx(9 - 1), y: ty(6.4 + 1), width: 2 * scale, height: 2 * scale)
    _ = eyeR
    path.append(NSBezierPath(ovalIn: leftEye))
    path.append(NSBezierPath(ovalIn: rightEye))
    // Mouth cutout (rect 5,8.8..9,9.5).
    path.append(NSBezierPath(rect: sr(5, 8.8, 4, 0.7)))

    NSColor.white.setFill()
    path.fill()
}

// macOS .iconset standard sizes (logical, retina variants).
struct Variant { let filename: String; let pixels: Int }
let variants: [Variant] = [
    Variant(filename: "icon_16x16.png",       pixels: 16),
    Variant(filename: "icon_16x16@2x.png",    pixels: 32),
    Variant(filename: "icon_32x32.png",       pixels: 32),
    Variant(filename: "icon_32x32@2x.png",    pixels: 64),
    Variant(filename: "icon_128x128.png",     pixels: 128),
    Variant(filename: "icon_128x128@2x.png",  pixels: 256),
    Variant(filename: "icon_256x256.png",     pixels: 256),
    Variant(filename: "icon_256x256@2x.png",  pixels: 512),
    Variant(filename: "icon_512x512.png",     pixels: 512),
    Variant(filename: "icon_512x512@2x.png",  pixels: 1024),
]

// Draw one square PNG: black rounded tile + white centered Copilot mark.
func renderIcon(pixels: Int) -> Data? {
    let size = NSSize(width: pixels, height: pixels)
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 32
    ) else { return nil }

    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    let rect = NSRect(origin: .zero, size: size)

    // macOS Big Sur+ app icons use a "squircle" with corner radius ≈ 22.37%
    // of the side length (Apple's macOS app icon template).
    let cornerRadius = CGFloat(pixels) * 0.2237
    let tile = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)
    NSColor.black.setFill()
    tile.fill()

    // Inset the mark inside the tile so the black frame reads cleanly. The
    // menubar uses inset=3/22 ≈ 13.6%; for the larger app icon, a slightly
    // larger relative inset (~22%) gives the mark room to breathe.
    let insetFraction: CGFloat = 0.22
    let inset = CGFloat(pixels) * insetFraction
    let markRect = rect.insetBy(dx: inset, dy: inset)

    // Draw the white Copilot mark using the shared NSBezierPath geometry.
    NSGraphicsContext.current?.imageInterpolation = .high
    drawCopilotMark(in: markRect)

    return bitmap.representation(using: .png, properties: [:])
}

try? FileManager.default.createDirectory(at: iconsetDir, withIntermediateDirectories: true)

for v in variants {
    guard let png = renderIcon(pixels: v.pixels) else {
        FileHandle.standardError.write("ERROR: failed to render \(v.filename)\n".data(using: .utf8)!)
        exit(1)
    }
    let dest = iconsetDir.appendingPathComponent(v.filename)
    try? png.write(to: dest)
    print("wrote \(dest.path) (\(v.pixels)px)")
}

print("Regenerated \(variants.count) icons in \(iconsetDir.path)")
print("Run macos/Scripts/package_app.sh to bake into Icon.icns and the .app bundle.")
