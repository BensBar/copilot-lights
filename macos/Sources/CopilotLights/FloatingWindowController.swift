import AppKit
import SwiftUI
import Combine

/// Borderless always-on-top NSPanel hosting a SwiftUI status orb. Hidden /
/// shown based on `UISettings.floatingWindowEnabled`. Window frame persists
/// across launches via UISettings.
@MainActor
final class FloatingWindowController {
    private var window: NSPanel?
    private let daemonClient: DaemonClient
    private let ui: UISettings
    private let configStore: ConfigStore
    private var cancellables: Set<AnyCancellable> = []
    private let viewModel = FloatingViewModel()

    init(daemonClient: DaemonClient, ui: UISettings, configStore: ConfigStore) {
        self.daemonClient = daemonClient
        self.ui = ui
        self.configStore = configStore
        observeStatus()
        observeUISettings()
        if ui.floatingWindowEnabled { show() }
    }

    private func observeStatus() {
        Task {
            for await status in await daemonClient.statusPublisher.values {
                await MainActor.run { self.viewModel.apply(status, configStore: self.configStore) }
            }
        }
    }

    private func observeUISettings() {
        ui.$floatingWindowEnabled.sink { [weak self] enabled in
            Task { @MainActor in
                if enabled { self?.show() } else { self?.hide() }
            }
        }.store(in: &cancellables)
    }

    private func show() {
        if let w = window { w.orderFrontRegardless(); return }
        let frame = ui.floatingWindowFrame
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false

        let host = NSHostingView(rootView: FloatingWindowRoot(viewModel: viewModel, configStore: configStore))
        panel.contentView = host

        // Persist frame changes.
        let observer = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.persistFrame() }
        }
        let resObs = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification, object: panel, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.persistFrame() }
        }
        objc_setAssociatedObject(panel, "obs1", observer, .OBJC_ASSOCIATION_RETAIN)
        objc_setAssociatedObject(panel, "obs2", resObs, .OBJC_ASSOCIATION_RETAIN)

        panel.orderFrontRegardless()
        self.window = panel
    }

    private func hide() {
        window?.close()
        window = nil
    }

    private func persistFrame() {
        guard let w = window else { return }
        ui.floatingWindowFrame = w.frame
    }
}

@MainActor
final class FloatingViewModel: ObservableObject {
    @Published var state: String = "off"
    @Published var sessions: Int = 0
    @Published var sessionList: [SessionDetail] = []
    @Published var followedSessionId: String? = nil
    @Published var color: String = "#888888"
    @Published var brightness: Int = 50
    @Published var effect: String = "steady"
    @Published var periodMs: Int? = nil
    @Published var online: Bool = false

    func apply(_ result: PollResult, configStore: ConfigStore? = nil) {
        switch result {
        case .ok(let r):
            online = true
            state = r.state
            sessions = r.sessions
            sessionList = r.sessionList ?? []
            followedSessionId = r.followedSessionId
            // Prefer the *configured style* for the resolved state name so
            // the orb color tracks the displayed word exactly. Fall back to
            // the daemon's tween frame only when no config is available.
            if let store = configStore {
                let style = store.doc.style(for: r.state)
                color = style.color
                brightness = style.brightness
            } else if let f = r.frame {
                color = f.rgb.hexString
                brightness = f.brightness
            }
        case .offline, .error:
            online = false
            sessionList = []
            followedSessionId = nil
        }
    }
}

