import AppKit
import Carbon.HIToolbox

/// Thin Swift wrapper around Carbon `RegisterEventHotKey`. Carbon hotkeys
/// don't require any special entitlement, work for unsigned/adhoc apps, and
/// fire a global handler regardless of which app currently has focus.
///
/// Usage:
///   let hk = GlobalHotKey(keyCode: UInt32(kVK_ANSI_L),
///                         modifiers: optionKey | shiftKey) { ... }
///   // store `hk` somewhere — releasing it unregisters the hotkey.
@MainActor
final class GlobalHotKey {
    private var ref: EventHotKeyRef?
    private let id: UInt32
    private let handler: () -> Void
    /// nonisolated(unsafe) because the Carbon callback runs on the main thread
    /// but in a nonisolated context. Mutations only happen from MainActor
    /// methods (init / explicit unregister), so concurrent mutation is not
    /// possible in practice.
    nonisolated(unsafe) private static var registry: [UInt32: GlobalHotKey] = [:]
    nonisolated(unsafe) private static var nextId: UInt32 = 1
    nonisolated(unsafe) private static var installedHandler = false

    /// `modifiers` is a bitmask of Carbon modifier constants
    /// (`cmdKey`, `optionKey`, `shiftKey`, `controlKey`).
    /// `keyCode` is one of the `kVK_*` virtual key codes.
    init?(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) {
        self.handler = handler
        let myId = GlobalHotKey.nextId
        GlobalHotKey.nextId += 1
        self.id = myId

        Self.installHandlerIfNeeded()

        var hotKeyRef: EventHotKeyRef?
        let signature = "CPLT".fourCharCode
        let hkID = EventHotKeyID(signature: signature, id: myId)
        let status = RegisterEventHotKey(keyCode, modifiers, hkID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr || hotKeyRef == nil {
            return nil
        }
        self.ref = hotKeyRef
        GlobalHotKey.registry[myId] = self
    }

    /// Tear down the hotkey explicitly. Safe to call multiple times.
    func unregister() {
        if let r = ref {
            UnregisterEventHotKey(r)
            ref = nil
        }
        GlobalHotKey.registry.removeValue(forKey: id)
    }

    private static func installHandlerIfNeeded() {
        if installedHandler { return }
        installedHandler = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let cb: EventHandlerUPP = { (_, eventRef, _) -> OSStatus in
            guard let event = eventRef else { return noErr }
            var hkID = EventHotKeyID()
            let err = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hkID
            )
            if err == noErr {
                let id = hkID.id
                DispatchQueue.main.async {
                    if let hk = GlobalHotKey.registry[id] {
                        hk.handler()
                    }
                }
            }
            return noErr
        }
        InstallEventHandler(GetApplicationEventTarget(), cb, 1, &spec, nil, nil)
    }
}

private extension String {
    /// Convert a 4-character ASCII string into a FourCharCode (OSType).
    var fourCharCode: FourCharCode {
        var result: FourCharCode = 0
        for c in unicodeScalars.prefix(4) {
            result = (result << 8) | (FourCharCode(c.value) & 0xff)
        }
        return result
    }
}
