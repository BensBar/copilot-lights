import SwiftUI

/// Root settings view rendered inside the SwiftUI `Settings` scene. Sidebar
/// nav over the four configurable areas. Each pane reads/writes through the
/// shared `ConfigStore`, which auto-saves and reloads the daemon when the
/// user clicks Save.
struct SettingsView: View {
    @EnvironmentObject var store: ConfigStore
    @EnvironmentObject var ui: UISettings
    @State private var selection: SettingsPane = .adapter

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    HStack(spacing: 10) {
                        RobotIconView(size: 28)
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Copilot Lights").font(.headline)
                            Text("Settings").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Label("Adapter", systemImage: "cpu").tag(SettingsPane.adapter)
                Label("Home Assistant", systemImage: "house").tag(SettingsPane.homeAssistant)
                Label("Philips Hue", systemImage: "lightbulb.led").tag(SettingsPane.hue)
                Label("Govee", systemImage: "lightbulb").tag(SettingsPane.govee)
                Label("State Styles", systemImage: "paintpalette").tag(SettingsPane.styles)
                Label("Test", systemImage: "bolt.horizontal.circle").tag(SettingsPane.test)
                Label("Desktop Surfaces", systemImage: "rectangle.on.rectangle").tag(SettingsPane.desktop)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            Group {
                switch selection {
                case .adapter:        AdapterPane()
                case .homeAssistant:  HomeAssistantPane()
                case .hue:            HuePane()
                case .govee:          GoveePane()
                case .styles:         StateStylesPane()
                case .test:           TestPane()
                case .desktop:        DesktopSurfacesPane()
                }
            }
            .frame(minWidth: 460, minHeight: 380)
            .padding(20)
        }
        .frame(minWidth: 720, minHeight: 460)
    }
}

enum SettingsPane: Hashable {
    case adapter, homeAssistant, hue, govee, styles, test, desktop
}

// MARK: - Adapter

struct AdapterPane: View {
    @EnvironmentObject var store: ConfigStore

    var body: some View {
        Form {
            Section("Active light adapters") {
                Text("Enable any combination — Copilot Lights drives all enabled backends at once. Configure each under its own tab first.")
                    .foregroundStyle(.secondary)
                    .font(.callout)
                ForEach(realAdapters) { kind in
                    Toggle(isOn: binding(for: kind)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(kind.label)
                            Text(adapterHelp(kind))
                                .foregroundStyle(.secondary)
                                .font(.caption)
                            if !isConfigured(kind) {
                                Text("Not configured yet — open the \(kind.label) tab to set it up.")
                                    .foregroundStyle(.orange)
                                    .font(.caption2)
                            }
                        }
                    }
                    .disabled(!isConfigured(kind))
                }
                Toggle(isOn: mockBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(AdapterKind.mock.label)
                        Text(adapterHelp(.mock)).foregroundStyle(.secondary).font(.caption)
                    }
                }
            }
            Section {
                Text(summaryLine).foregroundStyle(.secondary).font(.callout)
            }
            HStack {
                Spacer()
                Button("Save") { store.save() }.keyboardShortcut(.defaultAction)
            }
            if let err = store.lastError {
                Text(err).foregroundStyle(.red).font(.callout)
            }
            if let r = store.lastReloadResult {
                Text("Daemon: \(r.prefix(220))").foregroundStyle(.secondary).font(.caption)
            }
        }
        .formStyle(.grouped)
    }

    private var realAdapters: [AdapterKind] {
        AdapterKind.allCases.filter { $0 != .mock }
    }

    private var enabled: [AdapterKind] { store.doc.enabledAdapters }

    private func binding(for kind: AdapterKind) -> Binding<Bool> {
        Binding(
            get: { store.doc.enabledAdapters.contains(kind) },
            set: { store.setAdapterEnabled(kind, $0) }
        )
    }

    /// Mock is "on" only when no real backend is enabled (it's the fallback).
    private var mockBinding: Binding<Bool> {
        Binding(
            get: { store.doc.enabledAdapters == [.mock] },
            set: { on in
                if on { store.setAdapters([]) } // collapses to mock fallback
            }
        )
    }

    private var summaryLine: String {
        let active = enabled.map { $0.label }.joined(separator: ", ")
        if enabled == [.mock] {
            return "No real lights are enabled. State changes are tracked but not applied."
        }
        return "Driving: \(active)."
    }

    private func isConfigured(_ kind: AdapterKind) -> Bool {
        switch kind {
        case .govee:         return !(store.doc.govee?.devices.isEmpty ?? true)
        case .hue:           return store.doc.hue != nil && !(store.doc.hue?.lightIds.isEmpty ?? true)
        case .homeAssistant: return store.doc.homeAssistant != nil && !(store.doc.homeAssistant?.entities.isEmpty ?? true)
        case .mock:          return true
        }
    }

    private func adapterHelp(_ kind: AdapterKind) -> String {
        switch kind {
        case .homeAssistant: return "Drives lights via Home Assistant's REST API."
        case .hue:           return "Drives lights via a local Philips Hue bridge."
        case .govee:         return "Drives Govee bulbs/strips over your local network (LAN API)."
        case .mock:          return "No real lights. State is tracked but not applied. Auto-used when nothing else is enabled."
        }
    }
}