struct FloatingWindowRoot: View {
    @ObservedObject var viewModel: FloatingViewModel
    let configStore: ConfigStore
    @State private var showingSessions = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.black.opacity(0.55))
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(spacing: 6) {
                GlowingCopilotMark(
                    colorHex: viewModel.color,
                    brightness: viewModel.brightness,
                    size: 56,
                    online: viewModel.online
                )
                Text(viewModel.online ? viewModel.state.replacingOccurrences(of: "_", with: " ").capitalized : "Offline")
                    .font(.headline)
                    .foregroundStyle(.white)
                followingBadge
                sessionsLabel
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(minWidth: 160, minHeight: 140)
    }

    /// Compact "★ Following <name> ⓧ" pill shown whenever a single session is
    /// being followed. Tapping the ⓧ clears the follow back to aggregate.
    @ViewBuilder
    private var followingBadge: some View {
        if let fid = viewModel.followedSessionId {
            let followed = viewModel.sessionList.first(where: { $0.id == fid })
            HStack(spacing: 4) {
                Image(systemName: "star.fill").font(.system(size: 9))
                Text(prettyLabel(for: followed, fallbackId: fid))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Button {
                    Task { await configStore.setFollowedSession(nil) }
                } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .help("Stop following — go back to aggregating all sessions")
            }
            .font(.caption2)
            .foregroundStyle(.yellow)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.yellow.opacity(0.12), in: Capsule())
        }
    }

    private func prettyLabel(for session: SessionDetail?, fallbackId: String) -> String {
        guard let session = session else { return String(fallbackId.prefix(8)) + "…" }
        if let cwd = session.cwd, !cwd.isEmpty {
            let home = NSHomeDirectory()
            if cwd == home { return "~" }
            if cwd.hasPrefix(home + "/") { return "~" + cwd.dropFirst(home.count) }
            return cwd
        }
        return String(session.id.prefix(8)) + "…"
    }

    @ViewBuilder
    private var sessionsLabel: some View {
        if !viewModel.online {
            Text("daemon offline")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.7))
        } else if viewModel.sessionList.isEmpty {
            Text("\(viewModel.sessions) session\(viewModel.sessions == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.7))
        } else {
            Button {
                showingSessions.toggle()
            } label: {
                HStack(spacing: 4) {
                    Text("\(viewModel.sessions) session\(viewModel.sessions == 1 ? "" : "s")")
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                }
                .font(.caption)
                .foregroundStyle(.white.opacity(0.85))
                .underline()
            }
            .buttonStyle(.plain)
            .help("Click to pick a session to follow, or reveal a session's working directory")
            .popover(isPresented: $showingSessions, arrowEdge: .bottom) {
                SessionListPopover(
                    sessions: viewModel.sessionList,
                    followedSessionId: viewModel.followedSessionId,
                    configStore: configStore
                )
            }
        }
    }
}

struct SessionListPopover: View {
    let sessions: [SessionDetail]
    let followedSessionId: String?
    let configStore: ConfigStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Sessions")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if followedSessionId != nil {
                    Button("Show all") {
                        Task { await configStore.setFollowedSession(nil) }
                    }
                    .font(.caption2)
                    .buttonStyle(.borderless)
                    .help("Stop following the selected session")
                }
            }
            Text("Click ★ to follow one session (the bulb tracks only that session). Click the path to reveal it in Finder.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Divider()
            ForEach(sessions) { session in
                SessionRow(
                    session: session,
                    isFollowed: session.id == followedSessionId,
                    onToggleFollow: {
                        let target: String? = (session.id == followedSessionId) ? nil : session.id
                        Task { await configStore.setFollowedSession(target) }
                    }
                )
            }
        }
        .padding(12)
        .frame(minWidth: 320, maxWidth: 460)
    }
}

struct SessionRow: View {
    let session: SessionDetail
    let isFollowed: Bool
    let onToggleFollow: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button(action: onToggleFollow) {
                Image(systemName: isFollowed ? "star.fill" : "star")
                    .foregroundStyle(isFollowed ? .yellow : .secondary)
                    .font(.system(size: 13))
            }
            .buttonStyle(.plain)
            .help(isFollowed ? "Unfollow this session" : "Follow this session — the bulb will track only it")

            VStack(alignment: .leading, spacing: 2) {
                Text(displayPath)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(session.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { reveal() }
            .help(session.cwd ?? "(unknown working directory)")
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
    }

    private var displayPath: String {
        guard let cwd = session.cwd else { return "(unknown working directory)" }
        let home = NSHomeDirectory()
        if cwd == home { return "~" }
        if cwd.hasPrefix(home + "/") {
            return "~" + cwd.dropFirst(home.count)
        }
        return cwd
    }

    private func reveal() {
        guard let cwd = session.cwd else { return }
        let url = URL(fileURLWithPath: cwd, isDirectory: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
