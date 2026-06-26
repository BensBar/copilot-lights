import SwiftUI

/// Settings pane that lets the user discover, add, and configure Govee LAN
/// lights — and apply per-device-type recommended scenes — without touching
/// config.json. Discovery is delegated to the daemon (which owns the Govee
/// adapter + SKU→model catalog) over the Unix socket; this view is a thin
/// consumer that writes the chosen devices/scenes back through `ConfigStore`.
struct GoveePane: View {
    @EnvironmentObject var store: ConfigStore

    /// Unified row that merges already-configured devices with freshly
    /// scanned ones. `model`/`type` are only known after a scan (or for new
    /// scans of previously-saved devices).
    struct Row: Identifiable, Equatable {
        let id: String
        var ip: String
        var sku: String?
        var name: String?
        var mac: String?
        var model: String?
        var type: String?
        var typeLabel: String?
        var configured: Bool
        var found: Bool
    }

    @State private var rows: [Row] = []
    @State private var selected: Set<String> = []
    @State private var scenesByType: [String: [String: StateStyle]] = [:]
    @State private var rationaleByType: [String: String] = [:]
    @State private var scanning = false
    @State private var statusMsg: String?
    @State private var statusOK = false
    @State private var applyScenes = true
    @State private var manualIp = ""
    @State private var manualName = ""
    @State private var blinkingId: String?