// MARK: - Home Assistant

struct HomeAssistantPane: View {
    @EnvironmentObject var store: ConfigStore
    @State private var baseUrl: String = ""
    @State private var token: String = ""
    @State private var tokenPlaceholder: String = ""
    @State private var entities: [HAEntity] = []
    @State private var selectedEntities: Set<String> = []
    @State private var loading = false
    @State private var statusMsg: String?
    @State private var entitySearch: String = ""
    @State private var blinkingId: String?
    private let client = HAEntityClient()

    var body: some View {
        Form {
            Section("Connection") {
                TextField("Base URL", text: $baseUrl, prompt: Text("http://homeassistant.local:8123"))
                    .textFieldStyle(.roundedBorder)
                SecureField("Long-lived access token", text: $token, prompt: Text(tokenPlaceholder))
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("Test Connection", action: testConnection).disabled(loading || baseUrl.isEmpty)
                    Button("Load entities…", action: loadEntities).disabled(loading || baseUrl.isEmpty)
                    if loading { ProgressView().controlSize(.small) }
                    Spacer()
                    if let s = statusMsg {
                        Text(s).font(.callout).foregroundStyle(s.hasPrefix("✓") ? .green : .red)
                    }
                }
            }
            Section("Entities (\(selectedEntities.count) selected)") {
                if entities.isEmpty {
                    Text("Click \"Load entities…\" to fetch your `light.*` entities from Home Assistant.")
                        .foregroundStyle(.secondary).font(.callout)
                } else {
                    TextField("Search", text: $entitySearch)
                        .textFieldStyle(.roundedBorder)
                    HStack(spacing: 12) {
                        Button("Select all") {
                            selectedEntities = Set(filteredEntities.map { $0.entityId })
                        }
                        .disabled(filteredEntities.allSatisfy { selectedEntities.contains($0.entityId) })
                        Button("Select none") {
                            for e in filteredEntities { selectedEntities.remove(e.entityId) }
                        }
                        .disabled(filteredEntities.allSatisfy { !selectedEntities.contains($0.entityId) })
                        Spacer()
                        Text("Tap the wand to blink a light so you can find it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.link)
                    List {
                        ForEach(filteredEntities) { e in
                            HStack(spacing: 8) {
                                Toggle(isOn: Binding(
                                    get: { selectedEntities.contains(e.entityId) },
                                    set: { on in
                                        if on { selectedEntities.insert(e.entityId) }
                                        else { selectedEntities.remove(e.entityId) }
                                    }
                                )) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(e.displayName)
                                        Text(e.entityId).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .toggleStyle(.checkbox)
                                Spacer()
                                Button {
                                    blink(e.entityId, name: e.displayName)
                                } label: {
                                    if blinkingId == e.entityId {
                                        ProgressView().controlSize(.small)
                                    } else {
                                        Image(systemName: "wand.and.rays")
                                    }
                                }
                                .buttonStyle(.borderless)
                                .disabled(blinkingId != nil)
                                .help("Blink this light to locate it")
                            }
                        }
                    }
                    .frame(minHeight: 220)
                }
            }
            HStack {
                Spacer()
                Button("Save") { saveAndReload() }.keyboardShortcut(.defaultAction)
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: hydrate)
    }

    private var filteredEntities: [HAEntity] {
        guard !entitySearch.isEmpty else { return entities }
        let q = entitySearch.lowercased()
        return entities.filter {
            $0.displayName.lowercased().contains(q) || $0.entityId.lowercased().contains(q)
        }
    }

    private func hydrate() {
        let ha = store.doc.homeAssistant
        baseUrl = ha?.baseUrl ?? ""
        if let ref = ha?.token {
            tokenPlaceholder = ref.hasPrefix("keychain:") ? "(stored in Keychain — leave blank to keep)" :
                               ref.hasPrefix("env:") ? "(from environment — leave blank to keep)" :
                               "(stored in config — leave blank to keep)"
        } else {
            tokenPlaceholder = "Paste your long-lived token"
        }
        selectedEntities = Set(ha?.entities ?? [])
    }

    private func testConnection() {
        statusMsg = nil
        loading = true
        Task {
            let secret = effectiveToken()
            guard let s = secret, !s.isEmpty else {
                statusMsg = "(token missing)"; loading = false; return
            }
            if let err = await client.testConnection(baseUrl: baseUrl, token: s) {
                statusMsg = "✗ \(err)"
            } else {
                statusMsg = "✓ Connected"
            }
            loading = false
        }
    }

    private func loadEntities() {
        statusMsg = nil
        loading = true
        Task {
            let secret = effectiveToken()
            guard let s = secret, !s.isEmpty else {
                statusMsg = "(token missing)"; loading = false; return
            }
            do {
                let list = try await client.listLightEntities(baseUrl: baseUrl, token: s)
                entities = list
                statusMsg = "✓ Loaded \(list.count) lights"
            } catch {
                statusMsg = "✗ \(error.localizedDescription)"
            }
            loading = false
        }
    }

    private func effectiveToken() -> String? {
        if !token.isEmpty { return token }
        if let ref = store.doc.homeAssistant?.token { return store.resolveToken(ref) }
        return nil
    }

    /// Blink one HA light through the daemon so the user can locate it. Requires
    /// the connection to be saved (the daemon uses its own configured token).
    private func blink(_ entityId: String, name: String) {
        guard blinkingId == nil else { return }
        blinkingId = entityId
        Task {
            let result = await store.identify(adapter: .homeAssistant, entityId: entityId)
            await MainActor.run {
                blinkingId = nil
                if let result, result.ok {
                    statusMsg = "✓ Blinking \(name)"
                } else if let result {
                    statusMsg = "✗ \(result.error ?? "Blink failed") — Save first so the daemon has your connection."
                } else {
                    statusMsg = "✗ Daemon offline — start Copilot Lights' daemon and retry."
                }
            }
        }
    }

    private func saveAndReload() {
        store.setHomeAssistant(
            baseUrl: baseUrl,
            tokenPlain: token.isEmpty ? nil : token,
            entities: Array(selectedEntities).sorted()
        )
        if !selectedEntities.isEmpty {
            store.enableAdapter(.homeAssistant)
        }
        store.save()
        token = ""           // clear the field; secret now lives in Keychain
        hydrate()            // refresh placeholder
    }
}

// MARK: - State Styles

struct StateStylesPane: View {
    @EnvironmentObject var store: ConfigStore

    var body: some View {
        Form {
            ForEach(CopilotLightsConfigDoc.stateOrder, id: \.self) { name in
                Section(name.replacingOccurrences(of: "_", with: " ").capitalized) {
                    StyleRow(stateName: name)
                }
            }
            HStack {
                Spacer()
                Button("Save") { store.save() }.keyboardShortcut(.defaultAction)
            }
        }
        .formStyle(.grouped)
    }
}

struct StyleRow: View {
    @EnvironmentObject var store: ConfigStore
    let stateName: String
    @State private var localStyle: StateStyle = StateStyle(color: "#888", brightness: 50, effect: "steady")

    private static let effects = ["steady", "breathe", "pulse", "flash"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 14) {
                StateOrb(style: localStyle).frame(width: 38, height: 38)
                ColorPicker("Color", selection: Binding(
                    get: { Color(hex: localStyle.color) ?? .gray },
                    set: { newColor in
                        localStyle.color = newColor.toHex()
                        push()
                    }
                ), supportsOpacity: false)
                .labelsHidden()
                Text(localStyle.color).font(.system(.callout, design: .monospaced))
                Spacer()
            }
            HStack {
                Text("Brightness")
                Slider(value: Binding(
                    get: { Double(localStyle.brightness) },
                    set: { localStyle.brightness = Int($0); push() }
                ), in: 0...100, step: 1)
                Text("\(localStyle.brightness)%").frame(width: 42, alignment: .trailing)
            }
            HStack {
                Picker("Effect", selection: Binding(
                    get: { localStyle.effect },
                    set: { localStyle.effect = $0; push() }
                )) {
                    ForEach(StyleRow.effects, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.menu)
                if localStyle.effect == "breathe" || localStyle.effect == "pulse" {
                    Text("Period (ms)")
                    TextField("ms", value: Binding(
                        get: { localStyle.periodMs ?? 0 },
                        set: { localStyle.periodMs = $0 == 0 ? nil : $0; push() }
                    ), formatter: NumberFormatter())
                    .textFieldStyle(.roundedBorder).frame(width: 80)
                }
                if localStyle.effect == "flash" || localStyle.effect == "pulse" {
                    Text("Count")
                    TextField("n", value: Binding(
                        get: { localStyle.count ?? 0 },
                        set: { localStyle.count = $0 == 0 ? nil : $0; push() }
                    ), formatter: NumberFormatter())
                    .textFieldStyle(.roundedBorder).frame(width: 60)
                }
            }
        }
        .onAppear {
            localStyle = store.doc.states[stateName] ?? StateStyle.defaultFor(stateName)
        }
    }

    private func push() {
        store.setStateStyle(stateName, localStyle)
    }
}

// MARK: - Test pane

struct TestPane: View {
    @State private var lastSent: String?
    private let states: [(name: String, event: String, prompt: String)] = [
        ("ready", "Stop", "End of session"),
        ("thinking", "UserPromptSubmit", "Simulate prompt submit"),
        ("awaiting_input", "Notification", "Simulate notification"),
        ("error", "PostToolUseFailure", "Simulate tool failure"),
        ("done", "Stop", "Simulate done")
    ]

