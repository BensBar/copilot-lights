import SwiftUI

/// Settings pane for Philips Hue: enter the bridge connection, discover the
/// bridge's lights via the daemon, blink any light to locate it, select which
/// ones Copilot Lights should drive, and save. Mirrors the Govee/Home Assistant
/// flows (scan · select all/none · blink · save).
///
/// Pairing (obtaining the application key) is a one-time press-the-link-button
/// handshake; the simplest path is the CLI `copilot-lights pair-hue <bridgeIp>`,
/// whose printed key is pasted here. Once the connection is saved, discovery and
/// blink run through the daemon (which holds the key).
struct HuePane: View {
    @EnvironmentObject var store: ConfigStore

    @State private var bridgeIp = ""
    @State private var applicationKey = ""
    @State private var lights: [HueScanLight] = []
    @State private var selected: Set<String> = []
    @State private var scanning = false
    @State private var statusMsg: String?
    @State private var statusOK = false
    @State private var blinkingId: String?

    var body: some View {
        Form {
            Section("Bridge connection") {
                TextField("Bridge IP", text: $bridgeIp, prompt: Text("192.168.1.42"))
                    .textFieldStyle(.roundedBorder)
                SecureField("Application key", text: $applicationKey, prompt: Text(keyPlaceholder))
                    .textFieldStyle(.roundedBorder)
                Text("No key yet? Press the round button on your Hue bridge, then run `copilot-lights pair-hue \(bridgeIp.isEmpty ? "<bridge-ip>" : bridgeIp)` in a terminal and paste the printed key here.")
                    .foregroundStyle(.secondary).font(.caption)
                HStack {
                    Button("Save connection & scan", action: saveConnectionAndScan)
                        .disabled(bridgeIp.trimmingCharacters(in: .whitespaces).isEmpty || scanning)
                    if scanning { ProgressView().controlSize(.small) }
                    Spacer()
                    if let s = statusMsg {
                        Text(s).font(.callout).foregroundStyle(statusOK ? .green : .red)
                    }
                }
            }

            Section("Lights (\(selected.count) selected)") {
                if lights.isEmpty {
                    Text("Save the connection above and scan to list your Hue lights.")
                        .foregroundStyle(.secondary).font(.callout)
                } else {
                    HStack(spacing: 12) {
                        Button("Select all") { selected = Set(lights.map { $0.id }) }
                            .disabled(selected.count == lights.count)
                        Button("Select none") { selected.removeAll() }
                            .disabled(selected.isEmpty)
                        Spacer()
                        Text("Tap the wand to blink a light so you can find it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.link)
                    List {
                        ForEach(lights) { light in
                            HStack(spacing: 8) {
                                Toggle(isOn: binding(for: light.id)) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(light.name)
                                        if let a = light.archetype {
                                            Text(a).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .toggleStyle(.checkbox)
                                Spacer()
                                Button {
                                    blink(light)
                                } label: {
                                    if blinkingId == light.id {
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
                Button("Save & use Hue") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(selected.isEmpty)
            }
            if let r = store.lastReloadResult {
                Text("Daemon: \(r.prefix(220))").foregroundStyle(.secondary).font(.caption)
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: hydrate)
    }

    private var keyPlaceholder: String {
        (store.doc.hue?.applicationKey.isEmpty == false)
            ? "(saved — leave blank to keep)"
            : "Paste the key from pair-hue"
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { selected.contains(id) },
            set: { on in
                if on { selected.insert(id) } else { selected.remove(id) }
            }
        )
    }

    private func hydrate() {
        let hue = store.doc.hue
        bridgeIp = hue?.bridgeIp ?? ""
        selected = Set(hue?.lightIds ?? [])
    }

    private func saveConnectionAndScan() {
        let ip = bridgeIp.trimmingCharacters(in: .whitespaces)
        let key = applicationKey.isEmpty ? (store.doc.hue?.applicationKey ?? "") : applicationKey
        guard !ip.isEmpty, !key.isEmpty else {
            statusOK = false
            statusMsg = "Enter the bridge IP and application key first."
            return
        }
        store.setHueBridge(bridgeIp: ip, applicationKey: key)
        store.save()           // persist + reload so the daemon can use the key
        applicationKey = ""
        scan()
    }

    private func scan() {
        statusMsg = nil
        scanning = true
        Task {
            // Brief pause so the daemon finishes the reload before we query it.
            try? await Task.sleep(for: .milliseconds(400))
            let reply = await store.scanHue()
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
                lights = reply.lights
                let known = Set(lights.map { $0.id })
                selected = selected.intersection(known)
                statusOK = true
                statusMsg = "✓ Found \(reply.lights.count) light\(reply.lights.count == 1 ? "" : "s")"
            }
        }
    }

    private func blink(_ light: HueScanLight) {
        guard blinkingId == nil else { return }
        blinkingId = light.id
        Task {
            let result = await store.identify(adapter: .hue, lightId: light.id)
            await MainActor.run {
                blinkingId = nil
                if let result, result.ok {
                    statusOK = true
                    statusMsg = "✓ Blinking \(light.name)"
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

    private func save() {
        store.setHueLights(Array(selected).sorted())
        store.enableAdapter(.hue)
        store.save()
        statusOK = true
        statusMsg = "✓ Saved \(selected.count) light\(selected.count == 1 ? "" : "s") — Hue enabled"
    }
}
