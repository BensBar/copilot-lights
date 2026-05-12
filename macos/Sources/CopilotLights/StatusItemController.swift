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

    init(daemonClient: DaemonClient, configStore: ConfigStore) {
        self.daemonClient = daemonClient
        self.configStore = configStore
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
        // Fill the full menubar height with the mark itself — no black tile
        // backdrop. The tile used to act as a frame against busy wallpapers
        // but it made the icon read as a small dim glyph stuck inside a
        // box. Drawing the silhouette directly at 22×22 reads bigger and
        // brighter, and macOS already composites status-bar icons against
        // the menubar's own backdrop blur.
        let size = NSSize(width: 22, height: 22)

        let image = NSImage(size: size, flipped: false) { rect in
            self.drawTintedMark(rect: rect, rgb: rgb, brightness: brightness)
            return true
        }

        image.isTemplate = false
        statusItem?.button?.image = image
    }
    
    private func drawTintedMark(rect: NSRect, rgb: RGBColor, brightness: Int) {
        // Keep the mark crisp on the menubar regardless of the configured
        // bulb brightness. The brightness slider is meant for the physical
        // light — applying it 1:1 to the icon's alpha made dim states
        // (ready @ 30%) almost invisible. Floor at 0.85 so the silhouette
        // always reads, and let brightness only nudge it toward fully
        // opaque from there.
        let b = max(0, min(100, brightness))
        let alpha = 0.85 + (CGFloat(b) / 100.0) * 0.15

        let tintColor = NSColor(
            red: CGFloat(rgb.r) / 255.0,
            green: CGFloat(rgb.g) / 255.0,
            blue: CGFloat(rgb.b) / 255.0,
            alpha: alpha
        )

        tintColor.setFill()
        CopilotMarkPath.path(in: rect, mouth: mouthFor(state: currentState)).fill()
    }

    /// Map the resolved daemon state name to a mouth expression. Ready
    /// is a smile, error is a frown; everything in between is the
    /// original flat slot so the active states (thinking,
    /// awaiting_input, done) read as "neutral working face" rather
    /// than over-emoting.
    private func mouthFor(state: String) -> CopilotMarkPath.Mouth {
        CopilotMarkPath.Mouth.for(state: state)
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
