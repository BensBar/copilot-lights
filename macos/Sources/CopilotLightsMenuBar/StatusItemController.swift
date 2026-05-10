import AppKit
import Combine

@MainActor
class StatusItemController: ObservableObject {
    private var statusItem: NSStatusItem?
    private var cancellables = Set<AnyCancellable>()
    private let daemonClient: DaemonClient
    private let configStore: ConfigStore

    /// One always-on tick. Drives both the colour tween (current → target)
    /// and the pulse on top of it for thinking/awaiting_input. Replaces the
    /// previous setup which restarted a timer on every state change and
    /// snapped colour instantaneously between states.
    private var tickTimer: Timer?
    private let tickInterval: TimeInterval = 0.05  // 20 fps
    /// How much of the remaining gap to close per tick. 0.15 ≈ 250ms to
    /// converge to within 1 part in 1000.
    private let tweenAlpha: Double = 0.15

    private var currentR: Double = 128
    private var currentG: Double = 128
    private var currentB: Double = 128
    private var currentBrightness: Double = 50

    private var targetR: Double = 128
    private var targetG: Double = 128
    private var targetB: Double = 128
    private var targetBrightness: Double = 50

    private var currentState: String = "off"
    private var animationPhase: Double = 0

    private var copilotMarkTemplate: NSImage?

    init(daemonClient: DaemonClient, configStore: ConfigStore) {
        self.daemonClient = daemonClient
        self.configStore = configStore
        self.copilotMarkTemplate = Self.loadCopilotMark()
    }
    
    private static func loadCopilotMark() -> NSImage? {
        // For .app bundle: Resources are in Contents/Resources/
        if let resourcePath = Bundle.main.resourcePath {
            let svgPath = (resourcePath as NSString).appendingPathComponent("copilot-mark.svg")
            if let image = NSImage(contentsOfFile: svgPath) {
                return image
            }
        }
        
        // For SwiftPM resource bundles
        let bundleName = "CopilotLightsMenuBar_CopilotLightsMenuBar.bundle"
        if let bundleURL = Bundle.main.resourceURL?.appendingPathComponent(bundleName),
           let bundle = Bundle(url: bundleURL),
           let url = bundle.url(forResource: "copilot-mark", withExtension: "svg") {
            return NSImage(contentsOf: url)
        }
        
        return nil
    }
    
    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        Task {
            for await status in await daemonClient.statusPublisher.values {
                self.updateTarget(for: status)
            }
        }

        Task {
            await daemonClient.start()
        }

        startTicker()
    }
    
    func setMenu(_ menu: NSMenu) {
        statusItem?.menu = menu
    }
    
    /// Update the tween target colour from the latest poll. The actual icon
    /// is redrawn by the tick timer so we never snap.
    private func updateTarget(for result: PollResult) {
        switch result {
        case .ok(let status):
            // Derive colour from the resolved state name (via config) rather
            // than the daemon's mid-tween frame.rgb. This guarantees the
            // menu-bar icon colour matches the state word the user sees.
            let style = configStore.doc.style(for: status.state)
            let rgb = RGBColor.fromHex(style.color) ?? status.frame?.rgb ?? RGBColor(r: 128, g: 128, b: 128)
            self.targetR = Double(rgb.r)
            self.targetG = Double(rgb.g)
            self.targetB = Double(rgb.b)
            self.targetBrightness = Double(style.brightness)
            self.currentState = status.state
        case .offline, .error:
            self.targetR = 128
            self.targetG = 128
            self.targetB = 128
            self.targetBrightness = 50
            self.currentState = "off"
        }
    }

    private func startTicker() {
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: tickInterval, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            Task { @MainActor in
                self.tick()
            }
        }
        // First draw immediately so the icon isn't blank for ~50ms.
        tick()
    }

    private func tick() {
        // Lerp toward target.
        currentR += (targetR - currentR) * tweenAlpha
        currentG += (targetG - currentG) * tweenAlpha
        currentB += (targetB - currentB) * tweenAlpha
        currentBrightness += (targetBrightness - currentBrightness) * tweenAlpha

        // Pulse for "live" states: thinking (faster, smaller swing) and
        // awaiting_input (slower, larger swing). Steady otherwise.
        animationPhase += 0.1
        let pulse: Double
        switch currentState {
        case "thinking":
            pulse = sin(animationPhase) * 0.30 + 0.70
        case "awaiting_input":
            pulse = sin(animationPhase * 0.5) * 0.45 + 0.55
        default:
            pulse = 1.0
        }

        let drawBrightness = max(0, min(100, Int((currentBrightness * pulse).rounded())))
        let rgb = RGBColor(
            r: max(0, min(255, Int(currentR.rounded()))),
            g: max(0, min(255, Int(currentG.rounded()))),
            b: max(0, min(255, Int(currentB.rounded())))
        )
        setIcon(rgb: rgb, brightness: drawBrightness)
    }
    
    private func setIcon(rgb: RGBColor, brightness: Int) {
        // 20×20 fills the menubar more prominently than the macOS template
        // default of ~14–16. The status item lays out around a 22pt-tall
        // bar so 20 leaves a 1pt vertical breathing strip above and below
        // while making the Copilot mark + halo clearly visible.
        let size = NSSize(width: 20, height: 20)
        
        let image = NSImage(size: size, flipped: false) { rect in
            if let template = self.copilotMarkTemplate {
                self.drawTintedMark(template: template, rect: rect, rgb: rgb, brightness: brightness)
            } else {
                self.drawFallbackCircle(rect: rect, rgb: rgb, brightness: brightness)
            }
            return true
        }
        
        image.isTemplate = false
        statusItem?.button?.image = image
    }
    
    private func drawTintedMark(template: NSImage, rect: NSRect, rgb: RGBColor, brightness: Int) {
        let tintColor = NSColor(
            red: CGFloat(rgb.r) / 255.0,
            green: CGFloat(rgb.g) / 255.0,
            blue: CGFloat(rgb.b) / 255.0,
            alpha: CGFloat(brightness) / 100.0
        )
        
        template.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0)
        
        tintColor.setFill()
        rect.fill(using: .sourceIn)
    }
    
    private func drawFallbackCircle(rect: NSRect, rgb: RGBColor, brightness: Int) {
        let color = NSColor(
            red: CGFloat(rgb.r) / 255.0,
            green: CGFloat(rgb.g) / 255.0,
            blue: CGFloat(rgb.b) / 255.0,
            alpha: CGFloat(brightness) / 100.0
        )
        
        color.setFill()
        let circlePath = NSBezierPath(ovalIn: rect)
        circlePath.fill()
    }
}