    var body: some View {
        Form {
            Section("Send a test event to the daemon") {
                Text("Each button writes a single hook event to the daemon socket. The lights should follow.")
                    .foregroundStyle(.secondary).font(.callout)
                ForEach(states, id: \.name) { row in
                    HStack {
                        Button(row.prompt) { send(event: row.event) }
                            .frame(width: 220, alignment: .leading)
                        Text("→ \(row.name)").foregroundStyle(.secondary)
                    }
                }
            }
            if let s = lastSent {
                Text(s).font(.callout)
            }
        }
        .formStyle(.grouped)
    }

    private func send(event: String) {
        let session = "settings-test"
        let ts = Int(Date().timeIntervalSince1970 * 1000)
        let body = "{\"kind\":\"event\",\"event\":\"\(event)\",\"sessionId\":\"\(session)\",\"ts\":\(ts)}\n"
        Task.detached {
            _ = await SocketSend.fireAndForget(line: body, socketPath: SocketPath.resolve())
        }
        lastSent = "Sent \(event) → \(Date().formatted(date: .omitted, time: .standard))"
    }
}

// MARK: - Desktop surfaces

struct DesktopSurfacesPane: View {
    @EnvironmentObject var ui: UISettings

    var body: some View {
        Form {
            Section("Floating desktop widget") {
                Toggle("Show floating window", isOn: $ui.floatingWindowEnabled)
                Text("A small always-on-top window with the current state orb. Drag from anywhere on its surface to reposition; the position is remembered.")
                    .foregroundStyle(.secondary).font(.callout)
            }
            Section("Other surfaces") {
                Text("• Menu-bar icon — always on (the colored Copilot mark to the left).\n• WidgetKit (desktop tile / Notification Center) — not yet implemented; would require packaging this app via Xcode for the widget extension.")
                    .foregroundStyle(.secondary).font(.callout)
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Helpers

/// SwiftUI orb that mirrors a state style with a basic effect animation.
struct StateOrb: View {
    let style: StateStyle
    @State private var phase: Double = 0
    @State private var visible = true

    var body: some View {
        Circle()
            .fill(Color(hex: style.color) ?? .gray)
            .opacity(opacityForEffect)
            .overlay(Circle().stroke(.white.opacity(0.15), lineWidth: 0.5))
            .shadow(color: (Color(hex: style.color) ?? .gray).opacity(0.6), radius: 6)
            .onAppear { tick() }
    }

    private var opacityForEffect: Double {
        let bri = Double(max(0, min(100, style.brightness))) / 100.0
        switch style.effect {
        case "breathe":
            let period = Double(style.periodMs ?? 4000)
            return bri * (0.55 + 0.45 * (sin(phase * (2 * .pi / period)) * 0.5 + 0.5))
        case "pulse":
            let period = Double(style.periodMs ?? 1500)
            return bri * (0.4 + 0.6 * abs(sin(phase * (.pi / period))))
        case "flash":
            return visible ? bri : bri * 0.15
        default: return bri
        }
    }

    private func tick() {
        Timer.scheduledTimer(withTimeInterval: 1.0/30.0, repeats: true) { _ in
            phase += 33
            if style.effect == "flash" {
                let cycle = Int(phase / 250) % 2
                visible = cycle == 0
            }
        }
    }
}

extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        let r = Double((v >> 16) & 0xff) / 255.0
        let g = Double((v >> 8) & 0xff) / 255.0
        let b = Double(v & 0xff) / 255.0
        self = Color(red: r, green: g, blue: b)
    }

    func toHex() -> String {
        #if canImport(AppKit)
        let ns = NSColor(self).usingColorSpace(.sRGB) ?? NSColor.white
        let r = Int(round(ns.redComponent * 255))
        let g = Int(round(ns.greenComponent * 255))
        let b = Int(round(ns.blueComponent * 255))
        return String(format: "#%02x%02x%02x", r, g, b)
        #else
        return "#888888"
        #endif
    }
}