    var body: some View {
        Form {
            Section("Discover devices") {
                Text("Enable “LAN Control” for each light in the Govee Home app first (Device Settings → LAN Control). Then scan — the daemon detects each light's model and type automatically.")
                    .foregroundStyle(.secondary).font(.callout)
                HStack {
                    Button(action: scan) {
                        Label("Scan for devices", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .disabled(scanning)
                    if scanning { ProgressView().controlSize(.small) }
                    Spacer()
                    if let s = statusMsg {
                        Text(s).font(.callout).foregroundStyle(statusOK ? .green : .red)
                    }
                }
            }

            Section("Lights (\(selected.count) selected)") {
                if rows.isEmpty {
                    Text("No devices yet. Click “Scan for devices”, or add one manually by IP below.")
                        .foregroundStyle(.secondary).font(.callout)
                } else {
                    HStack(spacing: 12) {
                        Button("Select all") { selected = Set(rows.map { $0.id }) }
                            .disabled(selected.count == rows.count)
                        Button("Select none") { selected.removeAll() }
                            .disabled(selected.isEmpty)
                        Spacer()
                        Text("Tap the wand to blink a light so you can find it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.link)
                    List {
                        ForEach(rows) { row in
                            deviceRow(row)
                        }
                    }
                    .frame(minHeight: 200)
                }
            }

            Section("Add manually") {
                HStack {
                    TextField("Device IP", text: $manualIp, prompt: Text("192.168.1.42"))
                        .textFieldStyle(.roundedBorder)
                    TextField("Name (optional)", text: $manualName, prompt: Text("Desk strip"))
                        .textFieldStyle(.roundedBorder)
                    Button("Add", action: addManual)
                        .disabled(manualIp.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Text("Manually-added lights work right away. Run a scan afterwards to auto-detect their model and type for tailored scenes.")
                    .foregroundStyle(.secondary).font(.caption)
            }

            Section("Recommended scenes") {
                Toggle("Apply recommended scenes for these lights on save", isOn: $applyScenes)
                if applyScenes {
                    Text(sceneRationale)
                        .foregroundStyle(.secondary).font(.callout)
                }
            }

            HStack {
                Spacer()
                Button("Save & use Govee") { save() }.keyboardShortcut(.defaultAction)
            }
            if let err = store.lastError {
                Text(err).foregroundStyle(.red).font(.callout)
            }
            if let r = store.lastReloadResult {
                Text("Daemon: \(r.prefix(220))").foregroundStyle(.secondary).font(.caption)
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: hydrate)
    }

    // MARK: - Subviews

    @ViewBuilder
    private func deviceRow(_ row: Row) -> some View {
        HStack(spacing: 8) {
            Toggle(isOn: binding(for: row.id)) {
                deviceLabel(row)
            }
            .toggleStyle(.checkbox)

            Spacer()

            // Per-device manual type override. Only meaningful once we know an
            // IP (we do) — it persists to config and wins on the next scan.
            Picker("", selection: typeBinding(for: row.id)) {
                Text("Auto").tag("")
                ForEach(GoveeDeviceCatalog.types, id: \.self) { t in
                    Text(GoveeDeviceCatalog.label(t)).tag(t)
                }
            }
            .labelsHidden()
            .frame(width: 130)
            .help("Override the detected device type (drives recommended scenes).")

            Button {
                blink(row)
            } label: {
                if blinkingId == row.id {
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

    @ViewBuilder
    private func deviceLabel(_ row: Row) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(row.name ?? row.model ?? "Govee device")
                if let label = row.typeLabel {
                    Text(label)
                        .font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.secondary.opacity(0.15), in: Capsule())
                }
                if row.configured && !row.found {
                    Text("saved").font(.caption2).foregroundStyle(.secondary)
                } else if row.found && !row.configured {
                    Text("new").font(.caption2).foregroundStyle(.green)
                }
            }
            Text(subtitle(row)).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func subtitle(_ row: Row) -> String {
        var parts: [String] = [row.ip]
        if let m = row.model, row.name != nil { parts.append(m) }
        if let sku = row.sku { parts.append(sku) }
        if let mac = row.mac { parts.append(mac) }
        return parts.joined(separator: " · ")
    }

    // MARK: - State helpers

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { selected.contains(id) },
            set: { on in
                if on { selected.insert(id) } else { selected.remove(id) }
            }
        )
    }

    /// Two-way binding for a row's manual type override. Empty string means
    /// "Auto" (no override) — which clears the row's type so the daemon's
    /// SKU-derived guess is used on the next scan.
    private func typeBinding(for id: String) -> Binding<String> {
        Binding(
            get: { rows.first(where: { $0.id == id })?.type ?? "" },
            set: { newValue in
                guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
                let trimmed = newValue.isEmpty ? nil : newValue
                rows[i].type = trimmed
                rows[i].typeLabel = trimmed.map { GoveeDeviceCatalog.label($0) } ?? rows[i].typeLabel
            }
        )
    }

    /// The device type that should drive the recommended scene set: the most
    /// common known type among the *selected* rows. Ties break toward the
    /// first such type encountered. Returns nil when nothing usable is known.
    private var dominantType: String? {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for row in rows where selected.contains(row.id) {
            guard let t = row.type, t != "unknown", scenesByType[t] != nil else { continue }
            if counts[t] == nil { order.append(t) }
            counts[t, default: 0] += 1
        }
        return order.max(by: { (counts[$0] ?? 0) < (counts[$1] ?? 0) })
    }

    private var sceneRationale: String {
        if let t = dominantType, let r = rationaleByType[t] {
            return "\(t): \(r)"
        }
        return "Scan your lights so their type can be detected. Until then, balanced default scenes are used."
    }

    // MARK: - Actions

    private func hydrate() {
        guard rows.isEmpty else { return }
        let configured = store.doc.govee?.devices ?? []
        rows = configured.map { d in
            Row(id: d.mac ?? d.ip, ip: d.ip, sku: d.sku, name: d.name, mac: d.mac,
                model: nil, type: d.type,
                typeLabel: d.type.map { GoveeDeviceCatalog.label($0) },
                configured: true, found: false)
        }
        selected = Set(rows.map { $0.id })
    }

    /// Blink a single light via the daemon so the user can physically find it.
    private func blink(_ row: Row) {
        guard blinkingId == nil else { return }
        blinkingId = row.id
        Task {
            let result = await store.identify(adapter: .govee, ip: row.ip, mac: row.mac)
            await MainActor.run {
                blinkingId = nil
                if let result, result.ok {
                    statusOK = true
                    statusMsg = "✓ Blinking \(row.name ?? row.model ?? row.ip)"
                } else if let result {
                    statusOK = false
                    statusMsg = "✗ \(result.error ?? "Blink failed")"
                } else {
                    statusOK = false
                    statusMsg = "✗ Daemon offline — start Copilot Lights' daemon and retry."
                }
            }
        }
    }

    private func scan() {
        statusMsg = nil
        scanning = true
        Task {
            let reply = await store.scanGovee()
            await MainActor.run {
                scanning = false
                guard let reply else {
                    statusOK = false
                    statusMsg = "✗ Daemon offline — start Copilot Lights' daemon and retry."
                    return
                }
                if let err = reply.error {
                    statusOK = false
                    statusMsg = "✗ \(err)"
                    return
                }
                scenesByType = reply.scenesByType
                rationaleByType = reply.rationaleByType
                mergeScanned(reply.devices)
                statusOK = true
                statusMsg = "✓ Found \(reply.devices.count) device\(reply.devices.count == 1 ? "" : "s")"
            }
        }
    }

    /// Fold scanned devices into `rows`, matching existing rows by MAC (then
    /// IP) so configured devices get enriched in place rather than duplicated.
    private func mergeScanned(_ devices: [GoveeScanDevice]) {
        for dev in devices {
            let matchIdx = rows.firstIndex(where: {
                ($0.mac != nil && $0.mac == dev.mac) || $0.ip == dev.ip
            })
            if let i = matchIdx {
                rows[i].ip = dev.ip
                rows[i].sku = dev.sku ?? rows[i].sku
                rows[i].mac = dev.mac ?? rows[i].mac
                rows[i].model = dev.model
                // Keep a manual override the user set this session; otherwise
                // adopt the daemon's detected type.
                if rows[i].type == nil {
                    rows[i].type = dev.type
                    rows[i].typeLabel = dev.typeLabel
                }
                rows[i].found = true
                selected.insert(rows[i].id)
            } else {
                let row = Row(id: dev.id, ip: dev.ip, sku: dev.sku, name: nil, mac: dev.mac,
                              model: dev.model, type: dev.type, typeLabel: dev.typeLabel,
                              configured: false, found: true)
                rows.append(row)
                selected.insert(row.id)
            }
        }
    }

    private func addManual() {
        let ip = manualIp.trimmingCharacters(in: .whitespaces)
        guard !ip.isEmpty else { return }
        let name = manualName.trimmingCharacters(in: .whitespaces)
        if let i = rows.firstIndex(where: { $0.ip == ip }) {
            if !name.isEmpty { rows[i].name = name }
            selected.insert(rows[i].id)
        } else {
            let row = Row(id: ip, ip: ip, sku: nil, name: name.isEmpty ? nil : name, mac: nil,
                          model: nil, type: nil, typeLabel: nil, configured: false, found: false)
            rows.append(row)
            selected.insert(row.id)
        }
        manualIp = ""
        manualName = ""
    }

    private func save() {
        let devices: [GoveeDeviceConfig] = rows
            .filter { selected.contains($0.id) }
            .map { GoveeDeviceConfig(ip: $0.ip, sku: $0.sku, name: $0.name, mac: $0.mac, type: $0.type) }

        store.setGoveeDevices(devices)
        store.enableAdapter(.govee)
        if applyScenes, let t = dominantType, let scenes = scenesByType[t] {
            store.applyStateStyles(scenes)
        }
        store.save()
        statusOK = true
        statusMsg = "✓ Saved \(devices.count) light\(devices.count == 1 ? "" : "s") — Govee enabled"
        // Reflect the persisted state (drops deselected rows from "configured").
        for i in rows.indices {
            rows[i].configured = selected.contains(rows[i].id)
        }
    }
}
